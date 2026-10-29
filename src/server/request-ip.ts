import { headers } from 'next/headers';
import { allowDevLoginOnTunnel, isLocal, isLoopbackOrPrivateHost } from '@/lib/env';

/**
 * [SEC-1] 요청이 "내 컴퓨터(또는 사내망)에서 직접 들어온 것" 인지 판정한다.
 *
 * 로컬 미리보기를 Cloudflare 터널 등으로 공유하면, APP_ENV=local 이라는 이유만으로
 * 그 주소를 아는 누구나 테스트 로그인(비밀번호 없는 최고관리자)과 개발 아웃박스(보안링크 원문)를
 * 쓸 수 있었다. 개발 전용 기능은 아래 조건을 모두 만족하는 요청에만 연다.
 *
 *  - 터널·CDN 이 붙이는 헤더(cf-connecting-ip, cf-ray, cdn-loop, forwarded, x-real-ip 등)가 없다.
 *  - X-Forwarded-For 의 모든 홉이 루프백·사설망이다. (Next 는 이 헤더가 없으면 소켓 주소를 넣는다.
 *    cloudflared·ngrok 은 실제 접속자 공인 IP 를 넣으므로 여기서 걸린다)
 *  - Host / X-Forwarded-Host 가 루프백·사설망이다.
 *
 * 헤더는 위조할 수 있지만, 위조로는 "더 로컬처럼" 보이게 만들 수 없다. 터널이 붙이는 헤더를
 * 클라이언트가 지울 수는 없기 때문이다. 판정이 애매하면 false(차단)를 돌려준다.
 */
const PROXY_MARKER_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cdn-loop',
  'forwarded',
  'x-real-ip',
  'true-client-ip',
  'fly-client-ip',
] as const;

function hostnameOf(hostHeader: string): string {
  const v = hostHeader.split(',')[0]!.trim();
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  // IPv6 리터럴(콜론 여러 개)은 그대로, host:port 는 포트를 뗀다.
  return v.split(':').length === 2 ? v.split(':')[0]! : v;
}

export function isDirectLocalRequest(get: (name: string) => string | null): boolean {
  for (const h of PROXY_MARKER_HEADERS) {
    if (get(h)) return false;
  }
  const xff = get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.some((ip) => !isLoopbackOrPrivateHost(hostnameOf(ip)))) return false;
  }
  const host = get('host');
  if (!host || !isLoopbackOrPrivateHost(hostnameOf(host))) return false;
  const fwdHost = get('x-forwarded-host');
  if (fwdHost && !isLoopbackOrPrivateHost(hostnameOf(fwdHost))) return false;
  return true;
}

/**
 * 개발 전용 기능(테스트 로그인, 개발 아웃박스)을 이 요청에 열어도 되는지.
 *
 * APP_ENV=local 이 전제이고, 직접 접속이거나 운영자가 ALLOW_DEV_LOGIN_ON_TUNNEL=1 로
 * 터널 시연을 명시적으로 허용한 경우에만 true 다.
 */
export function isDevFeatureAllowedFor(get: (name: string) => string | null): boolean {
  if (!isLocal) return false;
  if (allowDevLoginOnTunnel()) return true;
  return isDirectLocalRequest(get);
}

/** 서버 액션/서버 컴포넌트용. 요청 컨텍스트가 없으면 차단한다. */
export async function isDevFeatureRequestAllowed(): Promise<boolean> {
  if (!isLocal) return false;
  try {
    const h = await headers();
    return isDevFeatureAllowedFor((name) => h.get(name));
  } catch {
    return false;
  }
}
