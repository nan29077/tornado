import { redirect } from 'next/navigation';
import { requireAdmin, type SessionUser } from '@/server/auth';

/**
 * 관리자 화면 **페이지 단위** 인증 가드 (A-1).
 *
 * 왜 레이아웃만으로는 부족한가
 * ----------------------------
 * `src/app/admin/layout.tsx` 가 이미 requireAdmin() 을 부르지만, 레이아웃 한 겹에만 기대면
 * 다음 상황에서 그대로 뚫린다.
 *  - 페이지가 다른 라우트 그룹으로 옮겨지거나 레이아웃이 리팩터링되면서 가드가 빠지는 경우
 *  - 부분 렌더(RSC payload) 요청이 페이지 세그먼트만 다시 그리는 경우
 *  - 레이아웃이 렌더되기 전에 페이지의 데이터 조회가 먼저 실행되는 경우
 *    (레이아웃과 페이지는 **병렬로** 렌더된다. 레이아웃이 redirect 를 결정하기 전에
 *     페이지의 prisma 조회가 이미 나가 회원 개인정보·결제 내역을 읽는다)
 * 마지막 항목이 실제 위험이다. 화면에 보이지 않더라도 조회는 일어난다.
 *
 * 그래서 각 page.tsx 는 **데이터 조회보다 먼저** 이 함수를 부른다.
 *
 * 레이아웃과 같은 기준으로 로그인 화면으로 보낸다(예외를 던져 오류 화면을 띄우지 않는다).
 */
export async function requireAdminPage(next = '/admin'): Promise<SessionUser> {
  let admin: SessionUser | null = null;
  try {
    admin = await requireAdmin();
  } catch {
    admin = null;
  }
  if (!admin) redirect(`/login?next=${encodeURIComponent(next)}`);
  return admin;
}
