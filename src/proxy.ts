import { NextResponse, type NextRequest } from 'next/server';

/**
 * 로그인이 필요한 화면의 1차 관문 (7차 점검 P2-7, 2026-11-19).
 *
 * 스튜디오 · 관리자 · 마이페이지는 레이아웃이 로그인을 확인하고 로그인 화면으로 보낸다. 그런데 Next 는 레이아웃과
 * 화면을 **동시에** 그리기 때문에, 비로그인으로 열면 화면 쪽 권한 확인(requireCreator 등)도 함께 실행되어
 * 서버 로그에 "로그인이 필요합니다" 오류가 남았다(화면은 정상적으로 로그인으로 이동). 돌아갈 주소도 /studio · /my 로만 잡혔다.
 *
 * 그래서 로그인 쿠키가 **아예 없는** 요청은 화면을 그리기 전에 여기서 로그인 화면으로 보낸다(원래 열려던 주소를 next 로).
 * 쿠키가 있으면 그대로 통과시킨다 — 세션이 유효한지 · 권한이 맞는지는 지금처럼 레이아웃과 화면이 확인한다.
 * (여기서는 DB · 공유 모듈을 쓰지 않는다. 쿠키 이름만 auth.ts 의 SESSION_COOKIE 와 맞춘다)
 */
const SESSION_COOKIE = 'tornado_session';

export function proxy(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/studio', '/studio/:path*', '/admin', '/admin/:path*', '/my', '/my/:path*'],
};
