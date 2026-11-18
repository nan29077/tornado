import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb } from './helpers';
import {
  describeApiError,
  isPlausibleApiKey,
  looksLikeShort,
  maskApiKey,
  parseChannelInput,
  parseChannelResponse,
  parseIsoDuration,
  parsePlaylistVideoIds,
  parseVideosResponse,
} from '@/server/services/youtube-api-parse';
import {
  addApiChannel,
  clearYouTubeApiKey,
  collectAllApiChannels,
  getYouTubeApiSettings,
  loadApiVideosForHub,
  resolveYouTubeApiKey,
  saveYouTubeApiKey,
  testYouTubeApiKey,
  updateYouTubeApiSettings,
} from '@/server/services/youtube-api';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 최고관리자 YouTube Data API 관리 + 영상 수집 (2026-11-18)
 * 키 암호화 저장·마스킹, 채널 확인, 수집·숨김, 방송국 합치기. 네트워크는 고정 응답으로 대신한다.
 */

const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmn';
const CH = 'UC0123456789abcdefghijkl';

function channelJson() {
  return {
    items: [
      {
        id: CH,
        snippet: { title: '테스트 채널', customUrl: '@testch', thumbnails: { medium: { url: 'https://yt3.ggpht.com/a.jpg' } } },
        statistics: { subscriberCount: '12345', hiddenSubscriberCount: false },
        contentDetails: { relatedPlaylists: { uploads: `UU${CH.slice(2)}` } },
      },
    ],
  };
}

function videosJson(ids: string[]) {
  return {
    items: ids.map((id, i) => ({
      id,
      snippet: {
        channelId: CH,
        title: i === 1 ? '짧은 영상 #shorts' : `영상 ${id}`,
        publishedAt: `2026-11-1${i}T00:00:00Z`,
        thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
        liveBroadcastContent: 'none',
      },
      contentDetails: { duration: i === 1 ? 'PT45S' : 'PT12M3S' },
      statistics: { viewCount: String(1000 * (i + 1)) },
      status: { privacyStatus: i === 2 ? 'private' : 'public', embeddable: true },
    })),
  };
}

const IDS = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
let calls: string[] = [];

beforeEach(async () => {
  await resetDb();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname.split('/').pop()}?${url.searchParams.get('forHandle') ?? url.searchParams.get('id') ?? url.searchParams.get('playlistId') ?? ''}`);
      if (url.searchParams.get('key') !== KEY) return new Response(JSON.stringify({ error: { errors: [{ reason: 'keyInvalid' }] } }), { status: 400 });
      if (url.pathname.endsWith('/channels')) return Response.json(channelJson());
      if (url.pathname.endsWith('/playlistItems')) return Response.json({ items: IDS.map((videoId) => ({ contentDetails: { videoId } })) });
      if (url.pathname.endsWith('/videos')) return Response.json(videosJson((url.searchParams.get('id') ?? '').split(',')));
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('응답 해석', () => {
  it('기간·채널 입력·쇼츠 판정', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('P1D')).toBe(86400);
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration('abc')).toBeNull();
    expect(parseChannelInput(CH)).toEqual({ kind: 'id', value: CH });
    expect(parseChannelInput(`https://www.youtube.com/channel/${CH}`)).toEqual({ kind: 'id', value: CH });
    expect(parseChannelInput('@침착맨')).toEqual({ kind: 'handle', value: '@침착맨' });
    expect(parseChannelInput('https://m.youtube.com/@testch/videos')).toEqual({ kind: 'handle', value: '@testch' });
    expect(parseChannelInput('youtube.com/%40testch')).toEqual({ kind: 'handle', value: '@testch' });
    expect(parseChannelInput('https://evil.com/@testch')).toBeNull();
    expect(parseChannelInput('')).toBeNull();
    expect(looksLikeShort(45, '')).toBe(true);
    expect(looksLikeShort(150, '제목 #Shorts')).toBe(true);
    expect(looksLikeShort(150, '제목')).toBe(false);
    expect(looksLikeShort(null, '#shorts')).toBe(false);
  });

  it('채널·재생목록·영상 응답', () => {
    expect(parseChannelResponse(channelJson())).toMatchObject({ channelId: CH, title: '테스트 채널', handle: '@testch', subscriberCount: 12345, uploadsPlaylistId: `UU${CH.slice(2)}` });
    expect(parseChannelResponse({ items: [] })).toBeNull();
    expect(parsePlaylistVideoIds({ items: [{ contentDetails: { videoId: 'aaaaaaaaaaa' } }, { contentDetails: { videoId: 'bad' } }, { contentDetails: { videoId: 'aaaaaaaaaaa' } }] })).toEqual(['aaaaaaaaaaa']);
    const v = parseVideosResponse(videosJson(IDS));
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ videoId: 'aaaaaaaaaaa', views: 1000, durationSec: 723, isShort: false, usable: true });
    expect(v[1]).toMatchObject({ isShort: true });
    expect(v[2].usable).toBe(false);
    expect(parseVideosResponse({ items: [{ id: 'x', snippet: {} }] })).toEqual([]);
  });

  it('오류 사유·키 마스킹·형식 검사', () => {
    expect(describeApiError(403, { error: { errors: [{ reason: 'quotaExceeded' }] } })).toMatch(/할당량/);
    expect(describeApiError(400, { error: { errors: [{ reason: 'keyInvalid' }] } })).toMatch(/올바르지 않습니다/);
    expect(describeApiError(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } })).toMatch(/사용 설정/);
    expect(maskApiKey(KEY)).toBe('AIza••••klmn');
    expect(isPlausibleApiKey(KEY)).toBe(true);
    expect(isPlausibleApiKey('short')).toBe(false);
    expect(isPlausibleApiKey('AIza key with spaces and more than thirty')).toBe(false);
  });
});

describe('API 키 관리', () => {
  it('키는 암호화해 저장하고 원문은 DB 에 남지 않는다. 삭제하면 환경변수 키로 돌아간다', async () => {
    expect((await resolveYouTubeApiKey()).source).not.toBe('admin');
    await saveYouTubeApiKey(KEY, 'admin-1');
    const row = await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'youtube.dataApi' } });
    expect(JSON.stringify(row.value)).not.toContain(KEY);
    expect(JSON.stringify(row.value)).toContain('AIza••••klmn');
    expect(await resolveYouTubeApiKey()).toMatchObject({ key: KEY, source: 'admin', masked: 'AIza••••klmn' });

    const ok = await testYouTubeApiKey();
    expect(ok.ok).toBe(true);
    expect((await getYouTubeApiSettings()).lastTestOk).toBe(true);

    await saveYouTubeApiKey('AIzaSyWRONGKEY0123456789abcdefghijklmn');
    const bad = await testYouTubeApiKey();
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toMatch(/올바르지 않습니다/);

    await clearYouTubeApiKey();
    expect((await getYouTubeApiSettings()).keyEnc).toBeNull();
    expect((await resolveYouTubeApiKey()).source).not.toBe('admin');
  });

  it('설정값은 범위를 벗어나면 기본값으로 정리된다', async () => {
    const s = await updateYouTubeApiSettings({ intervalHours: 999, perChannel: 0 });
    expect(s.intervalHours).toBe(6);
    expect(s.perChannel).toBe(15);
  });
});

describe('영상 수집', () => {
  it('채널을 핸들로 확인해 추가하고, 공개 영상만 저장해 방송국에 합친다', async () => {
    await expect(addApiChannel('@testch', 'game')).rejects.toThrow(/API 키/);
    await saveYouTubeApiKey(KEY);
    await expect(addApiChannel('@testch', 'all')).rejects.toThrow(/카테고리/);
    const row = await addApiChannel('https://www.youtube.com/@testch', 'game');
    expect(row).toMatchObject({ channelId: CH, title: '테스트 채널', category: 'game', active: true });
    expect(calls).toContain('channels?@testch');

    const r = await collectAllApiChannels();
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/영상 2개 저장/);
    const saved = await prisma.youTubeApiVideo.findMany({ orderBy: { publishedAt: 'asc' } });
    expect(saved.map((v) => v.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']); // 비공개 영상 제외
    expect(saved[1].isShort).toBe(true);
    expect((await getYouTubeApiSettings()).lastCollectSummary).toMatch(/채널 1\/1개/);

    const hub = await loadApiVideosForHub();
    expect(hub.rows.map((v) => v.videoId).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(hub.rows[0].channel).toMatchObject({ title: '테스트 채널', category: 'game' });

    // 관리자가 숨긴 영상 · 멈춘 채널 · 꺼진 설정은 방송국에 나오지 않는다
    await prisma.youTubeApiVideo.update({ where: { videoId: 'aaaaaaaaaaa' }, data: { hidden: true } });
    const afterHide = await loadApiVideosForHub();
    expect(afterHide.rows.map((v) => v.videoId)).toEqual(['bbbbbbbbbbb']);
    expect(afterHide.hiddenIds.has('aaaaaaaaaaa')).toBe(true);
    // 다시 수집해도 관리자가 숨긴 영상은 숨김 유지
    await collectAllApiChannels();
    expect((await prisma.youTubeApiVideo.findUniqueOrThrow({ where: { videoId: 'aaaaaaaaaaa' } })).hidden).toBe(true);
    await prisma.youTubeApiChannel.update({ where: { id: row.id }, data: { active: false } });
    expect((await loadApiVideosForHub()).rows).toHaveLength(0);
    await prisma.youTubeApiChannel.update({ where: { id: row.id }, data: { active: true } });
    await updateYouTubeApiSettings({ enabled: false });
    expect((await loadApiVideosForHub()).rows).toHaveLength(0);
  });

  it('키가 없으면 수집하지 않고, 같은 채널을 다시 추가하면 하나로 합친다', async () => {
    expect((await collectAllApiChannels()).summary).toMatch(/API 키가 없어/);
    await saveYouTubeApiKey(KEY);
    await addApiChannel(CH, 'game');
    await addApiChannel(`https://www.youtube.com/channel/${CH}`, 'music');
    const rows = await prisma.youTubeApiChannel.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('music');
  });
});
