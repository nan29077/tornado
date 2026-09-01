import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { GameStudioState } from '@/server/services/game-state';

/**
 * 게임 오버레이 실시간 버스.
 *
 * 후원 알림 버스(overlay-bus.ts)와 채널을 분리한다.
 *  - 후원 알림은 "한 건씩 순차 재생"하는 이벤트 스트림이고,
 *    게임은 "지금 화면 상태"를 통째로 덮어쓰는 스냅샷이다. 성격이 다르다.
 *  - 채널을 나눠 두면 게임 쪽 변경이 후원 알림 경로에 영향을 주지 않는다.
 *    (후원 송출은 서비스의 본류이므로 어떤 경우에도 건드리지 않는다)
 *
 * 버스에는 **내부 상태(정답 포함)** 를 그대로 싣는다.
 * 방송 화면·참여 페이지로 나갈 때 각 라우트가 공개용으로 잘라낸다.
 */

const CHANNEL = 'tornado:overlay:game';

const globalForGameBus = globalThis as unknown as {
  gameEmitter?: EventEmitter;
  gamePub?: Redis;
  gameSub?: Redis;
  gamePendingPublish?: Map<string, ReturnType<typeof setTimeout>>;
};

const emitter =
  globalForGameBus.gameEmitter ??
  (() => {
    const e = new EventEmitter();
    // 크리에이터 1명에 오버레이·스튜디오·팝아웃 창이 동시에 붙는다.
    e.setMaxListeners(0);
    return e;
  })();
globalForGameBus.gameEmitter = emitter;

function ensureRedis() {
  if (!env.redisUrl) return;
  if (globalForGameBus.gamePub && globalForGameBus.gameSub) return;
  try {
    const retryStrategy = (times: number) => (times > 5 ? null : Math.min(times * 300, 2000));
    const pub = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy });
    const sub = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy });
    pub.on('error', (e: Error) => logger.warn('game pub error', { message: e.message }));
    sub.on('error', (e: Error) => logger.warn('game sub error', { message: e.message }));
    sub.subscribe(CHANNEL).catch((e: Error) => logger.warn('game subscribe 실패', { message: e.message }));
    sub.on('message', (_ch: string, raw: string) => {
      try {
        const state = JSON.parse(raw) as GameStudioState;
        emitter.emit(state.creatorId, state);
      } catch {
        /* ignore */
      }
    });
    globalForGameBus.gamePub = pub;
    globalForGameBus.gameSub = sub;
  } catch (e) {
    logger.warn('게임 Redis 연결 실패. 인메모리 버스만 사용합니다.', { message: (e as Error).message });
  }
}

ensureRedis();

/**
 * 상태를 즉시 발행한다.
 * 상태 전이(시작·마감·발표)처럼 지연되면 안 되는 변화에 쓴다.
 */
export function publishGameState(state: GameStudioState) {
  emitter.emit(state.creatorId, state);
  globalForGameBus.gamePub?.publish(CHANNEL, JSON.stringify(state)).catch((e: Error) => {
    logger.warn('게임 상태 Redis 전파 실패', { creatorId: state.creatorId, message: e.message });
  });
}

const pending = globalForGameBus.gamePendingPublish ?? new Map<string, ReturnType<typeof setTimeout>>();
globalForGameBus.gamePendingPublish = pending;

/** 참여 폭주 시 초당 발행 횟수 상한 (밀리초) */
const THROTTLE_MS = 700;

/**
 * 참여자 유입처럼 초당 수백 번 일어날 수 있는 변화를 묶어서 발행한다.
 *
 * 시청자 5,000명이 20초 안에 참여하면 참여 1건마다 발행할 경우 초당 250회 브로드캐스트가 된다.
 * 화면에 보이는 것은 "참여자 수"와 "막대 길이"뿐이라 0.7초에 한 번이면 충분하다.
 */
export function publishGameStateThrottled(creatorId: string, build: () => Promise<GameStudioState | null>) {
  if (pending.has(creatorId)) return;
  const timer = setTimeout(() => {
    pending.delete(creatorId);
    build()
      .then((state) => {
        if (state) publishGameState(state);
      })
      .catch((e: Error) => logger.warn('게임 상태 발행 실패', { creatorId, message: e.message }));
  }, THROTTLE_MS);
  // 프로세스 종료를 막지 않는다.
  timer.unref?.();
  pending.set(creatorId, timer);
}

export function subscribeGame(creatorId: string, handler: (s: GameStudioState) => void): () => void {
  emitter.on(creatorId, handler);
  return () => emitter.off(creatorId, handler);
}
