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
 * 카카오페이 정기결제(빌키) 어댑터.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **카카오페이 계약 후 CID 환경변수(KAKAO_CID) 설정 필요.**
 * 계약 전에는 환경변수 미설정으로 모든 호출이 AdapterNotConfiguredError 를 반환한다.
 *
 * 정기결제 흐름 (서버 to 서버)
 *   1) 빌키 발급 요청 (최초 결제 포함)  → billKeyRegisterPath
 *   2) 빌키로 정기 결제                  → billKeyApprovePath
 *   3) 빌키 해지                         → billKeyUnregisterPath
 *   4) 주문 조회                         → orderInquiryPath
 *   5) 결제 취소                         → cancelPath
 *
 * 인증 방식
 *   Authorization: SECRET_KEY ${KAKAO_SECRET_KEY}
 *   Content-Type:  application/json
 *
 * 카드번호 취급
 *   카카오페이는 카드정보를 카카오 자체 UI 에서 처리한다.
 *   우리 서버에는 카드번호가 오지 않으므로 PAN 스크럽이 불필요하다.
 *
 * 웹훅
 *   정기결제는 서버 to 서버 호출 방식이라 결제 완료 웹훅이 없다.
 *   콜백 URL 을 지정해 결제 결과를 받거나, 주문 조회 API 로 상태를 확인한다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 연동규격서와 대조해야 하는 API 경로 모음. */
export const KAKAO_SPEC = {
  /** 빌키 발급 요청 (최초 결제 포함) */
  billKeyRegisterPath: 'https://open-api.kakaopay.com/online/v1/payment/subscription/register',
  /** 빌키 정기 결제(승인) */
  billKeyApprovePath: 'https://open-api.kakaopay.com/online/v1/payment/subscription',
  /** 빌키 해지 */
  billKeyUnregisterPath: 'https://open-api.kakaopay.com/online/v1/payment/subscription/sid',
  /** 주문 조회 */
  orderInquiryPath: 'https://open-api.kakaopay.com/online/v1/payment/order',
  /** 결제 취소 */
  cancelPath: 'https://open-api.kakaopay.com/online/v1/payment/cancel',
} as const;

const TIMEOUT_MS = 20_000;

export interface KakaoResponse {
  aid?: string;
  tid?: string;
  sid?: string;
  cid?: string;
  status?: string;
  error_code?: string;
  error_message?: string;
  extras?: { method_result_code?: string; method_result_message?: string };
  [key: string]: unknown;
}

function requiredCredentials(): string[] {
  const missing: string[] = [];
  if (!env.payment.kakaoSecretKey) missing.push('KAKAO_SECRET_KEY');
  if (!env.payment.kakaoCid) missing.push('KAKAO_CID');
  return missing;
}

function assertConfigured(): void {
  const missing = requiredCredentials();
  if (missing.length > 0) throw new AdapterNotConfiguredError('kakao', missing);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: KakaoResponse; latencyMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SECRET_KEY ${env.payment.kakaoSecretKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: KakaoResponse = {};
    try {
      json = JSON.parse(text) as KakaoResponse;
    } catch {
      json = { error_message: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, json, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function isSuccess(json: KakaoResponse): boolean {
  return !json.error_code;
}

function failure(json: KakaoResponse, fallback: string): ProviderResult<never> {
  const detail = json.extras?.method_result_message
    ? ` (${json.extras.method_result_code}: ${json.extras.method_result_message})`
    : '';
  return {
    ok: false,
    code: String(json.error_code ?? 'UNKNOWN'),
    message: `${String(json.error_message ?? fallback)}${detail}`,
    raw: json as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// 어댑터
// ---------------------------------------------------------------------------

export const kakaoPaymentAdapter: PaymentAdapter = {
  info(): AdapterInfo {
    const missing = requiredCredentials();
    return { provider: 'kakao', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  /**
   * 카카오페이 빌키 발급 세션 생성.
   *
   * 카카오페이 정기결제는 최초 결제 시 빌키를 동시에 발급받는 방식이다.
   * 빌키 발급 요청에는 redirect_url 이 필요하므로 세션을 먼저 만들어 반환한다.
   *
   * CARD / ACCOUNT 둘 다 지원한다. 카카오페이는 한 빌키로 카카오머니·카드·계좌 모두 연결되며
   * 결제수단 선택은 카카오 앱 UI 에서 이루어진다.
   */
  async createRegistrationSession({
    donorRef,
    returnUrl,
    notifyUrl,
    method = 'ACCOUNT',
  }): Promise<ProviderResult<RegistrationSession>> {
    assertConfigured();

    // partner_order_id 를 donorRef(= PaymentRegistration.id) 와 동일하게 고정한다.
    // 타임스탬프를 붙이면 approval 단계에서 재현이 불가능해진다(저장하지 않으므로).
    const orderNo = donorRef;
    const res = await postJson(KAKAO_SPEC.billKeyRegisterPath, {
      cid: env.payment.kakaoCid,
      partner_order_id: orderNo,
      partner_user_id: donorRef,
      item_name: '후원 결제수단 등록',
      quantity: 1,
      total_amount: 0,
      tax_free_amount: 0,
      approval_url: returnUrl,
      cancel_url: returnUrl,
      fail_url: returnUrl,
      open_type: method === 'CARD' ? 'REDIRECT' : 'REDIRECT',
    });

    if (!res.ok || !isSuccess(res.json)) return failure(res.json, '카카오페이 빌키 발급 세션 생성에 실패했습니다.');

    const redirectUrl = String(res.json.next_redirect_pc_url ?? res.json.next_redirect_mobile_url ?? '');
    const tid = String(res.json.tid ?? '');
    if (!redirectUrl || !tid) {
      return { ok: false, code: 'NO_REDIRECT', message: '카카오페이 응답에 redirect_url 또는 tid 가 없습니다.' };
    }

    return {
      ok: true,
      data: {
        redirectUrl,
        providerTid: tid,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
      raw: res.json as Record<string, unknown>,
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 빌키 발급 완료 처리.
   *
   * 카카오 앱에서 결제수단 선택이 완료되면 approval_url 로 pg_token 이 전달된다.
   * 그 pg_token 과 최초 발급 요청의 tid 로 승인을 요청하면 sid(빌키)가 발급된다.
   */
  async completeRegistration(payload): Promise<ProviderResult<RegistrationResult>> {
    assertConfigured();

    const pgToken = String(payload.pg_token ?? '');
    const tid = String(payload.tid ?? '');
    // registrationId(= PaymentRegistration.id = startRegistration 의 donorRef) 를 서비스 레이어가
    // 주입한다. partner_order_id 와 partner_user_id 는 ready 요청 때 donorRef 와 동일하게 고정했으므로
    // 이 값으로 재현한다. payload.partner_order_id / partner_user_id 를 클라이언트에서 받지 않는다.
    const registrationId = String(payload.registrationId ?? payload.partner_order_id ?? '');

    if (!pgToken || !tid) {
      return {
        ok: false,
        code: 'NO_PG_TOKEN',
        message: 'pg_token 또는 tid 가 없습니다. 카카오페이 빌키 승인에 필요합니다.',
      };
    }
    if (!registrationId) {
      return {
        ok: false,
        code: 'NO_REGISTRATION_ID',
        message: 'registrationId 가 없습니다. partner_order_id / partner_user_id 를 재현할 수 없습니다.',
      };
    }

    // 빌키 발급 승인: billKeyApprovePath (/online/v1/payment/subscription)
    // (billKeyRegisterPath 는 ready 전용이므로 여기서 쓰면 전건 실패한다)
    const res = await postJson(KAKAO_SPEC.billKeyApprovePath, {
      cid: env.payment.kakaoCid,
      tid,
      partner_order_id: registrationId,
      partner_user_id: registrationId,
      pg_token: pgToken,
    });

    if (!res.ok || !isSuccess(res.json)) return failure(res.json, '카카오페이 빌키 발급 완료에 실패했습니다.');

    const sid = String(res.json.sid ?? '');
    if (!sid) return { ok: false, code: 'NO_SID', message: '카카오페이 응답에 sid(빌키)가 없습니다.' };

    return {
      ok: true,
      data: {
        providerTid: tid,
        billKey: sid,
        method: 'CARD',
      },
      raw: res.json as Record<string, unknown>,
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 카카오페이 정기결제는 서버 to 서버 방식이라 PIN 인증 링크가 없다.
   * 빌키가 있으면 바로 approve() 로 승인한다.
   */
  async requestPinLink(
    donationId: string,
    amount: bigint,
    _phone: string,
    method: PaymentMethodKind = 'CARD',
  ): Promise<ProviderResult<PinLinkSession>> {
    assertConfigured();
    logger.warn('카카오페이 정기결제는 PIN 인증 단계가 없습니다. 빌키로 바로 승인(approve)해야 합니다.', {
      donationId,
      amount: amount.toString(),
      method,
    });
    return {
      ok: false,
      code: 'PIN_NOT_SUPPORTED',
      message: '카카오페이 정기결제는 PIN 인증을 사용하지 않습니다. 빌키 승인(approve) 흐름을 사용하십시오.',
    };
  },

  /**
   * 빌키 정기 결제(승인).
   *
   * 카카오페이 계약 후 CID 환경변수 설정 필요.
   */
  async approve(req: ApproveRequest): Promise<ProviderResult<ApproveResult>> {
    assertConfigured();

    const now = new Date();
    const res = await postJson(KAKAO_SPEC.billKeyApprovePath, {
      cid: env.payment.kakaoCid,
      sid: req.billKey,
      partner_order_id: req.orderNo,
      partner_user_id: req.buyerName ?? 'donor',
      item_name: req.productName,
      quantity: 1,
      total_amount: Number(req.amount),
      tax_free_amount: 0,
    });

    if (!res.ok || !isSuccess(res.json)) return failure(res.json, '카카오페이 정기결제 승인에 실패했습니다.');

    return {
      ok: true,
      data: {
        providerTid: String(res.json.tid ?? res.json.aid ?? req.orderNo),
        approvedAt: now,
        amount: req.amount,
      },
      raw: res.json as Record<string, unknown>,
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 주문 조회로 거래 상태를 확인한다.
   */
  async inquire(
    orderNo: string,
  ): Promise<ProviderResult<{ status: InquiryStatus; providerTid?: string; amount?: bigint }>> {
    assertConfigured();

    const res = await postJson(KAKAO_SPEC.orderInquiryPath, {
      cid: env.payment.kakaoCid,
      tid: orderNo,
    });

    if (!res.ok || !isSuccess(res.json)) return failure(res.json, '카카오페이 주문 조회에 실패했습니다.');

    const status = String(res.json.status ?? '');
    let inquiryStatus: InquiryStatus;
    switch (status) {
      case 'SUCCESS_PAYMENT':
        inquiryStatus = 'APPROVED';
        break;
      case 'CANCEL_PAYMENT':
        inquiryStatus = 'CANCELED';
        break;
      case 'FAIL_PAYMENT':
        inquiryStatus = 'FAILED';
        break;
      default:
        inquiryStatus = 'PENDING';
    }

    return {
      ok: true,
      data: {
        status: inquiryStatus,
        providerTid: String(res.json.tid ?? orderNo),
        amount: res.json.amount != null ? BigInt(Number(res.json.amount)) : undefined,
      },
      raw: res.json as Record<string, unknown>,
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 결제 취소.
   */
  async cancel({ providerTid, amount }): Promise<ProviderResult<{ canceledAt: Date }>> {
    assertConfigured();

    const res = await postJson(KAKAO_SPEC.cancelPath, {
      cid: env.payment.kakaoCid,
      tid: providerTid,
      cancel_amount: Number(amount),
      cancel_tax_free_amount: 0,
    });

    if (!res.ok || !isSuccess(res.json)) return failure(res.json, '카카오페이 결제 취소에 실패했습니다.');

    return {
      ok: true,
      data: { canceledAt: new Date() },
      raw: res.json as Record<string, unknown>,
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 빌키(SID) 해지.
   *
   * 카카오페이 계약 후 CID 환경변수 설정 필요.
   */
  async revokeBillKey(billKey: string): Promise<ProviderResult<{ revokedAt: Date }>> {
    assertConfigured();

    const res = await postJson(KAKAO_SPEC.billKeyUnregisterPath, {
      cid: env.payment.kakaoCid,
      sid: billKey,
    });

    if (!res.ok || !isSuccess(res.json)) {
      logger.warn('카카오페이 빌키 해지 실패', {
        code: res.json.error_code,
        message: res.json.error_message,
      });
      return failure(res.json, '카카오페이 빌키 해지에 실패했습니다.');
    }

    return {
      ok: true,
      data: { revokedAt: new Date() },
      raw: res.json as Record<string, unknown>,
      latencyMs: res.latencyMs,
    };
  },
};
