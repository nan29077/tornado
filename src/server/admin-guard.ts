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

/**
 * 화면 단위 등급 판정 (A-1 / R-3 / A-18).
 *
 * 서버 액션 쪽 가드(`assertFinanceAdmin` / `assertOperationAdmin`)와 **같은 등급 집합**을 쓴다.
 * 액션만 막고 화면은 그대로 두면, 권한 없는 담당자가 폼을 채우고 제출한 뒤에야
 * "권한이 없습니다" 를 보게 된다. 눌러 봐야 알 수 있는 버튼은 안내가 아니라 함정이다.
 *
 * 이 파일에 둔 이유: 페이지(서버 컴포넌트)에서 `'use server'` 모듈을 거치지 않고 부르기 위함.
 */
export const FINANCE_VIEW_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'FINANCE', 'OPERATION']);
export const OPERATION_VIEW_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'OPERATION']);

/** 재무 성격 변경(정산·환불·수수료·세무)을 할 수 있는 등급인가. */
export function canWriteFinance(admin: SessionUser): boolean {
  return Boolean(admin.adminPermission && FINANCE_VIEW_PERMISSIONS.has(admin.adminPermission));
}

/** 운영 성격 변경(승인·정지·번호 배정)과 민감 정보 열람이 가능한 등급인가. */
export function canWriteOperation(admin: SessionUser): boolean {
  return Boolean(admin.adminPermission && OPERATION_VIEW_PERMISSIONS.has(admin.adminPermission));
}

/** 버튼을 비활성화할 때 함께 보여 줄 사유. 권한이 있으면 undefined. */
export function financeDenyReason(admin: SessionUser, what = '이 작업'): string | undefined {
  return canWriteFinance(admin) ? undefined : `${what}은(는) 재무 또는 운영 권한에서만 가능합니다.`;
}

export function operationDenyReason(admin: SessionUser, what = '이 작업'): string | undefined {
  return canWriteOperation(admin) ? undefined : `${what}은(는) 운영 권한(OPERATION) 이상에서만 가능합니다.`;
}
