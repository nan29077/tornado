/**
 * 도네이도 샵 영상 후원 (2026-11-17).
 *
 * 문자(MO)가 아니라 샵 페이지에서 바로 결제(PG)한다. 결제가 승인된 후원만:
 *  - 기존 후원(donation)으로 기록하고 정산 원장 3분개(후원금·결제수수료·플랫폼수수료)를 쌓는다
 *  - 기존 송출 흐름(dispatchBroadcast)으로 **방송 오버레이(금액별 연출 포함) + 유튜브 라이브 채팅**에 띄운다
 *  - 샵 라이브 화면의 실시간 후원 목록에도 나온다(같은 donation 을 읽는다)
 * 결제 성공과 송출 성공은 별개다(CLAUDE.md 규칙 3) — 송출이 실패해도 결제·원장은 그대로다.
 * 결제는 아직 mock(테스트 결제)이며 화면에 표시한다.
 *
 * 2026-11-17: 샵 [후원하기] 탭의 '신용카드 후원'도 같은 흐름을 쓴다 (input.kind = 'CARD').
 *   영상 후원 설정(shopVideoDonation)과 무관하게 받고, 결제 기록 종류만 CARD_DONATION 으로 남긴다.
 */
import { prisma, withAdvisoryLock } from '@/server/db';
import { newId, newTransactionNo } from '@/lib/id';
import { kstStartOfDay, kstStartOfMonth } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { resolvePolicy } from '@/server/services/limits';
import { encrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { getShopPaymentAdapter, shopPaymentClosedMessage } from '@/server/adapters/shop-payment';
import { calculateFees, postDonationSettlement } from '@/server/services/settlement';
import { dispatchBroadcast } from '@/server/services/broadcast-dispatch';
import { loadBannedWords } from '@/server/services/donation-flow';
import { filterContent } from '@/server/services/content-filter';

export const VIDEO_DONATION_MAX = 1_000_000n;

export function parseDonationPresets(raw: string | null | undefined): bigint[] {
  const out = (raw ?? '')
    .split(',')
    .map((v) => v.replace(/[^\d]/g, ''))
    .filter((v) => /^\d{3,7}$/.test(v))
    .map((v) => BigInt(v))
    .slice(0, 6);
  return out.length > 0 ? out : [1000n, 3000n, 5000n, 10000n];
}

export interface VideoDonationResult {
  ok: boolean;
  message: string;
  transactionNo?: string;
}

export async function donateToVideo(
  user: { id: string; name: string | null },
  input: { creatorId: string; videoRef: string; videoTitle: string; amount: bigint; message: string; nickname: string; anonymous?: boolean; kind?: 'VIDEO' | 'CARD' },
): Promise<VideoDonationResult> {
  const closed = shopPaymentClosedMessage();
  if (closed) return { ok: false, message: closed };
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: input.creatorId },
    select: { id: true, status: true, displayName: true, shopVideoDonation: true, shopDonationMin: true, maxAmount: true, userId: true },
  });
  if (!creator || creator.status !== 'APPROVED') return { ok: false, message: '후원할 수 없는 크리에이터입니다.' };
  // [5차 PAY-C] 내 채널에는 후원할 수 없다 (자기 후원으로 정산금을 만드는 경로 차단)
  if (creator.userId === user.id) return { ok: false, message: '내 채널에는 후원할 수 없어요.' };
  const card = input.kind === 'CARD';
  if (!card && !creator.shopVideoDonation) return { ok: false, message: '이 크리에이터는 영상 후원을 받지 않습니다.' };
  const min = creator.shopDonationMin > 0n ? creator.shopDonationMin : 1000n;
  const max = creator.maxAmount > 0n && creator.maxAmount < VIDEO_DONATION_MAX ? creator.maxAmount : VIDEO_DONATION_MAX;
  if (input.amount < min || input.amount > max) return { ok: false, message: `후원 금액은 ${min.toString()}원 ~ ${max.toString()}원 사이로 입력해 주세요.` };

  const nickname = input.nickname.trim().slice(0, 20) || (user.name ?? '').trim().slice(0, 20) || '후원자';
  const rawMessage = input.message.trim();
  if (rawMessage.length > 200) return { ok: false, message: '메시지는 200자 이내로 입력해 주세요.' };

  // 차단된 후원자는 영상 후원도 막는다 (휴대폰을 연결한 회원만 판정 가능)
  const donor = await prisma.donorProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (donor) {
    const blocked = await prisma.blockedDonor.findFirst({ where: { creatorId: creator.id, donorId: donor.id }, select: { id: true } });
    if (blocked) return { ok: false, message: '이 크리에이터에게는 후원할 수 없습니다.' };
  }

  const bannedWords = await loadBannedWords(creator.id);
  const overlay = await prisma.overlaySetting.findUnique({ where: { creatorId: creator.id }, select: { maxMessageLen: true } });
  const filtered = filterContent(rawMessage, { bannedWords, maxLength: overlay?.maxMessageLen ?? 80 });
  if (filtered.action === 'BLOCK') return { ok: false, message: '메시지에 사용할 수 없는 표현이 있습니다. 고쳐서 다시 보내 주세요.' };
  const nickFiltered = filterContent(nickname, { bannedWords, maxLength: 20 });
  if (nickFiltered.action === 'BLOCK') return { ok: false, message: '닉네임에 사용할 수 없는 표현이 있습니다.' };

  // 1) 결제 준비 — 한도 확인과 결제 행 생성을 회원 단위 잠금 안에서 한다 (동시에 눌러도 한도를 넘지 않게)
  const adapter = getShopPaymentAdapter();
  const paymentNo = `${card ? 'CDN' : 'VDN'}${Date.now().toString(36).toUpperCase()}${newId().slice(-6)}`;
  const paymentId = newId();
  const policy = await resolvePolicy(creator.id, donor?.id ?? null);
  const limitError = await prisma.$transaction((tx) =>
    withAdvisoryLock(tx, `shop-donation:user:${user.id}`, async () => {
      const err = await checkShopDonationLimits(tx, { userId: user.id, creatorId: creator.id, amount: input.amount, policy });
      if (err) return err;
      await tx.shopPayment.create({
        data: { id: paymentId, paymentNo, userId: user.id, kind: card ? 'CARD_DONATION' : 'VIDEO_DONATION', amount: input.amount, provider: adapter.provider, creatorId: creator.id },
      });
      return null;
    }),
  );
  if (limitError) return { ok: false, message: limitError };

  // 2) 승인
  const approved = await adapter
    .approve({ paymentNo, amount: input.amount, buyerName: nickname, itemName: `${creator.displayName} ${card ? '신용카드' : '영상'} 후원` })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '결제 오류' }));
  if (!approved.ok) {
    await prisma.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'FAILED', failReason: approved.reason.slice(0, 200) } });
    return { ok: false, message: `결제에 실패했습니다: ${approved.reason}` };
  }

  // 3) 후원 기록 + 원장 (한 트랜잭션, 결제 승인 반영은 한 번만)
  const fees = await calculateFees(creator.id, input.amount);
  const donationId = newId();
  const transactionNo = newTransactionNo();
  const now = new Date();
  const committed = await prisma.$transaction(async (tx) => {
    const moved = await tx.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'PAID', providerTx: approved.providerTx, paidAt: now, donationId } });
    if (moved.count === 0) return false;
    await tx.donation.create({
      data: {
        id: donationId,
        transactionNo,
        creatorId: creator.id,
        donorId: donor?.id ?? null,
        amount: input.amount,
        displayName: nickFiltered.clean || '후원자',
        message: filtered.clean,
        messageRawEnc: rawMessage ? encrypt(rawMessage) : null,
        status: 'SETTLEMENT_PENDING',
        channel: 'SHOP',
        anonymous: Boolean(input.anonymous),
        paidAt: now,
        pgFee: fees.pgFee,
        platformFee: fees.platformFee,
        feeVat: fees.vat,
        netAmount: fees.net,
      },
    });
    await tx.donationStatusLog.createMany({
      data: [
        { id: newId(), donationId, fromStatus: 'RECEIVED', toStatus: 'PAYMENT_SUCCESS', reason: card ? `도네이도 샵 신용카드 후원 결제 ${paymentNo}` : `도네이도 샵 영상 후원 결제 ${paymentNo} · ${input.videoTitle.slice(0, 60)}`, actor: 'system' },
        { id: newId(), donationId, fromStatus: 'PAYMENT_SUCCESS', toStatus: 'SETTLEMENT_PENDING', reason: '정산 대기', actor: 'system' },
      ],
    });
    if (donor) {
      await tx.donorCreatorLink.upsert({
        where: { donorId_creatorId: { donorId: donor.id, creatorId: creator.id } },
        create: { id: newId(), donorId: donor.id, creatorId: creator.id, consentedAt: now, totalAmount: input.amount, totalCount: 1, lastDonatedAt: now },
        update: { totalAmount: { increment: input.amount }, totalCount: { increment: 1 }, lastDonatedAt: now },
      });
    }
    await postDonationSettlement({ creatorId: creator.id, donationId, amount: input.amount, fees, occurredAt: now }, tx);
    return true;
  });
  if (!committed) return { ok: true, message: '후원이 이미 처리되었습니다.' };

  // 4) 송출 (실패해도 결제는 그대로)
  try {
    await dispatchBroadcast(donationId);
  } catch (e) {
    logger.error(card ? '신용카드 후원 송출 실패 (결제는 정상 완료)' : '영상 후원 송출 실패 (결제는 정상 완료)', { donationId, message: (e as Error).message });
  }
  return { ok: true, message: `${creator.displayName} 님에게 후원했습니다.`, transactionNo };
}

/** 한도 집계에 넣는 샵 후원 결제: 결제 완료 + 결제 진행 중(READY, 30분 이내) */
const SHOP_DONATION_KINDS = ['VIDEO_DONATION', 'CARD_DONATION'];
const READY_WINDOW_MS = 30 * 60_000;

type LimitTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * [5차 PAY-C] 영상·카드 후원 한도.
 * 문자 후원과 같은 정책 값(후원 한도 정책: 1일·월 한도, 크리에이터별 1일 한도, 1일 건수)을 쓴다.
 * 문자 후원 집계(휴대폰 기준)와는 따로, 회원 계정 기준으로 샵 결제를 센다.
 * 문제가 있으면 안내 문구, 없으면 null.
 */
export async function checkShopDonationLimits(
  tx: LimitTx,
  input: { userId: string; creatorId: string; amount: bigint; policy: Awaited<ReturnType<typeof resolvePolicy>> },
  now: Date = new Date(),
): Promise<string | null> {
  const { policy } = input;
  const live = { OR: [{ status: 'PAID' }, { status: 'READY', createdAt: { gte: new Date(now.getTime() - READY_WINDOW_MS) } }] };
  const base = { userId: input.userId, kind: { in: SHOP_DONATION_KINDS }, ...live };
  const [day, month, creatorDay] = await Promise.all([
    tx.shopPayment.aggregate({ where: { ...base, createdAt: { gte: kstStartOfDay(now) } }, _sum: { amount: true }, _count: { _all: true } }),
    tx.shopPayment.aggregate({ where: { ...base, createdAt: { gte: kstStartOfMonth(now) } }, _sum: { amount: true } }),
    tx.shopPayment.aggregate({ where: { ...base, creatorId: input.creatorId, createdAt: { gte: kstStartOfDay(now) } }, _sum: { amount: true } }),
  ]);
  const dayAmount = day._sum.amount ?? 0n;
  if (policy.donorDailyLimit > 0n && dayAmount + input.amount > policy.donorDailyLimit) {
    return `하루 후원 한도(${formatWon(policy.donorDailyLimit)})를 넘습니다. 오늘 남은 한도는 ${formatWon(maxZero(policy.donorDailyLimit - dayAmount))}입니다.`;
  }
  if (policy.donorDailyMaxCount > 0 && day._count._all + 1 > policy.donorDailyMaxCount) {
    return `하루 최대 ${policy.donorDailyMaxCount}건까지 후원할 수 있습니다.`;
  }
  const monthAmount = month._sum.amount ?? 0n;
  if (policy.donorMonthlyLimit > 0n && monthAmount + input.amount > policy.donorMonthlyLimit) {
    return `월 후원 한도(${formatWon(policy.donorMonthlyLimit)})를 넘습니다. 이번 달 남은 한도는 ${formatWon(maxZero(policy.donorMonthlyLimit - monthAmount))}입니다.`;
  }
  const cAmount = creatorDay._sum.amount ?? 0n;
  if (policy.perCreatorDailyLimit > 0n && cAmount + input.amount > policy.perCreatorDailyLimit) {
    return `이 크리에이터에게 하루 후원할 수 있는 금액(${formatWon(policy.perCreatorDailyLimit)})을 넘습니다.`;
  }
  return null;
}

function maxZero(v: bigint): bigint {
  return v > 0n ? v : 0n;
}
