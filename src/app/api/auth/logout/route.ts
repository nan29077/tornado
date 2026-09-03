import { NextResponse } from 'next/server';
import { destroySession } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { authReturnPath } from '@/lib/auth-return-path';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // CSRF 방어: 외부 사이트가 사용자를 임의로 로그아웃시키지 못하게 한다.
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  }

  /**
   * 로그아웃 뒤 돌아갈 곳.
   *
   * 크리에이터 후원 페이지는 "그 페이지 안에서만 머무는" 화면이라, 로그아웃했다고
   * 도네이도 메인으로 튕겨 나가면 후원자가 보던 크리에이터를 잃어버린다.
   * 폼에서 넘어온 next 를 쓰되 **내부 경로만** 허용한다(authReturnPath 가 걸러 준다).
   */
  let next = '/';
  try {
    const form = await req.formData();
    next = authReturnPath(form.get('next'), '/');
  } catch {
    // 폼이 아닌 요청(fetch 등)이면 기본값을 쓴다.
  }

  await destroySession();
  return NextResponse.redirect(new URL(next, req.url), 303);
}
