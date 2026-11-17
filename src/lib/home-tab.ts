/**
 * 메인 화면 탭 — [크리에이터 전용] / [구독자 전용] (2026-11-17)
 *
 * 기본 탭 결정 순서
 *   1. 주소의 ?tab=creator | ?tab=fan
 *   2. 사용자가 직접 고른 탭 (쿠키). 쿠키에는 "누가 골랐는지"를 함께 적어 두고,
 *      로그인·로그아웃으로 사람이 바뀌면 그 쿠키는 무시한다 → 로그인 직후에는 역할 기본값이 보인다.
 *   3. 역할 기본값 — 크리에이터 → 크리에이터 전용 / 그 외(비로그인·일반회원·관리자) → 구독자 전용 (2026-11-17 변경)
 *
 * 이 파일은 브라우저 번들에도 실린다. env·DB·node 모듈을 import 하지 않는다.
 */

export type HomeTab = 'creator' | 'fan';

export const HOME_TAB_COOKIE = 'donaido_home_tab';

export const HOME_TAB_LABEL: Record<HomeTab, string> = {
  creator: '크리에이터 전용',
  fan: '구독자 전용',
};

export type HomeViewerRole = 'DONOR' | 'CREATOR' | 'ADMIN' | null | undefined;

export function isHomeTab(v: unknown): v is HomeTab {
  return v === 'creator' || v === 'fan';
}

/** 쿠키에 적는 "고른 사람" 표식. 비로그인은 guest. */
export function homeTabOwner(userId: string | null | undefined): string {
  return userId ? `u:${userId}` : 'guest';
}

export function encodeHomeTabCookie(tab: HomeTab, userId: string | null | undefined): string {
  return `${tab}|${homeTabOwner(userId)}`;
}

/** 쿠키 값을 읽는다. 다른 사람이 고른 값이거나 형식이 틀리면 null. */
export function decodeHomeTabCookie(raw: string | null | undefined, userId: string | null | undefined): HomeTab | null {
  if (!raw) return null;
  const sep = raw.indexOf('|');
  if (sep < 0) return null;
  const tab = raw.slice(0, sep);
  const owner = raw.slice(sep + 1);
  if (!isHomeTab(tab)) return null;
  if (owner !== homeTabOwner(userId)) return null;
  return tab;
}

export function defaultHomeTabForRole(role: HomeViewerRole): HomeTab {
  return role === 'CREATOR' ? 'creator' : 'fan';
}

export function resolveHomeTab(input: {
  query?: string | string[] | null;
  cookie?: string | null;
  userId?: string | null;
  role?: HomeViewerRole;
}): HomeTab {
  const q = Array.isArray(input.query) ? input.query[0] : input.query;
  if (isHomeTab(q)) return q;
  const picked = decodeHomeTabCookie(input.cookie, input.userId);
  if (picked) return picked;
  return defaultHomeTabForRole(input.role);
}

/** 브라우저에서 고른 탭을 기억한다 (180일). 쿠키를 못 쓰는 환경이면 조용히 넘어간다 — 주소(?tab=)만으로도 동작한다. */
export function rememberHomeTab(tab: HomeTab, userId: string | null | undefined): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = `${HOME_TAB_COOKIE}=${encodeURIComponent(encodeHomeTabCookie(tab, userId))}; path=/; max-age=${60 * 60 * 24 * 180}; samesite=lax`;
  } catch {
    // 무시
  }
}
