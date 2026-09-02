import { prisma } from '@/server/db';
import { resolveSecureLink, consumeSecureLink } from './secure-link';
import { tokenHash } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { executePayment, setStatus } from './donation-flow';

/**
 * **deprecated — 구(舊) CONFIRM_LINK 경로.**
 *
 * 후원자가 MT 로 받은 토네이도 자체 확인 링크에서 버튼을 누르면 빌키로 곧바로 승인한다.
 * 현재 기본 경로는 결제사 PIN 인증(`pin-authorization.ts`)이며, 이 경로는
 * `ALLOW_LEGACY_CONFIRM_LINK=true` 일 때만 새 링크가 발급된다
 * (발급 지점: donation-flow.ts 의 resolveConfirmChannel).
 *
 * 링크 해석·확인 함수 자체는 계속 동작한다. 플래그를 끄는 순간 이미 발송된 링크까지
 * 막아 버리면, 문자를 받아 둔 후원자의 대기 건이 갈 곳 없이 멈추기 때문이다.
 * (미확인 건은 기존대로 expireStaleConfirmations 로 자동 취소된다)
 *
 * PIN 인증 흐름이 안정화되면 이 파일과 /r/[token] 확인 화면을 함께 제거한다.
 */

export interface ConfirmContext {
  linkId: string;
  donationId: string;
  donorId: string | null;
  creatorName: string;
  amount: bigint;
  message: string;
  expiresAt: Date;
  /** 후원자가 기존에 저장한 닉네임 (없으면 null) */
  donorNickname: string | null;
  /** 후원자가 기존에 저장한 SNS 플랫폼 (없으면 null) */
  donorSnsPlatform: string | null;
}

export async function loadConfirmContext(
  token: string,
): Promise<{ ok: true; ctx: ConfirmContext } | { ok: false; reason: string }> {
  const res = await resolveSecureLink(token);
  if (!res.ok) {
    // 만료된 링크를 열면 그 자리에서 확인 대기 건을 취소한다(배치가 돌기 전에도 화면 안내와 실제 상태가 맞도록).
    if (res.reason === 'EXPIRED') await expireConfirmationByToken(token);
    const reason =
      res.reason === 'EXPIRED'
        ? '확인 시간이 지나 후원이 자동 취소되었습니다. 결제는 진행되지 않았습니다.'
        : res.reason === 'USED'
          ? '이미 처리된 요청입니다.'
          : '유효하지 않은 링크입니다.';
    return { ok: false, reason };
  }
  const link = res.link!;
  if (link.purpose !== 'CONFIRM_PAYMENT' || !link.donationId) {
    return { ok: false, reason: '용도가 다른 링크입니다.' };
  }

  const donation = await prisma.donation.findUnique({
    where: { id: link.donationId },
    include: {
      creator: true,
      donor: { select: { id: true, displayName: true, snsPlatform: true } },
    },
  });
  if (!donation) return { ok: false, reason: '후원 거래를 찾을 수 없습니다.' };
  if (donation.status !== 'PENDING_CONFIRM') {
    return { ok: false, reason: '이미 처리된 후원입니다.' };
  }

  return {
    ok: true,
    ctx: {
      linkId: link.id,
      donationId: donation.id,
      donorId: donation.donorId ?? null,
      creatorName: donation.creator.displayName,
      amount: donation.amount,
      message: donation.message,
      expiresAt: link.expiresAt,
      donorNickname: donation.donor?.displayName ?? null,
      donorSnsPlatform: donation.donor?.snsPlatform ?? null,
    },
  };
}

export async function confirmDonation(token: string, ip?: string, userAgent?: string) {
  const loaded = await loadConfirmContext(token);
  if (!loaded.ok) throw new Error(loaded.reason);

  // 링크 1회 사용 선점 (중복 클릭으로 인한 이중 결제 방지)
  const consumed = await consumeSecureLink(loaded.ctx.linkId, ip, userAgent);
  if (!consumed) throw new Error('이미 처리된 요청입니다.');

  return executePayment(loaded.ctx.donationId);
}

/** 만료된 확인 링크 한 건에 연결된 확인 대기 후원을 취소한다. */
async function expireConfirmationByToken(token: string) {
  const link = await prisma.secureLink.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: { purpose: true, donationId: true },
  });
  if (!link || link.purpose !== 'CONFIRM_PAYMENT' || !link.donationId) return;
  const d = await prisma.donation.findUnique({ where: { id: link.donationId }, select: { status: true } });
  if (d?.status !== 'PENDING_CONFIRM') return;
  await setStatus(link.donationId, 'PAYMENT_FAILED', '확인 시간 초과로 자동 취소');
}

/** 만료된 확인 대기 건 정리 (배치) */
export async function expireStaleConfirmations(now = new Date()) {
  const stale = await prisma.secureLink.findMany({
    where: { purpose: 'CONFIRM_PAYMENT', usedAt: null, expiresAt: { lt: now }, donationId: { not: null } },
    select: { donationId: true },
  });
  let count = 0;
  for (const s of stale) {
    if (!s.donationId) continue;
    const d = await prisma.donation.findUnique({ where: { id: s.donationId }, select: { status: true } });
    if (d?.status !== 'PENDING_CONFIRM') continue;
    // setStatus 를 거쳐야 DonationStatusLog 감사 이력이 남는다
    await setStatus(s.donationId, 'PAYMENT_FAILED', '확인 시간 초과로 자동 취소');
    count += 1;
  }
  return count;
}

/**
 * 확인 링크 소비(consumeSecureLink)까지는 끝났는데 executePayment 로 이어지지 못하고
 * 크래시한 건을 복구한다 (M-6). 링크는 소비됐는데 후원이 여전히 PENDING_CONFIRM 인 건이 대상이다.
 *
 * 링크 소비와 결제 실행 사이는 외부 PG 호출을 포함해 하나의 DB 트랜잭션으로 묶을 수 없으므로,
 * 대신 주기적으로 이 상태를 찾아 결제를 다시 시도한다. executePayment 는 결제 트랜잭션을
 * 주문번호로 재사용하므로 다시 호출해도 이중 승인되지 않는다.
 */
export async function recoverStaleConfirmedDonations(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30_000);
  const stale = await prisma.secureLink.findMany({
    where: { purpose: 'CONFIRM_PAYMENT', usedAt: { not: null, lt: cutoff }, donationId: { not: null } },
    select: { donationId: true },
  });

  let count = 0;
  for (const s of stale) {
    if (!s.donationId) continue;
    const d = await prisma.donation.findUnique({ where: { id: s.donationId }, select: { status: true } });
    if (d?.status !== 'PENDING_CONFIRM') continue;
    try {
      await executePayment(s.donationId);
      count += 1;
    } catch (e) {
      logger.error('확인 링크 소비 후 결제 재시도 실패', { donationId: s.donationId, message: (e as Error).message });
    }
  }
  return count;
}
