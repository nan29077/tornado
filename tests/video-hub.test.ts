import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoCard, VideoProfile } from '@/components/video-hub/video-card';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import {
  formatViews,
  isVideoCategory,
  timeAgo,
  videosHref,
  youtubeEmbedUrl,
  sortVideos,
  videoOrder,
  type VideoItem,
} from '@/lib/video-hub';
import {
  channelIdFromUrl,
  filterVideos,
  mergeVideos,
  parseChannelSpecs,
  parseYouTubeFeed,
} from '@/server/services/video-hub-parse';
import { sampleVideos } from '@/server/services/video-hub-sample';
import {
  __resetVideoHubCache,
  getVideoFeed,
  getVideoWithRelated,
  isVideoHubEnabled,
} from '@/server/services/video-hub';

/**
 * 영상 허브 (2026-11-16).
 * - 유튜브 RSS 파싱이 깨진 입력에도 예외 없이 동작하는가
 * - 가입 크리에이터 영상에만 후원 연결이 붙는가 (미가입은 절대 후원 연결 없음)
 * - 피드 실패·채널 없음 → 확인된 공개 영상만 표시하는가
 * - 끄기 스위치(VIDEO_HUB_ENABLED=false)
 */

const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

function feedXml(channelId: string, title: string, entries: Array<{ id: string; title: string; published: string; views?: number; short?: boolean }>) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>${channelId}</yt:channelId>
 <title>${title}</title>
 ${entries
   .map(
     (e) => `<entry>
  <id>yt:video:${e.id}</id>
  <yt:videoId>${e.id}</yt:videoId>
  <yt:channelId>${channelId}</yt:channelId>
  <title>${e.title}</title>
  <link rel="alternate" href="https://www.youtube.com/${e.short ? 'shorts/' : 'watch?v='}${e.id}"/>
  <author><name>${title}</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
  <published>${e.published}</published>
  <media:group>
   <media:title>${e.title}</media:title>
   <media:thumbnail url="https://i1.ytimg.com/vi/${e.id}/hqdefault.jpg" width="480" height="360"/>
   <media:community>${e.views != null ? `<media:statistics views="${e.views}"/>` : ''}</media:community>
  </media:group>
 </entry>`,
   )
   .join('\n')}
</feed>`;
}

describe('영상 허브 — 순수 함수', () => {
  it('유튜브 RSS 를 파싱한다 (엔티티 해제·쇼츠·조회수·썸네일)', () => {
    const xml = feedXml(CH_A, '먹방 &amp; 여행', [
      { id: 'abcdefghijk', title: '라면 &lt;매운맛&gt; 도전 &#x1F35C;', published: '2026-11-15T10:00:00+00:00', views: 12345 },
      { id: 'ABCDEFGHIJK', title: '쇼츠', published: '2026-11-14T10:00:00+00:00', short: true },
    ]);
    const v = parseYouTubeFeed(xml, CH_A);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: 'abcdefghijk', channelId: CH_A, channelTitle: '먹방 & 여행', views: 12345, isShort: false });
    expect(v[0].title).toBe('라면 <매운맛> 도전 \u{1F35C}');
    expect(v[0].thumbnail).toBe('https://i1.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
    expect(v[1]).toMatchObject({ isShort: true, views: null });
  });

  it('깨진 입력·형식이 틀린 항목·다른 채널 항목은 버리고 예외를 던지지 않는다', () => {
    expect(parseYouTubeFeed('')).toEqual([]);
    expect(parseYouTubeFeed('<html>not a feed</html>')).toEqual([]);
    expect(parseYouTubeFeed(undefined as unknown as string)).toEqual([]);
    const xml = feedXml(CH_A, 'A', [
      { id: 'short', title: '잘못된 ID', published: '2026-11-15T10:00:00Z' },
      { id: 'abcdefghijk', title: '날짜 없음', published: 'not-a-date' },
      { id: 'zzzzzzzzzzz', title: '정상', published: '2026-11-15T10:00:00Z' },
    ]);
    expect(parseYouTubeFeed(xml).map((v) => v.id)).toEqual(['zzzzzzzzzzz']);
    expect(parseYouTubeFeed(xml, CH_B)).toEqual([]);
  });

  it('유튜브 이미지 서버가 아닌 썸네일 주소는 쓰지 않는다', () => {
    const xml = feedXml(CH_A, 'A', [{ id: 'zzzzzzzzzzz', title: 't', published: '2026-11-15T10:00:00Z' }]).replace(
      'https://i1.ytimg.com/vi/zzzzzzzzzzz/hqdefault.jpg',
      'javascript:alert(1)',
    );
    expect(parseYouTubeFeed(xml)[0].thumbnail).toBe('https://i.ytimg.com/vi/zzzzzzzzzzz/hqdefault.jpg');
  });

  it('VIDEO_HUB_CHANNELS 를 해석한다 (잘못된 ID 제외·중복 제거·카테고리 기본값)', () => {
    expect(parseChannelSpecs(`${CH_A}:mukbang, bad:humor, ${CH_B}:없는카테고리, ${CH_A}:humor, ${CH_B.replace('b', 'c')}:all`)).toEqual([
      { channelId: CH_A, category: 'mukbang' },
      { channelId: CH_B, category: 'talk' },
      { channelId: CH_B.replace('b', 'c'), category: 'talk' },
    ]);
    expect(parseChannelSpecs(undefined)).toEqual([]);
  });

  it('채널 주소에서 채널 ID 를 꺼낸다', () => {
    expect(channelIdFromUrl(`https://www.youtube.com/channel/${CH_A}/live`)).toBe(CH_A);
    expect(channelIdFromUrl('https://www.youtube.com/@handle')).toBeNull();
    expect(channelIdFromUrl(null)).toBeNull();
  });

  it('필터: 카테고리·후원 가능·검색어', () => {
    const items = sampleVideos(Date.parse('2026-11-16T00:00:00Z'));
    const withCreator: VideoItem[] = [{ ...items[0], id: 'creatorvid1', creator: { code: 'TOR-1', displayName: 'A' } }, ...items];
    expect(filterVideos(withCreator, { c: 'mukbang' }).every((v) => v.category === 'mukbang')).toBe(true);
    expect(filterVideos(withCreator, { c: 'donaido' }).map((v) => v.id)).toEqual(['creatorvid1']);
    expect(filterVideos(withCreator, { q: '떡볶이' })).toHaveLength(1);
    expect(filterVideos(withCreator, { q: '샘플 채널 1' }).length).toBeGreaterThan(0);
    expect(filterVideos(withCreator, { c: 'all', q: '' })).toHaveLength(withCreator.length);
  });

  it('병합: 최신순 + 중복 제거', () => {
    const [a, b] = sampleVideos();
    const merged = mergeVideos([[b], [a, b]]);
    expect(merged.map((v) => v.id)).toEqual([a.id, b.id]);
  });

  it('표시 도우미', () => {
    expect(formatViews(null)).toBeNull();
    expect(formatViews(999)).toBe('조회수 999회');
    expect(formatViews(1234)).toBe('조회수 1.2천회');
    expect(formatViews(12345)).toBe('조회수 1.2만회');
    expect(formatViews(1_234_567)).toBe('조회수 123만회');
    expect(formatViews(123_456_789)).toBe('조회수 1.2억회');
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(timeAgo('2026-11-16T11:59:30Z', now)).toBe('방금 전');
    expect(timeAgo('2026-11-16T09:00:00Z', now)).toBe('3시간 전');
    expect(timeAgo('2026-11-13T12:00:00Z', now)).toBe('3일 전');
    expect(timeAgo('2025-11-01T12:00:00Z', now)).toBe('1년 전');
    expect(timeAgo('garbage', now)).toBe('');
    expect(videosHref({ c: 'all', q: '' })).toBe('/videos');
    expect(videosHref({ c: 'mukbang', q: '라면', limit: 48 })).toBe('/videos?c=mukbang&q=%EB%9D%BC%EB%A9%B4&limit=48');
    expect(youtubeEmbedUrl('abcdefghijk')).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/abcdefghijk\?/);
    expect(isVideoCategory('adult')).toBe(false);
  });

  it('샘플은 모두 source=sample, 썸네일 없음, 후원 연결 없음', () => {
    for (const v of sampleVideos()) {
      expect(v.source).toBe('sample');
      expect(v.thumbnail).toBeNull();
      expect(v.creator).toBeNull();
      expect(v.id.startsWith('sample-')).toBe(true);
    }
  });

  it('최신·인기 정렬과 채널을 골고루 소개하는 추천을 제공하고 원본은 유지한다', () => {
    const base = sampleVideos()[0];
    const items: VideoItem[] = [
      { ...base, id: 'a1', channelId: 'a', views: 50, publishedAt: '2026-11-13T00:00:00Z', creator: { code: 'A', displayName: 'A' } },
      { ...base, id: 'a2', channelId: 'a', views: 100, publishedAt: '2026-11-14T00:00:00Z', creator: { code: 'A', displayName: 'A' } },
      { ...base, id: 'b1', channelId: 'b', views: 200, publishedAt: '2026-11-15T00:00:00Z' },
      { ...base, id: 'c1', channelId: 'c', views: null, publishedAt: '2026-11-16T00:00:00Z' },
    ];
    expect(sortVideos(items, 'latest').map((v) => v.id)).toEqual(['c1', 'b1', 'a2', 'a1']);
    expect(sortVideos(items, 'popular').map((v) => v.id)).toEqual(['b1', 'a2', 'a1', 'c1']);
    expect(sortVideos(items, 'recommended').map((v) => v.id)).toEqual(['a2', 'b1', 'c1', 'a1']);
    expect(items.map((v) => v.id)).toEqual(['a1', 'a2', 'b1', 'c1']);
    expect(sortVideos([], 'recommended')).toEqual([]);
    expect(videoOrder('invalid')).toBe('latest');
    expect(videosHref({ sort: 'popular', c: 'game' })).toBe('/videos?c=game&sort=popular');
  });
});

describe('영상 허브 — 피드 조립 (DB·네트워크)', () => {
  let fx: Fixture;
  const env = { ...process.env };

  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    __resetVideoHubCache();
    delete process.env.VIDEO_HUB_CHANNELS;
    delete process.env.VIDEO_HUB_SAMPLE;
    delete process.env.VIDEO_HUB_ENABLED;
    // 기본 노출 채널(시사·정치·유머 등)은 아래 개별 테스트에서만 켠다
    process.env.VIDEO_HUB_DEFAULT_CHANNELS = 'false';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it('등록된 채널이 없으면 시청 페이지가 있는 공개 영상으로 채운다', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const feed = await getVideoFeed();
    expect(feed.curated).toBe(true);
    expect(feed.channelCount).toBe(0);
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.items.every((v) => v.source === 'youtube' && v.creator === null && v.thumbnail)).toBe(true);
    const { item } = await getVideoWithRelated(feed.items[0].id);
    expect(item?.id).toBe(feed.items[0].id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('가입 크리에이터 채널 영상에는 후원 연결이, 미가입 채널 영상에는 없다', async () => {
    await prisma.youTubeConnection.update({ where: { creatorId: fx.creatorId }, data: { channelId: CH_A } });
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { avatarUrl: '/avatars/donaido-v2/avatar-03.png' } });
    process.env.VIDEO_HUB_CHANNELS = `${CH_B}:mukbang,${CH_A}:humor`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const ch = new URL(url).searchParams.get('channel_id');
        const xml =
          ch === CH_A
            ? feedXml(CH_A, '가입채널', [{ id: 'aaaaaaaaaa1', title: '가입 영상', published: '2026-11-15T10:00:00Z', views: 10 }])
            : feedXml(CH_B, '미가입채널', [{ id: 'bbbbbbbbbb1', title: '미가입 영상', published: '2026-11-16T10:00:00Z' }]);
        return new Response(xml, { status: 200 });
      }),
    );
    const feed = await getVideoFeed();
    expect(feed.curated).toBe(false);
    expect(feed.items.map((v) => v.id)).toEqual(['bbbbbbbbbb1', 'aaaaaaaaaa1']);
    const joined = feed.items.find((v) => v.id === 'aaaaaaaaaa1')!;
    expect(joined.creator).toMatchObject({ code: fx.creatorCode, displayName: '테스트크리에이터', avatarUrl: '/avatars/donaido-v2/avatar-03.png', avatarIndex: expect.any(Number) });
    expect(joined.category).toBe('humor');
    const card = renderToStaticMarkup(createElement(VideoCard, { item: joined, now: feed.now }));
    expect(card).toContain(`href="/watch/${joined.id}"`);
    expect(card).toContain(`href="/c/${fx.creatorCode}"`);
    expect(card).toContain('src="/avatars/donaido-v2/avatar-03.png"');
    const profile = renderToStaticMarkup(createElement(VideoProfile, { item: joined, detailed: true }));
    expect(profile).toContain(`href="/c/${fx.creatorCode}"`);
    const notJoined = feed.items.find((v) => v.id === 'bbbbbbbbbb1')!;
    expect(notJoined.creator).toBeNull();
    expect(notJoined.category).toBe('mukbang');

    const { item, related } = await getVideoWithRelated('aaaaaaaaaa1');
    expect(item?.id).toBe('aaaaaaaaaa1');
    expect(related.map((v) => v.id)).toEqual(['bbbbbbbbbb1']);
    expect((await getVideoWithRelated('nope')).item).toBeNull();
  });

  it('승인되지 않은(정지) 크리에이터는 후원 연결을 붙이지 않는다', async () => {
    await prisma.youTubeConnection.update({ where: { creatorId: fx.creatorId }, data: { channelId: CH_A } });
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { status: 'SUSPENDED' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(feedXml(CH_A, 'A', [{ id: 'aaaaaaaaaa1', title: 't', published: '2026-11-15T10:00:00Z' }]))));
    const feed = await getVideoFeed();
    expect(feed.items.some((v) => v.creator)).toBe(false);
  });

  it('유튜브 피드가 실패하면 공개 영상으로 대체하고, 실패는 재시도 간격을 둔다', async () => {
    process.env.VIDEO_HUB_CHANNELS = `${CH_B}:game`;
    const fetchSpy = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);
    const first = await getVideoFeed();
    expect(first.curated).toBe(true);
    expect(first.channelCount).toBe(1);
    await getVideoFeed();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 5분 안에는 다시 두드리지 않는다
  });

  it('이전 샘플 설정이 남아 있어도 샘플을 노출하지 않는다', async () => {
    process.env.VIDEO_HUB_SAMPLE = 'always';
    vi.stubGlobal('fetch', vi.fn());
    const feed = await getVideoFeed();
    expect(feed.items.some((item) => item.source === 'sample')).toBe(false);
    expect((await getVideoWithRelated(sampleVideos()[0].id)).item).toBeNull();
  });

  it('끄기 스위치', () => {
    expect(isVideoHubEnabled()).toBe(true);
    process.env.VIDEO_HUB_ENABLED = 'false';
    expect(isVideoHubEnabled()).toBe(false);
    process.env.VIDEO_HUB_ENABLED = 'FALSE ';
    expect(isVideoHubEnabled()).toBe(false);
  });
});

describe('영상 허브 — 카테고리 확장 · 기본 채널 · 형식 탭 · 라이브 (2026-11-17)', () => {
  it('기존 카테고리 slug 를 유지하고 시사·정치·유머·예능·경제 등을 추가했다', async () => {
    const { VIDEO_CATEGORIES } = await import('@/lib/video-hub');
    const slugs = VIDEO_CATEGORIES.map((c) => c.slug as string);
    for (const keep of ['all', 'donaido', 'humor', 'talk', 'news', 'politics', 'mukbang', 'game', 'music', 'beauty', 'travel', 'pet', 'sports', 'study', 'finance', 'fishing']) expect(slugs).toContain(keep);
    for (const add of ['economy', 'entertain', 'cooking', 'dance', 'movie', 'drama', 'animation', 'camping', 'knowledge', 'science', 'tech', 'car']) expect(slugs).toContain(add);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('기본 채널은 형식이 맞고 중복이 없으며, 모든 카테고리가 실제 카테고리다', async () => {
    const { SEED_CHANNELS } = await import('@/server/services/video-hub-channels');
    const { isYouTubeChannelId, CONTENT_CATEGORY_SLUGS } = await import('@/lib/video-hub');
    expect(SEED_CHANNELS.length).toBeGreaterThan(40);
    expect(new Set(SEED_CHANNELS.map((c) => c.channelId)).size).toBe(SEED_CHANNELS.length);
    for (const c of SEED_CHANNELS) {
      expect(isYouTubeChannelId(c.channelId)).toBe(true);
      expect(CONTENT_CATEGORY_SLUGS).toContain(c.category);
    }
    // 시사·정치는 여러 출처를 함께 둔다
    expect(SEED_CHANNELS.filter((c) => c.category === 'news').length).toBeGreaterThanOrEqual(6);
    expect(SEED_CHANNELS.filter((c) => c.category === 'politics').length).toBeGreaterThanOrEqual(2);
  });

  it('형식 탭 값과 링크', async () => {
    const { videoType, videosHref } = await import('@/lib/video-hub');
    expect(videoType('shorts')).toBe('shorts');
    expect(videoType('live')).toBe('live');
    expect(videoType('x')).toBe('all');
    expect(videosHref({ t: 'shorts', c: 'news' })).toBe('/videos?t=shorts&c=news');
    expect(videosHref({ t: 'all' })).toBe('/videos');
  });

  it('라이브 탭: 방송 중인 승인 크리에이터만', async () => {
    await resetDb();
    const fx = await seedBasics();
    const { getLiveCreators } = await import('@/server/services/video-hub');
    expect(await getLiveCreators()).toEqual([]);
    await prisma.creatorProfile.update({
      where: { id: fx.creatorId },
      data: { liveOn: true, livePlatform: 'YOUTUBE', liveUrl: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/live', channelUrl: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa', contentCategory: 'game' },
    });
    const lives = await getLiveCreators();
    expect(lives).toHaveLength(1);
    expect(lives[0]).toMatchObject({ code: fx.creatorCode, platform: 'YOUTUBE', youtubeChannelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', category: 'game' });
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { status: 'SUSPENDED' } });
    expect(await getLiveCreators()).toEqual([]);
  });
});
