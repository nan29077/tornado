import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { decrypt, encrypt, generateToken, safeEqual, tokenHash } from '@/lib/crypto';
import { newId } from '@/lib/id';
import {
  getYouTubeAdapter,
  type YouTubeActiveBroadcast,
  type YouTubeAdapter,
} from '@/server/adapters/youtube';
import { reserveYouTubeQuota, releaseYouTubeQuota } from './youtube-quota';

/**
 * 유튜브 연결(토큰 · 라이브 방송) 공용 처리.
 *
 * 예전에는 같은 갱신 로직이 broadcast-dispatch / actions/studio / game-share 세 곳에
 * 복제되어 있었다. 그래서 (1) 한 곳만 고치면 나머지가 어긋나고, (2) 세 경로가 동시에
 * refresh 를 호출해 서로의 access token 을 무효화했다. 한 곳으로 모으고 잠금을 건다.
 */

/** 만료 판정 여유. 서버 시계 오차와 API 왕복 시간을 감안해 넉넉히 잡는다. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** 같은 크리에이터의 동시 갱신을 막는 잠금 시간(초). */
const REFRESH_LOCK_SEC = 20;
/** 잠금을 놓쳤을 때 다른 요청의 갱신 결과를 기다리는 최대 시간. */
const REFRESH_WAIT_MS = 6_000;

// ---------------------------------------------------------------------------
// OAuth state (1회성 · 만료 있음)
// ---------------------------------------------------------------------------

/** 채팅 등록에 반드시 필요한 스코프. 없으면 연결은 성공해도 전송이 전건 실패한다. */
export const REQUIRED_YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const OAUTH_STATE_TTL_SEC = 600;

function stateKey(creatorId: string, nonce: string) {
  return `yt:oauth:${creatorId}:${nonce}`;
}

/**
 * OAuth state 발급.
 *
 * 예전에는 `creatorId.HMAC(creatorId)` 로 **크리에이터마다 영구 고정**이었다. 위조는 막지만
 * 브라우저 기록에 남은 URL 을 언제든 다시 열 수 있어 재사용·재생 방어가 없었다.
 * 난수 nonce 를 저장소에 넣고 콜백에서 1회 소비한다.
 */
export async function createYouTubeOAuthState(creatorId: string): Promise<string> {
  const nonce = generateToken(16);
  await kv.set(stateKey(creatorId, nonce), '1', OAUTH_STATE_TTL_SEC);
  const payload = `${creatorId}.${nonce}`;
  return `${payload}.${tokenHash(payload)}`;
}

export type OAuthStateResult =
  | { ok: true; creatorId: string }
  | { ok: false; reason: 'MALFORMED' | 'SIGNATURE' | 'MISMATCH' | 'USED_OR_EXPIRED' };

/** state 를 검증하고 **소비**한다. 같은 state 로 두 번 통과하지 않는다. */
export async function consumeYouTubeOAuthState(state: string, sessionCreatorId: string): Promise<OAuthStateResult> {
  const parts = (state ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [creatorId, nonce, signature] = parts;
  if (!creatorId || !nonce || !signature) return { ok: false, reason: 'MALFORMED' };
  if (!safeEqual(tokenHash(`${creatorId}.${nonce}`), signature)) return { ok: false, reason: 'SIGNATURE' };
  if (creatorId !== sessionCreatorId) return { ok: false, reason: 'MISMATCH' };

  const key = stateKey(creatorId, nonce);
  const exists = await kv.get(key).catch(() => null);
  if (!exists) return { ok: false, reason: 'USED_OR_EXPIRED' };
  await kv.del(key).catch(() => undefined);
  return { ok: true, creatorId };
}

/** 발급받은 스코프에 채팅 등록 권한이 포함되어 있는지. */
export function hasRequiredScope(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).some((s) => s.trim() === REQUIRED_YOUTUBE_SCOPE);
}

export type ConnectionRow = {
  id: string;
  creatorId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: Date;
  status: string;
};

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'NO_CONNECTION' | 'TOKEN_REFRESH_FAILED'; permanent: boolean; message?: string };

/**
 * 구글이 영구 실패로 확정한 코드.
 * 이 경우에는 EXPIRED 로 두고 계속 재시도하면 안 된다. 사람이 다시 연결해야 하므로
 * REVOKED 로 올려 화면이 "재연결 필요"를 정확히 안내하게 한다.
 */
function isPermanentRefreshFailure(code?: string, message?: string): boolean {
  const c = (code ?? '').toLowerCase();
  if (c === 'invalid_grant' || c === 'unauthorized_client' || c === 'invalid_client') return true;
  return /invalid_grant|token has been (expired|revoked)/i.test(message ?? '');
}

function usable(conn: { status: string } | null): boolean {
  // EXPIRED 는 "이전 갱신이 한 번 실패했다"는 뜻일 뿐 영구 실패가 아니다.
  // REVOKED / ERROR 는 사람이 다시 연결해야 하므로 시도하지 않는다.
  return Boolean(conn && (conn.status === 'CONNECTED' || conn.status === 'EXPIRED'));
}

/**
 * 유효한 access token 을 돌려준다. 필요하면 갱신하고 DB에 반영한다.
 * 동시 갱신은 Redis 잠금으로 한 요청만 수행하고, 나머지는 그 결과를 다시 읽는다.
 */
export async function ensureYouTubeAccessToken(
  conn: ConnectionRow | null,
  adapter: YouTubeAdapter = getYouTubeAdapter(),
): Promise<TokenResult> {
  if (!usable(conn) || !conn) return { ok: false, reason: 'NO_CONNECTION', permanent: true };

  const needsRefresh = conn.status === 'EXPIRED' || conn.expiresAt.getTime() < Date.now() + EXPIRY_MARGIN_MS;
  if (!needsRefresh) return { ok: true, accessToken: decrypt(conn.accessTokenEnc) };

  const lockKey = `yt:refresh:${conn.creatorId}`;
  const gotLock = await kv.setnx(lockKey, '1', REFRESH_LOCK_SEC).catch(() => true);

  if (!gotLock) {
    // 다른 요청이 갱신 중이다. 그 결과를 기다렸다가 DB 에서 다시 읽는다.
    // 여기서 같이 refresh 를 호출하면 구글이 토큰을 회전시키는 계정에서
    // 서로의 access token 을 무효화한다.
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const fresh = await prisma.youTubeConnection.findUnique({ where: { id: conn.id } });
      if (!fresh) return { ok: false, reason: 'NO_CONNECTION', permanent: true };
      if (fresh.status === 'REVOKED' || fresh.status === 'ERROR') {
        return { ok: false, reason: 'TOKEN_REFRESH_FAILED', permanent: true, message: fresh.lastError ?? undefined };
      }
      if (fresh.expiresAt.getTime() > Date.now() + 30_000 && fresh.status === 'CONNECTED') {
        return { ok: true, accessToken: decrypt(fresh.accessTokenEnc) };
      }
    }
    return { ok: false, reason: 'TOKEN_REFRESH_FAILED', permanent: false, message: '토큰 갱신 대기 시간 초과' };
  }

  try {
    const refreshed = await adapter.refresh(decrypt(conn.refreshTokenEnc));
    if (!refreshed.ok || !refreshed.data) {
      const permanent = isPermanentRefreshFailure(refreshed.code, refreshed.message);
      await prisma.youTubeConnection.update({
        where: { id: conn.id },
        data: {
          // 영구 실패는 REVOKED 로 확정한다. EXPIRED 로 두면 후원이 들어올 때마다
          // 실패가 확정된 refresh 를 영원히 재시도한다.
          status: permanent ? 'REVOKED' : 'EXPIRED',
          lastError: refreshed.message ?? 'refresh 실패',
          lastCheckedAt: new Date(),
        },
      });
      return { ok: false, reason: 'TOKEN_REFRESH_FAILED', permanent, message: refreshed.message };
    }

    await prisma.youTubeConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: encrypt(refreshed.data.accessToken),
        // 구글이 refresh token 을 교체해 주는 경우가 있다. 버리면 다음 갱신이 영구 실패한다.
        ...(refreshed.data.refreshToken ? { refreshTokenEnc: encrypt(refreshed.data.refreshToken) } : {}),
        expiresAt: refreshed.data.expiresAt,
        status: 'CONNECTED',
        lastError: null,
        lastCheckedAt: new Date(),
      },
    });
    return { ok: true, accessToken: refreshed.data.accessToken };
  } finally {
    await kv.del(lockKey).catch(() => undefined);
  }
}

export type BroadcastResult =
  | { ok: true; broadcast: YouTubeActiveBroadcast }
  | {
      ok: false;
      reason: 'QUOTA_EXCEEDED' | 'BROADCAST_LOOKUP_FAILED' | 'NO_ACTIVE_BROADCAST' | 'CHAT_DISABLED';
      message?: string;
    };

interface CachedBroadcast {
  broadcastId: string;
  liveChatId: string;
  title: string;
  lifeCycleStatus: string;
  chatEnabled: boolean;
  startedAt: string | null;
}

function cacheKey(creatorId: string) {
  return `yt:live:${creatorId}`;
}

/** 캐시를 버린다. 전송이 liveChatId 문제로 실패했을 때 호출한다. */
export async function invalidateBroadcastCache(creatorId: string) {
  await kv.del(cacheKey(creatorId)).catch(() => undefined);
}

/**
 * 진행 중인 라이브 방송을 찾는다. 짧은 TTL 동안 결과를 재사용한다.
 *
 * 후원 1건마다 조회하면 (1) 조회 비용도 할당량을 먹고, (2) 그 왕복 시간이 그대로
 * 후원 처리 지연이 된다. 방송은 몇 초 사이에 바뀌지 않으므로 짧게 캐시한다.
 * 전송이 채팅 관련 오류로 실패하면 캐시를 버리고 다음 건에서 다시 조회한다.
 */
export async function resolveActiveBroadcast(
  creatorId: string,
  accessToken: string,
  adapter: YouTubeAdapter = getYouTubeAdapter(),
): Promise<BroadcastResult> {
  const key = cacheKey(creatorId);
  if (env.youtube.broadcastCacheSec > 0) {
    const raw = await kv.get(key).catch(() => null);
    if (raw) {
      try {
        const c = JSON.parse(raw) as CachedBroadcast;
        return {
          ok: true,
          broadcast: {
            broadcastId: c.broadcastId,
            liveChatId: c.liveChatId,
            title: c.title,
            lifeCycleStatus: c.lifeCycleStatus,
            chatEnabled: c.chatEnabled,
            startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
          },
        };
      } catch {
        await kv.del(key).catch(() => undefined);
      }
    }
  }

  // 조회도 할당량을 소비한다. 계상하지 않으면 잔여 건수가 항상 실제보다 크게 보인다.
  const lookupCost = env.youtube.listQuotaCost;
  const reserved = await reserveYouTubeQuota({ cost: lookupCost, creatorId, purpose: 'lookup' });
  if (!reserved) {
    // 할당량 소진은 "조회가 깨졌다" 와 성격이 다르다. 시간이 지나면(태평양시 자정) 저절로
    // 풀리는 일시적 상태이고, 운영자가 봐야 할 조치도 다르다. 이유를 뭉개지 않는다.
    return { ok: false, reason: 'QUOTA_EXCEEDED', message: '일일 할당량 초과로 방송 조회를 건너뜁니다.' };
  }

  const live = await adapter.findActiveBroadcast(accessToken);
  if (!live.ok) {
    // 실패한 조회는 예산을 되돌린다.
    await releaseYouTubeQuota({ cost: lookupCost, creatorId, purpose: 'lookup' });
    await prisma.youTubeConnection
      .updateMany({
        where: { creatorId },
        data: { lastError: live.message ?? '라이브 방송 조회 실패', lastCheckedAt: new Date() },
      })
      .catch(() => undefined);
    logger.warn('유튜브 라이브 방송 조회 실패', { creatorId, code: live.code ?? null, message: live.message ?? null });
    return { ok: false, reason: 'BROADCAST_LOOKUP_FAILED', message: live.message };
  }

  const data = live.data;
  // 종료된 방송을 잡고 있으면 다음 후원까지 계속 실패한다. 종료 시각을 남기고 캐시도 비운다.
  if (!data || !data.liveChatId || data.lifeCycleStatus === 'complete') {
    await kv.del(key).catch(() => undefined);
    if (data?.broadcastId) {
      await prisma.youTubeBroadcast
        .updateMany({
          where: { creatorId, broadcastId: data.broadcastId, endedAt: null },
          data: { endedAt: new Date(), lifeCycle: data.lifeCycleStatus },
        })
        .catch(() => undefined);
    }
    return { ok: false, reason: 'NO_ACTIVE_BROADCAST' };
  }
  if (!data.chatEnabled) {
    // 채팅이 꺼진 방송에 전송을 시도하면 예산만 쓰고 확정 실패한다. 미리 걸러낸다.
    return { ok: false, reason: 'CHAT_DISABLED' };
  }

  if (env.youtube.broadcastCacheSec > 0) {
    const payload: CachedBroadcast = {
      broadcastId: data.broadcastId,
      liveChatId: data.liveChatId,
      title: data.title,
      lifeCycleStatus: data.lifeCycleStatus,
      chatEnabled: data.chatEnabled,
      startedAt: data.startedAt ? data.startedAt.toISOString() : null,
    };
    await kv.set(key, JSON.stringify(payload), env.youtube.broadcastCacheSec).catch(() => undefined);
  }

  return { ok: true, broadcast: data };
}

/**
 * 방송 정보를 DB 에 반영한다.
 * update 절에 메타를 함께 넣지 않으면 최초 감지 시점의 제목·채팅 활성 여부가 그대로 굳어
 * 스튜디오/관리자 화면이 며칠 전 방송을 계속 보여 준다.
 */
export async function upsertBroadcastRow(creatorId: string, data: YouTubeActiveBroadcast) {
  return prisma.youTubeBroadcast.upsert({
    where: { creatorId_broadcastId: { creatorId, broadcastId: data.broadcastId } },
    create: {
      id: newId(),
      creatorId,
      broadcastId: data.broadcastId,
      liveChatId: data.liveChatId,
      title: data.title,
      lifeCycle: data.lifeCycleStatus,
      chatEnabled: data.chatEnabled,
      startedAt: data.startedAt ?? null,
    },
    update: {
      liveChatId: data.liveChatId,
      lifeCycle: data.lifeCycleStatus,
      title: data.title,
      chatEnabled: data.chatEnabled,
      detectedAt: new Date(),
      endedAt: null,
    },
  });
}

/**
 * 연결 해제. 구글 쪽 권한까지 회수하고 토큰 암호문을 지운다.
 *
 * status 만 REVOKED 로 바꾸면 구글 계정에는 권한이 그대로 남고 우리 DB 에도
 * 복호화 가능한 토큰이 남는다. 화면은 "더 이상 사용되지 않습니다"라고 안내하므로
 * 실제 동작이 그 안내와 같아야 한다.
 */
export async function revokeYouTubeConnection(input: {
  connectionId: string;
  refreshTokenEnc: string;
  reason: string;
}): Promise<{ providerRevoked: boolean }> {
  let providerRevoked = false;
  try {
    const adapter = getYouTubeAdapter();
    const res = await adapter.revoke(decrypt(input.refreshTokenEnc));
    providerRevoked = Boolean(res.ok);
    if (!res.ok) logger.warn('유튜브 권한 회수 실패(로컬 토큰은 폐기함)', { code: res.code ?? null });
  } catch (e) {
    // 어댑터 미구성·네트워크 오류로 회수에 실패해도 우리 토큰 폐기는 반드시 진행한다.
    logger.warn('유튜브 권한 회수 호출 실패(로컬 토큰은 폐기함)', { message: (e as Error)?.message });
  }

  await prisma.youTubeConnection.update({
    where: { id: input.connectionId },
    data: {
      status: 'REVOKED',
      accessTokenEnc: '',
      refreshTokenEnc: '',
      lastError: input.reason,
      lastCheckedAt: new Date(),
    },
  });
  return { providerRevoked };
}
