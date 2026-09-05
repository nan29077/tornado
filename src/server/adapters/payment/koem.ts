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
 * 코엠페이먼츠 카드 빌키결제(DIRECTPAY v1.1) 어댑터.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **checkHash 재료가 동작마다 다르다.** 하나의 공식으로 통일할 수 없다.
 *
 *   빌키 발급  : mid + card_no + reqdt + reqtm
 *   빌키 결제  : mid + orderno + orderdt + ordertm + buy_reqamt + bill_key
 *   빌키 취소  : tid + mid + cancel_amt
 *   빌키 해지  : mid + bill_key
 *
 * 전부 Base64(HMAC-SHA256(key=API_KEY, message)) 다.
 * 재료를 하나라도 섞으면 인증 실패하므로 동작별 함수를 따로 두고 각각 테스트한다.
 *
 * **필드 이름의 대소문자도 동작마다 다르다.**
 *   발급·결제 : `checkHash` (대문자 H)
 *   취소·해지 : `checkhash` (전부 소문자)
 * 규격서에 그렇게 되어 있다. 통일하면 거절당한다.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 화이트리스트 방식
 * -----------------
 * 코엠은 가맹점 서버의 공인 IP 를 PG 방화벽에 등록하는 방식이다. 결제창(호스팅 페이지)이
 * 없으므로 카드번호를 우리 화면에서 받아 우리 서버가 코엠으로 보낸다.
 *
 * 카드번호 취급 원칙 (PCI-DSS)
 * ----------------------------
 * 카드번호·유효기간·비밀번호·생년월일은 **저장하지 않고 로그에도 남기지 않는다.**
 *  - 요청 본문을 로그로 출력하지 않는다.
 *  - 응답에 카드 관련 필드가 echo 되어도 scrubCardFields() 로 지운 뒤 반환한다.
 *  - 반환값에는 발급사명과 끝 4자리만 담는다.
 *  - 이 어댑터를 호출하는 화면·액션도 같은 원칙을 지켜야 한다.
 */

/** 연동규격서와 대조해야 하는 값 모음. */
export const KOEM_SPEC = {
  /** 빌키 발급 */
  billKeyRegisterPath: '/api/cc/billkey/register',
  /** 빌키 결제(승인) */
  billKeyApprovePath: '/api/cc/billkey/approv',
  /** 빌키 결제 취소 */
  cancelPath: '/api/cc/approv/cancel',
  /** 빌키 해지 */
  billKeyUnregisterPath: '/api/cc/billkey/unregister',
  /** 성공 응답 코드 */
  successCode: '0000',
  /** 취소 요청의 결제수단 구분값 */
  cancelPayMethod: 'CC',
} as const;

/**
 * 규격서에 없어 확정하지 못한 것
 *
 *  1. **거래결과조회(조회) API** — 경로가 규격서에 없다.
 *     inquire() 는 상태를 단정하지 않고 항상 PENDING 을 돌려준다. 그래야 승인 응답이
 *     유실된 건을 "실패"로 확정해 정산에서 누락시키는 사고를 막는다.
 *     조회 API 경로를 받는 즉시 실제 구현으로 교체해야 한다.
 */

const TIMEOUT_MS = 20_000;

/** 할부 개월 기본값. '00' = 일시불. */
const DEFAULT_QUOTA_MONTHS = '00';
/** 과세 여부 기본값. */
const DEFAULT_TAX_YN = 'Y';

function requiredCredentials(): string[] {
  const missing: string[] = [];
  if (!env.payment.koemMid) missing.push('KOEM_MID');
  if (!env.payment.koemApiKey) missing.push('KOEM_API_KEY');
  if (!env.payment.koemApiBase) missing.push('KOEM_API_BASE');
  return missing;
}

function assertConfigured(): void {
  const missing = requiredCredentials();
  if (missing.length > 0) throw new AdapterNotConfiguredError('koem', missing);
}

// ---------------------------------------------------------------------------
// 서명
// ---------------------------------------------------------------------------

/** yyyyMMdd (KST) */
export function koemDate(at: Date): string {
  const kst = new Date(at.getTime() + 9 * 3600_000);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

/** HHmmss (KST) */
export function koemTime(at: Date): string {
  const kst = new Date(at.getTime() + 9 * 3600_000);
  return kst.toISOString().slice(11, 19).replace(/:/g, '');
}

/** Base64(HMAC-SHA256(key=API_KEY, message)) — 모든 checkHash 의 공통 계산부. */
function hmacBase64(message: string, apiKey: string): string {
  return crypto.createHmac('sha256', apiKey).update(message, 'utf8').digest('base64');
}

/** 빌키 발급 서명: mid + card_no + reqdt + reqtm */
export function koemRegisterHash(
  input: { mid: string; cardNo: string; reqdt: string; reqtm: string },
  apiKey = env.payment.koemApiKey,
): string {
  return hmacBase64(`${input.mid}${input.cardNo}${input.reqdt}${input.reqtm}`, apiKey);
}

/** 빌키 결제 서명: mid + orderno + orderdt + ordertm + buy_reqamt + bill_key */
export function koemApproveHash(
  input: {
    mid: string;
    orderno: string;
    orderdt: string;
    ordertm: string;
    buyReqamt: string;
    billKey: string;
  },
  apiKey = env.payment.koemApiKey,
): string {
  return hmacBase64(
    `${input.mid}${input.orderno}${input.orderdt}${input.ordertm}${input.buyReqamt}${input.billKey}`,
    apiKey,
  );
}

/** 빌키 취소 서명: tid + mid + cancel_amt */
export function koemCancelHash(
  input: { tid: string; mid: string; cancelAmt: string },
  apiKey = env.payment.koemApiKey,
): string {
  return hmacBase64(`${input.tid}${input.mid}${input.cancelAmt}`, apiKey);
}

/** 빌키 해지 서명: mid + bill_key */
export function koemUnregisterHash(
  input: { mid: string; billKey: string },
  apiKey = env.payment.koemApiKey,
): string {
  return hmacBase64(`${input.mid}${input.billKey}`, apiKey);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface KoemResponse {
  result_code?: string;
  result_msg?: string;
  /** 매입/발급사 단계 결과 */
  dresult_code?: string;
  dresult_msg?: string;
  [key: string]: unknown;
}

/** 로그·감사에 남기면 안 되는 카드 관련 필드. 응답에 echo 되어도 지운다. */
const CARD_FIELDS = [
  'card_no',
  'cardno',
  'card_ym',
  'cardym',
  'card_pw',
  'card_password',
  'card_ssn',
  'auth_value',
  'birth_day',
];

function isCardField(key: string): boolean {
  return CARD_FIELDS.includes(key.toLowerCase());
}

function scrubCardFields(json: KoemResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    out[k] = isCardField(k) ? '[제거됨]' : v;
  }
  return out;
}

/**
 * 코엠 REST 호출.
 *
 * **요청 본문은 절대 로그로 출력하지 않는다.** 빌키 발급 요청에는 카드번호가 들어 있다.
 */
async function postJson(path: string, body: Record<string, unknown>): Promise<{
  ok: boolean;
  status: number;
  json: KoemResponse;
  latencyMs: number;
}> {
  const url = `${env.payment.koemApiBase}${path}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: KoemResponse = {};
    try {
      json = JSON.parse(text) as KoemResponse;
    } catch {
      json = { result_msg: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, json, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 코엠 응답이 성공인지 판정한다. result_code 가 '0000' 이 아니면 절대 성공이 아니다. */
function isSuccess(json: KoemResponse): boolean {
  return json.result_code === KOEM_SPEC.successCode;
}

function failure(json: KoemResponse, fallback: string): ProviderResult<never> {
  // 발급사 단계 오류(dresult_*)가 있으면 그쪽이 더 구체적이므로 함께 보여 준다.
  const detail = json.dresult_msg ? ` (${json.dresult_code}: ${json.dresult_msg})` : '';
  return {
    ok: false,
    code: String(json.result_code ?? json.dresult_code ?? 'UNKNOWN'),
    message: `${String(json.result_msg ?? fallback)}${detail}`,
    raw: scrubCardFields(json),
  };
}

// ---------------------------------------------------------------------------
// 빌키 발급 (인터페이스 밖의 전용 진입점)
// ---------------------------------------------------------------------------

export interface KoemCardRegisterInput {
  /** 카드번호(숫자만). 저장 금지 — 이 함수 밖으로 나가지 않는다. */
  cardNo: string;
  /** 유효기간 YYMM */
  cardYm: string;
  /** 구매자명 (필수) */
  buyerNm: string;
  /** 카드 비밀번호 앞 2자리 (선택) */
  cardPw?: string;
  /** 생년월일 6자리 또는 사업자번호 10자리 (선택) */
  cardSsn?: string;

  /**
   * 발급과 동시에 결제할지 여부.
   * true 면 아래 결제 관련 항목이 모두 필요하다.
   */
  payNow?: boolean;
  orderNo?: string;
  itemName?: string;
  amount?: bigint;
  /** 할부 개월. '00' = 일시불 */
  quotaMonths?: string;
  taxYn?: string;
}

/**
 * 카드 빌키 발급 (pay_yn = N 이면 발급만, Y 면 발급과 동시에 결제).
 *
 * PaymentAdapter 인터페이스에는 "카드번호를 받아 빌키를 만든다"는 모양이 없다.
 * (헥토는 결제창이 카드/계좌 정보를 대신 받는다)
 * 인터페이스를 바꾸지 않기 위해 전용 함수로 분리한다.
 *
 * **이 함수를 호출하는 경로는 PCI-DSS 범위에 들어간다.**
 * 카드번호를 서버 로그·DB·세션 어디에도 남기지 않아야 한다.
 */
export async function koemRegisterBillKey(
  input: KoemCardRegisterInput,
): Promise<ProviderResult<RegistrationResult>> {
  assertConfigured();

  const cardNo = input.cardNo.replace(/\D/g, '');
  const cardYm = input.cardYm.replace(/\D/g, '');
  if (!cardNo || !cardYm) {
    return { ok: false, code: 'NO_CARD_INPUT', message: '카드번호와 유효기간이 필요합니다.' };
  }
  if (!input.buyerNm?.trim()) {
    return { ok: false, code: 'NO_BUYER_NAME', message: '구매자명이 필요합니다.' };
  }

  const now = new Date();
  const reqdt = koemDate(now);
  const reqtm = koemTime(now);
  const payNow = input.payNow === true;

  if (payNow && (!input.orderNo || !input.itemName || input.amount === undefined)) {
    return {
      ok: false,
      code: 'MISSING_PAYMENT_FIELDS',
      message: '발급과 동시에 결제하려면 주문번호·상품명·금액이 모두 필요합니다.',
    };
  }

  const body: Record<string, unknown> = {
    mid: env.payment.koemMid,
    card_no: cardNo,
    card_ym: cardYm,
    buyer_nm: input.buyerNm.trim(),
    pay_yn: payNow ? 'Y' : 'N',
    reqdt,
    reqtm,
    tax_yn: input.taxYn ?? DEFAULT_TAX_YN,
    // 서명 재료: mid + card_no + reqdt + reqtm (결제 필드가 들어가지 않는다)
    checkHash: koemRegisterHash({ mid: env.payment.koemMid, cardNo, reqdt, reqtm }),
  };
  if (input.cardPw) body.card_pw = input.cardPw.replace(/\D/g, '');
  if (input.cardSsn) body.card_ssn = input.cardSsn.replace(/\D/g, '');

  if (payNow) {
    body.orderno = input.orderNo;
    body.orderdt = reqdt;
    body.ordertm = reqtm;
    body.buy_itemnm = input.itemName;
    body.buy_reqamt = input.amount!.toString();
    body.quota_months = input.quotaMonths ?? DEFAULT_QUOTA_MONTHS;
  }

  const res = await postJson(KOEM_SPEC.billKeyRegisterPath, body);

  if (!isSuccess(res.json)) return failure(res.json, '카드 빌키 발급에 실패했습니다.');

  const billKey = String(res.json.bill_key ?? '');
  if (!billKey) return { ok: false, code: 'NO_BILLKEY', message: '빌키가 응답에 없습니다.' };

  return {
    ok: true,
    data: {
      providerTid: String(res.json.tid ?? input.orderNo ?? billKey),
      billKey,
      method: 'CARD',
      // 발급사명. 규격서 응답 필드는 issue_name 이다.
      cardIssuer: res.json.issue_name ? String(res.json.issue_name) : undefined,
      // 카드번호 원문은 저장하지 않는다. 우리가 받은 입력의 끝 4자리만 남긴다.
      cardTail4: cardNo.slice(-4) || undefined,
    },
    raw: scrubCardFields(res.json),
    latencyMs: res.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// 어댑터
// ---------------------------------------------------------------------------

export const koemPaymentAdapter: PaymentAdapter = {
  info(): AdapterInfo {
    const missing = requiredCredentials();
    return { provider: 'koem', mode: missing.length > 0 ? 'mock' : 'live', missingCredentials: missing };
  },

  /**
   * 코엠 DIRECTPAY 에는 호스팅 결제창이 없다(화이트리스트 방식).
   * 카드 입력 화면에서 completeRegistration() 또는 koemRegisterBillKey() 를 직접 호출한다.
   */
  async createRegistrationSession({ method = 'CARD' }): Promise<ProviderResult<RegistrationSession>> {
    assertConfigured();
    return {
      ok: false,
      code: 'NO_HOSTED_WINDOW',
      message:
        method === 'ACCOUNT'
          ? '코엠은 카드 빌키 전용입니다. 내통장결제는 헥토를 사용하십시오.'
          : '코엠 카드 빌키는 결제창이 없습니다. 카드 입력 화면에서 직접 발급해야 합니다.',
    };
  },

  /**
   * 카드 빌키 발급.
   * 카드 입력 화면이 넘긴 payload 로 발급한다. 카드번호가 없으면 통신 전에 실패한다.
   */
  async completeRegistration(payload): Promise<ProviderResult<RegistrationResult>> {
    assertConfigured();

    const cardNo = String(payload.card_no ?? payload.cardNo ?? '');
    const cardYm = String(payload.card_ym ?? payload.cardYm ?? '');
    const buyerNm = String(payload.buyer_nm ?? payload.buyerNm ?? '');

    if (!cardNo.replace(/\D/g, '') || !cardYm.replace(/\D/g, '')) {
      return {
        ok: false,
        code: 'NO_CARD_INPUT',
        message: '카드번호와 유효기간이 필요합니다. (코엠 빌키 발급은 카드정보를 직접 받습니다)',
      };
    }

    return koemRegisterBillKey({
      cardNo,
      cardYm,
      buyerNm,
      cardPw: payload.card_pw ? String(payload.card_pw) : undefined,
      cardSsn: payload.card_ssn ? String(payload.card_ssn) : undefined,
      // 등록 단계에서는 결제하지 않는다(pay_yn = N).
      payNow: false,
    });
  },

  /**
   * 코엠 카드 빌키에는 PIN 인증 단계가 없다. 등록된 빌키로 바로 승인한다.
   * mock PIN 을 돌려주면 존재하지 않는 인증을 통과한 것처럼 보이므로 실패를 반환한다.
   */
  async requestPinLink(
    donationId: string,
    amount: bigint,
    _phone: string,
    method: PaymentMethodKind = 'CARD',
  ): Promise<ProviderResult<PinLinkSession>> {
    assertConfigured();
    // 전화번호는 남기지 않는다(개인정보). 어떤 거래가 이 경로로 왔는지만 남긴다.
    logger.warn('코엠 카드 빌키에는 PIN 인증 단계가 없습니다. 승인 전 분기 구현이 필요합니다.', {
      donationId,
      amount: amount.toString(),
      method,
    });
    return {
      ok: false,
      code: 'PIN_NOT_SUPPORTED',
      message: '코엠 카드 빌키는 PIN 인증을 사용하지 않습니다. 카드 결제 흐름을 별도로 구성해야 합니다.',
    };
  },

  /**
   * 빌키 승인(즉시 청구).
   * 서명 재료: mid + orderno + orderdt + ordertm + buy_reqamt + bill_key
   */
  async approve(req: ApproveRequest): Promise<ProviderResult<ApproveResult>> {
    assertConfigured();

    const now = new Date();
    const orderdt = koemDate(now);
    const ordertm = koemTime(now);
    const buyReqamt = req.amount.toString();

    const res = await postJson(KOEM_SPEC.billKeyApprovePath, {
      mid: env.payment.koemMid,
      bill_key: req.billKey,
      buy_itemnm: req.productName,
      buy_reqamt: buyReqamt,
      // 규격서상 필수. 비어 있으면 거절되므로 빈 문자열을 보내지 않는다.
      buyer_nm: req.buyerName?.trim() || '후원자',
      orderno: req.orderNo,
      orderdt,
      ordertm,
      quota_months: DEFAULT_QUOTA_MONTHS,
      tax_yn: DEFAULT_TAX_YN,
      checkHash: koemApproveHash({
        mid: env.payment.koemMid,
        orderno: req.orderNo,
        orderdt,
        ordertm,
        buyReqamt,
        billKey: req.billKey,
      }),
    });

    if (!res.ok) {
      // 실제로는 승인됐는데 실패로 확정하면 크리에이터가 그 금액을 영영 못 받는다.
      // 조회 API 가 없으므로 inquire() 는 PENDING 만 돌려주고, 정리 배치가 재시도한다.
      throw new Error(`코엠 승인 API HTTP 오류 (status=${res.status})`);
    }
    if (!isSuccess(res.json)) return failure(res.json, '카드 결제 승인에 실패했습니다.');

    return {
      ok: true,
      data: {
        providerTid: String(res.json.tid ?? req.orderNo),
        approvedAt: now,
        amount: req.amount,
      },
      raw: scrubCardFields(res.json),
      latencyMs: res.latencyMs,
    };
  },

  /**
   * 거래결과조회. **규격서에 해당 API 가 없어 구현하지 못했다.**
   *
   * 상태를 모르면서 FAILED 나 NOT_FOUND 를 돌려주면 승인된 거래를 실패로 확정해
   * 정산에서 누락시킨다. 그래서 항상 PENDING 을 돌려준다.
   */
  async inquire(orderNo): Promise<ProviderResult<{ status: InquiryStatus; providerTid?: string; amount?: bigint }>> {
    assertConfigured();
    logger.warn('코엠 거래결과조회 API 가 규격서에 없어 상태를 확정할 수 없습니다. 수동 대사가 필요합니다.', {
      orderNo,
    });
    return {
      ok: true,
      data: { status: 'PENDING' },
      code: 'INQUIRY_NOT_IMPLEMENTED',
      message: '코엠 거래결과조회 API 미구현 — 결제사 원장과 대사가 필요합니다.',
    };
  },

  /**
   * 빌키 결제 취소.
   * 서명 재료: tid + mid + cancel_amt / 필드명은 소문자 `checkhash`.
   */
  async cancel({ providerTid, amount }): Promise<ProviderResult<{ canceledAt: Date }>> {
    assertConfigured();

    const cancelAmt = amount.toString();
    const res = await postJson(KOEM_SPEC.cancelPath, {
      mid: env.payment.koemMid,
      pay_method: KOEM_SPEC.cancelPayMethod,
      tid: providerTid,
      cancel_amt: cancelAmt,
      tax_yn: DEFAULT_TAX_YN,
      // 규격서상 이 요청만 소문자다. 대문자로 보내면 거절된다.
      checkhash: koemCancelHash({ tid: providerTid, mid: env.payment.koemMid, cancelAmt }),
    });

    if (!isSuccess(res.json)) return failure(res.json, '카드 결제 취소에 실패했습니다.');
    return { ok: true, data: { canceledAt: new Date() }, raw: scrubCardFields(res.json), latencyMs: res.latencyMs };
  },

  /**
   * 빌키 해지.
   * 서명 재료: mid + bill_key / 필드명은 소문자 `checkhash`.
   */
  async revokeBillKey(billKey): Promise<ProviderResult<{ revokedAt: Date }>> {
    assertConfigured();

    const res = await postJson(KOEM_SPEC.billKeyUnregisterPath, {
      mid: env.payment.koemMid,
      bill_key: billKey,
      checkhash: koemUnregisterHash({ mid: env.payment.koemMid, billKey }),
    });

    if (!isSuccess(res.json)) {
      logger.warn('코엠 빌키 해지 실패', { code: res.json.result_code, message: res.json.result_msg });
      return failure(res.json, '빌키 해지에 실패했습니다.');
    }
    return { ok: true, data: { revokedAt: new Date() }, raw: scrubCardFields(res.json), latencyMs: res.latencyMs };
  },
};
