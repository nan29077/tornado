import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/server/db';
import { resetDb, seedBasics } from './helpers';
import {
  decodeHomeTabCookie,
  defaultHomeTabForRole,
  encodeHomeTabCookie,
  resolveHomeTab,
} from '@/lib/home-tab';
import { DEMO_CHANNELS, DEMO_CREATORS, DEMO_ID_PREFIX, DEMO_LIVE_CHANNELS, DEMO_PRODUCTS, demoCreatorCode, demoSubscribersForChannel } from '@/server/services/demo-data/catalog';
import { cleanDemoData, seedDemoData } from '@/server/services/demo-data/seed';
import { SEED_CHANNELS } from '@/server/services/video-hub-channels';
import type { VideoItem } from '@/lib/video-hub';
import type { FanChannel, FanCreator, FanLiveItem } from '@/server/services/home-fan';
import { FanChannelCard, FanCreatorCard, FanLiveCard, compactKo } from '@/components/home-fan/parts';
import { BrowseAll } from '@/components/home-fan/browse-all';
import { ComingSoonSticker } from '@/components/home-fan/coming-soon-sticker';

/**
 * 메인 [크리에이터 전용] / [구독자 전용] 탭 (2026-11-17)
 *  - 기본 탭 규칙 (크리에이터 → 크리에이터 전용 / 비로그인·일반회원·관리자 → 구독자 전용)
 *  - 미가입 채널에는 후원 버튼·후원 링크가 절대 없다
 *  - 더미 데이터는 demo- 접두사로만 넣고, 정리하면 남지 않는다
 */

// 영상 피드는 네트워크(유튜브 RSS)를 타므로 시험에서는 고정 목록으로 바꾼다.
const FEED: VideoItem[] = [
  { id: 'aaaaaaaaaaa', source: 'youtube', title: '랄로 영상', channelId: 'UCD2YO_A_PVMgMDN9jpRrpVA', channelTitle: '랄로', thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg', publishedAt: new Date().toISOString(), views: 120_000, category: 'game', isShort: false, creator: null },
  { id: 'bbbbbbbbbbb', source: 'youtube', title: '침착맨 영상', channelId: 'UCUj6rrhMTR9pipbAWBAMvUQ', channelTitle: '침착맨', thumbnail: 'https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg', publishedAt: new Date(Date.now() - 3_600_000).toISOString(), views: 980_000, category: 'talk', isShort: false, creator: null },
  { id: 'ccccccccccc', source: 'youtube', title: '쇼츠', channelId: 'UCUj6rrhMTR9pipbAWBAMvUQ', channelTitle: '침착맨', thumbnail: null, publishedAt: new Date(Date.now() - 7_200_000).toISOString(), views: 5_000, category: 'talk', isShort: true, creator: null },
];
vi.mock('@/server/services/video-hub', async (orig) => {
  const real = await orig<typeof import('@/server/services/video-hub')>();
  return { ...real, getVideoFeed: vi.fn(async () => ({ items: FEED, curated: false, channelCount: 2, now: Date.now() })) };
});

describe('기본 탭 규칙', () => {
  it('역할 기본값: 크리에이터 = 크리에이터 전용 / 비로그인·일반회원·관리자 = 구독자 전용', () => {
    expect(defaultHomeTabForRole(null)).toBe('fan');
    expect(defaultHomeTabForRole(undefined)).toBe('fan');
    expect(defaultHomeTabForRole('CREATOR')).toBe('creator');
    expect(defaultHomeTabForRole('DONOR')).toBe('fan');
    expect(defaultHomeTabForRole('ADMIN')).toBe('fan');
  });

  it('주소의 ?tab= 이 가장 우선한다', () => {
    expect(resolveHomeTab({ query: 'fan', role: 'CREATOR' })).toBe('fan');
    expect(resolveHomeTab({ query: ['creator'], role: 'DONOR' })).toBe('creator');
    expect(resolveHomeTab({ query: 'nope', role: 'DONOR' })).toBe('fan');
  });

  it('직접 고른 탭(쿠키)은 고른 사람이 같을 때만 쓴다 — 로그인·로그아웃하면 역할 기본값으로 돌아간다', () => {
    const guestPick = encodeHomeTabCookie('creator', null);
    expect(resolveHomeTab({ cookie: guestPick, userId: null, role: null })).toBe('creator');
    // 같은 브라우저에서 일반회원으로 로그인 → 비로그인 때 고른 값은 무시
    expect(resolveHomeTab({ cookie: guestPick, userId: 'u1', role: 'DONOR' })).toBe('fan');
    // 비로그인 때 구독자 전용을 골랐어도 크리에이터로 로그인하면 크리에이터 전용
    expect(resolveHomeTab({ cookie: encodeHomeTabCookie('fan', null), userId: 'u4', role: 'CREATOR' })).toBe('creator');
    // 일반회원이 크리에이터 전용을 골랐으면 유지
    const donorPick = encodeHomeTabCookie('creator', 'u2');
    expect(resolveHomeTab({ cookie: donorPick, userId: 'u2', role: 'DONOR' })).toBe('creator');
    // 다른 계정으로 바뀌면 무시
    expect(resolveHomeTab({ cookie: donorPick, userId: 'u3', role: 'DONOR' })).toBe('fan');
  });

  it('깨진 쿠키 값은 무시한다', () => {
    expect(decodeHomeTabCookie('fan', null)).toBeNull();
    expect(decodeHomeTabCookie('hack|guest', null)).toBeNull();
    expect(decodeHomeTabCookie('', null)).toBeNull();
  });
});

describe('더미 데이터 목록', () => {
  it('추가 채널은 기본 채널과 겹치지 않고, 채널 ID 형식이 맞다', () => {
    const base = new Set(SEED_CHANNELS.map((s) => s.channelId));
    for (const [id] of DEMO_CHANNELS) {
      expect(id).toMatch(/^UC[A-Za-z0-9_-]{22}$/);
      expect(base.has(id)).toBe(false);
    }
    expect(new Set(DEMO_CHANNELS.map(([id]) => id)).size).toBe(DEMO_CHANNELS.length);
  });

  it('더미 라이브 채널은 모두 노출 채널 목록 안에 있다 (없는 채널에 LIVE 를 붙이지 않는다)', () => {
    const all = new Set([...SEED_CHANNELS.map((s) => s.channelId), ...DEMO_CHANNELS.map(([id]) => id)]);
    for (const l of DEMO_LIVE_CHANNELS) expect(all.has(l.channelId)).toBe(true);
  });

  it('더미 가입 크리에이터 코드는 후원샵 코드 형식(TOR-)을 따른다', () => {
    for (const c of DEMO_CREATORS) expect(demoCreatorCode(c.n)).toMatch(/^TOR-[A-Z0-9]{2,10}$/);
  });

  it('상품은 https 사진과 옵션을 갖는다', () => {
    expect(DEMO_PRODUCTS.length).toBeGreaterThanOrEqual(24);
    for (const p of DEMO_PRODUCTS) {
      expect(p.image.startsWith('https://')).toBe(true);
      expect(p.variants.length).toBeGreaterThan(0);
      expect(p.price).toBeGreaterThan(0);
    }
  });

  it('채널별 더미 구독자 수는 항상 같은 값이다', () => {
    expect(demoSubscribersForChannel('UCD2YO_A_PVMgMDN9jpRrpVA')).toBe(demoSubscribersForChannel('UCD2YO_A_PVMgMDN9jpRrpVA'));
  });
});

describe('화면 — 미가입 채널에는 후원 연결이 없다', () => {
  const now = Date.now();
  const channel: FanChannel = {
    channelId: 'UCD2YO_A_PVMgMDN9jpRrpVA', title: '랄로', category: 'game', avatarUrl: null, subscribers: 1_230_000,
    latest: FEED[0], uploads7d: 3, totalViews: 120_000,
  };
  const creator: FanCreator = {
    id: 'c1', code: 'TOR-AB12', displayName: '테스트크리에이터', avatarUrl: null, avatarIndex: 3, category: 'game', description: null,
    subscribers: 1200, liveOn: true, weeklyDonations: 10, growth: 5, approvedAt: new Date().toISOString(),
  };
  const channelLive: FanLiveItem = {
    key: 'channel:x', kind: 'channel', title: '라이브', name: '랄로', category: 'game', viewers: 21640, thumbnail: null, platform: 'YOUTUBE',
    href: '/watch/aaaaaaaaaaa', donatable: false,
  };

  it('방송국 인기 채널 카드: 미가입 표기, 후원 문구·후원샵 링크 없음', () => {
    const html = renderToStaticMarkup(<FanChannelCard channel={channel} />);
    expect(html).toContain('미가입');
    expect(html).not.toContain('후원');
    expect(html).not.toContain('/c/');
    expect(html).toContain('구독자 123만명');
  });

  it('미가입 채널 라이브 카드: 시청자 수는 보이고 "후원 가능"은 없다', () => {
    const html = renderToStaticMarkup(<FanLiveCard item={channelLive} />);
    expect(html).toContain('21,640명 시청 중');
    expect(html).toContain('미가입');
    expect(html).not.toContain('후원');
  });

  it('가입 크리에이터 카드: 후원하기 · 샵 보기 버튼', () => {
    const html = renderToStaticMarkup(<FanCreatorCard creator={creator} />);
    expect(html).toContain('후원하기');
    expect(html).toContain('/c/TOR-AB12?tab=donate');
    expect(html).toContain('/c/TOR-AB12?tab=shop');
  });

  it('전체 둘러보기: 가입은 "후원 가능", 미가입은 "미가입"으로 구분한다', () => {
    const html = renderToStaticMarkup(<BrowseAll creators={[creator]} channels={[channel]} videos={FEED} live={[channelLive]} now={now} />);
    expect(html).toContain('후원 가능');
    expect(html).toContain('미가입');
    expect(html).toContain('크리에이터');
    expect(html).toContain('동영상');
    expect(html).toContain('라이브');
  });

  it('상품 준비 중 스티커는 도네이도 캐릭터와 안내 문구를 보여 준다', () => {
    const html = renderToStaticMarkup(<ComingSoonSticker />);
    expect(html).toContain('gift-pop');
    expect(html).toContain('상품 준비 중이에요');
  });

  it('숫자 줄임 표기', () => {
    expect(compactKo(980)).toBe('980');
    expect(compactKo(12_345)).toBe('1.2만');
    expect(compactKo(3_520_000)).toBe('352만');
    expect(compactKo(123_000_000)).toBe('1.2억');
  });
});

describe('더미 데이터 넣기 · 정리 (DB)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
  });
  afterEach(() => {
    delete process.env.DEMO_DATA;
  });

  it('두 번 넣어도 중복되지 않고, 모든 행이 demo- 로 시작한다', async () => {
    await seedDemoData(prisma);
    await seedDemoData(prisma);
    const creators = await prisma.creatorProfile.findMany({ where: { id: { startsWith: DEMO_ID_PREFIX } } });
    const products = await prisma.product.findMany({ where: { id: { startsWith: DEMO_ID_PREFIX } } });
    expect(creators).toHaveLength(DEMO_CREATORS.length);
    expect(products).toHaveLength(DEMO_PRODUCTS.length);
    expect(creators.every((c) => c.status === 'APPROVED')).toBe(true);
    const displays = await prisma.creatorProduct.count({ where: { id: { startsWith: DEMO_ID_PREFIX } } });
    expect(displays).toBe(DEMO_CREATORS.length * 10);
  });

  it('정리하면 demo- 행이 남지 않고, 기존(시드) 크리에이터는 그대로다', async () => {
    const before = await prisma.creatorProfile.count({ where: { id: { not: { startsWith: DEMO_ID_PREFIX } } } });
    await seedDemoData(prisma);
    const r = await cleanDemoData(prisma);
    expect(r.products).toBe(DEMO_PRODUCTS.length);
    expect(r.creators).toBe(DEMO_CREATORS.length);
    expect(await prisma.creatorProfile.count({ where: { id: { startsWith: DEMO_ID_PREFIX } } })).toBe(0);
    expect(await prisma.product.count({ where: { id: { startsWith: DEMO_ID_PREFIX } } })).toBe(0);
    expect(await prisma.user.count({ where: { id: { startsWith: DEMO_ID_PREFIX } } })).toBe(0);
    expect(await prisma.creatorProfile.count({ where: { id: { not: { startsWith: DEMO_ID_PREFIX } } } })).toBe(before);
  });

  it('구독자 전용 데이터: 더미를 켜면 가입 크리에이터·상품·라이브·시청자 수가 채워진다', async () => {
    process.env.DEMO_DATA = 'true';
    const { getFanHomeData } = await import('@/server/services/home-fan');
    const d = await getFanHomeData(null);
    expect(d.demo).toBe(true);
    expect(d.creators.length).toBeGreaterThanOrEqual(DEMO_CREATORS.length);
    expect(d.products.length).toBeGreaterThan(0);
    expect(d.products.every((p) => p.shop?.code.startsWith('TOR-'))).toBe(true);
    expect(d.watching.viewers).toBeGreaterThan(0);
    // 미가입 채널 라이브는 후원 불가로 표시된다
    expect(d.live.filter((l) => l.kind === 'channel').every((l) => !l.donatable)).toBe(true);
    expect(d.live.some((l) => l.kind === 'creator' && l.donatable)).toBe(true);
    // 미가입 채널에는 후원 통계를 붙이지 않는다(가입 크리에이터만 weeklyDonations)
    expect(d.channels.every((c) => !('weeklyDonations' in c))).toBe(true);
  });

  it('구독자 전용 데이터: 더미를 끄면 더미 행이 DB 에 남아 있어도 보이지 않고, 숫자를 지어내지 않는다', async () => {
    await seedDemoData(prisma);
    process.env.DEMO_DATA = 'false';
    const { getFanHomeData } = await import('@/server/services/home-fan');
    const d = await getFanHomeData(null);
    expect(d.demo).toBe(false);
    expect(d.creators.some((c) => c.id.startsWith(DEMO_ID_PREFIX))).toBe(false);
    expect(d.products.some((p) => p.id.startsWith(DEMO_ID_PREFIX))).toBe(false);
    expect(d.watching.viewers).toBeNull();
    expect(d.channels.every((c) => c.subscribers === null)).toBe(true);
  });
});
