import { prisma } from '@/server/db';
import { newId, newTransactionNo } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { donorDisplayName } from '@/lib/donor-name';
import { filterContent } from './content-filter';
import { checkLimits } from './limits';
import { acquireIdempotency } from './idempotency';
import { executePayment, loadBannedWords, resolvePaymentModeChecked, startPinAuthorization } from './donation-flow';
import { allowLegacyWebInstantPay } from '@/lib/env';
import type { DonationStatus } from '@/generated/prisma/enums';

/**
 * 후원샵(웹, PC) 후원 파이프라인.
 *
 * 모바일 MO 문자 흐름과 동일한 안전장치(금칙어 필터, 한도, 멱등, 원장)를 그대로 거치되,
 * 접수 채널만 WEB 이다. 결제가 성공한 후원만 유튜브 댓글·오버레이로 전달된다.
 *
 * 결제 단계는 두 갈래다.
 *  - `PIN`(기본): 결제사 PIN 입력 링크를 문자로 보내고, 후원자가 PIN 을 넣어야 결제된다.
 *                 MO 문자 흐름과 같은 startPinAuthorization() 을 그대로 재사용한다.
 *  - `LEGACY_INSTANT`(**deprecated**): 화면 버튼 클릭 즉시 빌키로 출금한다.
 *                 ALLOW_LEGACY_WEB_INSTANT_PAY=true 일 때만 사용한다.
 */

export type WebDonationChannel = 'PIN' | 'LEGACY_INSTANT';

export function resolveWebDonationChannel(
  allowLegacy: boolean = allowLegacyWebInstantPay(),
): WebDonationChannel {
  return allowLegacy ? 'LEGACY_INSTANT' : 'PIN';
}

export interface WebDonationInput {
  /** 전화번호 인증을 마친 후원자의 phoneHash */
  phoneHash: string;
  creatorId: string;
  amount: bigint;
  message: string;
  /** 중복 제출 방지용 클라이언트 멱등키 */
  requestId: string;
}

export interface WebDonationResult {
  ok: boolean;
  status?: DonationStatus;
  donationId?: string;
  transactionNo?: string;
  message: string;
  /** PIN 흐름에서만: 인증 링크 만료 시각 (대기 화면 카운트다운용) */
  pinExpiresAt?: Date;
  /** PIN 흐름에서만: 결제사 실연동이 아닌 mock 링크인지 */
  pinMock?: boolean;
}

export async function createWebDonation(input: WebDonationInput): Promise<WebDonationResult> {
  /**
   * 크리에이터 프로필 승인 여부만 보면 안 된다.
   * 공개 후원 페이지는 `user.status === 'ACTIVE'` 까지 함께 확인하는데(정지 계정에 돈이 계속
   * 쌓이는 것을 막기 위해서다) 정작 결제 파이프라인 진입부에서 빠져 있었다.
   * creatorId 를 직접 POST 하면 정지된 계정도 후원을 계속 받을 수 있었다.
   */
  const creator = await prisma.creatorProfile.findFirst({
    where: { id: input.creatorId, status: 'APPROVED', user: { status: 'ACTIVE' } },
  });
  if (!creator) return { ok: false, message: '후원할 수 없는 크리에이터입니다.' };

  const donor = await prisma.donorProfile.findUnique({ where: { phoneHash: input.phoneHash } });
  if (!donor) return { ok: false, message: '등록된 후원자 정보가 없습니다. 내통장결제 가입을 먼저 완료해 주세요.' };

  const token = await prisma.paymentMethodToken.findFirst({
    where: { donorId: donor.id, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!token) {
    return { ok: false, message: '등록된 결제수단(내통장결제)이 없습니다. 가입을 먼저 완료해 주세요.' };
  }

  // 콘텐츠 필터 (금칙어 차단/마스킹)
  const bannedWords = await loadBannedWords(creator.id);
  const overlay = await prisma.overlaySetting.findUnique({ where: { creatorId: creator.id } });
  const filtered = filterContent(input.message, {
    bannedWords,
    maxLength: overlay?.maxMessageLen ?? 80,
  });
  if (filtered.action === 'BLOCK') {
    return { ok: false, message: '메시지에 사용할 수 없는 단어가 포함되어 있습니다. 내용을 수정해 주세요.' };
  }

  // 한도 확인 (후원 생성 전에 먼저 확인해 불필요한 레코드를 만들지 않는다)
  const blocked = await prisma.blockedDonor.findUnique({
    where: { creatorId_donorId: { creatorId: creator.id, donorId: donor.id } },
  });
  const limit = await checkLimits({
    donor,
    creatorId: creator.id,
    amount: input.amount,
    blockedByCreator: Boolean(blocked),
    /**
     * 속도 카운터는 접수 시점에 소비한다(executePayment 는 재검사만 한다).
     *
     * 이 흐름은 본인확인 없이 남의 번호로도 시작할 수 있어 "피해자 카운터 태우기"가
     * 이론적으로 가능하지만, 카운터를 여기서 빼면 웹 PIN 경로 전체가 속도 제한 밖으로
     * 나가 실제 남용을 막지 못한다. 남용 방어를 유지하고, 가용성 쪽은 발신 IP 제한과
     * 번호당 발송 제한(10분 3건)으로 좁힌다.
     */
  });
  if (!limit.ok) {
    // 금액 범위 오류는 입력 실수라 이상거래로 기록하지 않는다.
    if (limit.code !== 'AMOUNT_RANGE') await prisma.riskDetection.create({
      data: {
        id: newId(),
        donorId: donor.id,
        creatorId: creator.id,
        type: limit.code === 'VELOCITY' || limit.code === 'COOLDOWN' ? 'VELOCITY' : 'DAILY_LIMIT',
        level: 'MEDIUM',
        detail: { code: limit.code, message: limit.message, channel: 'WEB' } as object,
      },
    });
    return { ok: false, message: limit.message ?? '이용 한도를 초과했습니다.' };
  }

  // 멱등: 같은 requestId 로 두 번 제출돼도 후원이 중복 생성되지 않는다
  const idem = await acquireIdempotency('donation', `web:${creator.id}:${donor.id}:${input.requestId}`);
  if (idem.status === 'DUPLICATE') {
    return { ok: false, message: '이미 처리 중인 후원입니다. 잠시 후 후원 내역에서 확인해 주세요.' };
  }

  let donation;
  try {
    donation = await prisma.donation.create({
      data: {
        id: newId(),
        transactionNo: newTransactionNo(),
        creatorId: creator.id,
        donorId: donor.id,
        channel: 'WEB',
        amount: input.amount,
        // 닉네임을 설정하지 않았으면 번호 끝 4자리로 만든 기본 이름을 쓴다 (예: 후원자5678).
        // phoneMasked(010-****-5678)에도 끝 4자리는 남아 있어 그대로 재료로 쓸 수 있다.
        displayName: donorDisplayName(donor.displayName, donor.phoneMasked),
        message: filtered.clean,
        messageRawEnc: encrypt(input.message),
        status: 'RECEIVED',
        statusReason: '후원샵 웹 후원',
        paymentMode: await resolvePaymentModeChecked(creator.paymentMode),
      },
    });
  } catch (error) {
    // 후원 생성에 실패했는데 멱등키를 IN_PROGRESS 로 남기면 TTL(7일) 동안
    // 같은 requestId 재제출이 전부 DUPLICATE 로 막힌다. 키를 지워 재시도를 허용한다.
    await idem.abort();
    throw error;
  }
  await idem.release(donation.id);

  // 기본 경로: 결제사 PIN 입력 링크를 문자로 보낸다. 이 시점에는 출금이 일어나지 않는다.
  if (resolveWebDonationChannel() === 'PIN') {
    const pin = await startPinAuthorization(donation.id);
    return {
      ok: pin.ok,
      status: pin.status,
      donationId: donation.id,
      transactionNo: donation.transactionNo,
      message: pin.message,
      pinExpiresAt: pin.expiresAt,
      pinMock: pin.mock,
    };
  }

  // ── deprecated: 즉시 결제 ─────────────────────────────────────────────
  // 화면에서 금액을 확인하고 버튼을 눌렀다는 것만으로 곧바로 출금한다.
  // ALLOW_LEGACY_WEB_INSTANT_PAY=true 일 때만 이 경로를 탄다.
  const paid = await executePayment(donation.id);
  return {
    ok: paid.ok,
    status: paid.status,
    donationId: donation.id,
    transactionNo: donation.transactionNo,
    message: paid.ok
      ? '후원이 완료되었습니다. 결제된 후원만 유튜브 댓글과 방송 오버레이로 전달됩니다.'
      : paid.message,
  };
}
