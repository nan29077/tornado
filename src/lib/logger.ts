/**
 * 마스킹 로거.
 * 전화번호/빌키/토큰/계좌번호가 로그로 새어나가지 않도록 출력 직전에 한 번 더 거른다.
 */

const SENSITIVE_KEYS = [
  'phone', 'phoneNumber', 'mobile', 'msisdn',
  'billKey', 'billkey', 'cardNo', 'account', 'accountNo', 'accountNumber',
  'token', 'accessToken', 'refreshToken', 'password',
  'authorization', 'signature', 'secret', 'apiKey', 'licenseKey',
  /**
   * MO 사업자 payload 의 실제 키 이름들.
   *
   * 예전 목록에는 이 중 어느 것도 걸리지 않아, 웹훅 로그(`webhook_log.body_masked`)에
   * **문자 원문과 050 수신번호가 사실상 평문으로** 남았다. 값 기준 마스킹도 국내 휴대폰
   * 형식만 잡아서 050·02·1588·+82 표기를 전부 통과시켰다.
   */
  'msg', 'smsmsg', 'text', 'content', 'body',
  'callee', 'caller', 'recvno', 'sendno', 'svcno', 'calledno', 'callingno',
  'resident', 'ssn', 'holder', 'holdername',
];

/**
 * 전화번호 패턴.
 *
 * 휴대폰(010 계열)만이 아니라 **050 안심번호·지역번호·국제 표기**까지 덮는다.
 * 앞뒤에 숫자가 더 붙어 있으면 매칭하지 않는다 — 금액·주문번호 같은 긴 숫자열을
 * 전화번호로 오인해 로그를 망가뜨리면 사고 조사가 더 어려워진다.
 * (대표번호 1588-0000 류는 개인정보가 아니고, 8자리 숫자와 구분이 어려워 대상에서 뺀다)
 * 이 서비스의 MO 수신번호는 050 계열이고, 그 번호는 어느 크리에이터에게 가는 문자인지를
 * 그대로 드러낸다.
 */
const PHONE_PATTERNS: RegExp[] = [
  // +82 10 1234 5678 / 821012345678
  /(?<![0-9])(?:\+?82[-\s.]?)(1[016789])[-\s.]?(\d{3,4})[-\s.]?(\d{4})(?![0-9])/g,
  // 010-1234-5678 / 01012345678 / 010.1234.5678
  /(?<![0-9])(01[016789])[-\s.]?(\d{3,4})[-\s.]?(\d{4})(?![0-9])/g,
  // 050 안심번호 (0504-1234-5678 포함)
  /(?<![0-9])(050\d?)[-\s.]?(\d{3,4})[-\s.]?(\d{4})(?![0-9])/g,
  // 지역번호 (02-1234-5678, 031-123-4567 …)
  /(?<![0-9])(0(?:2|[3-6][1-5]))[-\s.]?(\d{3,4})[-\s.]?(\d{4})(?![0-9])/g,
];

/**
 * URL 은 통째로 가린다.
 *
 * 이 앱의 일회용 링크(비밀번호 재설정, 계좌 등록, PIN 인가)는 토큰을 경로나 쿼리에 싣는다.
 * 그 링크가 로그에 한 줄만 남아도 로그를 볼 수 있는 사람이 남의 계정을 가져갈 수 있다.
 * 호스트만 남기고 나머지는 지운다.
 */
const URL_RE = /(https?:\/\/[^\s/]+)\/\S*/gi;

/** 문자열에서 개인정보·자격증명 흔적을 지운다. 로그 메시지와 meta 양쪽에 쓴다. */
export function scrubText(input: string): string {
  let out = input.replace(URL_RE, '$1/[링크 감춤]');
  for (const re of PHONE_PATTERNS) {
    // 마지막 4자리만 남긴다. 대표번호(4+4)는 그룹이 두 개뿐이라 별도로 처리한다.
    out = out.replace(re, (...args) => {
      const groups = args.slice(1, -2).filter((g): g is string => typeof g === 'string');
      if (groups.length >= 3) return `${groups[0]}-****-${groups[2]}`;
      return '****';
    });
  }
  return out;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
      out[k] = typeof v === 'string' && v.length > 8 ? `${v.slice(0, 2)}***${v.slice(-2)}` : '***';
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    // message 도 반드시 걸러야 한다. 예전에는 meta 만 걸러서,
    // 링크를 메시지에 끼워 넣은 곳(비밀번호 재설정)에서 토큰이 그대로 새 나갔다.
    message: scrubText(message),
    ...(meta !== undefined ? { meta: scrub(meta) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};
