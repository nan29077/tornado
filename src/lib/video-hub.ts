/**
 * 영상 허브 — 화면(클라이언트)과 서버가 함께 쓰는 타입·카테고리·표시 도우미.
 *
 * 이 파일은 브라우저 번들에도 실린다. 그래서 env·DB·node 모듈을 절대 import 하지 않는다.
 * (tests/client-bundle-safety.test.ts 가 검사한다)
 *
 * 데이터를 모으는 쪽은 src/server/services/video-hub.ts 다.
 */

export type VideoSource = 'youtube' | 'sample';

export interface VideoItem {
  /** 유튜브 videoId(11자). 샘플은 'sample-' 접두사 */
  id: string;
  source: VideoSource;
  title: string;
  channelId: string;
  channelTitle: string;
  channelAvatarUrl?: string | null;
  /** 썸네일 URL. 없으면 화면에서 그러데이션 대체 이미지를 그린다 */
  thumbnail: string | null;
  /** ISO 시각 */
  publishedAt: string;
  /** 조회수. 출처가 주지 않으면 null */
  views: number | null;
  /** 카테고리 slug (VIDEO_CATEGORIES 의 값) */
  category: VideoCategorySlug;
  /** 쇼츠 여부 (피드 링크가 /shorts/ 인 경우) */
  isShort: boolean;
  /** 도네이도에 가입·승인된 크리에이터면 후원 페이지로 연결한다. 미가입이면 null */
  creator: {
    code: string;
    displayName: string;
    avatarUrl?: string | null;
    avatarIndex?: number | null;
  } | null;
}

/**
 * 카테고리 (2026-11-17 확장: 시사·정치·경제·예능·요리·댄스·지식·과학·IT·자동차·영화·드라마·애니·캠핑 등).
 * - 'all' 은 필터 없음, 'donaido' 는 "후원 가능(가입 크리에이터)" 모아보기다.
 * - 기존 slug 는 크리에이터 신청서(contentCategory)에도 저장되므로 바꾸거나 지우지 않는다. 추가만 한다.
 * - 성인 카테고리는 법률 검토(본인인증 게이트) 결정 전까지 넣지 않는다.
 */
export const VIDEO_CATEGORIES = [
  { slug: 'all', label: '전체' },
  { slug: 'donaido', label: '후원 가능' },
  { slug: 'news', label: '시사' },
  { slug: 'politics', label: '정치' },
  { slug: 'economy', label: '경제' },
  { slug: 'humor', label: '유머' },
  { slug: 'entertain', label: '예능' },
  { slug: 'talk', label: '소통·토크' },
  { slug: 'mukbang', label: '먹방' },
  { slug: 'cooking', label: '요리' },
  { slug: 'game', label: '게임' },
  { slug: 'music', label: '노래·음악' },
  { slug: 'dance', label: '댄스' },
  { slug: 'movie', label: '영화·리뷰' },
  { slug: 'drama', label: '드라마' },
  { slug: 'animation', label: '애니·웹툰' },
  { slug: 'beauty', label: '뷰티' },
  { slug: 'travel', label: '여행' },
  { slug: 'camping', label: '캠핑·아웃도어' },
  { slug: 'pet', label: '반려동물' },
  { slug: 'sports', label: '운동·스포츠' },
  { slug: 'knowledge', label: '지식·교양' },
  { slug: 'science', label: '과학' },
  { slug: 'tech', label: 'IT·테크' },
  { slug: 'car', label: '자동차' },
  { slug: 'study', label: '공부' },
  { slug: 'finance', label: '주식·코인' },
  { slug: 'fishing', label: '낚시' },
] as const;

export type VideoCategorySlug = (typeof VIDEO_CATEGORIES)[number]['slug'];

/** 실제 영상에 붙일 수 있는 카테고리 (모아보기용 all·donaido 제외) */
export const CONTENT_CATEGORY_SLUGS = VIDEO_CATEGORIES.map((c) => c.slug).filter(
  (s) => s !== 'all' && s !== 'donaido',
) as VideoCategorySlug[];

export function isVideoCategory(value: unknown): value is VideoCategorySlug {
  return typeof value === 'string' && VIDEO_CATEGORIES.some((c) => c.slug === value);
}

export function categoryLabel(slug: string): string {
  return VIDEO_CATEGORIES.find((c) => c.slug === slug)?.label ?? '기타';
}

/** 유튜브 videoId 형식 (11자, 영문·숫자·-·_) */
export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}

/** 유튜브 채널 ID 형식 (UC + 22자) */
export function isYouTubeChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(value);
}

/** 조회수 표기: 1,234 → 1.2천회, 12,345 → 1.2만회, 123,456,789 → 1.2억회 */
export function formatViews(views: number | null): string | null {
  if (views == null || !Number.isFinite(views) || views < 0) return null;
  const trim = (n: number) => (n >= 10 ? Math.floor(n).toString() : (Math.floor(n * 10) / 10).toString());
  if (views >= 100_000_000) return `조회수 ${trim(views / 100_000_000)}억회`;
  if (views >= 10_000) return `조회수 ${trim(views / 10_000)}만회`;
  if (views >= 1_000) return `조회수 ${trim(views / 1_000)}천회`;
  return `조회수 ${views}회`;
}

/** 경과 시간 표기 (유튜브식): 방금 전 / 5분 전 / 3시간 전 / 2일 전 / 3주 전 / 4개월 전 / 1년 전 */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return '방금 전';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}일 전`;
  if (day < 30) return `${Math.floor(day / 7)}주 전`;
  if (day < 365) return `${Math.floor(day / 30)}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}

/** /videos 링크 (카테고리·검색어 유지) */
export const VIDEO_ORDERS = [
  { value: 'latest', label: '최신 영상' },
  { value: 'popular', label: '인기 영상' },
  { value: 'recommended', label: '추천 영상' },
] as const;

export type VideoOrder = (typeof VIDEO_ORDERS)[number]['value'];

export function videoOrder(value: unknown): VideoOrder {
  return VIDEO_ORDERS.find((order) => order.value === value)?.value ?? 'latest';
}

/** 추천은 후원 가능한 채널을 우선하고, 채널마다 한 편씩 번갈아 소개한다. */
export function sortVideos(items: VideoItem[], order: VideoOrder): VideoItem[] {
  const latest = (a: VideoItem, b: VideoItem) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  const popular = (a: VideoItem, b: VideoItem) => (b.views ?? -1) - (a.views ?? -1) || latest(a, b);
  const sorted = [...items].sort(order === 'latest' ? latest : popular);
  if (order !== 'recommended') return sorted;
  sorted.sort((a, b) => Number(Boolean(b.creator)) - Number(Boolean(a.creator)));
  const channels = new Map<string, VideoItem[]>();
  for (const item of sorted) {
    const queue = channels.get(item.channelId) ?? [];
    queue.push(item);
    channels.set(item.channelId, queue);
  }
  const result: VideoItem[] = [];
  for (let round = 0; result.length < sorted.length; round++) {
    for (const queue of channels.values()) if (queue[round]) result.push(queue[round]);
  }
  return result;
}

/** 영상 형식 탭: 전체 / 동영상 / 쇼츠 / 라이브 */
export const VIDEO_TYPES = [
  { value: 'all', label: '전체' },
  { value: 'video', label: '동영상' },
  { value: 'shorts', label: '쇼츠' },
  { value: 'live', label: '라이브' },
] as const;

export type VideoType = (typeof VIDEO_TYPES)[number]['value'];

export function videoType(value: unknown): VideoType {
  return VIDEO_TYPES.find((t) => t.value === value)?.value ?? 'all';
}

/** 지금 방송 중인 도네이도 크리에이터 (라이브 탭) */
export interface LiveCreator {
  code: string;
  displayName: string;
  avatarUrl: string | null;
  avatarIndex: number | null;
  /** YOUTUBE | INSTAGRAM | TIKTOK | FACEBOOK 등 */
  platform: string | null;
  /** 방송 주소(플랫폼 원래 주소). 도네이도 샵에서 함께 볼 수 있다 */
  liveUrl: string | null;
  /** 유튜브 채널 ID 를 알면 공식 라이브 임베드 썸네일·플레이어에 쓴다 */
  youtubeChannelId: string | null;
  category: VideoCategorySlug | null;
}

export function videosHref(params: { c?: string | null; q?: string | null; limit?: number | null; sort?: VideoOrder; t?: VideoType | null } = {}): string {
  const sp = new URLSearchParams();
  if (params.t && params.t !== 'all') sp.set('t', params.t);
  if (params.c && params.c !== 'all') sp.set('c', params.c);
  if (params.q) sp.set('q', params.q);
  if (params.limit) sp.set('limit', String(params.limit));
  if (params.sort && params.sort !== 'latest') sp.set('sort', params.sort);
  const qs = sp.toString();
  return qs ? `/videos?${qs}` : '/videos';
}

/**
 * 유튜브 공식 임베드 주소. 쿠키를 덜 남기는 youtube-nocookie 도메인을 쓴다.
 * 영상 파일을 내려받거나 재호스팅하지 않는다(유튜브 정책).
 */
export function youtubeEmbedUrl(id: string, autoplay = false): string {
  const sp = new URLSearchParams({ rel: '0', playsinline: '1', modestbranding: '1' });
  if (autoplay) sp.set('autoplay', '1');
  return `https://www.youtube-nocookie.com/embed/${id}?${sp.toString()}`;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function youtubeChannelUrl(channelId: string, subscribe = false): string {
  return `https://www.youtube.com/channel/${channelId}${subscribe ? '?sub_confirmation=1' : ''}`;
}
