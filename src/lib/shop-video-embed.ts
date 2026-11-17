/**
 * 도네이도 샵 영상 — 플랫폼별 공식 임베드 주소 (2026-11-17). 브라우저·서버 공용.
 * 주소 붙여넣기로 등록한 영상은 ID 만 뽑아 공식 임베드 주소를 다시 만든다(임의 주소를 iframe 에 넣지 않는다).
 */
export type ShopVideoPlatform = 'YOUTUBE' | 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK';

export interface ParsedVideoUrl {
  platform: ShopVideoPlatform;
  externalId: string;
  url: string;
}

export function parseVideoUrl(raw: string): ParsedVideoUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const path = u.pathname;
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id =
      host === 'youtu.be' ? path.slice(1, 12) : u.searchParams.get('v') ?? path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/)?.[1] ?? '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { platform: 'YOUTUBE', externalId: id, url: `https://www.youtube.com/watch?v=${id}` } : null;
  }
  if (host === 'tiktok.com') {
    const id = path.match(/\/video\/(\d{8,25})/)?.[1];
    return id ? { platform: 'TIKTOK', externalId: id, url: `https://www.tiktok.com${path.split('?')[0]}` } : null;
  }
  if (host === 'instagram.com') {
    const m = path.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]{5,40})/);
    return m ? { platform: 'INSTAGRAM', externalId: `${m[1]}/${m[2]}`, url: `https://www.instagram.com/${m[1]}/${m[2]}/` } : null;
  }
  if (host === 'facebook.com' || host === 'fb.watch') {
    const clean = `https://www.facebook.com${path}`.replace(/\/+$/, '');
    const id = path.match(/\/videos\/(?:[^/]+\/)?(\d{6,25})/)?.[1] ?? u.searchParams.get('v') ?? '';
    return /^\d{6,25}$/.test(id) ? { platform: 'FACEBOOK', externalId: id, url: clean } : null;
  }
  return null;
}

export function embedUrlFor(platform: string, externalId: string, url: string, autoplay = false): string | null {
  switch (platform) {
    case 'YOUTUBE':
      return /^[A-Za-z0-9_-]{11}$/.test(externalId)
        ? `https://www.youtube-nocookie.com/embed/${externalId}?rel=0&playsinline=1${autoplay ? '&autoplay=1' : ''}`
        : null;
    case 'TIKTOK':
      return /^\d{8,25}$/.test(externalId) ? `https://www.tiktok.com/embed/v2/${externalId}` : null;
    case 'INSTAGRAM':
      return /^(p|reel|tv)\/[A-Za-z0-9_-]{5,40}$/.test(externalId) ? `https://www.instagram.com/${externalId}/embed` : null;
    case 'FACEBOOK':
      return /^\d{6,25}$/.test(externalId)
        ? `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`
        : null;
    default:
      return null;
  }
}

export function liveThumbnailUrl(url: string | null): string | null {
  const video = url ? parseVideoUrl(url) : null;
  return video?.platform === 'YOUTUBE' ? `https://i.ytimg.com/vi/${video.externalId}/mqdefault.jpg` : null;
}

export const SHOP_VIDEO_PLATFORM_LABEL: Record<string, string> = { YOUTUBE: 'YouTube', TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook' };
