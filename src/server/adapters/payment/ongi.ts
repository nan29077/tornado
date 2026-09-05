import crypto from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AdapterNotConfiguredError, type AdapterInfo, type ProviderResult } from '../types';
import type {
  ApproveRequest,
  ApproveResult,
  InquiryStatus,
  PaymentAdapter,
  PaymentMethodKind,
  PinLinkSession,
  RegistrationResult,
  RegistrationSession,
} from './index';

/**
 * 온기(Ongi) 결제 어댑터.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **헥토파이낸셜 EzAuth 와는 완전히 다른 구조다.**
 *
 *   헥토 EzAuth                          온기
 *   ─────────────────────────────────    ────────────────────────────────────
 *   결제창(UI) + 서버 API 호스트 2개      REST API 호스트 1개
 *   SHA256 서명 + AES-256-ECB 암호화      X-API-KEY 헤더 인증
 *   계좌 인증 → 빌키 발급 → 빌키 승인      결제 URL 발급 → 후원자 결제 → 웹훅 노티
 *
 * 헥토 방식(서명·암호화)을 그대로 가져다 쓰면 전건 인증 실패한다. 그래서 이 파일에는
 * AES/SHA256 서명 로직이 **하나도 없다.** 웹훅 서명 검증용 HMAC 만 있다.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 현재 상태
 * ---------
 * 인증 구조(X-API-KEY)와 결제 노티 웹훅 서명 검증은 완성되어 있다.
 * **결제 요청/조회 API 의 구체적 경로는 아직 온기에서 받지 못했다.**
 * 경로를 추정해 호출하면 전건 실패하거나 최악의 경우 잘못된 결제로 이어지므로,
 * 경로가 비어 있는 동작은 호출하지 않고 명시적 실패를 돌려준다.
 * 경로를 받으면 아래 ONGI_SPEC 블록만 채우면 나머지는 그대로 동작한다.
 */

/**
 * 연동규격 수령 시 채워야 하는 값 모음.
 *
 * 빈 문자열('')은 **아직 규격을 받지 못했다**는 뜻이다. `requirePath()` 가 이를 보고
 * 통신을 시도하지 않고 실패를 돌려준다. 추정값을 넣어 두면 안 된다.
 */
/**
 * 온기 측에 확인해야 할 사항
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 정기결제 구조
 *    - 빌키 방식인가, 결제 URL 발급 방식인가?
 *    - 등록(최초 결제)과 재청구(정기결제)가 별도 엔드포인트인가?
 *    - 빌키 방식이라면 등록 복귀 URL 에 어떤 파라미터가 전달되는가?
 *
 * 2. API 경로 3개 (현재 미확정 — 채우면 어댑터가 즉시 동작함)
 *    - 결제 생성/URL 발급: paymentCreatePath  (예: /api/external/.../payment)
 *    - 결제 단건 조회:     paymentInquirePath (예: /api/external/.../payment/{id})
 *    - 결제 취소:          paymentCancelPath  (예: /api/external/.../payment/{id}/cancel)
 *
 * 3. 웹훅(결제 노티)
 *    - 웹훅 경로는 온기에서 고정하는가, 가맹점이 지정하는가?
 *    - 현재 /api/webhooks/ongi 를 준비해 두었으나 경로 미확정으로 501 반환 중이다.
 *    - 서명 헤더 이름이 'x-ongi-signature' 이 맞는가? (ONGI_WEBHOOK_HEADER 참고)
 *    - 서명 알고리즘 형식: sha256=HMAC-SHA256(secret, "{timestamp}.{rawBody}") 가 맞는가?
 *
 * 4. 성공 응답 코드
 *    - successCode 가 '0000' 이 맞는가? 규격서 수령 후 확인 필요.
 *
 * 5. ONGI_RECURRING_MID 가 일반 ONGI_API_MID 와 다른지 여부
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const ONGI_SPEC = {
  /**
   * 확인된 경로 형태(온기 문서 페이지 기준).
   * 가맹점/조직 정보 조회. 연결 점검(health)에 쓸 수 있다.
   */
  organizationPath: '/api/external/integration/merchant/v1/organization',

  /**
   * TODO(온기 제공 대기): 결제 생성/URL 발급 API 경로.
   * 온기로부터 규격서 수령 후 이 값만 채우면 startRegistration/approve 가 즉시 동작한다.
   * 예: '/api/external/integration/payment/v1/create'
   */
  paymentCreatePath: '',

  /**
   * TODO(온기 제공 대기): 결제 단건 조회 API 경로.
   * inquire() 와 syncDonationStatus() 에서 사용한다.
   * 예: '/api/external/integration/payment/v1/inquiry'
   */
  paymentInquirePath: '',

  /**
   * TODO(온기 제공 대기): 결제 취소 API 경로.
   * cancel() 에서 사용한다.
   * 예: '/api/external/integration/payment/v1/cancel'
   */
  paymentCancelPath: '',

  /** 응답에서 성공을 뜻하는 값. 규격서 수령 시 확인 필요. */
  successCode: '0000',
} as const;

/** 웹훅 서명 헤더 이름. 온기 규격 확인 후 다르면 이 값만 바꾼다. */
export const ONGI_SIGNATURE_HEADER = 'x-ongi-signature';
export const ONGI_TIMESTAMP_HEADER = 'x-ongi-timestamp';

const TIMEOUT_MS = 20_000;

function requiredCredentials(): string[] {
  const missing: string[] = [];
  if (!env.payment.ongiApiBase) missing.push('ONGI_API_BASE');
  if (!env.payment.ongiApiKey) missing.push('ONGI_API_KEY');
  // ONGI_API_MID 는 선택 항목이라 누락으로 보지 않는다.
  // ONGI_WEBHOOK_SECRET 은 웹훅 검증에서만 필요하므로 여기서 막지 않는다.
  return missing;
}

function assertConfigured(): void {
  const missing = requiredCredentials();
  if (missing.length > 0) throw new AdapterNotConfiguredError('ongi', missing);
}

/**
 * 아직 경로를 받지 못한 동작을 막는다.
 * 규격 없이 추정 경로로 호출하면 실패하거나 엉뚱한 자원을 건드린다.
 */
function missingSpec(what: string): ProviderResult<never> {
  return {
    ok: false,
    code: 'ONGI_SPEC_PENDING',
    message: `온기 ${what} API 경로를 아직 받지 못했습니다. ONGI_SPEC 을 채운 뒤 사용하십시오.`,
  };
}

// ---------------------------------------------------------------------------
// 웹훅 서명 검증
// ---------------------------------------------------------------------------

/**
 * 결제 노티 웹훅 서명을 만든다.
 *
 *   sha256=HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * 본문을 **파싱 전 원문 그대로** 넣어야 한다. JSON.parse 후 다시 stringify 하면
 * 키 순서·공백이 달라져 서명이 어긋난다.
 */
export function ongiWebhookSignature(
  timestamp: string,
  rawBody: string,
  secret = env.payment.ongiWebhookSecret,
): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

/**
 * 결제 노티 웹훅 서명을 검증한다.
 *
 * 비밀이 설정되지 않았으면 **검증 불가 = 실패**로 본다(fail-closed).
 * 비밀이 없다고 통과시키면 누구나 결제 완료 노티를 위조해 후원을 만들 수 있다.
 */
export function verifyOngiWebhook(input: {
  timestamp: string | null | undefined;
  rawBody: string;
  signature: string | null | undefined;
  secret?: string;
  /** 재생 공격 방어용 허용 오차(초). 0 이면 시각 검사를 건너뛴다. */
  toleranceSec?: number;
  now?: Date;
}): { ok: boolean; reason?: string } {
  const secret = input.secret ?? env.payment.ongiWebhookSecret;
  if (!secret) return { ok: false, reason: 'ONGI_WEBHOOK_SECRET 미설정' };
  if (!input.signature) return { ok: false, reason: '서명 헤더 없음' };
  if (!input.timestamp) return { ok: false, reason: '타임스탬프 헤더 없음' };

  const tolerance = input.toleranceSec ?? 300;
  if (tolerance > 0) {
    // 초 단위 epoch 와 밀리초 단위 epoch 를 모두 허용한다.
    const raw = Number(input.timestamp);
    if (!Number.isFinite(raw)) return { ok: false, reason: '타임스탬프 형식 오류' };
    const ms = String(input.timestamp).trim().length >= 13 ? raw : raw * 1000;
    const now = (input.now ?? new Date()).getTime();
    if (Math.abs(now - ms) > tolerance * 1000) return { ok: false, reason: '타임스탬프 허용 범위 초과' };
  }

  const expected = ongiWebhookSignature(input.timestamp, input.rawBody, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(input.signature, 'utf8');
  // 길이가 다르면 timingSafeEqual 이 예외를 던지므로 먼저 확인한다.
  if (a.length !== b.length) return { ok: false, reason: '서명 불일치' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: '서명 불일치' };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface OngiResponse {
  /** 규격 확인 전까지 코드/메시지 필드명을 넓게 받는다. */
  code?: string;
  resultCode?: string;
  message?: string;
  resultMessage?: string;
  [key: string]: unknown;
}

/**
 * 온기 REST 호출.
 * 인증은 헤더 하나뿐이다. 본문에 서명·암호문을 넣지 않는다.
 */
async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: OngiResponse; latencyMs: number }> {
  const url = `${env.payment.ongiApiBase}${path}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = {
    'X-API-KEY': env.payment.ongiApiKey,
    Accept: 'application/json',
  };
  // 선택 헤더. 비어 있으면 붙이지 않는다(빈 값을 보내면 식별 실패로 거절될 수 있다).
  if (env.payment.ongiApiMid) headers['X-API-MID'] = env.payment.ongiApiMid;
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: OngiResponse = {};
    try {
      json = JSON.parse(text) as OngiResponse;
    } catch {
      json = { message: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, json, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 성공 판정.
 * HTTP 2xx 이면서 응답 코드가 성공값이거나 코드 필드가 아예 없을 때만 성공으로 본다.
 * (코드 필드 규격을 아직 받지 못해 넓게 받되, 명시적 실패 코드는 반드시 실패로 취급한다)
 */
function isSuccess(httpOk: boolean, json: OngiResponse): boolean {
  if (!httpOk) return false;
  const code = json.resultCode ?? json.code;
  if (code === undefined || code === null || code === '') return true;
  return String(code) === ONGI_SPEC.successCode;
}

function failure(json: OngiResponse, fallback: string): ProviderResult<never> {
  return {
    ok: false,
    code: String(json.resultCode ?? json.code ?? 'UNKNOWN'),
    message: String(json.resultMessage ?? json.message ?? fallback),
    raw: json as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// 연결 점검
// ---------------------------------------------------------------------------

/**
 * 가맹점 정보 조회로 연결과 API 키를 점검한다.
 * 결제 경로를 받기 전에도 인증이 통하는지 확인할 수 있는 유일한 호출이다.
 */
export async function ongiPing(): Promise<ProviderResult<{ status: number }>> {
  assertConfigured();
  const res = await request('GET', ONGI_SPEC.organizationPath);
  if (!isSuccess(res.ok, res.json)) return failure(res.json, '온기 연결 점검에 실패했습니다.');
  return { ok: true, data: { status: res.status }, raw: res.json as Record<string, unknown>, latencyMs: res.latencyMs };
}

// ---------------------------------------------------------------------------
// 어댑터
// ---------------------------------------------------------------------------

export const ongiPaymentAdapter: PaymentAdapter = {
  info(): AdapterInfo {
    const missing = requiredCredentials();
    return { provider: 'ongi', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  /**
   * 결제 URL 발급.
   *
   * 온기는 빌키(자동결제 키) 개념이 아니라 **건별 결제 URL** 방식이다.
   * 후원자가 그 URL 에서 결제를 마치면 온기가 결제 노티 웹훅을 보낸다.
   *
   * 경로를 받기 전까지는 호출하지 않는다.
   */
  async createRegistrationSession({ donorRef, returnUrl, notifyUrl, method = 'ACCOUNT' }): Promise<ProviderResult<RegistrationSession>> {
    assertConfigured();
    if (!ONGI_SPEC.paymentCreatePath) return missingSpec('결제 URL 발급');

    const res = await request('POST', ONGI_SPEC.paymentCreatePath, {
      merchantId: env.payment.ongiApiMid || undefined,
      orderNo: donorRef,
      returnUrl,
      notifyUrl,
      method,
    });

    if (!isSuccess(res.ok, res.json)) return failure(res.json, '온기 결제 URL 발급에 실패했습니다.');

    const paymentUrl = String(res.json.paymentUrl ?? res.json.payUrl ?? '');
    if (!paymentUrl) return { ok: false, code: 'NO_PAYMENT_URL', message: '결제 URL 이 응답에 없습니다.' };

    return {
      ok: true,
      data: {
        redirectUrl: paymentUrl,
        providerTid: String(res.json.paymentId ?? res.json.tid ?? donorRef),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 온기에는 "빌키 발급"에 해당하는 단계가 없다.
   * 결제 노티를 받아 결제 건을 확정하는 것이 등록에 해당하지만, 그 규격을 아직 받지 못했다.
   */
  async completeRegistration(): Promise<ProviderResult<RegistrationResult>> {
    assertConfigured();
    return missingSpec('결제 확정(빌키 상당)');
  },

  /**
   * 후원자에게 보낼 결제 링크를 발급한다.
   *
   * 헥토와 달리 **PIN 인증창이 아니라 결제 URL** 이다. 온기가 실제로 발급한 URL 이므로
   * mock 이 아니다(`mock: false`). 다만 경로를 받기 전에는 발급 자체가 불가능하므로
   * 가짜 URL 을 돌려주지 않고 실패를 반환한다.
   */
  async requestPinLink(
    donationId: string,
    amount: bigint,
    _phone: string,
    method: PaymentMethodKind = 'ACCOUNT',
  ): Promise<ProviderResult<PinLinkSession>> {
    assertConfigured();
    if (!ONGI_SPEC.paymentCreatePath) return missingSpec('결제 URL 발급');

    const res = await request('POST', ONGI_SPEC.paymentCreatePath, {
      merchantId: env.payment.ongiApiMid || undefined,
      orderNo: donationId,
      amount: amount.toString(),
      method,
    });

    if (!isSuccess(res.ok, res.json)) return failure(res.json, '온기 결제 링크 발급에 실패했습니다.');

    const payUrl = String(res.json.paymentUrl ?? res.json.payUrl ?? '');
    if (!payUrl) return { ok: false, code: 'NO_PAYMENT_URL', message: '결제 URL 이 응답에 없습니다.' };

    return {
      ok: true,
      data: {
        pinUrl: payUrl,
        sessionId: String(res.json.paymentId ?? res.json.tid ?? donationId),
        expiresAt: new Date(Date.now() + env.payment.pinTtlSec * 1000),
        // 온기가 실제로 발급한 결제 URL 이다. mock 이 아니다.
        mock: false,
      },
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 승인 확정.
   *
   * 온기는 우리가 출금을 지시하는 방식이 아니라, 후원자가 결제 URL 에서 결제한 뒤
   * **웹훅으로 결과가 오는** 방식이다. 그래서 approve() 는 출금을 일으키지 않고
   * 온기 서버에 결제 상태를 조회해 확정한다.
   */
  async approve(req: ApproveRequest): Promise<ProviderResult<ApproveResult>> {
    assertConfigured();
    if (!ONGI_SPEC.paymentInquirePath) return missingSpec('결제 조회');

    const res = await request('POST', ONGI_SPEC.paymentInquirePath, {
      merchantId: env.payment.ongiApiMid || undefined,
      orderNo: req.orderNo,
    });

    if (!res.ok) {
      // HTTP 오류는 결제 실패가 아니라 "불확실"이다. 상위가 inquire() 로 확정하게 예외를 던진다.
      throw new Error(`온기 결제 조회 HTTP 오류 (status=${res.status})`);
    }
    if (!isSuccess(res.ok, res.json)) return failure(res.json, '온기 결제 확인에 실패했습니다.');

    const paid = String(res.json.status ?? res.json.paymentStatus ?? '').toUpperCase();
    if (paid && !['PAID', 'APPROVED', 'DONE', 'COMPLETE', 'COMPLETED'].includes(paid)) {
      return { ok: false, code: paid, message: '아직 결제가 완료되지 않았습니다.', raw: res.json as Record<string, unknown> };
    }

    const approvedAtRaw = res.json.paidAt ?? res.json.approvedAt;
    const approvedAt = approvedAtRaw ? new Date(String(approvedAtRaw)) : new Date();

    return {
      ok: true,
      data: {
        providerTid: String(res.json.paymentId ?? res.json.tid ?? req.orderNo),
        approvedAt: Number.isNaN(approvedAt.getTime()) ? new Date() : approvedAt,
        amount: req.amount,
      },
      latencyMs: res.latencyMs,
    };
  },

  async inquire(orderNo): Promise<ProviderResult<{ status: InquiryStatus; providerTid?: string; amount?: bigint }>> {
    assertConfigured();
    if (!ONGI_SPEC.paymentInquirePath) {
      // 조회 경로가 없다고 FAILED 로 확정하면 실제로 결제된 건을 정산에서 누락시킨다.
      logger.warn('온기 결제 조회 경로 미확정 — 상태를 확정할 수 없습니다.', { orderNo });
      return {
        ok: true,
        data: { status: 'PENDING' },
        code: 'ONGI_SPEC_PENDING',
        message: '온기 결제 조회 API 경로 미확정 — 결제사 원장과 대사가 필요합니다.',
      };
    }

    const res = await request('POST', ONGI_SPEC.paymentInquirePath, {
      merchantId: env.payment.ongiApiMid || undefined,
      orderNo,
    });

    // 조회 자체가 실패하면 상태를 단정하지 않는다.
    if (!isSuccess(res.ok, res.json)) {
      if (res.status === 404) return { ok: true, data: { status: 'NOT_FOUND' }, raw: res.json as Record<string, unknown> };
      return { ok: true, data: { status: 'PENDING' }, raw: res.json as Record<string, unknown> };
    }

    const stat = String(res.json.status ?? res.json.paymentStatus ?? '').toUpperCase();
    const status: InquiryStatus =
      ['PAID', 'APPROVED', 'DONE', 'COMPLETE', 'COMPLETED'].includes(stat)
        ? 'APPROVED'
        : ['CANCELED', 'CANCELLED', 'REFUNDED'].includes(stat)
          ? 'CANCELED'
          : ['READY', 'PENDING', 'IN_PROGRESS'].includes(stat)
            ? 'PENDING'
            : stat === ''
              ? 'PENDING'
              : 'FAILED';

    const amountRaw = res.json.amount ?? res.json.payAmount;
    let amount: bigint | undefined;
    if (amountRaw !== undefined && amountRaw !== null && String(amountRaw) !== '') {
      try {
        amount = BigInt(String(amountRaw).replace(/[^\d]/g, ''));
      } catch {
        amount = undefined;
      }
    }

    return {
      ok: true,
      data: {
        status,
        providerTid: res.json.paymentId ? String(res.json.paymentId) : undefined,
        amount,
      },
      latencyMs: res.latencyMs,
    };
  },

  async cancel({ orderNo, providerTid, amount, reason }): Promise<ProviderResult<{ canceledAt: Date }>> {
    assertConfigured();
    if (!ONGI_SPEC.paymentCancelPath) return missingSpec('결제 취소');

    const res = await request('POST', ONGI_SPEC.paymentCancelPath, {
      merchantId: env.payment.ongiApiMid || undefined,
      orderNo,
      paymentId: providerTid,
      amount: amount.toString(),
      reason: reason ?? '후원 환불',
    });

    if (!isSuccess(res.ok, res.json)) return failure(res.json, '온기 결제 취소에 실패했습니다.');
    return { ok: true, data: { canceledAt: new Date() }, latencyMs: res.latencyMs };
  },

  /**
   * 온기는 빌키를 발급하지 않으므로 해지할 대상이 없다.
   * 상위 흐름(결제수단 해지)이 이 어댑터에서 호출하면 조용히 성공시키지 않고 사실을 알린다.
   */
  async revokeBillKey(): Promise<ProviderResult<{ revokedAt: Date }>> {
    assertConfigured();
    return {
      ok: false,
      code: 'NO_BILLKEY',
      message: '온기는 빌키를 발급하지 않습니다(건별 결제 URL 방식). 해지할 대상이 없습니다.',
    };
  },
};
