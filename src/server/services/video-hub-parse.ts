/**
 * 영상 허브 — 순수 함수 모음 (DB·네트워크 없음, 단위 테스트 대상).
 *
 *  - parseYouTubeFeed : 유튜브 채널 공개 RSS(Atom) → 영상 목록
 *  - parseChannelSpecs: 환경변수 VIDEO_HUB_CHANNELS → 채널·카테고리 목록
 *  - channelIdFromUrl : 크리에이터가 입력한 채널 주소에서 UC… 채널 ID 추출
 *  - filterVideos     : 카테고리·검색어 필터
 *
 * 유튜브 RSS(https://www.youtube.com/feeds/videos.xml?channel_id=…)는 유튜브가 공개로 제공하는 피드라
 * 화면을 긁는 스크래핑이 아니며 Data API 할당량도 쓰지 않는다. 라이브 채팅 등록에 쓰는 일일 할당량과
 * 완전히 분리된다.
 */
import {
  CONTENT_CATEGORY_SLUGS,
  isVideoCategory,
  isYouTubeChannelId,
  isYouTubeVideoId,
  type VideoCategorySlug,
  type VideoItem,
} from '@/lib/video-hub';

export interface RawFeedVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumbnail: string | null;
  publishedAt: string;
  views: number | null;
  isShort: boolean;
}

export interface ChannelSpec {
  channelId: string;
  category: VideoCategorySlug;
  creator: VideoItem['creator'];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
      if (e.startsWith('#x')) return safeCodePoint(parseInt(e.slice(2), 16), m);
      if (e.startsWith('#')) return safeCodePoint(parseInt(e.slice(1), 10), m);
      return ENTITIES[e] ?? m;
    })
    .trim();
}

function safeCodePoint(n: number, fallback: string): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
}

function attr(block: string, name: string, attribute: string): string | null {
  const m = block.match(new RegExp(`<${name}\\s[^>]*?${attribute}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

/** 썸네일은 유튜브 이미지 서버(https://i.ytimg.com …)만 허용한다. 다른 주소는 버린다. */
function safeThumb(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)ytimg\.com$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 유튜브 채널 RSS(Atom) 파싱.
 * 형식이 깨졌거나 필수 값이 없는 항목은 건너뛴다(예외를 던지지 않는다).
 */
export function parseYouTubeFeed(xml: string, expectedChannelId?: string): RawFeedVideo[] {
  if (typeof xml !== 'string' || !xml.includes('<feed')) return [];
  const head = xml.split('<entry')[0];
  const feedChannelId = tag(head, 'yt:channelId');
  const feedTitle = tag(head, 'title') ?? '';
  const out: RawFeedVideo[] = [];

  for (const m of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const id = tag(block, 'yt:videoId');
    if (!isYouTubeVideoId(id)) continue;
    const channelId = tag(block, 'yt:channelId') ?? feedChannelId ?? '';
    if (!isYouTubeChannelId(channelId)) continue;
    if (expectedChannelId && channelId !== expectedChannelId) continue;
    const published = tag(block, 'published');
    const publishedAt = published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null;
    if (!publishedAt) continue;
    const viewsRaw = attr(block, 'media:statistics', 'views');
    const views = viewsRaw != null && /^\d+$/.test(viewsRaw) ? Number(viewsRaw) : null;
    const link = attr(block, 'link', 'href') ?? '';
    const author = block.match(/<author>([\s\S]*?)<\/author>/);
    out.push({
      id,
      title: (tag(block, 'title') ?? tag(block, 'media:title') ?? '').slice(0, 200) || '제목 없음',
      channelId,
      channelTitle: ((author ? tag(author[1], 'name') : null) ?? feedTitle).slice(0, 80) || '채널',
      thumbnail: safeThumb(attr(block, 'media:thumbnail', 'url')) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      publishedAt,
      views,
      isShort: /\/shorts\//.test(link),
    });
  }
  return out;
}

/**
 * VIDEO_HUB_CHANNELS="UCxxxx:mukbang,UCyyyy:humor" 형식.
 * 카테고리를 생략하거나 잘못 쓰면 'talk'(팬챗)으로 둔다. 형식이 틀린 채널 ID 는 버린다.
 */
export function parseChannelSpecs(raw: string | undefined | null): Array<{ channelId: string; category: VideoCategorySlug }> {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: Array<{ channelId: string; category: VideoCategorySlug }> = [];
  for (const part of raw.split(/[,\n]/)) {
    const [idRaw, catRaw] = part.trim().split(':').map((v) => v?.trim());
    if (!isYouTubeChannelId(idRaw) || seen.has(idRaw)) continue;
    seen.add(idRaw);
    const category = isVideoCategory(catRaw) && CONTENT_CATEGORY_SLUGS.includes(catRaw) ? catRaw : 'talk';
    out.push({ channelId: idRaw, category });
  }
  return out;
}

/** https://www.youtube.com/channel/UC… 형태의 주소에서 채널 ID 를 꺼낸다. @핸들 주소는 ID 를 알 수 없어 null. */
export function channelIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  return m ? m[1] : null;
}

export function toVideoItem(raw: RawFeedVideo, spec: ChannelSpec): VideoItem {
  return { ...raw, source: 'youtube', category: spec.category, creator: spec.creator };
}

/** 카테고리·검색어 필터. 검색은 제목·채널명에 대해 대소문자 무시 부분 일치. */
export function filterVideos(items: VideoItem[], opts: { c?: string | null; p?: string | null; q?: string | null }): VideoItem[] {
  const c = opts.c && opts.c !== 'all' ? opts.c : null;
  const p = opts.p && opts.p !== 'all' ? opts.p : null;
  const q = (opts.q ?? '').trim().toLowerCase().slice(0, 50);
  return items.filter((v) => {
    if (c === 'donaido' && !v.creator) return false;
    if (c && c !== 'donaido' && v.category !== c) return false;
    if (p && (v.platform ?? 'youtube') !== p) return false;
    if (q && !v.title.toLowerCase().includes(q) && !v.channelTitle.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** 최신순 정렬 + 같은 영상 중복 제거 */
export function mergeVideos(lists: VideoItem[][]): VideoItem[] {
  const map = new Map<string, VideoItem>();
  for (const list of lists) for (const v of list) if (!map.has(v.id)) map.set(v.id, v);
  return [...map.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
