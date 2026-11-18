/**
 * 영상 허브 — 영상 목록을 모으는 서버 서비스.
 *
 * 출처
 *  1) 도네이도 가입·승인 크리에이터 중 유튜브 채널 ID 를 알 수 있는 채널 (후원 가능 배지 + 후원 페이지 연결)
 *  2) SEED_CHANNELS + 환경변수 VIDEO_HUB_CHANNELS (미가입 크리에이터, 영상만 노출)
 *  3) 위에서 영상이 하나도 안 나오면 선별한 실제 공개 영상
 *
 * 성능·안정성 원칙
 *  - 유튜브 피드는 채널별로 30분 메모리 캐시. 오래된 값은 먼저 보여 주고 뒤에서 갱신한다.
 *  - 처음 불러올 때도 전체 2.5초 안에 끝낸다. 늦은 채널은 다음 요청부터 보인다.
 *  - 피드를 읽지 못하면 선별한 공개 영상으로 방송국을 구성한다.
 *
 * 끄기: .env 에 VIDEO_HUB_ENABLED=false → 메인 영상 영역·섹션이 사라지고 /videos·/watch 는 404.
 */
import * as React from 'react';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { CONTENT_CATEGORY_SLUGS, isVideoCategory, isYouTubeChannelId, platformSlugOf, type LiveCreator, type VideoCategorySlug, type VideoItem } from '@/lib/video-hub';
import { SEED_CHANNELS, defaultChannelsEnabled } from './video-hub-channels';
import { DEMO_CHANNELS, isDemoDataEnabled } from './demo-data';
import { PUBLIC_VIDEOS } from './video-hub-public-videos';
import {
  channelIdFromUrl,
  mergeVideos,
  parseChannelSpecs,
  parseYouTubeFeed,
  toVideoItem,
  type ChannelSpec,
  type RawFeedVideo,
} from './video-hub-parse';

const FEED_TTL_MS = 30 * 60_000;
const FAIL_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 3_500;
const FIRST_LOAD_BUDGET_MS = 2_500;
const MAX_CHANNELS = 200;
const CONCURRENCY = 10;

export function isVideoHubEnabled(): boolean {
  return (process.env.VIDEO_HUB_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

interface CacheEntry {
  at: number;
  ok: boolean;
  videos: RawFeedVideo[];
}

const g = globalThis as unknown as {
  __videoHubCache?: Map<string, CacheEntry>;
  __videoHubInflight?: Map<string, Promise<void>>;
};
const cache: Map<string, CacheEntry> = (g.__videoHubCache ??= new Map<string, CacheEntry>());
const inflight: Map<string, Promise<void>> = (g.__videoHubInflight ??= new Map<string, Promise<void>>());

/** 테스트용: 캐시 초기화 */
export function __resetVideoHubCache() {
  cache.clear();
  inflight.clear();
}

async function fetchChannel(channelId: string): Promise<void> {
  const existing = inflight.get(channelId);
  if (existing) return existing;
  const job = (async () => {
    try {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/atom+xml, application/xml;q=0.9' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const videos = parseYouTubeFeed(await res.text(), channelId);
      cache.set(channelId, { at: Date.now(), ok: true, videos });
    } catch (e) {
      const prev = cache.get(channelId);
      // 실패해도 이전에 받아 둔 영상은 지우지 않는다. 재시도만 5분 뒤로 미룬다.
      cache.set(channelId, { at: Date.now() - (FEED_TTL_MS - FAIL_TTL_MS), ok: false, videos: prev?.videos ?? [] });
      logger.warn('video-hub: 유튜브 피드 조회 실패', { channelId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      inflight.delete(channelId);
    }
  })();
  inflight.set(channelId, job);
  return job;
}

async function runLimited(ids: string[]): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (i < ids.length) await fetchChannel(ids[i++]);
  });
  await Promise.all(workers);
}

/** 채널 목록: 가입 크리에이터 + 기본 채널 (같은 채널이면 가입 정보가 우선, 카테고리는 기본 목록 값 유지) */
async function loadChannelSpecs(): Promise<ChannelSpec[]> {
  const seeds = [
    ...(defaultChannelsEnabled() ? SEED_CHANNELS : []),
    ...parseChannelSpecs(process.env.VIDEO_HUB_CHANNELS),
    // 테스트용 추가 채널 (DEMO_DATA=true 일 때만, 배포 전 정리 대상)
    ...(isDemoDataEnabled() ? DEMO_CHANNELS.map(([channelId, category]) => ({ channelId, category })) : []),
  ];
  const categoryOf = new Map(seeds.map((s) => [s.channelId, s.category]));
  const specs = new Map<string, ChannelSpec>();

  const creators = await prisma.creatorProfile
    .findMany({
      where: { status: 'APPROVED' },
      select: {
        code: true,
        displayName: true,
        avatarUrl: true,
        user: { select: { avatarIndex: true } },
        channelUrl: true,
        youtubeLiveUrl: true,
        contentCategory: true,
        youtubeConnection: { select: { channelId: true, status: true } },
      },
      take: MAX_CHANNELS,
    })
    .catch((e) => {
      logger.warn('video-hub: 크리에이터 목록 조회 실패', { error: e instanceof Error ? e.message : String(e) });
      return [];
    });

  for (const c of creators) {
    const connected = c.youtubeConnection?.status === 'CONNECTED' ? c.youtubeConnection.channelId : null;
    const channelId = [connected, channelIdFromUrl(c.channelUrl), channelIdFromUrl(c.youtubeLiveUrl)].find(isYouTubeChannelId);
    if (!channelId || specs.has(channelId)) continue;
    specs.set(channelId, {
      channelId,
      category: categoryOf.get(channelId) ?? contentCategoryOf(c.contentCategory) ?? 'talk',
      creator: { code: c.code, displayName: c.displayName, avatarUrl: c.avatarUrl, avatarIndex: c.user.avatarIndex },
    });
  }
  for (const s of seeds) {
    if (!specs.has(s.channelId)) specs.set(s.channelId, { ...s, creator: null });
  }
  return [...specs.values()].slice(0, MAX_CHANNELS);
}

function contentCategoryOf(v: string | null | undefined): VideoCategorySlug | null {
  return isVideoCategory(v) && CONTENT_CATEGORY_SLUGS.includes(v) ? v : null;
}

/**
 * 지금 방송 중인 도네이도 크리에이터 (라이브 탭).
 * 라이브 상태는 크리에이터가 등록한 방송 주소 감지 결과(liveOn)를 따른다. 실패해도 빈 목록.
 */
export async function getLiveCreators(limit = 48): Promise<LiveCreator[]> {
  const rows = await prisma.creatorProfile
    .findMany({
      where: { status: 'APPROVED', liveOn: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        code: true,
        displayName: true,
        avatarUrl: true,
        livePlatform: true,
        liveUrl: true,
        channelUrl: true,
        youtubeLiveUrl: true,
        contentCategory: true,
        user: { select: { avatarIndex: true } },
        youtubeConnection: { select: { channelId: true, status: true } },
      },
    })
    .catch((e) => {
      logger.warn('video-hub: 라이브 크리에이터 조회 실패', { error: e instanceof Error ? e.message : String(e) });
      return [];
    });
  return rows.map((c) => {
    const connected = c.youtubeConnection?.status === 'CONNECTED' ? c.youtubeConnection.channelId : null;
    const yt = [connected, channelIdFromUrl(c.channelUrl), channelIdFromUrl(c.youtubeLiveUrl)].find(isYouTubeChannelId) ?? null;
    return {
      code: c.code,
      displayName: c.displayName,
      avatarUrl: c.avatarUrl,
      avatarIndex: c.user.avatarIndex,
      platform: c.livePlatform ?? null,
      liveUrl: c.liveUrl ?? null,
      youtubeChannelId: c.livePlatform === 'YOUTUBE' || !c.livePlatform ? yt : null,
      category: contentCategoryOf(c.contentCategory),
    };
  });
}

/**
 * 가입·승인 크리에이터가 도네이도 샵에 직접 등록한 유튜브 외 영상 (틱톡·인스타·페이스북 등).
 * 플랫폼 카테고리(틱톡·인스타…)가 비지 않도록 방송국 피드에 함께 싣는다. 실패해도 빈 목록.
 */
async function loadExternalVideos(): Promise<VideoItem[]> {
  const rows = await prisma.shopVideo
    .findMany({
      where: { source: 'MANUAL', hidden: false, platform: { not: 'YOUTUBE' }, creator: { status: 'APPROVED', user: { status: 'ACTIVE' } } },
      orderBy: { createdAt: 'desc' },
      take: 120,
      select: {
        id: true,
        platform: true,
        externalId: true,
        url: true,
        title: true,
        thumbnail: true,
        createdAt: true,
        creator: {
          select: {
            code: true,
            displayName: true,
            avatarUrl: true,
            contentCategory: true,
            user: { select: { avatarIndex: true } },
            channels: { where: { verifiedAt: { not: null } }, select: { platform: true, url: true }, take: 8 },
          },
        },
      },
    })
    .catch((e) => {
      logger.warn('video-hub: 샵 등록 영상 조회 실패', { error: e instanceof Error ? e.message : String(e) });
      return [];
    });
  return rows.map((r) => {
    const c = r.creator;
    const short = r.platform === 'TIKTOK' || (r.platform === 'INSTAGRAM' && r.externalId.startsWith('reel/'));
    return {
      id: `ext-${r.id}`,
      source: 'external' as const,
      platform: platformSlugOf(r.platform),
      title: r.title?.trim() || `${c.displayName} 님의 영상`,
      channelId: `donaido:${c.code}`,
      channelTitle: c.displayName,
      channelAvatarUrl: c.avatarUrl,
      channelUrl: c.channels.find((ch) => ch.platform === r.platform)?.url ?? null,
      externalUrl: r.url,
      thumbnail: r.thumbnail,
      publishedAt: r.createdAt.toISOString(),
      views: null,
      category: contentCategoryOf(c.contentCategory) ?? 'talk',
      isShort: short,
      creator: { code: c.code, displayName: c.displayName, avatarUrl: c.avatarUrl, avatarIndex: c.user.avatarIndex },
    };
  });
}

export interface VideoFeed {
  items: VideoItem[];
  /** 연동 피드 대신 선별한 공개 영상을 사용했는가 */
  curated: boolean;
  /** 등록된 실제 채널 수 */
  channelCount: number;
  /** 목록을 만든 기준 시각. 화면의 "N분 전" 표기는 이 값으로 계산한다(서버·브라우저 표기 일치) */
  now: number;
}

/**
 * 한 요청 안에서는 한 번만 계산한다(메인의 PC 영역·모바일 섹션이 함께 부른다).
 * React.cache 가 없는 환경(단위 테스트 등)에서는 그냥 함수를 쓴다.
 */
const requestCache: <T extends (...args: never[]) => unknown>(fn: T) => T =
  (React as unknown as { cache?: <T>(fn: T) => T }).cache ?? ((fn) => fn);

export const getVideoFeed = requestCache(async function getVideoFeedUncached(): Promise<VideoFeed> {
  const specs = await loadChannelSpecs();
  const now = Date.now();
  const cold = specs.filter((s) => !cache.has(s.channelId)).map((s) => s.channelId);
  const stale = specs
    .filter((s) => {
      const e = cache.get(s.channelId);
      return e && now - e.at > FEED_TTL_MS;
    })
    .map((s) => s.channelId);

  // 오래된 것은 기다리지 않고 뒤에서 갱신한다.
  if (stale.length) void runLimited(stale).catch(() => undefined);
  // 처음 보는 채널만 시간 예산 안에서 기다린다.
  if (cold.length) {
    await Promise.race([runLimited(cold), new Promise((r) => setTimeout(r, FIRST_LOAD_BUDGET_MS))]).catch(() => undefined);
  }

  const external = await loadExternalVideos();
  const real = mergeVideos(specs.map((s) => (cache.get(s.channelId)?.videos ?? []).map((v) => toVideoItem(v, s))));
  const curated = real.length === 0;
  return {
    items: mergeVideos([curated ? PUBLIC_VIDEOS : real, external]),
    curated,
    channelCount: specs.length,
    now,
  };
});

/** 시청 화면용: 영상 1건 + 같은 카테고리 우선 관련 영상 */
export async function getVideoWithRelated(id: string, relatedLimit = 20) {
  const feed = await getVideoFeed();
  const item = feed.items.find((v) => v.id === id) ?? PUBLIC_VIDEOS.find((v) => v.id === id) ?? null;
  if (!item) return { item: null, related: [] as VideoItem[], now: feed.now };
  const others = feed.items.filter((v) => v.id !== id);
  const related = [
    ...others.filter((v) => v.channelId === item.channelId),
    ...others.filter((v) => v.channelId !== item.channelId && v.category === item.category),
    ...others.filter((v) => v.channelId !== item.channelId && v.category !== item.category),
  ].slice(0, relatedLimit);
  return { item, related, now: feed.now };
}
