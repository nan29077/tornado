/**
 * 크리에이터 채널 — 화면과 서버가 함께 쓰는 플랫폼 목록·주소 검증 (2026-11-17).
 * 브라우저 번들에도 실리므로 env·DB·node 모듈을 import 하지 않는다.
 */

export const CHANNEL_PLATFORMS = [
  { value: 'YOUTUBE', label: 'YouTube', placeholder: 'https://www.youtube.com/@channel', hosts: ['youtube.com', 'youtu.be'], countLabel: '구독자' },
  { value: 'TIKTOK', label: 'TikTok', placeholder: 'https://www.tiktok.com/@username', hosts: ['tiktok.com'], countLabel: '팔로워' },
  { value: 'INSTAGRAM', label: 'Instagram', placeholder: 'https://www.instagram.com/username', hosts: ['instagram.com'], countLabel: '팔로워' },
  { value: 'FACEBOOK', label: 'Facebook', placeholder: 'https://www.facebook.com/pagename', hosts: ['facebook.com', 'fb.com'], countLabel: '팔로워' },
  { value: 'CHZZK', label: '치지직', placeholder: 'https://chzzk.naver.com/채널ID', hosts: ['chzzk.naver.com'], countLabel: '팔로워' },
  { value: 'SOOP', label: '숲(SOOP)', placeholder: 'https://www.sooplive.co.kr/아이디', hosts: ['sooplive.co.kr', 'afreecatv.com'], countLabel: '애청자' },
  { value: 'TWITCH', label: 'Twitch', placeholder: 'https://www.twitch.tv/username', hosts: ['twitch.tv'], countLabel: '팔로워' },
  { value: 'OTHER', label: '기타', placeholder: 'https://', hosts: [] as string[], countLabel: '구독자·팔로워' },
] as const;

export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number]['value'];

export const MAX_CHANNELS = 8;

export function isChannelPlatform(v: unknown): v is ChannelPlatform {
  return typeof v === 'string' && CHANNEL_PLATFORMS.some((p) => p.value === v);
}

export function platformLabel(v: string): string {
  return CHANNEL_PLATFORMS.find((p) => p.value === v)?.label ?? v;
}

export function platformCountLabel(v: string): string {
  return CHANNEL_PLATFORMS.find((p) => p.value === v)?.countLabel ?? '구독자';
}

/** 중복 신청 차단용 정규화 키: 소문자, 프로토콜·www·m. 제거, 쿼리·해시·끝 슬래시 제거 */
export function channelUrlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** 채널 주소 검증. 문제가 없으면 null */
export function validateChannelUrl(platform: string, url: string): string | null {
  const v = url.trim();
  if (!v) return '채널 주소를 입력해 주세요.';
  if (v.length > 300) return '채널 주소가 너무 깁니다.';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return '채널 주소는 https:// 로 시작하는 전체 주소로 입력해 주세요.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '채널 주소는 https:// 로 시작해야 합니다.';
  const p = CHANNEL_PLATFORMS.find((x) => x.value === platform);
  if (!p) return '플랫폼을 선택해 주세요.';
  if (p.hosts.length > 0) {
    const host = u.hostname.toLowerCase();
    if (!p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return `${p.label} 주소가 아닙니다. (${p.placeholder} 형식)`;
    }
  }
  if (u.pathname.replace(/\/+$/, '') === '') return '채널 주소에 채널 아이디(경로)가 빠져 있습니다.';
  return null;
}

/** "1.2만", "12,345", "3k" 같은 입력을 숫자로. 해석 불가면 null */
export function parseFollowerCount(raw: string): number | null {
  const v = raw.trim().replace(/,/g, '').toLowerCase();
  if (!v) return null;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(만|천|억|k|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const mul = { 만: 10_000, 천: 1_000, 억: 100_000_000, k: 1_000, m: 1_000_000 }[m[2] as '만'] ?? 1;
  const out = Math.round(n * mul);
  return Number.isFinite(out) && out >= 0 && out <= 2_000_000_000 ? out : null;
}

export function formatFollowerCount(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}억`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}만`;
  return n.toLocaleString('ko-KR');
}

/** youtube.com/channel/UC… 주소에서 채널 ID */
export function youtubeChannelIdFromUrl(url: string): string | null {
  const m = url.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  return m ? m[1] : null;
}
