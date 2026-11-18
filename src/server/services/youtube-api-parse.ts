/**
 * YouTube Data API v3 응답 해석 — 순수 함수 (DB·네트워크 없음, 단위 테스트 대상) (2026-11-18).
 */
import { isYouTubeChannelId, isYouTubeVideoId } from '@/lib/video-hub';

/** ISO 8601 기간(PT1H2M3S) → 초. 해석할 수 없으면 null */
export function parseIsoDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m || v === 'P' || v === 'PT') return null;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
}

export type ChannelLookup = { kind: 'id'; value: string } | { kind: 'handle'; value: string };

/**
 * 관리자가 입력한 채널 → 조회 방법.
 *  UC… / youtube.com/channel/UC… → 채널 ID
 *  @핸들 / youtube.com/@핸들      → 핸들 (channels.list forHandle)
 */
export function parseChannelInput(raw: string): ChannelLookup | null {
  const v = raw.trim();
  if (!v || v.length > 200) return null;
  if (isYouTubeChannelId(v as unknown)) return { kind: 'id', value: v };
  const handle = (h: string) => {
    const clean = decodeURIComponentSafe(h).replace(/^@/, '');
    return /^[\p{L}\p{N}._-]{3,100}$/u.test(clean) ? ({ kind: 'handle', value: `@${clean}` } as const) : null;
  };
  if (v.startsWith('@')) return handle(v);
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host !== 'youtube.com') return null;
  const [first, second] = u.pathname.split('/').filter(Boolean).map(decodeURIComponentSafe);
  if (first === 'channel' && isYouTubeChannelId(second)) return { kind: 'id', value: second };
  if (first?.startsWith('@')) return handle(first);
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface ApiChannelInfo {
  channelId: string;
  title: string | null;
  handle: string | null;
  avatarUrl: string | null;
  subscriberCount: number | null;
  uploadsPlaylistId: string | null;
}

const INT_MAX = 2_147_483_647;

function toInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(INT_MAX, Math.floor(n));
}

function httpsOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

/** channels.list 응답의 첫 항목 */
export function parseChannelResponse(json: unknown): ApiChannelInfo | null {
  const item = obj((obj(json).items as unknown[] | undefined)?.[0]);
  const channelId = item.id;
  if (!isYouTubeChannelId(channelId)) return null;
  const sn = obj(item.snippet);
  const thumbs = obj(sn.thumbnails);
  const uploads = obj(obj(item.contentDetails).relatedPlaylists).uploads;
  const stats = obj(item.statistics);
  return {
    channelId,
    title: typeof sn.title === 'string' ? sn.title.slice(0, 200) : null,
    handle: typeof sn.customUrl === 'string' ? sn.customUrl.slice(0, 100) : null,
    avatarUrl: httpsOrNull(obj(thumbs.medium).url) ?? httpsOrNull(obj(thumbs.default).url),
    subscriberCount: stats.hiddenSubscriberCount === true ? null : toInt(stats.subscriberCount),
    uploadsPlaylistId: typeof uploads === 'string' && /^[A-Za-z0-9_-]{10,60}$/.test(uploads) ? uploads : null,
  };
}

/** playlistItems.list 응답 → 영상 ID 목록 */
export function parsePlaylistVideoIds(json: unknown): string[] {
  const items = (obj(json).items as unknown[] | undefined) ?? [];
  const ids = items.map((i) => obj(obj(i).contentDetails).videoId ?? obj(obj(obj(i).snippet).resourceId).videoId);
  return [...new Set(ids.filter(isYouTubeVideoId))];
}

export interface ApiVideoInfo {
  videoId: string;
  channelId: string;
  title: string;
  thumbnail: string | null;
  publishedAt: Date;
  views: number | null;
  durationSec: number | null;
  isShort: boolean;
  liveState: 'none' | 'live' | 'upcoming';
  /** 공개 영상이 아니거나(비공개·삭제) 퍼가기를 막은 영상이면 false — 저장하지 않는다 */
  usable: boolean;
}

/** 쇼츠 판정: 3분 이하이면서 제목·설명에 #shorts 가 있거나 1분 이하 */
export function looksLikeShort(durationSec: number | null, text: string): boolean {
  if (durationSec == null || durationSec <= 0) return false;
  if (durationSec <= 60) return true;
  return durationSec <= 180 && /#shorts?\b/i.test(text);
}

/** videos.list 응답 → 영상 정보 */
export function parseVideosResponse(json: unknown): ApiVideoInfo[] {
  const items = (obj(json).items as unknown[] | undefined) ?? [];
  const out: ApiVideoInfo[] = [];
  for (const raw of items) {
    const item = obj(raw);
    if (!isYouTubeVideoId(item.id)) continue;
    const sn = obj(item.snippet);
    const status = obj(item.status);
    const thumbs = obj(sn.thumbnails);
    const publishedAt = new Date(typeof sn.publishedAt === 'string' ? sn.publishedAt : NaN);
    if (!isYouTubeChannelId(sn.channelId) || Number.isNaN(publishedAt.getTime())) continue;
    const title = typeof sn.title === 'string' && sn.title.trim() ? sn.title.trim().slice(0, 300) : '제목 없음';
    const durationSec = parseIsoDuration(obj(item.contentDetails).duration);
    const live = sn.liveBroadcastContent === 'live' ? 'live' : sn.liveBroadcastContent === 'upcoming' ? 'upcoming' : 'none';
    const privacy = status.privacyStatus;
    out.push({
      videoId: item.id,
      channelId: sn.channelId,
      title,
      thumbnail:
        httpsOrNull(obj(thumbs.high).url) ?? httpsOrNull(obj(thumbs.medium).url) ?? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      publishedAt,
      views: toInt(obj(item.statistics).viewCount),
      durationSec,
      isShort: looksLikeShort(durationSec, `${title} ${typeof sn.description === 'string' ? sn.description.slice(0, 500) : ''}`),
      liveState: live,
      usable: (privacy == null || privacy === 'public') && status.embeddable !== false,
    });
  }
  return out;
}

/** API 오류 응답 → 관리자용 한국어 사유 */
export function describeApiError(status: number, json: unknown): string {
  const err = obj(obj(json).error);
  const reason = String(obj((err.errors as unknown[] | undefined)?.[0]).reason ?? err.status ?? '');
  if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(reason)) return '오늘 YouTube API 할당량을 모두 썼습니다. (태평양 시간 자정에 초기화)';
  if (/keyInvalid|API_KEY_INVALID|badRequest/i.test(reason) && status === 400) return 'API 키가 올바르지 않습니다. Google Cloud 콘솔에서 키를 다시 확인해 주세요.';
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason)) return '이 키의 프로젝트에서 YouTube Data API v3 가 사용 설정되어 있지 않습니다.';
  if (/ipRefererBlocked|keyExpired|forbidden/i.test(reason) || status === 403) return '키 사용이 거부되었습니다. 키의 애플리케이션·API 제한 설정을 확인해 주세요.';
  if (status === 404) return '채널 또는 재생목록을 찾을 수 없습니다.';
  return `YouTube API 오류 (HTTP ${status}${reason ? `, ${reason}` : ''})`;
}

/** 키 표시용 마스킹: 앞 4 · 뒤 4 자리만 */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

/** 형식 검사 (구글 API 키는 보통 AIza 로 시작하는 39자) */
export function isPlausibleApiKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{30,60}$/.test(key.trim());
}
