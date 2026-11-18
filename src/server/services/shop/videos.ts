/**
 * 도네이도 샵 영상 탭 데이터 (2026-11-17).
 *  - 유튜브: 샵 관리에 등록한 유튜브 채널(+유튜브 연동 채널)의 최신 영상을 자동으로 (공개 RSS, 할당량 미사용)
 *  - 틱톡·인스타·페이스북: 크리에이터가 영상 주소를 붙여 넣어 등록 (계정 연동 자동 수집은 각 플랫폼 앱 심사 후)
 *  - 숨김·상단 고정은 shop_video 행으로 관리
 */
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { isYouTubeChannelId } from '@/lib/video-hub';
import { parseYouTubeFeed, type RawFeedVideo } from '@/server/services/video-hub-parse';

/**
 * 유튜브 채널 공개 RSS — 채널별 30분 메모리 캐시, 첫 조회도 2.5초 안에 끝낸다.
 * (영상 허브와 같은 방식이지만 영상 허브 파일은 별도 작업 중이라 샵 전용으로 둔다)
 */
const TTL = 30 * 60_000;
const g = globalThis as unknown as { __shopYtCache?: Map<string, { at: number; videos: RawFeedVideo[] }> };
const ytCache = (g.__shopYtCache ??= new Map());

async function fetchYt(channelId: string): Promise<void> {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ytCache.set(channelId, { at: Date.now(), videos: parseYouTubeFeed(await res.text(), channelId) });
  } catch (e) {
    const prev = ytCache.get(channelId);
    ytCache.set(channelId, { at: Date.now() - TTL + 5 * 60_000, videos: prev?.videos ?? [] });
    logger.warn('shop: 유튜브 피드 조회 실패', { channelId, error: (e as Error).message });
  }
}

export async function getChannelsVideos(channelIds: string[]): Promise<RawFeedVideo[]> {
  const ids = [...new Set(channelIds.filter(isYouTubeChannelId))].slice(0, 10);
  if (ids.length === 0) return [];
  const now = Date.now();
  const cold = ids.filter((id) => !ytCache.has(id));
  const stale = ids.filter((id) => (ytCache.get(id)?.at ?? now) < now - TTL);
  if (stale.length) void Promise.all(stale.map(fetchYt)).catch(() => undefined);
  if (cold.length) await Promise.race([Promise.all(cold.map(fetchYt)), new Promise((r) => setTimeout(r, 2500))]);
  return ids.flatMap((id) => ytCache.get(id)?.videos ?? []).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** 테스트용 */
export function __resetShopVideoCache() {
  ytCache.clear();
}

export interface ShopVideoItem {
  key: string; // platform:externalId
  platform: string;
  externalId: string;
  url: string;
  title: string;
  thumbnail: string | null;
  publishedAt: string | null;
  views: number | null;
  pinned: boolean;
  hidden: boolean;
  source: 'AUTO' | 'MANUAL';
}

export async function getShopVideos(creatorId: string, opts: { includeHidden?: boolean } = {}): Promise<ShopVideoItem[]> {
  const [creator, rows] = await Promise.all([
    prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: {
        youtubeConnection: { select: { channelId: true, status: true } },
        channels: { where: { platform: 'YOUTUBE', showOnShop: true, verifiedAt: { not: null } }, select: { externalId: true } },
      },
    }),
    prisma.shopVideo.findMany({ where: { creatorId }, orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }] }),
  ]);
  const ytIds = [
    ...(creator?.channels.map((c) => c.externalId).filter((v): v is string => Boolean(v)) ?? []),
    ...(creator?.youtubeConnection?.status === 'CONNECTED' ? [creator.youtubeConnection.channelId] : []),
  ];
  const auto = await getChannelsVideos(ytIds).catch(() => []);
  const setting = new Map(rows.map((r) => [`${r.platform}:${r.externalId}`, r]));
  const items: ShopVideoItem[] = [];
  for (const v of auto.slice(0, 60)) {
    const key = `YOUTUBE:${v.id}`;
    const s = setting.get(key);
    items.push({ key, platform: 'YOUTUBE', externalId: v.id, url: `https://www.youtube.com/watch?v=${v.id}`, title: v.title, thumbnail: v.thumbnail, publishedAt: v.publishedAt, views: v.views, pinned: s?.pinned ?? false, hidden: s?.hidden ?? false, source: 'AUTO' });
    setting.delete(key);
  }
  for (const r of setting.values()) {
    if (r.source === 'AUTO') continue; // 피드에서 사라진 유튜브 영상의 설정 행
    items.push({ key: `${r.platform}:${r.externalId}`, platform: r.platform, externalId: r.externalId, url: r.url, title: r.title ?? '영상', thumbnail: r.thumbnail, publishedAt: r.createdAt.toISOString(), views: null, pinned: r.pinned, hidden: r.hidden, source: 'MANUAL' });
  }
  const visible = opts.includeHidden ? items : items.filter((i) => !i.hidden);
  return visible.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.publishedAt ?? '') - Date.parse(a.publishedAt ?? ''));
}
