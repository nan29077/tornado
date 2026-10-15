import { env } from '@/lib/env';

/**
 * 상태를 바꾸는 라우트 핸들러용 동일 출처 검사 (CSRF 방어).
 *
 * [CSRF] 예전 주석은 "SameSite=Lax 라 폼 POST 는 기본적으로 막히지 않는다" 였는데 사실과 반대다.
 * Lax 쿠키는 **다른 사이트에서 시작된 POST 에는 실리지 않는다**(최상위 GET 이동에만 실린다).
 * 그래도 이 검사를 두는 이유:
 *  - SameSite 는 "사이트(eTLD+1)" 단위라 같은 사이트의 다른 서브도메인/호스트에서 온 요청은 막지 못한다.
 *  - SameSite 를 지원하지 않거나 다르게 해석하는 구형 브라우저·웹뷰가 있다.
 *  - 로그인 CSRF(세션 고정)처럼 **쿠키가 없어도** 성립하는 공격은 SameSite 와 무관하다.
 * 그래서 쿠키로 인증하는 상태 변경 라우트는 Origin(없으면 Referer)이 우리 호스트인지 확인한다.
 * 서버 액션은 Next.js 가 자체적으로 Origin 을 검사하므로 이 함수를 쓰지 않는다.
 * 웹훅·콜백·크론·공개 참여(/api/play)는 각자 별도 인증(서명·허용목록·시크릿)을 쓰므로 대상이 아니다.
 */

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function allowedHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const base = hostOf(env.baseUrl);
  if (base) hosts.add(base);
  // 리버스 프록시 뒤에서도 동작하도록 실제 요청 호스트를 함께 허용한다.
  const forwarded = req.headers.get('x-forwarded-host');
  if (forwarded) hosts.add(forwarded.split(',')[0]!.trim());
  const hostHeader = req.headers.get('host');
  if (hostHeader) hosts.add(hostHeader);
  const self = hostOf(req.url);
  if (self) hosts.add(self);
  return hosts;
}

/** 동일 출처 요청이면 true. Origin·Referer 가 모두 없으면 거절한다(fail-closed). */
export function isSameOrigin(req: Request): boolean {
  const hosts = allowedHosts(req);
  const origin = hostOf(req.headers.get('origin'));
  if (origin) return hosts.has(origin);
  const referer = hostOf(req.headers.get('referer'));
  if (referer) return hosts.has(referer);
  return false;
}

/**
 * [CSRF] 라우트 핸들러 첫 줄에서 쓰는 축약형. 다른 출처면 403 응답을, 같은 출처면 null 을 돌려준다.
 *
 * 브라우저의 fetch 는 POST/PATCH/PUT/DELETE 에 항상 Origin 을 붙이므로(같은 출처 포함)
 * 앱 화면에서 부르는 요청은 그대로 통과한다. Origin·Referer 가 둘 다 없으면 거절한다(fail-closed).
 */
export function rejectCrossOrigin(req: Request): Response | null {
  if (isSameOrigin(req)) return null;
  // 라우트마다 오류 필드 이름이 달라(message / error) 둘 다 채운다.
  const message = '허용되지 않은 요청입니다.';
  return Response.json({ ok: false, message, error: message }, { status: 403 });
}
