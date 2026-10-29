import { headers } from 'next/headers';
import { kv } from '@/server/redis';
import { env, isLocal, trustCfConnectingIpHeader, trustRealIpHeader } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * IP 단위 속도 제한 공용 유틸.
 *
 * 대상은 "인증 없이 계정/자원을 만들 수 있는" 입구다.
 *  - 회원가입 / 크리에이터 신청 : 계정 대량 생성 방지
 *  - 비밀번호 재설정 요청       : 메일 폭탄 · 계정 존재 여부 탐색 방지
 *
 * 규칙
 *  - [P2-12] 주소를 알 수 없으면 로컬(APP_ENV=local)에서만 제한을 건너뛴다. 운영·스테이징에서는
 *    주소를 모르는 요청 전부가 하나의 공용 버킷(`noip`)을 같은 상한으로 나눠 쓴다.
 *    예전에는 그냥 통과시켜서, 프록시 단수 오설정이나 XFF 를 짧게 위조하는 것만으로
 *    로그인·문자 발송 등 모든 IP 제한을 우회할 수 있었다.
 *  - 카운터는 Redis(없으면 인메모리)를 쓴다. 다중 인스턴스에서는 Redis 가 필요하다.
 *  - 실패해도 예외를 밖으로 던지지 않는다. 속도 제한 저장소 장애가 가입 자체를 막으면 안 된다.
 */

/** ::ffff:1.2.3.4 → 1.2.3.4, 대괄호/포트 제거. 비교 전에 항상 거친다. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;
  // [::1]:1234 형태
  if (v.startsWith('[')) v = v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  // IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped) return mapped[1];
  // 1.2.3.4:5678 (IPv6 는 콜론이 여러 개이므로 제외)
  if (v.includes('.') && v.includes(':') && v.split(':').length === 2) v = v.split(':')[0];
  return v.toLowerCase();
}

/**
 * 클라이언트 IP.
 *
 * X-Forwarded-For 는 "클라이언트, 프록시1, 프록시2" 순이므로, **마지막 홉**을 쓰면
 * 신뢰 프록시가 2단 이상일 때(CloudFront + ALB) 내부 프록시 주소를 클라이언트로 오인한다.
 * 그러면 MO 허용목록이 전건 실패하거나, 같은 엣지를 거친 시청자 전원이 하나의
 * 속도 제한 버킷을 공유해 서로를 잠근다. 신뢰 프록시 단수만큼 뒤에서 건너뛴 값을 쓴다.
 */
export function clientIpFrom(get: (name: string) => string | null): string | null {
  const xff = get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) {
      /**
       * **홉 수가 설정보다 적으면 판정을 포기한다(fail-closed).**
       *
       * 예전에는 `Math.max(0, ...)` 로 0 에 붙였는데, `hops[0]` 은 클라이언트가 직접 써 넣는
       * 값이다. TRUSTED_PROXY_HOPS 가 실제 구성보다 크게 잡혀 있으면(오설정, 프록시 단수 변경)
       * 공격자가 `X-Forwarded-For: <허용된 사업자 IP>` 한 줄로 MO·PIN 웹훅의 허용목록 검사를
       * 그대로 통과한다. 두 겹 방어 중 한 겹이 조용히 사라지는 셈이다.
       * 알 수 없으면 null 을 돌려주어 허용목록 검사가 실패하게 둔다.
       */
      const idx = hops.length - env.trustedProxyHops;
      if (idx < 0) return null;
      return normalizeIp(hops[idx]);
    }
  }
  /**
   * [P2-12] XFF 가 없을 때의 대체 헤더는 **운영자가 명시적으로 켠 경우에만** 믿는다.
   * CF-Connecting-IP / X-Real-IP 는 클라이언트가 직접 써 넣을 수 있어, 앞단이 덮어쓰지 않는
   * 구성에서 믿으면 요청마다 IP 를 바꿔 속도 제한을 피하거나 허용목록 IP 를 사칭할 수 있다.
   *  - TRUST_CF_HEADER=true      : Cloudflare 가 앞단이고 원본이 Cloudflare 에서만 접근 가능할 때
   *  - TRUST_REAL_IP_HEADER=true : Nginx 등이 X-Real-IP 를 항상 덮어쓸 때
   */
  if (trustCfConnectingIpHeader()) {
    const cf = normalizeIp(get('cf-connecting-ip'));
    if (cf) return cf;
  }
  if (trustRealIpHeader()) {
    const real = normalizeIp(get('x-real-ip'));
    if (real) return real;
  }
  return null;
}

/**
 * IP 가 허용목록에 있는지. 정확 일치와 IPv4 CIDR(예: 203.0.113.0/24)을 함께 지원한다.
 * 사업자는 보통 단일 주소가 아니라 대역으로 통보하므로 문자열 비교만으로는 부족하다.
 */
export function ipMatchesAllowlist(ip: string | null | undefined, allowlist: readonly string[]): boolean {
  const target = normalizeIp(ip);
  if (!target || allowlist.length === 0) return false;
  const targetNum = ipv4ToNum(target);
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!entry.includes('/')) {
      if (normalizeIp(entry) === target) return true;
      continue;
    }
    if (targetNum === null) continue;
    const [net, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    const netNum = ipv4ToNum(normalizeIp(net) ?? '');
    if (netNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((targetNum & mask) === (netNum & mask)) return true;
  }
  return false;
}

function ipv4ToNum(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = Number(m[i]);
    if (part > 255) return null;
    n = (n << 8) | part;
  }
  return n >>> 0;
}

export function clientIpFromRequest(req: Request): string | null {
  return clientIpFrom((name) => req.headers.get(name));
}

/**
 * 서버 액션에서 호출자의 IP 를 얻는다.
 *
 * `headers()` 는 **요청 컨텍스트 안에서만** 쓸 수 있다. 크론/워커/테스트처럼 요청이 없는
 * 곳에서 같은 서비스 함수를 부르면 여기서 예외가 나면서, 정작 하려던 작업(후원 처리 등)이
 * 통째로 실패한다. IP 는 속도 제한을 위한 **보조 정보**이지 작업의 전제가 아니다.
 * 얻을 수 없으면 null 로 돌려주고, 판정은 호출부의 failClosed 정책에 맡긴다.
 */
export async function clientIpFromHeaders(): Promise<string | null> {
  try {
    const h = await headers();
    return clientIpFrom((name) => h.get(name));
  } catch {
    return null;
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** 현재 창에서의 시도 횟수. 제한을 적용하지 않은 경우 0. */
  count: number;
}

export interface RateLimitOptions {
  /**
   * 카운터 저장소(Redis)가 죽었을 때의 동작.
   *
   * 기본은 통과(fail-open)다. 가입 폼이 Redis 장애로 전부 막히는 쪽이 더 나쁘기 때문이다.
   * 다만 **로그인·결제 인증처럼 무제한 시도가 곧 피해**인 입구는 반드시 true 로 막는다.
   * (예전에는 로그인만 kv.incr 를 직접 불러 Redis 장애 시 500 이 났고, 다른 입구는
   *  통째로 열렸다. 같은 장애에서 정반대로 동작하던 것을 이 옵션으로 통일한다)
   */
  failClosed?: boolean;
}

/** 주소를 알 수 없는 요청이 함께 쓰는 공용 버킷 키. */
export const UNKNOWN_CLIENT_BUCKET = 'noip';
/** 공용 버킷의 상한 배수. 여러 사용자가 나눠 쓰므로 개별 IP 상한보다 크게 잡는다. */
export const UNKNOWN_CLIENT_MULTIPLIER = 20;
let warnedUnknownClient = false;

/**
 * 카운터를 1 증가시키고 상한을 넘었는지 판정한다.
 * key 가 비어 있으면(주소를 알 수 없으면) 로컬에서는 통과시키고, 그 외 환경에서는
 * 공용 버킷(`noip`) 하나를 같은 상한으로 함께 쓴다(P2-12).
 */
export async function consumeRateLimit(
  scope: string,
  key: string | null | undefined,
  max: number,
  windowSec: number,
  opts: RateLimitOptions = {},
): Promise<RateLimitResult> {
  if (!key) {
    if (isLocal) return { ok: true, count: 0 };
    key = UNKNOWN_CLIENT_BUCKET;
    /**
     * 공용 버킷은 주소를 모르는 **모든** 요청이 함께 쓴다. 프록시 단수(TRUSTED_PROXY_HOPS)를
     * 잘못 잡으면 정상 사용자 전원이 여기로 몰리므로, 상한을 넉넉히 늘리고 경고를 남긴다
     * (4차 검토: 설정 실수로 로그인·웹 후원이 통째로 막히는 것을 막는다).
     */
    max = max * UNKNOWN_CLIENT_MULTIPLIER;
    if (!warnedUnknownClient) {
      warnedUnknownClient = true;
      logger.error('클라이언트 IP 를 알 수 없는 요청 — 공용 속도 제한 버킷 사용. TRUSTED_PROXY_HOPS 설정을 확인하세요.', {
        scope,
      });
    }
  }
  try {
    const count = await kv.incr(`rl:${scope}:${key}`, windowSec);
    return { ok: count <= max, count };
  } catch (e) {
    logger.warn('속도 제한 카운터 실패', { scope, failClosed: Boolean(opts.failClosed), message: (e as Error)?.message });
    return { ok: !opts.failClosed, count: 0 };
  }
}

/** 서버 액션용 축약형. IP 를 알 수 없으면 로컬에서는 통과, 그 외에는 공용 버킷을 쓴다. */
export async function consumeIpRateLimit(
  scope: string,
  max: number,
  windowSec: number,
  opts: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const ip = await clientIpFromHeaders();
  return consumeRateLimit(scope, ip, max, windowSec, opts);
}
