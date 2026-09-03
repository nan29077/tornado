import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { formatNumber } from '@/lib/money';

/**
 * MT 문자 템플릿.
 * - 이모지를 사용하지 않는다.
 * - 최초 문자가 후원 처리되지 않았음을 명확히 고지한다.
 * - 보안 링크 원문은 로그/DB 본문에 남기지 않고 마스킹해 저장한다.
 */

export const MT_TEMPLATE = {
  REGISTER_GUIDE: 'REGISTER_GUIDE',
  CONFIRM_PAYMENT: 'CONFIRM_PAYMENT',
  PIN_REQUEST: 'PIN_REQUEST',
  DONATION_SUCCESS: 'DONATION_SUCCESS',
  DONATION_FAILED: 'DONATION_FAILED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  LIMIT_BLOCKED: 'LIMIT_BLOCKED',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  REFUND_DONE: 'REFUND_DONE',
  UNKNOWN_ROUTE: 'UNKNOWN_ROUTE',
  /** 후원내역 확인(비회원 조회) 인증번호 */
  LOOKUP_VERIFY: 'LOOKUP_VERIFY',
  /** 마이페이지 휴대폰 번호 연결 인증번호 */
  PHONE_LINK_VERIFY: 'PHONE_LINK_VERIFY',
  /** 후원샵 PC 웹 결제 인증번호 */
  PAYMENT_VERIFY: 'PAYMENT_VERIFY',
} as const;

export type MtTemplateCode = (typeof MT_TEMPLATE)[keyof typeof MT_TEMPLATE];

export interface TemplateOutput {
  code: MtTemplateCode;
  text: string;
  /** DB/로그 저장용. 링크 토큰을 제거한 본문 */
  masked: string;
  /**
   * 관리자 커스텀 본문(MtMessageTemplate)에 치환해 넣을 값.
   *
   * 이 값이 있는 템플릿만 관리자 화면에서 본문을 바꿀 수 있다.
   * 보안링크가 들어가는 본문(등록 안내/결제 확인/PIN 요청)도 `{보안링크}` 치환자로 넘기되,
   * 저장 단계에서 그 치환자가 빠지면 거부한다(validateMtTemplateBody).
   * 크리에이터가 직접 설정한 감사 문자만 vars 를 두지 않아 오버라이드 대상에서 빠진다.
   */
  vars?: Record<string, string>;
  /**
   * 관리자가 무슨 문구를 쓰든 **반드시 본문 앞에 남아야 하는 표시.**
   * 지금은 mock 결제 표시(`[MOCK]`) 하나뿐이다. 이 표시가 사라지면 연동 시험용 문자를
   * 실제 결제로 오인한다.
   */
  forcedTag?: string;
}

function withLink(body: string, link: string): TemplateOutput['text'] {
  return `${body} ${link}`;
}

function maskLink(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/g, '[보안링크]');
}

/**
 * 최초 1회 결제수단 등록 안내.
 *
 * 계좌(내통장결제)와 카드 빌링키 모두 같은 흐름을 쓴다. 안내 문구만 결제수단에 맞춰 바뀐다.
 * 카드는 아직 실 연동 전이라 현재 호출부는 모두 기본값(ACCOUNT)을 쓴다.
 */
export function tplRegisterGuide(
  creatorName: string,
  link: string,
  method: 'ACCOUNT' | 'CARD' = 'ACCOUNT',
): TemplateOutput {
  const what = method === 'CARD' ? '카드 등록' : '계좌 등록';
  // 등록 화면에서 방송 닉네임도 정할 수 있다는 것을 미리 알려 입력률을 높인다.
  // (선택 항목이라 안내가 없으면 대부분 그냥 지나친다)
  const text = withLink(
    `[도네이도] ${creatorName} 크리에이터 문자후원을 이용하려면 ${what}과 이용 동의가 필요합니다. 최초 문자는 후원 처리되지 않았습니다. 등록 화면에서 방송에 표시될 닉네임도 정할 수 있습니다. 등록:`,
    link,
  );
  return {
    code: MT_TEMPLATE.REGISTER_GUIDE,
    text,
    masked: maskLink(text),
    vars: { 크리에이터: creatorName, 등록수단: what, 보안링크: link },
  };
}

export function tplConfirmPayment(creatorName: string, amount: bigint, link: string, ttlMin: number): TemplateOutput {
  const text = withLink(
    `[도네이도] ${creatorName} 크리에이터에게 ${formatNumber(amount)}원을 후원하시려면 아래 링크에서 확인해 주세요. ${ttlMin}분 내 미확인 시 자동 취소됩니다. 확인:`,
    link,
  );
  return {
    code: MT_TEMPLATE.CONFIRM_PAYMENT,
    text,
    masked: maskLink(text),
    vars: {
      크리에이터: creatorName,
      금액: `${formatNumber(amount)}원`,
      유효시간: String(ttlMin),
      보안링크: link,
    },
  };
}

/**
 * 결제 PIN 입력 요청.
 *
 * 결제사(헥토/카드)가 발급한 PIN 입력 링크를 후원자에게 보낸다.
 * 이 문자를 받은 시점에는 아직 출금이 일어나지 않았고, PIN 을 입력해야 결제가 완료된다.
 *
 * @param mock 결제사 실연동이 아닌 mock 링크이면 본문에 [MOCK] 을 명시한다.
 *             (계약 전 연동을 실제 결제로 오인하지 않게 하기 위한 표시다)
 */
export function tplPinRequest(input: {
  creatorName: string;
  amount: bigint;
  pinUrl: string;
  ttlMin: number;
  mock: boolean;
}): TemplateOutput {
  const tag = input.mock ? ' [MOCK]' : '';
  const text = withLink(
    `[도네이도]${tag} ${input.creatorName} 크리에이터에게 ${formatNumber(input.amount)}원 후원을 진행합니다. ` +
      `아직 결제되지 않았습니다. 결제 PIN 입력 링크: `,
    `${input.pinUrl} (유효시간: ${input.ttlMin}분)`,
  );
  return {
    code: MT_TEMPLATE.PIN_REQUEST,
    text,
    masked: maskLink(text),
    // mock 표시는 관리자가 본문을 어떻게 바꾸든 강제로 남긴다.
    forcedTag: input.mock ? '[MOCK]' : undefined,
    vars: {
      크리에이터: input.creatorName,
      금액: `${formatNumber(input.amount)}원`,
      유효시간: String(input.ttlMin),
      보안링크: input.pinUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// 후원 감사 문자 (크리에이터 커스터마이즈)
// ---------------------------------------------------------------------------

export interface DonationSuccessInput {
  donorName: string;
  creatorName: string;
  amount: bigint;
  message: string;
  cumulative: bigint;
  /** 크리에이터가 설정한 감사 문자 본문. 비어 있으면 기본 문구를 쓴다. */
  custom?: string | null;
}

/** 감사 문자 본문 최대 길이. LMS(2,000byte) 안에 확실히 들어가는 보수적인 값. */
export const THANKS_MT_MAX_LENGTH = 200;

/** 감사 문자에서 쓸 수 있는 치환자. 스튜디오 설정 화면 안내와 검증에 함께 쓴다. */
export const THANKS_MT_VARIABLES = [
  { token: '{후원자}', label: '후원자 이름' },
  { token: '{크리에이터}', label: '크리에이터 이름' },
  { token: '{금액}', label: '후원 금액' },
  { token: '{메시지}', label: '후원자가 보낸 메시지' },
  { token: '{누적}', label: '누적 후원 금액' },
] as const;

const THANKS_VALUES: Record<string, (i: DonationSuccessInput) => string> = {
  '후원자': (i) => i.donorName,
  '크리에이터': (i) => i.creatorName,
  '금액': (i) => `${formatNumber(i.amount)}원`,
  '메시지': (i) => i.message,
  '누적': (i) => `${formatNumber(i.cumulative)}원`,
};

const THANKS_TOKEN_RE = /\{(후원자|크리에이터|금액|메시지|누적)\}/g;

/** 문자 본문에 들어가면 안 되는 값(제어문자)을 제거한다. 줄바꿈은 그대로 둔다. */
function sanitizeLine(v: string): string {
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

/**
 * 크리에이터가 설정한 본문의 치환자를 실제 값으로 바꾼다.
 *
 * 치환값에 `$&` 같은 문자가 들어와도 그대로 남도록 함수형 치환을 쓴다.
 * (문자열 치환을 쓰면 후원자 이름이나 메시지에 `$` 가 있을 때 본문이 깨진다)
 */
export function renderThanksMessage(template: string, input: DonationSuccessInput): string {
  return sanitizeLine(template.replace(THANKS_TOKEN_RE, (_m, key: string) => THANKS_VALUES[key](input)));
}

/** 감사 문자 기본 문구 (크리에이터 설정이 없을 때) */
export function defaultThanksMessage(input: DonationSuccessInput): string {
  return (
    `${input.donorName}님, ${input.creatorName} 크리에이터에게 ${formatNumber(input.amount)}원이 후원되었습니다. 감사합니다. ` +
    `메시지: "${input.message}" 누적 후원: ${formatNumber(input.cumulative)}원`
  );
}

/**
 * 후원 성공 감사 문자.
 *
 * 크리에이터가 스튜디오에서 본문을 설정했으면 그 문구를 쓰고, 없으면 기본 문구를 쓴다.
 * 발신 주체 표기(`[도네이도]`)는 어떤 경우에도 앞에 붙인다.
 */
export function tplDonationSuccess(input: DonationSuccessInput): TemplateOutput {
  const custom = input.custom ? sanitizeLine(input.custom) : '';
  const body = custom ? renderThanksMessage(custom, input) : defaultThanksMessage(input);
  const text = `[도네이도] ${body || defaultThanksMessage(input)}`;
  return {
    code: MT_TEMPLATE.DONATION_SUCCESS,
    text,
    masked: maskLink(text),
    // 크리에이터가 직접 설정한 문구가 있으면 그 문구가 우선이다.
    // 관리자 기본 문구가 크리에이터 설정을 덮어쓰지 않도록 vars 를 넘기지 않는다.
    vars: custom
      ? undefined
      : {
          후원자: input.donorName,
          크리에이터: input.creatorName,
          금액: `${formatNumber(input.amount)}원`,
          메시지: input.message,
          누적: `${formatNumber(input.cumulative)}원`,
        },
  };
}

export function tplDonationFailed(creatorName: string, reason?: string): TemplateOutput {
  const text =
    `[도네이도] ${creatorName} 크리에이터 후원이 완료되지 않았습니다. ` +
    `${reason ? `사유: ${reason} ` : ''}계좌 상태 또는 이용 한도를 확인해 주세요. 결제되지 않은 메시지는 방송에 표시되지 않습니다.`;
  return {
    code: MT_TEMPLATE.DONATION_FAILED,
    text,
    masked: text,
    vars: { 크리에이터: creatorName, 사유: reason ?? '' },
  };
}

export function tplAccountInactive(creatorName: string): TemplateOutput {
  const text =
    `[도네이도] ${creatorName} 크리에이터 후원을 진행할 수 없습니다. ` +
    '내통장결제 이용 상태를 확인하거나 고객센터로 문의해 주세요. 결제는 진행되지 않았습니다.';
  return { code: MT_TEMPLATE.ACCOUNT_INACTIVE, text, masked: text, vars: { 크리에이터: creatorName } };
}

export function tplLimitBlocked(creatorName: string, reason: string): TemplateOutput {
  const text = `[도네이도] ${creatorName} 크리에이터 후원이 제한되었습니다. 사유: ${reason} 결제는 진행되지 않았습니다.`;
  return { code: MT_TEMPLATE.LIMIT_BLOCKED, text, masked: text, vars: { 크리에이터: creatorName, 사유: reason } };
}

export function tplContentBlocked(creatorName: string): TemplateOutput {
  const text = `[도네이도] ${creatorName} 크리에이터에게 보낸 메시지가 운영정책에 따라 차단되었습니다. 결제는 진행되지 않았습니다.`;
  return { code: MT_TEMPLATE.CONTENT_BLOCKED, text, masked: text, vars: { 크리에이터: creatorName } };
}

export function tplRefundDone(creatorName: string, amount: bigint): TemplateOutput {
  const text = `[도네이도] ${creatorName} 크리에이터 후원 ${formatNumber(amount)}원이 취소되어 환불 처리되었습니다.`;
  return {
    code: MT_TEMPLATE.REFUND_DONE,
    text,
    masked: text,
    vars: { 크리에이터: creatorName, 금액: `${formatNumber(amount)}원` },
  };
}

export function tplUnknownRoute(): TemplateOutput {
  const text =
    '[도네이도] 후원 대상 크리에이터를 찾을 수 없습니다. 방송 화면에 안내된 번호와 코드를 다시 확인해 주세요. 결제는 진행되지 않았습니다.';
  return { code: MT_TEMPLATE.UNKNOWN_ROUTE, text, masked: text, vars: {} };
}

// ---------------------------------------------------------------------------
// 인증번호 문자 (후원내역 확인 / 휴대폰 번호 연결 / 후원샵 결제)
// ---------------------------------------------------------------------------

/**
 * 인증번호 유효시간(분).
 * 각 액션(donation-lookup / phone-link / web-donation)의 TTL_SEC(300초)와 같은 값이어야 한다.
 * 문자에 안내한 시간과 실제 만료 시간이 어긋나면 후원자가 유효한 코드를 버리게 된다.
 */
export const VERIFY_CODE_TTL_MIN = 5;

/** 인증번호 6자리는 로그/DB 본문에 남기지 않는다. */
function maskVerifyCode(text: string, code: string): string {
  return text.split(code).join('[인증번호]');
}

function verifyTemplate(code: MtTemplateCode, purpose: string, verifyCode: string): TemplateOutput {
  const text = `[도네이도] ${purpose} 인증번호는 ${verifyCode} 입니다. ${VERIFY_CODE_TTL_MIN}분 안에 입력해 주세요.`;
  return {
    code,
    text,
    masked: maskVerifyCode(text, verifyCode),
    vars: { 인증번호: verifyCode, 유효시간: String(VERIFY_CODE_TTL_MIN) },
  };
}

/** 후원내역 확인(비회원 조회) 인증번호. */
export function tplLookupVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.LOOKUP_VERIFY, '후원내역 확인', code);
}

/** 마이페이지 휴대폰 번호 확인 인증번호. */
export function tplPhoneLinkVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.PHONE_LINK_VERIFY, '휴대폰 번호 확인', code);
}

/** 후원샵 PC 웹 결제 인증번호. */
export function tplPaymentVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.PAYMENT_VERIFY, '후원샵 결제', code);
}

// ---------------------------------------------------------------------------
// 관리자 커스텀 본문 (MtMessageTemplate) — 재배포 없이 문구를 바꾸기 위한 오버라이드
// ---------------------------------------------------------------------------

/**
 * 관리자 화면에서 본문을 고칠 수 있는 템플릿 목록과 안내 정보.
 *
 * editable=false 인 항목은 본문에 **보안링크**가 들어간다. 링크가 빠지거나 잘리면
 * 등록/결제 흐름 자체가 끊기므로 코드에서만 관리하고 화면에서는 읽기 전용으로 보여준다.
 */
export interface MtTemplateMeta {
  label: string;
  description: string;
  editable: boolean;
  /** 오버라이드가 없을 때 편집칸에 채워 넣는 기본 본문 (치환자 형태, 발신 표기 제외) */
  defaultBody: string;
  /** 이 템플릿에서 쓸 수 있는 치환자 (sample 은 관리자 미리보기 전용 예시 값) */
  variables: ReadonlyArray<{ token: string; label: string; sample: string }>;
}

/**
 * 치환자 정의.
 *
 * `sample` 은 관리자 화면 미리보기 전용 예시 값이다. 문자는 글자 수가 아니라 바이트로
 * SMS/LMS 가 갈리므로, 치환자가 실제 값으로 바뀐 뒤의 길이를 보지 않으면 요금이 3~4배가
 * 되는 문구를 모르고 저장하게 된다. 실제 발송 시 나올 법한 길이로 잡아 둔다.
 */
const V = {
  donor: { token: '{후원자}', label: '후원자 이름', sample: '구영' },
  creator: { token: '{크리에이터}', label: '크리에이터 이름', sample: '토네이도TV' },
  amount: { token: '{금액}', label: '후원 금액 (예: 10,000원)', sample: '10,000원' },
  message: { token: '{메시지}', label: '후원자가 보낸 메시지', sample: '오늘 방송 재밌어요' },
  cumulative: { token: '{누적}', label: '누적 후원 금액', sample: '52,000원' },
  reason: { token: '{사유}', label: '실패·제한 사유', sample: '잔액 부족' },
  verifyCode: { token: '{인증번호}', label: '6자리 인증번호', sample: '482913' },
  ttl: { token: '{유효시간}', label: '유효시간(분)', sample: '3' },
  /**
   * 1회용 보안링크. **이 치환자가 빠진 본문은 저장되지 않는다.**
   * 링크가 없으면 후원자가 등록·결제를 끝낼 방법이 사라진다.
   */
  link: { token: '{보안링크}', label: '1회용 보안링크 (반드시 포함)', sample: 'https://donaeido.kr/r/xxxxxxxx' },
  method: { token: '{등록수단}', label: '등록 수단 (계좌 등록 / 카드 등록)', sample: '계좌 등록' },
} as const;

/**
 * 본문에 보안링크가 들어가는 템플릿.
 *
 * 최고관리자가 **안내 문장은 고칠 수 있지만 링크는 뺄 수 없다.** 저장 시
 * `{보안링크}` 치환자 포함 여부를 강제 검사한다.
 * 크리에이터에게는 열지 않는다 — 결제 흐름 자체를 좌우하는 문자다.
 */
export const SECURE_LINK_TEMPLATES: ReadonlySet<string> = new Set([
  MT_TEMPLATE.REGISTER_GUIDE,
  MT_TEMPLATE.CONFIRM_PAYMENT,
  MT_TEMPLATE.PIN_REQUEST,
]);

export const MT_TEMPLATE_META: Record<MtTemplateCode, MtTemplateMeta> = {
  [MT_TEMPLATE.REGISTER_GUIDE]: {
    label: '최초 결제수단 등록 안내',
    description:
      '처음 문자를 보낸 후원자에게 계좌/카드 등록 링크를 보냅니다. 최고관리자만 수정할 수 있고, {보안링크} 는 뺄 수 없습니다.',
    editable: true,
    defaultBody:
      '{크리에이터} 크리에이터 문자후원을 이용하려면 {등록수단}과 이용 동의가 필요합니다. 최초 문자는 후원 처리되지 않았습니다. 등록 화면에서 방송에 표시될 닉네임도 정할 수 있습니다. 등록: {보안링크}',
    variables: [V.creator, V.method, V.link],
  },
  [MT_TEMPLATE.CONFIRM_PAYMENT]: {
    label: '후원 확인 링크',
    description:
      '후원 진행 여부를 확인받는 링크를 보냅니다. 최고관리자만 수정할 수 있고, {보안링크} 는 뺄 수 없습니다.',
    editable: true,
    defaultBody:
      '{크리에이터} 크리에이터에게 {금액}을 후원하시려면 아래 링크에서 확인해 주세요. {유효시간}분 내 미확인 시 자동 취소됩니다. 확인: {보안링크}',
    variables: [V.creator, V.amount, V.ttl, V.link],
  },
  [MT_TEMPLATE.PIN_REQUEST]: {
    label: '결제 PIN 입력 요청',
    description:
      '결제사 PIN 입력 링크를 보냅니다. 이 시점에는 아직 출금되지 않았습니다. 최고관리자만 수정할 수 있고, {보안링크} 는 뺄 수 없습니다.',
    editable: true,
    defaultBody:
      '{크리에이터} 크리에이터에게 {금액} 후원을 진행합니다. 아직 결제되지 않았습니다. 결제 PIN 입력 링크: {보안링크} (유효시간: {유효시간}분)',
    variables: [V.creator, V.amount, V.ttl, V.link],
  },
  [MT_TEMPLATE.DONATION_SUCCESS]: {
    label: '후원 완료 감사 문자',
    description:
      '결제가 완료되었을 때 후원자에게 보냅니다. 크리에이터가 스튜디오에서 직접 문구를 설정한 경우에는 그 문구가 우선합니다.',
    editable: true,
    defaultBody:
      '{후원자}님, {크리에이터} 크리에이터에게 {금액}이 후원되었습니다. 감사합니다. 메시지: "{메시지}" 누적 후원: {누적}',
    variables: [V.donor, V.creator, V.amount, V.message, V.cumulative],
  },
  [MT_TEMPLATE.DONATION_FAILED]: {
    label: '후원 실패 안내',
    description: '결제가 완료되지 않았을 때 보냅니다.',
    editable: true,
    defaultBody:
      '{크리에이터} 크리에이터 후원이 완료되지 않았습니다. 사유: {사유} 계좌 상태 또는 이용 한도를 확인해 주세요. 결제되지 않은 메시지는 방송에 표시되지 않습니다.',
    variables: [V.creator, V.reason],
  },
  [MT_TEMPLATE.ACCOUNT_INACTIVE]: {
    label: '결제수단 이용 불가 안내',
    description: '등록된 결제수단을 쓸 수 없을 때 보냅니다.',
    editable: true,
    defaultBody:
      '{크리에이터} 크리에이터 후원을 진행할 수 없습니다. 내통장결제 이용 상태를 확인하거나 고객센터로 문의해 주세요. 결제는 진행되지 않았습니다.',
    variables: [V.creator],
  },
  [MT_TEMPLATE.LIMIT_BLOCKED]: {
    label: '한도 초과 안내',
    description: '일일/월간 한도나 이상거래 탐지로 후원이 막혔을 때 보냅니다.',
    editable: true,
    defaultBody: '{크리에이터} 크리에이터 후원이 제한되었습니다. 사유: {사유} 결제는 진행되지 않았습니다.',
    variables: [V.creator, V.reason],
  },
  [MT_TEMPLATE.CONTENT_BLOCKED]: {
    label: '금칙어 차단 안내',
    description: '메시지가 운영정책(금칙어)에 걸렸을 때 보냅니다.',
    editable: true,
    defaultBody: '{크리에이터} 크리에이터에게 보낸 메시지가 운영정책에 따라 차단되었습니다. 결제는 진행되지 않았습니다.',
    variables: [V.creator],
  },
  [MT_TEMPLATE.REFUND_DONE]: {
    label: '환불 완료 안내',
    description: '후원이 취소되어 환불 처리되었을 때 보냅니다.',
    editable: true,
    defaultBody: '{크리에이터} 크리에이터 후원 {금액}이 취소되어 환불 처리되었습니다.',
    variables: [V.creator, V.amount],
  },
  [MT_TEMPLATE.UNKNOWN_ROUTE]: {
    label: '수신 대상 없음 안내',
    description: '어느 크리에이터에게 보낸 문자인지 찾지 못했을 때 보냅니다.',
    editable: true,
    defaultBody:
      '후원 대상 크리에이터를 찾을 수 없습니다. 방송 화면에 안내된 번호와 코드를 다시 확인해 주세요. 결제는 진행되지 않았습니다.',
    variables: [],
  },
  [MT_TEMPLATE.LOOKUP_VERIFY]: {
    label: '후원내역 확인 인증번호',
    description: '비회원이 후원내역을 조회할 때 보내는 인증번호입니다.',
    editable: true,
    defaultBody: '후원내역 확인 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
  [MT_TEMPLATE.PHONE_LINK_VERIFY]: {
    label: '휴대폰 번호 확인 인증번호',
    description: '마이페이지에서 휴대폰 번호를 계정에 연결할 때 보내는 인증번호입니다.',
    editable: true,
    defaultBody: '휴대폰 번호 확인 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
  [MT_TEMPLATE.PAYMENT_VERIFY]: {
    label: '후원샵 결제 인증번호',
    description: 'PC 웹 후원샵에서 결제 전 본인확인을 할 때 보내는 인증번호입니다.',
    editable: true,
    defaultBody: '후원샵 결제 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
};

/** 관리 화면 카드 순서. */
export const MT_TEMPLATE_CODES = Object.keys(MT_TEMPLATE_META) as MtTemplateCode[];

/** 관리자 커스텀 본문 최대 길이. LMS(2,000byte) 안에 확실히 들어가는 보수적인 값. */
export const MT_TEMPLATE_BODY_MAX_LENGTH = 400;

const SENDER_TAG = '[도네이도]';

/**
 * 발신 주체 표기(와 mock 표시)는 어떤 커스텀 본문에서도 빠지지 않게 강제한다.
 *
 * 관리자가 본문 앞에 `[도네이도]` 를 직접 적어 두었을 수도 있으므로, 있으면 떼어 낸 뒤
 * 다시 붙인다(`[도네이도] [도네이도] ...` 방지). forcedTag 는 항상 발신 표기 바로 뒤에 온다.
 */
function ensureSenderTag(text: string, forcedTag?: string): string {
  const body = text.startsWith(SENDER_TAG) ? text.slice(SENDER_TAG.length).trim() : text;
  return forcedTag ? `${SENDER_TAG} ${forcedTag} ${body}` : `${SENDER_TAG} ${body}`;
}

const OVERRIDE_TOKEN_RE = /\{([^{}\s]{1,12})\}/g;

/**
 * 커스텀 본문의 치환자를 실제 값으로 바꾼다.
 *
 * 값에 `$&` 같은 문자가 있어도 그대로 남도록 함수형 치환을 쓴다.
 * 지원하지 않는 치환자는 건드리지 않고 원문 그대로 남긴다
 * (오타로 문장이 통째로 사라지는 것보다 눈에 띄는 편이 낫다).
 */
export function renderMtTemplateBody(body: string, vars: Record<string, string>): string {
  return body.replace(OVERRIDE_TOKEN_RE, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

/** 커스텀 본문 유효성 검사. 문제가 있으면 사유를, 없으면 null 을 돌려준다. */
export function validateMtTemplateBody(code: MtTemplateCode, body: string): string | null {
  const meta = MT_TEMPLATE_META[code];
  if (!meta) return '알 수 없는 템플릿 코드입니다.';
  if (!meta.editable) {
    return `${meta.label} 문자는 보안링크가 포함되어 있어 화면에서 수정할 수 없습니다.`;
  }

  const trimmed = sanitizeLine(body);
  if (trimmed === '') return '본문을 입력해 주세요. 기본 문구로 되돌리려면 초기화를 사용하세요.';
  if (trimmed.length > MT_TEMPLATE_BODY_MAX_LENGTH) {
    return `본문은 ${MT_TEMPLATE_BODY_MAX_LENGTH}자 이하로 입력해 주세요. (현재 ${trimmed.length}자)`;
  }

  const allowed = new Set(meta.variables.map((v) => v.token.slice(1, -1)));
  const unknown = [...trimmed.matchAll(OVERRIDE_TOKEN_RE)].map((m) => m[1]).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return `이 문자에서 쓸 수 없는 치환자입니다: ${[...new Set(unknown)].map((k) => `{${k}}`).join(', ')}`;
  }

  // 인증번호가 빠지면 후원자가 인증을 끝낼 방법이 없어진다.
  if (allowed.has('인증번호') && !trimmed.includes('{인증번호}')) {
    return '인증번호 문자에는 {인증번호} 치환자가 반드시 들어가야 합니다.';
  }

  /**
   * 보안링크가 빠지면 등록·결제 흐름이 그 자리에서 끊긴다.
   * 후원자는 문자를 받고도 할 수 있는 일이 없고, 관리자는 문구만 보고는 알아채지 못한다.
   * 그래서 저장 자체를 막는다.
   */
  if (SECURE_LINK_TEMPLATES.has(code) && !trimmed.includes('{보안링크}')) {
    return `${meta.label} 문자에는 {보안링크} 치환자가 반드시 들어가야 합니다. 링크가 빠지면 후원자가 등록·결제를 끝낼 수 없습니다.`;
  }

  // 링크를 직접 적어 넣으면 1회용 보안링크 대신 그 주소가 나가고, 스팸 필터에도 걸린다.
  if (/https?:\/\/|www\./i.test(trimmed)) {
    return '본문에 주소를 직접 적을 수 없습니다. 링크가 필요한 문자에는 {보안링크} 치환자를 사용해 주세요.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 저장된 커스텀 본문 읽기
// ---------------------------------------------------------------------------

/**
 * 문자 발송 경로에서 매번 호출되므로 짧게 캐싱한다.
 * DB 조회가 실패해도 문자 발송 자체는 기본 문구로 계속 나가야 하므로 예외를 삼킨다.
 */
const OVERRIDE_CACHE_TTL_MS = 30_000;
let overrideCache: { at: number; map: Map<string, string> } | null = null;

/** 관리자가 본문을 저장/초기화한 직후 즉시 반영되도록 캐시를 비운다. */
export function clearMtTemplateOverrideCache(): void {
  overrideCache = null;
}

export async function loadMtTemplateOverrides(): Promise<Map<string, string>> {
  const now = Date.now();
  if (overrideCache && now - overrideCache.at < OVERRIDE_CACHE_TTL_MS) return overrideCache.map;
  try {
    const rows = await prisma.mtMessageTemplate.findMany({ select: { code: true, body: true } });
    const map = new Map(rows.filter((r) => r.body.trim() !== '').map((r) => [r.code, r.body]));
    overrideCache = { at: now, map };
    return map;
  } catch (e) {
    logger.warn('MT 커스텀 본문 조회 실패 - 기본 문구로 발송합니다.', { message: (e as Error).message });
    return overrideCache?.map ?? new Map();
  }
}

/**
 * 템플릿 결과에 관리자 커스텀 본문을 적용한다.
 *
 * 적용하지 않는 경우 (원본을 그대로 돌려준다)
 *  - vars 가 없는 템플릿 (크리에이터가 직접 설정한 감사 문자)
 *  - editable=false 인 템플릿
 *  - 저장된 본문이 없거나 치환 후 빈 문자열이 되는 경우
 *
 * 보안링크가 들어가는 본문도 여기서 적용된다. 링크 누락은 저장 단계
 * (validateMtTemplateBody)에서 이미 막았으므로, 여기까지 온 본문에는 링크가 들어 있다.
 */
export async function applyMtTemplateOverride(out: TemplateOutput): Promise<TemplateOutput> {
  if (!out.vars) return out;
  if (!MT_TEMPLATE_META[out.code]?.editable) return out;

  const body = (await loadMtTemplateOverrides()).get(out.code);
  if (!body) return out;

  const rendered = sanitizeLine(renderMtTemplateBody(body, out.vars));
  if (rendered === '') return out;

  const text = ensureSenderTag(rendered, out.forcedTag);
  const verifyCode = out.vars['인증번호'];
  const masked = verifyCode ? maskVerifyCode(maskLink(text), verifyCode) : maskLink(text);
  return { ...out, text, masked };
}
