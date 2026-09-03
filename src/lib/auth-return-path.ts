/** URL을 정규화한 뒤 앱 내부 사용자 화면만 허용한다. OAuth·테스트 로그인이 공유한다. */
export function authReturnPath(value: unknown, fallback = '/my'): string {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || /[\\\s\u0000-\u001f]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'https://donaido.invalid');
    const decoded = decodeURIComponent(url.pathname);
    if (url.origin !== 'https://donaido.invalid' || /[\\\u0000-\u001f]/.test(decoded) || decoded.startsWith('//')) return fallback;
    if (!/^\/(?:c\/TOR-[A-Z0-9]{2,10}(?:\/messages)?\/?|my(?:\/[^?#]*)?)$/.test(decoded)) return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}
