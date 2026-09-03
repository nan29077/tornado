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
