import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  VIDEO_PLATFORMS,
  isVideoPlatform,
  platformSlugOf,
  videoOpenTarget,
  videoProfileTarget,
  videosHref,
  type VideoItem,
} from '@/lib/video-hub';
import { filterVideos } from '@/server/services/video-hub-parse';
import { VideoCard } from '@/components/video-hub/video-card';
import { resolveDonateMethod } from '@/components/shop/shop-tabs';

/**
 * 2026-11-17
 *  - 영상 카드 프로필: 가입 크리에이터 → 도네이도 샵(새 창) / 미가입 → 원래 플랫폼 채널(새 창)
 *  - 플랫폼 카테고리(유튜브 · 틱톡 · 인스타그램 · 페이스북 · 치지직 · 숲 · 기타)
 *  - 샵 [후원하기] 탭 방식(문자 · 신용카드 · 간편계좌이체)
 * DB 를 쓰지 않는 순수 시험이다.
 */
const base: VideoItem = {
  id: 'aaaaaaaaaaa',
  source: 'youtube',
  title: '영상',
  channelId: 'UCD2YO_A_PVMgMDN9jpRrpVA',
  channelTitle: '채널',
  thumbnail: null,
  publishedAt: new Date().toISOString(),
  views: null,
  category: 'game',
  isShort: false,
  creator: null,
};
const member: VideoItem = { ...base, id: 'bbbbbbbbbbb', creator: { code: 'TOR-AB12', displayName: '가입크리에이터' } };
const tiktok: VideoItem = {
  ...base,
  id: 'ext-1',
  source: 'external',
  platform: 'tiktok',
  channelId: 'donaido:TOR-AB12',
  externalUrl: 'https://www.tiktok.com/@a/video/1234567890',
  channelUrl: 'https://www.tiktok.com/@a',
  creator: { code: 'TOR-AB12', displayName: '가입크리에이터' },
};

describe('영상 카드 프로필 이동', () => {
  it('가입 크리에이터는 도네이도 샵, 미가입 유튜브 채널은 유튜브 채널로 간다', () => {
    expect(videoProfileTarget(member)).toEqual({ href: '/c/TOR-AB12', kind: 'shop', label: '도네이도 샵' });
    expect(videoProfileTarget(base)?.href).toBe('https://www.youtube.com/channel/UCD2YO_A_PVMgMDN9jpRrpVA');
    expect(videoProfileTarget(base)?.kind).toBe('platform');
  });

  it('미가입 비유튜브 채널은 등록된 채널 주소로, 위험한 주소는 쓰지 않는다', () => {
    const ch: VideoItem = { ...base, platform: 'chzzk', channelId: 'x', channelUrl: 'https://chzzk.naver.com/abc' };
    expect(videoProfileTarget(ch)).toEqual({ href: 'https://chzzk.naver.com/abc', kind: 'platform', label: '치지직 채널' });
    const bad: VideoItem = { ...base, id: 'sample-1', source: 'sample', platform: 'other', channelId: 'x', channelUrl: 'javascript:alert(1)' };
    expect(videoProfileTarget(bad)).toBeNull();
  });

  it('카드의 프로필 링크는 새 창, 미가입 카드에는 후원 링크가 없다', () => {
    const html = renderToStaticMarkup(<VideoCard item={base} now={Date.now()} />);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('youtube.com/channel/');
    expect(html).not.toContain('/c/');
    const mine = renderToStaticMarkup(<VideoCard item={member} now={Date.now()} />);
    expect(mine).toMatch(/href="\/c\/TOR-AB12"[^>]*target="_blank"|target="_blank"[^>]*href="\/c\/TOR-AB12"/);
  });

  it('가입 크리에이터의 틱톡 영상은 샵 영상 탭을 새 창으로 연다', () => {
    expect(videoOpenTarget(tiktok)).toEqual({ href: '/c/TOR-AB12?tab=video', newWindow: true });
    expect(videoOpenTarget(base)).toEqual({ href: '/watch/aaaaaaaaaaa', newWindow: false });
  });
});

describe('플랫폼 카테고리', () => {
  it('유튜브 · 틱톡 · 인스타그램 · 페이스북 · 치지직 · 숲 · 기타', () => {
    expect(VIDEO_PLATFORMS.map((p) => p.slug)).toEqual(['youtube', 'tiktok', 'instagram', 'facebook', 'chzzk', 'soop', 'other']);
    expect(platformSlugOf('TIKTOK')).toBe('tiktok');
    expect(platformSlugOf('SOOP')).toBe('soop');
    expect(platformSlugOf('TWITCH')).toBe('other');
    expect(platformSlugOf(null)).toBe('youtube');
    expect(isVideoPlatform('chzzk')).toBe(true);
    expect(isVideoPlatform('nope')).toBe(false);
  });

  it('필터와 링크', () => {
    expect(filterVideos([base, tiktok], { p: 'tiktok' }).map((v) => v.id)).toEqual(['ext-1']);
    expect(filterVideos([base, tiktok], { p: 'youtube' }).map((v) => v.id)).toEqual(['aaaaaaaaaaa']);
    expect(videosHref({ p: 'tiktok', c: 'game' })).toBe('/videos?p=tiktok&c=game');
    expect(videosHref({ p: 'all' })).toBe('/videos');
  });
});

describe('샵 [후원하기] 방식', () => {
  it('주소 값이 없으면 문자 번호가 있으면 문자후원, 없으면 간편계좌이체', () => {
    expect(resolveDonateMethod(undefined, true)).toBe('sms');
    expect(resolveDonateMethod(undefined, false)).toBe('transfer');
    expect(resolveDonateMethod('card', true)).toBe('card');
    expect(resolveDonateMethod('weird', true)).toBe('sms');
  });
});
