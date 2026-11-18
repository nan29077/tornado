/**
 * 최고관리자 YouTube Data API 관리 + 영상 수집 (2026-11-18).
 *
 * - API 키는 관리자 화면에서 입력하면 암호화해 system_setting 에 저장한다. 화면·로그에는 앞뒤 4자리만.
 *   화면에 키가 없으면 서버 환경변수 YOUTUBE_API_KEY 를 쓴다(예전 방식 호환).
 * - 수집 채널(youtube_api_channel)을 등록하면 채널의 업로드 재생목록에서 최신 영상을 받아
 *   youtube_api_video 에 저장하고, 방송국(영상 허브)에 조회수·채널 아바타와 함께 합쳐 보여 준다.
 * - 비용: 채널 1개 수집 = playlistItems.list 1 + videos.list 1 = 2 units.
 *   라이브 채팅 송출과 같은 하루 할당량 카운터에 함께 계상하고, 사용량이 70%를 넘으면 자동 수집을 멈춰
 *   후원 채팅 송출 몫을 남긴다(후원이 우선).
 * - 자동 수집: 켜 두면 방송국을 누군가 열 때 간격(기본 6시간)이 지난 경우 뒤에서 한 번 돈다(별도 스케줄러 불필요).
 */
import { prisma } from '@/server/db';
import { encrypt, decrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { newId } from '@/lib/id';
import { isVideoCategory, type VideoCategorySlug } from '@/lib/video-hub';
import { getYouTubeQuotaUsage, reserveYouTubeQuota } from '@/server/services/youtube-quota';
import {
  describeApiError,
  maskApiKey,
  parseChannelInput,
  parseChannelResponse,
  parsePlaylistVideoIds,
  parseVideosResponse,
  type ApiChannelInfo,
} from './youtube-api-parse';

export const YT_API_SETTING_KEY = 'youtube.dataApi';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const FETCH_TIMEOUT_MS = 8_000;
/** 수집 채널 최대 개수 (할당량·화면 무게 보호) */
export const MAX_API_CHANNELS = 300;
/** 자동 수집이 하루 할당량 중 이 비율을 넘으면 멈춘다 */
const AUTO_COLLECT_QUOTA_CEILING = 0.7;

export interface YouTubeApiSettings {
  keyEnc: string | null;
  keyMasked: string | null;
  /** 방송국에 수집 영상을 보여 줄지 */
  enabled: boolean;
  /** 방송국 조회 때 간격이 지났으면 뒤에서 자동 수집 */
  autoCollect: boolean;
  /** 자동 수집 간격(시간) */
  intervalHours: number;
  /** 채널당 한 번에 받을 최신 영상 수 (1~50) */
  perChannel: number;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastCollectAt: string | null;
  lastCollectSummary: string | null;
  updatedAt: string | null;
}

export const DEFAULT_YT_API_SETTINGS: YouTubeApiSettings = {
  keyEnc: null,
  keyMasked: null,
  enabled: true,
  autoCollect: true,
  intervalHours: 6,
  perChannel: 15,
  lastTestAt: null,
  lastTestOk: null,
  lastTestMessage: null,
  lastCollectAt: null,
  lastCollectSummary: null,
  updatedAt: null,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function normalizeYouTubeApiSettings(raw: unknown): YouTubeApiSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    keyEnc: s('keyEnc'),
    keyMasked: s('keyMasked'),
    enabled: o.enabled !== false,
    autoCollect: o.autoCollect !== false,
    intervalHours: clampInt(o.intervalHours, 1, 168, DEFAULT_YT_API_SETTINGS.intervalHours),
    perChannel: clampInt(o.perChannel, 1, 50, DEFAULT_YT_API_SETTINGS.perChannel),
    lastTestAt: s('lastTestAt'),
    lastTestOk: typeof o.lastTestOk === 'boolean' ? o.lastTestOk : null,
    lastTestMessage: s('lastTestMessage'),
    lastCollectAt: s('lastCollectAt'),
    lastCollectSummary: s('lastCollectSummary'),
    updatedAt: s('updatedAt'),
  };
}

export async function getYouTubeApiSettings(): Promise<YouTubeApiSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: YT_API_SETTING_KEY } }).catch(() => null);
  return normalizeYouTubeApiSettings(row?.value);
}

async function writeSettings(next: YouTubeApiSettings, adminUserId?: string) {
  const value = { ...next, updatedAt: new Date().toISOString() };
  await prisma.systemSetting.upsert({
    where: { key: YT_API_SETTING_KEY },
    create: { key: YT_API_SETTING_KEY, value, memo: 'YouTube Data API 키(암호화)·수집 설정', updatedBy: adminUserId ?? null },
    update: { value, updatedBy: adminUserId ?? null },
  });
}

export async function updateYouTubeApiSettings(patch: Partial<YouTubeApiSettings>, adminUserId?: string): Promise<YouTubeApiSettings> {
  const next = normalizeYouTubeApiSettings({ ...(await getYouTubeApiSettings()), ...patch });
  await writeSettings(next, adminUserId);
  return next;
}

/** 화면에 키를 저장 (원문은 반환하지 않는다) */
export async function saveYouTubeApiKey(key: string, adminUserId?: string): Promise<YouTubeApiSettings> {
  const k = key.trim();
  return updateYouTubeApiSettings({ keyEnc: encrypt(k), keyMasked: maskApiKey(k), lastTestAt: null, lastTestOk: null, lastTestMessage: null }, adminUserId);
}

export async function clearYouTubeApiKey(adminUserId?: string): Promise<YouTubeApiSettings> {
  return updateYouTubeApiSettings({ keyEnc: null, keyMasked: null, lastTestAt: null, lastTestOk: null, lastTestMessage: null }, adminUserId);
}

export type ApiKeySource = 'admin' | 'env' | 'none';

/** 쓸 키: 관리자 화면 키 > 환경변수 */
export async function resolveYouTubeApiKey(settings?: YouTubeApiSettings): Promise<{ key: string | null; source: ApiKeySource; masked: string | null }> {
  const s = settings ?? (await getYouTubeApiSettings());
  if (s.keyEnc) {
    try {
      const key = decrypt(s.keyEnc);
      if (key) return { key, source: 'admin', masked: s.keyMasked ?? maskApiKey(key) };
    } catch (e) {
      logger.error('youtube-api: 저장된 키를 복호화하지 못했습니다', { error: (e as Error).message });
    }
  }
  const envKey = env.youtube.apiKey?.trim();
  if (envKey) return { key: envKey, source: 'env', masked: maskApiKey(envKey) };
  return { key: null, source: 'none', masked: null };
}

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 한 번의 API 호출. 할당량 카운터를 먼저 선점하고, 넘치면 호출하지 않는다 */
async function call(path: string, params: Record<string, string>, key: string, opts: { cost?: number; enforceQuota?: boolean } = {}): Promise<unknown> {
  const cost = opts.cost ?? 1;
  if (opts.enforceQuota !== false) {
    const ok = await reserveYouTubeQuota({ cost, purpose: 'lookup' }).catch(() => true);
    if (!ok) throw new YouTubeApiError('오늘 YouTube API 할당량 상한에 도달해 호출하지 않았습니다.', 429);
  }
  const qs = new URLSearchParams({ ...params, key });
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${path}?${qs.toString()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    throw new YouTubeApiError(`YouTube API 에 연결하지 못했습니다. (${(e as Error).name === 'TimeoutError' ? '시간 초과' : '네트워크 오류'})`, 0);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new YouTubeApiError(describeApiError(res.status, json), res.status);
  return json;
}

/** 키 확인: 공개 채널 1개를 조회한다 (1 unit). 결과를 설정에 기록한다 */
export async function testYouTubeApiKey(adminUserId?: string): Promise<{ ok: boolean; message: string }> {
  const { key, source } = await resolveYouTubeApiKey();
  let result: { ok: boolean; message: string };
  if (!key) {
    result = { ok: false, message: '등록된 API 키가 없습니다.' };
  } else {
    try {
      // YouTube 공식 채널 (항상 공개)
      const json = await call('channels', { part: 'id', id: 'UCBR8-60-B28hp2BmDPdntcQ' }, key);
      result = parseChannelResponse(json)
        ? { ok: true, message: `정상 — YouTube Data API v3 응답을 받았습니다. (${source === 'admin' ? '관리자 화면 키' : '환경변수 키'})` }
        : { ok: false, message: '응답은 받았지만 형식이 예상과 다릅니다.' };
    } catch (e) {
      result = { ok: false, message: (e as Error).message };
    }
  }
  await updateYouTubeApiSettings({ lastTestAt: new Date().toISOString(), lastTestOk: result.ok, lastTestMessage: result.message }, adminUserId).catch(() => undefined);
  return result;
}

/** 채널 주소·핸들·ID → 채널 정보 (1 unit) */
export async function lookupChannel(input: string): Promise<ApiChannelInfo> {
  const lookup = parseChannelInput(input);
  if (!lookup) throw new Error('채널 주소를 확인해 주세요. (예: https://www.youtube.com/@핸들, @핸들, UC로 시작하는 채널 ID)');
  const { key } = await resolveYouTubeApiKey();
  if (!key) throw new Error('먼저 [API 키 관리]에서 YouTube API 키를 등록해 주세요.');
  const json = await call(
    'channels',
    { part: 'snippet,statistics,contentDetails', ...(lookup.kind === 'id' ? { id: lookup.value } : { forHandle: lookup.value }) },
    key,
  );
  const info = parseChannelResponse(json);
  if (!info) throw new Error('채널을 찾을 수 없습니다. 주소나 핸들을 다시 확인해 주세요.');
  return info;
}

/** 수집 채널 추가 (이미 있으면 정보·카테고리만 갱신) */
export async function addApiChannel(input: string, category: string) {
  if (!isVideoCategory(category) || category === 'all' || category === 'donaido') throw new Error('방송국 카테고리를 골라 주세요.');
  const count = await prisma.youTubeApiChannel.count();
  const info = await lookupChannel(input);
  const existing = await prisma.youTubeApiChannel.findUnique({ where: { channelId: info.channelId }, select: { id: true } });
  if (!existing && count >= MAX_API_CHANNELS) throw new Error(`수집 채널은 ${MAX_API_CHANNELS}개까지 등록할 수 있습니다.`);
  const data = {
    title: info.title,
    handle: info.handle,
    avatarUrl: info.avatarUrl,
    subscriberCount: info.subscriberCount,
    uploadsPlaylistId: info.uploadsPlaylistId,
    category,
  };
  return prisma.youTubeApiChannel.upsert({
    where: { channelId: info.channelId },
    create: { id: newId(), channelId: info.channelId, active: true, ...data },
    update: { ...data, active: true },
  });
}

export interface CollectResult {
  channelId: string;
  title: string | null;
  ok: boolean;
  saved: number;
  message: string;
}

/** 채널 1개 수집: 업로드 재생목록 최신 N개 → 영상 상세 → 저장 */
export async function collectApiChannel(rowId: string, opts: { key?: string; perChannel?: number } = {}): Promise<CollectResult> {
  const row = await prisma.youTubeApiChannel.findUnique({ where: { id: rowId } });
  if (!row) return { channelId: '', title: null, ok: false, saved: 0, message: '채널을 찾을 수 없습니다.' };
  const key = opts.key ?? (await resolveYouTubeApiKey()).key;
  if (!key) return { channelId: row.channelId, title: row.title, ok: false, saved: 0, message: 'API 키가 없습니다.' };
  const per = clampInt(opts.perChannel, 1, 50, DEFAULT_YT_API_SETTINGS.perChannel);
  try {
    // 업로드 재생목록 ID 는 채널 ID 의 UC → UU 로 만들 수 있다(조회 실패 대비)
    const playlistId = row.uploadsPlaylistId ?? `UU${row.channelId.slice(2)}`;
    const list = await call('playlistItems', { part: 'contentDetails', playlistId, maxResults: String(per) }, key);
    const ids = parsePlaylistVideoIds(list);
    let saved = 0;
    if (ids.length > 0) {
      const detail = await call('videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(',') }, key);
      const videos = parseVideosResponse(detail).filter((v) => v.channelId === row.channelId);
      const now = new Date();
      for (const v of videos) {
        if (!v.usable) {
          // 비공개·퍼가기 금지로 바뀐 영상은 내린다
          await prisma.youTubeApiVideo.updateMany({ where: { videoId: v.videoId }, data: { hidden: true, fetchedAt: now } });
          continue;
        }
        const data = {
          title: v.title,
          thumbnail: v.thumbnail,
          publishedAt: v.publishedAt,
          views: v.views,
          durationSec: v.durationSec,
          isShort: v.isShort,
          liveState: v.liveState,
          fetchedAt: now,
        };
        await prisma.youTubeApiVideo.upsert({
          where: { videoId: v.videoId },
          create: { id: newId(), videoId: v.videoId, channelRowId: row.id, channelId: row.channelId, ...data },
          update: data,
        });
        saved++;
      }
      // 재생목록에 있는데 상세에서 사라진 영상(삭제·비공개)도 내린다
      const gone = ids.filter((id) => !videos.some((v) => v.videoId === id));
      if (gone.length) await prisma.youTubeApiVideo.updateMany({ where: { videoId: { in: gone } }, data: { hidden: true } });
    }
    await prisma.youTubeApiChannel.update({ where: { id: row.id }, data: { lastFetchedAt: new Date(), lastError: null } });
    return { channelId: row.channelId, title: row.title, ok: true, saved, message: `${saved}개 영상 저장` };
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await prisma.youTubeApiChannel.update({ where: { id: row.id }, data: { lastError: message } }).catch(() => undefined);
    return { channelId: row.channelId, title: row.title, ok: false, saved: 0, message };
  }
}

/** 활성 채널 전체 수집. 할당량이 바닥나면 남은 채널은 건너뛴다 */
export async function collectAllApiChannels(opts: { adminUserId?: string; auto?: boolean } = {}): Promise<{ ok: boolean; summary: string; results: CollectResult[] }> {
  const settings = await getYouTubeApiSettings();
  const { key } = await resolveYouTubeApiKey(settings);
  if (!key) return { ok: false, summary: 'API 키가 없어 수집하지 않았습니다.', results: [] };
  const rows = await prisma.youTubeApiChannel.findMany({
    where: { active: true },
    orderBy: [{ lastFetchedAt: { sort: 'asc', nulls: 'first' } }],
    select: { id: true },
    take: MAX_API_CHANNELS,
  });
  const results: CollectResult[] = [];
  for (const r of rows) {
    if (opts.auto) {
      const q = await getYouTubeQuotaUsage().catch(() => null);
      if (q && !q.usageUnavailable && q.used / Math.max(1, q.total) > AUTO_COLLECT_QUOTA_CEILING) {
        results.push({ channelId: '', title: null, ok: false, saved: 0, message: '할당량 70% 초과로 자동 수집을 멈췄습니다 (후원 채팅 송출 우선).' });
        break;
      }
    }
    const res = await collectApiChannel(r.id, { key, perChannel: settings.perChannel });
    results.push(res);
    if (!res.ok && /할당량/.test(res.message)) break;
  }
  const okCount = results.filter((r) => r.ok).length;
  const saved = results.reduce((s, r) => s + r.saved, 0);
  const failed = results.filter((r) => !r.ok && r.channelId).length;
  const stopped = results.find((r) => !r.ok && !r.channelId);
  const summary = rows.length === 0
    ? '수집할 채널이 없습니다.'
    : `채널 ${okCount}/${rows.length}개 수집 · 영상 ${saved}개 저장${failed ? ` · 실패 ${failed}개` : ''}${stopped ? ` · ${stopped.message}` : ''}`;
  await updateYouTubeApiSettings({ lastCollectAt: new Date().toISOString(), lastCollectSummary: `${opts.auto ? '[자동] ' : ''}${summary}` }, opts.adminUserId).catch(() => undefined);
  return { ok: failed === 0 && !stopped, summary, results };
}

const g = globalThis as unknown as { __ytApiAutoCollect?: Promise<unknown> | null };

/**
 * 방송국을 열 때 부른다. 자동 수집이 켜져 있고 간격이 지났으면 뒤에서 한 번 수집한다(기다리지 않는다).
 * 같은 프로세스에서 동시에 두 번 돌지 않는다.
 */
export function maybeAutoCollect(settings: YouTubeApiSettings): void {
  if (!settings.enabled || !settings.autoCollect || g.__ytApiAutoCollect) return;
  const last = settings.lastCollectAt ? Date.parse(settings.lastCollectAt) : 0;
  if (Date.now() - last < settings.intervalHours * 3600_000) return;
  g.__ytApiAutoCollect = (async () => {
    try {
      const { key } = await resolveYouTubeApiKey(settings);
      if (!key) return;
      const has = await prisma.youTubeApiChannel.count({ where: { active: true } });
      if (has === 0) return;
      // 다른 인스턴스와 겹치지 않도록 먼저 시각을 기록한다
      await updateYouTubeApiSettings({ lastCollectAt: new Date().toISOString() });
      await collectAllApiChannels({ auto: true });
    } catch (e) {
      logger.warn('youtube-api: 자동 수집 실패', { error: (e as Error).message });
    } finally {
      g.__ytApiAutoCollect = null;
    }
  })();
}

/** 방송국에 합칠 수집 영상 (최근 순) */
export async function loadApiVideosForHub(limit = 600) {
  const settings = await getYouTubeApiSettings();
  if (!settings.enabled) return { settings, rows: [] as ApiHubRow[], hiddenIds: new Set<string>() };
  maybeAutoCollect(settings);
  // 관리자가 숨긴 영상은 공개 피드(RSS)로 들어와도 방송국에서 뺀다
  const hiddenRows = await prisma.youTubeApiVideo
    .findMany({ where: { hidden: true }, select: { videoId: true }, take: 5000 })
    .catch(() => [] as Array<{ videoId: string }>);
  const hiddenIds = new Set(hiddenRows.map((r) => r.videoId));
  const rows = await prisma.youTubeApiVideo
    .findMany({
      where: { hidden: false, channel: { active: true } },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: {
        videoId: true, channelId: true, title: true, thumbnail: true, publishedAt: true, views: true, isShort: true, liveState: true,
        channel: { select: { title: true, avatarUrl: true, category: true } },
      },
    })
    .catch((e) => {
      logger.warn('youtube-api: 수집 영상 조회 실패', { error: (e as Error).message });
      return [];
    });
  return { settings, rows, hiddenIds };
}

export type ApiHubRow = {
  videoId: string;
  channelId: string;
  title: string;
  thumbnail: string | null;
  publishedAt: Date;
  views: number | null;
  isShort: boolean;
  liveState: string;
  channel: { title: string | null; avatarUrl: string | null; category: string };
};

export function apiCategoryOf(v: string): VideoCategorySlug {
  return isVideoCategory(v) && v !== 'all' && v !== 'donaido' ? v : 'talk';
}
