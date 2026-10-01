/** URL을 정규화한 뒤 앱 내부 사용자 화면만 허용한다. OAuth·테스트 로그인이 공유한다. */
export function authReturnPath(value: unknown, fallback = '/my'): string {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || /[\\\s\u0000-\u001f]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'https://donaido.invalid');
    const decoded = decodeURIComponent(url.pathname);
    if (url.origin !== 'https://donaido.invalid' || /[\\\u0000-\u001f]/.test(decoded) || decoded.startsWith('//')) return fallback;
    /**
     * 허용 경로.
     *  - 크리에이터 후원 페이지와 **그 안의 하위 화면들**. 후원 페이지는 메인으로 나가는 길을
     *    두지 않는 독립 화면이라, 로그인·로그아웃 뒤에도 그 안으로 돌아와야 한다.
     *  - 마이페이지 계열.
     * 그 밖의 경로는 fallback 으로 떨어뜨린다(오픈 리다이렉트 방지).
     */
    const CREATOR_SUB = 'messages|notifications|support|how-it-works|login|account';
    if (!new RegExp(`^/(?:c/TOR-[A-Z0-9]{2,10}(?:/(?:${CREATOR_SUB}))?/?|my(?:/[^?#]*)?)$`).test(decoded)) {
      return fallback;
    }
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}

/**
 * 로그인 후 이동 경로 검사 — 같은 사이트 내부 경로만 허용한다 (2026-10-01).
 *
 * `authReturnPath` 는 후원 페이지·마이페이지만 허용하는 좁은 규칙이라, 스튜디오·관리자 화면으로
 * 돌아가야 하는 로그인에는 쓸 수 없다. 대신 **해석 결과의 출처가 우리 사이트인지**를 확인한다.
 *
 * 예전 검사(`/^\/(?![\/\\])/`)는 두 번째 글자 탭을 막지 못했다. URL 파서는 탭·줄바꿈을
 * 지우고 해석하므로 `/\t/evil.com` 은 `//evil.com` → `https://evil.com/` 이 된다.
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // 공백·제어문자·역슬래시는 어디에 있든 거절한다(파서별 정규화 차이를 이용한 우회 차단).
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const base = 'https://donaido.invalid';
    const url = new URL(value, base);
    if (url.origin !== base) return null;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f]/.test(decoded)) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
