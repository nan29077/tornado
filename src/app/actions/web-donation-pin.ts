'use server';

import { cookies } from 'next/headers';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, normalizePhone, phoneHash } from '@/lib/crypto';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { issueSecureLink } from '@/server/services/secure-link';
import { createWebDonation } from '@/server/services/web-donation';
import { sendMt } from '@/server/services/donation-flow';
import { expirePinSessionIfStale } from '@/server/services/pin-authorization';
import * as tpl from '@/server/services/mt-templates';

/**
 * 후원샵 PC 웹 후원 — PIN 인증 흐름 서버 액션.
 *
 *   금액·메시지 작성 → 휴대전화 번호 입력 → 결제사 PIN 링크 요청 → MT 발송
 *   → (후원자가 문자 링크에서 PIN 입력) → 콜백 → 결제 완료
 *
 * 이 경로에는 인증번호(SMS OTP) 단계가 없다. 결제를 확정하는 주체는
 * **문자를 받은 휴대전화 본인**이며, PIN 을 입력하지 않으면 출금은 일어나지 않는다.
 *
 * 그래도 남는 위험이 있어 아래 두 가지로 막는다.
 *  1) PIN 링크는 **이미 결제수단이 등록된 번호**로만 나간다. 임의의 번호로는 발송되지 않는다.
 *  2) 번호당 발송 횟수를 제한한다(문자 폭탄·한도 소모 방지).
 *
 * 진행 상태는 클라이언트가 보낸 값이 아니라 **HttpOnly 쿠키에 담긴 후원 ID**로만 조회한다.
 * (거래번호·후원 상태가 ID 를 아는 제3자에게 노출되지 않도록)
 */

/** 번호당 PIN 링크 발송 제한 (문자 폭탄과 한도 소모 방지) */
const PIN_SEND_WINDOW_SEC = 600;
const PIN_SEND_MAX = 3;
const pinSendKey = (ph: string) => `webdon:pinsend:${ph}`;

/** 진행 중인 웹 후원 ID. 상태 조회의 유일한 근거다. */
const PIN_COOKIE = 'webdon_pin';

async function setPinCookie(donationId: string) {
  const jar = await cookies();
  jar.set(PIN_COOKIE, donationId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !isLocal && env.baseUrl.startsWith('https'),
    path: '/',
    // 링크 유효시간이 지난 뒤에도 결과 화면(만료 안내)을 볼 수 있도록 조금 더 길게 잡는다.
    maxAge: env.payment.pinTtlSec + 600,
  });
}

async function readPinCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(PIN_COOKIE)?.value ?? null;
}

export type WebPinStep = 'compose' | 'phone' | 'register' | 'waiting' | 'done' | 'failed';

export interface WebPinState {
  ok: boolean;
  step: WebPinStep;
  message?: string;
  phoneMasked?: string;
  /** 미가입자의 결제수단 등록 링크 (팝업으로 연다) */

  /** PIN 링크 만료 시각 (ISO). 대기 화면 카운트다운에 쓴다. */
  expiresAt?: string;
  /** 결제사 실연동이 아닌 mock 링크인지 */
  mock?: boolean;
  transactionNo?: string;
}

// ---------------------------------------------------------------- 1) PIN 링크 요청

export async function startWebPinDonation(_prev: WebPinState, formData: FormData): Promise<WebPinState> {
  const phoneRaw = String(formData.get('phone') ?? '');
  const creatorId = String(formData.get('creatorId') ?? '');
  const requestId = String(formData.get('requestId') ?? '');
  const message = String(formData.get('message') ?? '').trim();
  const amountRaw = String(formData.get('amount') ?? '').replace(/[^\d]/g, '');

  const phone = normalizePhone(phoneRaw);
  if (!/^01[0-9]{8,9}$/.test(phone)) {
    return { ok: false, step: 'phone', message: '휴대전화 번호 형식을 확인해 주세요. (예: 010-1234-5678)' };
  }
  if (!creatorId || !requestId) return { ok: false, step: 'phone', message: '요청 정보가 올바르지 않습니다.' };
  if (!message) return { ok: false, step: 'phone', message: '후원 메시지를 입력해 주세요.' };
  if (message.length > 200) return { ok: false, step: 'phone', message: '후원 메시지는 200자 이내로 입력해 주세요.' };
  if (!/^\d{3,7}$/.test(amountRaw)) return { ok: false, step: 'phone', message: '후원 금액을 확인해 주세요.' };

  const ph = phoneHash(phone);
  const masked = maskPhone(phone);

  /**
   * 이 흐름은 로그인도 인증번호도 없이 **전화번호 문자열만 받아** 그 번호로 결제 요청 문자를
   * 보낸다. 번호 단위 제한만 있으면 공격자가 번호를 바꿔 가며 광범위하게 발송할 수 있고,
   * 피해자에게는 공격자가 정한 금액·문구의 "PIN 을 입력하세요" 문자가 도착한다.
   * **발신 측(IP) 제한을 함께 건다.**
   */
  const ipLimit = await consumeIpRateLimit('web-pin-start', 10, PIN_SEND_WINDOW_SEC, { failClosed: true });
  if (!ipLimit.ok) {
    return {
      ok: false,
      step: 'phone',
      message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    };
  }

  const sent = await kv.incr(pinSendKey(ph), PIN_SEND_WINDOW_SEC);
  if (sent > PIN_SEND_MAX) {
    return {
      ok: false,
      step: 'phone',
      phoneMasked: masked,
      message: '결제 문자 발송이 너무 잦습니다. 10분 후 다시 시도해 주세요.',
    };
  }

  // 결제수단이 등록된 번호인지 먼저 확인한다.
  // 등록되지 않은 번호로는 PIN 링크를 만들 수 없으므로 가입 안내로 보낸다.
  const donor = await prisma.donorProfile.findUnique({ where: { phoneHash: ph }, select: { id: true } });
  const token = donor
    ? await prisma.paymentMethodToken.findFirst({ where: { donorId: donor.id, status: 'ACTIVE' }, select: { id: true } })
    : null;

  if (!donor || !token) {
    return registerGuide({ phone, ph, masked, creatorId, donorExists: Boolean(donor) });
  }

  const result = await createWebDonation({
    phoneHash: ph,
    creatorId,
    amount: BigInt(amountRaw),
    message,
    requestId,
  });

  if (!result.ok || !result.donationId) {
    // 결제수단 문제로 막힌 경우에는 가입 안내로 되돌린다.
    if (result.message.includes('가입')) {
      return registerGuide({ phone, ph, masked, creatorId, donorExists: true, reason: result.message });
    }
    return { ok: false, step: 'phone', phoneMasked: masked, message: result.message };
  }

  await setPinCookie(result.donationId);
  logger.info('후원샵 웹 후원 PIN 링크 발송', { phone: masked, donationId: result.donationId });

  return {
    ok: true,
    step: 'waiting',
    phoneMasked: masked,
    expiresAt: result.pinExpiresAt?.toISOString(),
    mock: result.pinMock,
    message: result.message,
  };
}

/**
 * 미가입 번호: 결제수단 등록 링크를 **문자로만** 보낸다.
 *
 * 이 액션은 비로그인 상태에서 전화번호만 받고, 본인확인(SMS 인증번호)을 거치지 않는다.
 * 그래서 발급한 가입 링크를 응답으로 돌려주면 남의 번호를 적어 넣은 사람이
 * 그 번호에 묶인 링크를 그대로 받아 가게 된다. 그 링크로는 피해자의 마스킹 번호를 보고,
 * 자기 카드로 등록을 마치고, 로그인 상태라면 그 후원자 프로필을 자기 계정에 붙일 수도 있다.
 *
 * 그래서 링크는 번호의 실제 소유자만 받을 수 있는 문자로만 내보낸다.
 * (인증번호를 확인하는 web-donation.ts 경로는 본인확인을 마친 뒤라 팝업으로 열어 준다)
 */
async function registerGuide(input: {
  phone: string;
  ph: string;
  masked: string;
  creatorId: string;
  donorExists: boolean;
  reason?: string;
}): Promise<WebPinState> {
  // 가입 화면(loadRegistrationContext)은 전화번호로 후원자 프로필을 찾으므로,
  // 문자를 한 번도 보낸 적 없는 번호는 여기서 프로필을 먼저 만들어 둔다.
  if (!input.donorExists) {
    await prisma.donorProfile.upsert({
      where: { phoneHash: input.ph },
      update: {},
      create: { id: newId(), phoneHash: input.ph, phoneEnc: encrypt(input.phone), phoneMasked: input.masked },
    });
  }

  // 폼의 creatorId 는 검증되지 않은 값이므로 승인된 크리에이터일 때만 링크에 연결한다.
  const linkedCreator = input.creatorId
    ? await prisma.creatorProfile.findFirst({
        where: { id: input.creatorId, status: 'APPROVED' },
        select: { id: true, displayName: true },
      })
    : null;

  const link = await issueSecureLink({
    purpose: 'REGISTER_ACCOUNT',
    phoneHash: input.ph,
    creatorId: linkedCreator?.id,
    payload: { channel: 'WEB' },
  });

  // 팝업이 차단되거나 창을 닫아도 가입을 이어갈 수 있도록 같은 링크를 문자로도 보낸다.
  // 문자 발송 실패가 팝업 안내를 막으면 안 되므로 실패는 로그로만 남긴다.
  let mtSent = false;
  try {
    mtSent = await sendMt({
      phone: input.phone,
      template: tpl.tplRegisterGuide(linkedCreator?.displayName ?? '도네이도', link.url),
      creatorId: linkedCreator?.id ?? null,
    });
  } catch (error) {
    logger.error('후원샵 웹 가입 안내 문자 발송 실패', { message: (error as Error).message });
  }

  return {
    ok: true,
    step: 'register',
    phoneMasked: input.masked,
    // registerUrl 은 일부러 담지 않는다. 위 주석 참고.
    message:
      (input.reason ? `${input.reason} ` : '') +
      (mtSent
        ? '결제수단 등록이 필요합니다. 등록 링크를 문자로 보냈습니다. 등록을 마친 뒤 이 창에서 다시 후원해 주세요.'
        : '결제수단 등록이 필요합니다. 잠시 뒤 도착하는 등록 안내 문자의 링크로 등록을 마친 뒤 이 창에서 다시 후원해 주세요.'),
  };
}

// ---------------------------------------------------------------- 2) 결제 완료 폴링

/** 결제가 승인되어 방송·정산으로 넘어간 상태들 */
const PAID_STATUSES = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * 대기 화면 폴링.
 *
 * 조회 대상은 HttpOnly 쿠키에 담긴 후원 ID 뿐이다. 클라이언트가 후원 ID 를 보내
 * 남의 거래 상태를 들여다보는 일이 생기지 않는다.
 */
export async function checkWebPinDonationStatus(): Promise<WebPinState> {
  const donationId = await readPinCookie();
  if (!donationId) {
    return { ok: false, step: 'phone', message: '진행 중인 후원이 없습니다. 처음부터 다시 시도해 주세요.' };
  }

  // 배치가 돌기 전이라도 만료를 화면에 바로 반영한다.
  await expirePinSessionIfStale(donationId);

  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      status: true,
      statusReason: true,
      transactionNo: true,
      pinSession: { select: { status: true, expiresAt: true, mock: true } },
    },
  });
  if (!donation) {
    return { ok: false, step: 'phone', message: '후원 정보를 찾을 수 없습니다. 처음부터 다시 시도해 주세요.' };
  }

  if (PAID_STATUSES.includes(donation.status)) {
    return {
      ok: true,
      step: 'done',
      transactionNo: donation.transactionNo,
      message: '후원이 완료되었습니다. 결제된 후원만 유튜브 댓글과 방송 오버레이로 전달됩니다.',
    };
  }

  if (donation.status === 'PENDING_PIN' || donation.status === 'PENDING_PAYMENT') {
    return {
      ok: true,
      step: 'waiting',
      expiresAt: donation.pinSession?.expiresAt.toISOString(),
      mock: donation.pinSession?.mock,
      message:
        donation.status === 'PENDING_PAYMENT'
          ? 'PIN 인증이 확인되어 결제를 진행하고 있습니다.'
          : undefined,
    };
  }

  // 만료·실패·차단 등 진행할 수 없는 상태
  const expired = donation.pinSession?.status === 'EXPIRED';
  return {
    ok: false,
    step: 'failed',
    message: expired
      ? 'PIN 입력 시간이 지나 후원이 취소되었습니다. 결제는 진행되지 않았습니다. 다시 시도해 주세요.'
      : donation.statusReason || '후원이 완료되지 않았습니다. 결제는 진행되지 않았습니다.',
  };
}
