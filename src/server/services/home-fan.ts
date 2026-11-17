/**
 * 메인 [구독자 전용] 탭 데이터 (2026-11-17).
 *
 * 원칙
 *  - 도네이도에 가입·승인된 크리에이터만 "후원 가능"으로 보여 준다. 미가입 채널(유명 크리에이터 포함)은
 *    영상·채널 정보만 보여 주고 후원 연결을 만들지 않는다.
 *  - 실제 채널에 후원 통계를 지어 붙이지 않는다. 미가입 채널의 "주목" 기준은 최근 7일 실제 업로드 수다.
 *  - 실패해도 화면을 무너뜨리지 않는다(빈 섹션은 숨김).
 *  - DEMO_DATA=true 일 때만 더미 시청자·구독자 수와 더미 라이브를 섞는다.
 */
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { getLiveCreators, getVideoFeed } from '@/server/services/video-hub';
import {
  DEMO_CREATORS,
  DEMO_ID_PREFIX,
  DEMO_LIVE_CHANNELS,
  demoCreatorId,
  demoSubscribersForChannel,
  ensureDemoData,
  isDemoDataEnabled,
} from '@/server/services/demo-data';
import { SELLABLE_PRODUCT } from '@/server/services/shop/catalog';
import { isVideoCategory, type VideoCategorySlug, type VideoItem } from '@/lib/video-hub';

const PAID: Array<'PAYMENT_SUCCESS' | 'BROADCAST_PENDING' | 'BROADCASTED' | 'PARTIAL_DELIVERY_FAILED' | 'SETTLEMENT_PENDING' | 'SETTLED'> = [
  'PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED',
];
const WEEK_MS = 7 * 86_400_000;

export interface FanLiveItem {
  key: string;
  kind: 'creator' | 'channel';
  title: string;
  name: string;
  category: VideoCategorySlug | null;
  /** 동시 시청자 수. 모르면 null (숫자를 지어내지 않는다) */
  viewers: number | null;
  thumbnail: string | null;
  platform: string | null;
  /** 가입: 도네이도 샵 / 미가입: 시청 화면 */
  href: string;
  donatable: boolean;
  creator?: { code: string; avatarUrl: string | null; avatarIndex: number | null };
}

export interface FanCreator {
  id: string;
  code: string;
  displayName: string;
  avatarUrl: string | null;
  avatarIndex: number | null;
  category: VideoCategorySlug | null;
  description: string | null;
  subscribers: number;
  liveOn: boolean;
  weeklyDonations: number;
  growth: number | null;
  approvedAt: string | null;
}

export interface FanChannel {
  channelId: string;
  title: string;
  category: VideoCategorySlug;
  avatarUrl: string | null;
  subscribers: number | null;
  latest: VideoItem;
  uploads7d: number;
  totalViews: number;
}

export interface FanProduct {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  price: number;
  listPrice: number | null;
  soldCount: number;
  category: string | null;
  shop: { code: string; displayName: string } | null;
}

export interface FanMine {
  follows: Array<{ code: string; displayName: string; avatarUrl: string | null; avatarIndex: number | null; liveOn: boolean }>;
  donations: Array<{ id: string; creatorName: string; creatorCode: string; amount: number; paidAt: string }>;
}

export interface FanHomeData {
  demo: boolean;
  now: number;
  feed: VideoItem[];
  curated: boolean;
  live: FanLiveItem[];
  watching: { viewers: number | null; liveCount: number };
  creators: FanCreator[];
  channels: FanChannel[];
  products: FanProduct[];
  trending: { creators: FanCreator[]; channels: FanChannel[] };
  mine: FanMine | null;
  notices: Array<{ id: string; title: string; createdAt: string }>;
}

function safe<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e) => {
    logger.warn(`home-fan: ${label} 조회 실패`, { error: e instanceof Error ? e.message : String(e) });
    return fallback;
  });
}

const demoStatsById = new Map(DEMO_CREATORS.map((c) => [demoCreatorId(c.n), c]));

async function loadCreators(demo: boolean): Promise<FanCreator[]> {
  const rows = await prisma.creatorProfile.findMany({
    where: {
      status: 'APPROVED',
      user: { status: 'ACTIVE' },
      ...(demo ? {} : { id: { not: { startsWith: DEMO_ID_PREFIX } } }),
    },
    orderBy: { approvedAt: 'desc' },
    take: 60,
    select: {
      id: true, code: true, displayName: true, avatarUrl: true, description: true, contentCategory: true,
      liveOn: true, approvedAt: true, user: { select: { avatarIndex: true } },
    },
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const since = new Date(Date.now() - WEEK_MS);
  const [follows, weekly] = await Promise.all([
    safe('구독 수', prisma.memberFollow.groupBy({ by: ['creatorId'], where: { creatorId: { in: ids } }, _count: { _all: true } }), []),
    safe(
      '주간 후원',
      prisma.donation.groupBy({ by: ['creatorId'], where: { creatorId: { in: ids }, status: { in: PAID }, paidAt: { gte: since } }, _count: { _all: true } }),
      [],
    ),
  ]);
  const followOf = new Map(follows.map((f) => [f.creatorId, f._count._all]));
  const weeklyOf = new Map(weekly.map((w) => [w.creatorId, w._count._all]));
  return rows.map((r) => {
    const d = demo ? demoStatsById.get(r.id) : undefined;
    return {
      id: r.id,
      code: r.code,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl,
      avatarIndex: r.user.avatarIndex,
      category: isVideoCategory(r.contentCategory) ? r.contentCategory : null,
      description: r.description,
      subscribers: (followOf.get(r.id) ?? 0) + (d?.subscribers ?? 0),
      liveOn: r.liveOn,
      weeklyDonations: (weeklyOf.get(r.id) ?? 0) + (d?.weeklyDonations ?? 0),
      growth: d?.growth ?? null,
      approvedAt: r.approvedAt?.toISOString() ?? null,
    };
  });
}

function buildChannels(feed: VideoItem[], now: number, demo: boolean): FanChannel[] {
  const by = new Map<string, VideoItem[]>();
  for (const v of feed) {
    if (v.creator || v.source !== 'youtube') continue;
    const list = by.get(v.channelId) ?? [];
    list.push(v);
    by.set(v.channelId, list);
  }
  const out: FanChannel[] = [];
  for (const [channelId, list] of by) {
    const sorted = [...list].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const latest = sorted[0];
    out.push({
      channelId,
      title: latest.channelTitle,
      category: latest.category,
      avatarUrl: latest.channelAvatarUrl ?? null,
      subscribers: demo ? demoSubscribersForChannel(channelId) : null,
      latest,
      uploads7d: sorted.filter((v) => now - Date.parse(v.publishedAt) <= WEEK_MS).length,
      totalViews: sorted.reduce((s, v) => s + (v.views ?? 0), 0),
    });
  }
  return out.sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0) || b.totalViews - a.totalViews);
}

async function loadLive(demo: boolean, channels: FanChannel[]): Promise<FanLiveItem[]> {
  const creators = await getLiveCreators(24);
  const items: FanLiveItem[] = creators
    .filter((c) => demo || !c.code.startsWith('TOR-DM'))
    .map((c) => {
      const d = demo ? DEMO_CREATORS.find((x) => `TOR-DM${String(x.n).padStart(2, '0')}` === c.code) : undefined;
      return {
        key: `creator:${c.code}`,
        kind: 'creator' as const,
        title: `${c.displayName} 라이브`,
        name: c.displayName,
        category: c.category,
        viewers: d?.liveViewers ?? null,
        thumbnail: null,
        platform: c.platform,
        href: `/c/${encodeURIComponent(c.code)}?tab=video`,
        donatable: true,
        creator: { code: c.code, avatarUrl: c.avatarUrl, avatarIndex: c.avatarIndex },
      };
    });
  if (demo) {
    const byId = new Map(channels.map((c) => [c.channelId, c]));
    for (const l of DEMO_LIVE_CHANNELS) {
      const ch = byId.get(l.channelId);
      if (!ch) continue;
      items.push({
        key: `channel:${l.channelId}`,
        kind: 'channel',
        title: ch.latest.title,
        name: ch.title,
        category: ch.category,
        viewers: l.viewers,
        thumbnail: ch.latest.thumbnail,
        platform: 'YOUTUBE',
        href: `/watch/${encodeURIComponent(ch.latest.id)}`,
        donatable: false,
      });
    }
  }
  return items.sort((a, b) => (b.viewers ?? -1) - (a.viewers ?? -1));
}

async function loadProducts(demo: boolean, take = 12): Promise<FanProduct[]> {
  const rows = await prisma.product.findMany({
    where: {
      ...SELLABLE_PRODUCT,
      ...(demo ? {} : { id: { not: { startsWith: DEMO_ID_PREFIX } } }),
      displays: { some: { active: true, blocked: false, creator: { status: 'APPROVED', user: { status: 'ACTIVE' } } } },
    },
    orderBy: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
    take,
    select: {
      id: true, name: true, thumbnailUrl: true, price: true, listPrice: true, soldCount: true, category: true, ownerType: true, creatorId: true,
      displays: {
        where: { active: true, blocked: false, creator: { status: 'APPROVED', user: { status: 'ACTIVE' } } },
        orderBy: { sortOrder: 'asc' },
        take: 5,
        select: { creatorId: true, creator: { select: { code: true, displayName: true } } },
      },
    },
  });
  return rows.map((p) => {
    // 직접 상품은 판매자 본인 샵에서만 판다
    const d = p.ownerType === 'CREATOR' ? p.displays.find((x) => x.creatorId === p.creatorId) : p.displays[0];
    return {
      id: p.id,
      name: p.name,
      thumbnailUrl: p.thumbnailUrl,
      price: Number(p.price),
      listPrice: p.listPrice != null ? Number(p.listPrice) : null,
      soldCount: p.soldCount,
      category: p.category,
      shop: d ? { code: d.creator.code, displayName: d.creator.displayName } : null,
    };
  }).filter((p) => p.shop);
}

async function loadMine(userId: string): Promise<FanMine> {
  const [follows, donations] = await Promise.all([
    safe(
      '내 구독',
      prisma.memberFollow.findMany({
        where: { userId, creator: { status: 'APPROVED' } },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { creator: { select: { code: true, displayName: true, avatarUrl: true, liveOn: true, user: { select: { avatarIndex: true } } } } },
      }),
      [],
    ),
    safe(
      '내 후원',
      prisma.donation.findMany({
        where: { donor: { userId }, status: { in: PAID } },
        orderBy: { paidAt: 'desc' },
        take: 3,
        select: { id: true, amount: true, paidAt: true, receivedAt: true, creator: { select: { displayName: true, code: true } } },
      }),
      [],
    ),
  ]);
  return {
    follows: follows.map((f) => ({
      code: f.creator.code,
      displayName: f.creator.displayName,
      avatarUrl: f.creator.avatarUrl,
      avatarIndex: f.creator.user.avatarIndex,
      liveOn: f.creator.liveOn,
    })),
    donations: donations.map((d) => ({
      id: d.id,
      creatorName: d.creator.displayName,
      creatorCode: d.creator.code,
      amount: Number(d.amount),
      paidAt: (d.paidAt ?? d.receivedAt).toISOString(),
    })),
  };
}

/**
 * @param opts.full 섹션 [더보기] 전체 보기 화면용 — 상품·주목 목록을 메인보다 넉넉하게 불러온다.
 */
export async function getFanHomeData(viewer: { id: string } | null, opts: { full?: boolean } = {}): Promise<FanHomeData> {
  const full = Boolean(opts.full);
  const demo = isDemoDataEnabled();
  await ensureDemoData();

  const [feedRes, creators, products, mine, notices] = await Promise.all([
    safe('영상 피드', getVideoFeed(), { items: [] as VideoItem[], curated: true, channelCount: 0, now: Date.now() }),
    safe('크리에이터', loadCreators(demo), [] as FanCreator[]),
    safe('상품', loadProducts(demo, full ? 120 : 12), [] as FanProduct[]),
    viewer ? safe('내 정보', loadMine(viewer.id), null) : Promise.resolve(null),
    safe(
      '공지',
      prisma.contentPost.findMany({ where: { type: 'NOTICE', published: true }, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: 3, select: { id: true, title: true, createdAt: true } }),
      [],
    ),
  ]);
  const now = feedRes.now;
  const channels = buildChannels(feedRes.items, now, demo);
  const live = await safe('라이브', loadLive(demo, channels), [] as FanLiveItem[]);

  const knownViewers = live.filter((l) => l.viewers != null);
  // 지금 시청 중: 라이브 동시 시청자 합계 + (더미일 때) 방송국 영상 시청자 추정치.
  // 실제 집계 수단이 없을 때는 숫자를 만들지 않고 방송 중인 수만 보여 준다.
  const viewers = demo
    ? knownViewers.reduce((s, l) => s + (l.viewers ?? 0), 0) + 9_000 + channels.length * 200
    : null;

  const trendingCreators = [...creators]
    .filter((c) => c.weeklyDonations > 0)
    .sort((a, b) => b.weeklyDonations - a.weeklyDonations)
    .slice(0, full ? 30 : 5);
  const trendingChannels = [...channels]
    .filter((c) => c.uploads7d > 0)
    .sort((a, b) => b.uploads7d - a.uploads7d || b.totalViews - a.totalViews)
    .slice(0, full ? 30 : 5);

  return {
    demo,
    now,
    feed: feedRes.items,
    curated: feedRes.curated,
    live,
    watching: { viewers, liveCount: live.length },
    creators,
    channels,
    products,
    trending: { creators: trendingCreators, channels: trendingChannels },
    mine,
    notices: notices.map((n) => ({ id: n.id, title: n.title, createdAt: n.createdAt.toISOString() })),
  };
}
