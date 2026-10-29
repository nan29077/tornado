import { prisma } from '@/server/db';
import { safeEqual } from '@/lib/crypto';

/**
 * [OV-1] 열린 오버레이 연결의 토큰 재확인.
 *
 * overlay-access.ts 와 나눈 이유: 이 모듈은 overlay-bus.ts(결제·웹훅 경로가 함께 쓰는 버스)에서도
 * 불러야 하는데, overlay-access.ts 는 세션(next/headers)을 끌어온다. 버스가 세션 모듈에 묶이지 않게 한다.
 *
 * 토큰 검사는 연결을 열 때 한 번만 한다. 재발급 알림(Redis)이 어떤 이유로 이 인스턴스에
 * 닿지 않으면, 유출된 OBS 주소가 연결을 끊지 않는 한 후원자 이름·메시지를 계속 받는다.
 * 그래서 하트비트마다 "지금 저장된 토큰 해시" 와 연결이 통과한 해시를 다시 비교한다.
 *
 * 한 크리에이터에 연결이 여러 개 붙어도 같은 틱에는 한 번만 읽도록 아주 짧게 캐시하고,
 * 동시에 들어온 조회는 하나로 묶는다. creatorId 는 고유 인덱스라 조회 자체도 가볍다.
 */
const TOKEN_HASH_TTL_MS = 3000;

const globalForAccess = globalThis as unknown as {
  overlayTokenHashCache?: Map<string, { at: number; value: string | null }>;
  overlayTokenHashInflight?: Map<string, Promise<string | null>>;
};
const tokenHashCache = globalForAccess.overlayTokenHashCache ?? new Map<string, { at: number; value: string | null }>();
globalForAccess.overlayTokenHashCache = tokenHashCache;
const tokenHashInflight = globalForAccess.overlayTokenHashInflight ?? new Map<string, Promise<string | null>>();
globalForAccess.overlayTokenHashInflight = tokenHashInflight;

/** 지금 저장된 오버레이 토큰 해시. 설정이 없으면 null. DB 오류는 호출부로 던진다. */
export async function currentOverlayTokenHash(creatorId: string): Promise<string | null> {
  const hit = tokenHashCache.get(creatorId);
  if (hit && Date.now() - hit.at < TOKEN_HASH_TTL_MS) return hit.value;

  const running = tokenHashInflight.get(creatorId);
  if (running) return running;

  const p = prisma.overlaySetting
    .findUnique({ where: { creatorId }, select: { tokenHash: true } })
    .then((row) => {
      const value = row?.tokenHash ?? null;
      tokenHashCache.set(creatorId, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (tokenHashInflight.get(creatorId) === p) tokenHashInflight.delete(creatorId);
    });
  tokenHashInflight.set(creatorId, p);
  return p;
}

/** 재발급 직후(또는 재발급 알림을 받았을 때) 새 해시를 바로 심는다. */
export function primeOverlayTokenHash(creatorId: string, value: string | null): void {
  tokenHashCache.set(creatorId, { at: Date.now(), value });
  tokenHashInflight.delete(creatorId);
}

/**
 * 연결이 통과한 해시가 아직 유효한지.
 * DB 를 읽지 못하면 true(유지)로 본다 — 일시적인 DB 오류로 방송 중인 정상 소스를 끊지 않는다.
 * 그 경우에도 재발급 알림(Redis) 경로는 따로 동작한다.
 */
export async function isOverlayTokenStillValid(creatorId: string, connectedHash: string): Promise<boolean> {
  try {
    const current = await currentOverlayTokenHash(creatorId);
    return Boolean(current && safeEqual(current, connectedHash));
  } catch {
    return true;
  }
}
