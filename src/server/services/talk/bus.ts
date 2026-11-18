import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { quietRedisWhenUnavailable, redisRetryStrategy } from '@/server/redis-quiet';

/**
 * 팬챗 실시간 알림 버스 (2026-11-18).
 *
 * 메시지 본문은 싣지 않는다. "이 팬챗방에 새 소식이 있다" 는 신호만 보내고,
 * 화면은 신호를 받으면 권한 확인을 거치는 기존 조회(pollFanThreadAction 등)로 내용을 가져온다.
 * 그래서 신호가 다른 사람에게 새어도 내용은 새지 않는다.
 *
 * - 단일 인스턴스: 인메모리 EventEmitter
 * - 다중 인스턴스: Redis Pub/Sub (오버레이 버스와 같은 방식). Redis 가 없으면 인메모리만 쓰고,
 *   화면은 20초 간격 보충 조회로 놓친 신호를 메운다.
 */

export type TalkSignalKind = 'BROADCAST' | 'DIRECT' | 'FAN_REPLY' | 'LETTER' | 'REACTION' | 'DELETE';

export interface TalkSignal {
  creatorId: string;
  kind: TalkSignalKind;
  /** DIRECT · FAN_REPLY · LETTER 의 상대 팬. 이 팬(또는 크리에이터)에게만 의미가 있다 */
  fanUserId?: string | null;
  at: string;
}

const CHANNEL = 'tornado:talk';

const g = globalThis as unknown as { talkEmitter?: EventEmitter; talkPub?: Redis; talkSub?: Redis; talkRedisOff?: boolean };

const emitter =
  g.talkEmitter ??
  (() => {
    const e = new EventEmitter();
    e.setMaxListeners(0);
    return e;
  })();
g.talkEmitter = emitter;

function ensureRedis() {
  if (!env.redisUrl || g.talkRedisOff) return;
  if (g.talkPub && g.talkSub) return;
  try {
    const pub = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy: redisRetryStrategy });
    const sub = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy: redisRetryStrategy });
    // Redis 가 없는 로컬(인메모리 폴백 허용)에서 포기하면 다시 붙지 않는다 — 연결마다 재시도하며 로그를 쏟지 않게
    quietRedisWhenUnavailable(pub, '팬챗 알림 발행', () => {
      g.talkPub = undefined;
      g.talkRedisOff = true;
    });
    quietRedisWhenUnavailable(sub, '팬챗 알림 구독', () => {
      g.talkSub = undefined;
      g.talkRedisOff = true;
    });
    // 연결된 뒤에 구독한다 (오프라인 큐를 끄고 있으므로 연결 전 구독은 바로 실패한다)
    sub.on('ready', () => {
      sub.subscribe(CHANNEL).catch((e: Error) => logger.warn('talk subscribe 실패', { message: e.message }));
    });
    sub.on('message', (_ch: string, raw: string) => {
      try {
        const s = JSON.parse(raw) as TalkSignal & { origin?: string };
        if (s.origin === ORIGIN) return; // 내가 보낸 것은 이미 로컬로 전달했다
        emitter.emit(s.creatorId, s);
      } catch {
        /* ignore */
      }
    });
    g.talkPub = pub;
    g.talkSub = sub;
  } catch (e) {
    logger.warn('팬챗 Redis 연결 실패. 인메모리 버스만 사용합니다.', { message: (e as Error).message });
  }
}

const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** 새 소식 신호 보내기. 실패해도 예외를 던지지 않는다 (화면은 보충 조회로 따라잡는다) */
export function publishTalkSignal(signal: Omit<TalkSignal, 'at'> & { at?: string }): void {
  const s: TalkSignal = { ...signal, at: signal.at ?? new Date().toISOString() };
  try {
    emitter.emit(s.creatorId, s);
  } catch {
    /* ignore */
  }
  try {
    ensureRedis();
    g.talkPub?.publish(CHANNEL, JSON.stringify({ ...s, origin: ORIGIN })).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** 한 팬챗방의 신호 구독. 해제 함수를 돌려준다 */
export function subscribeTalkSignals(creatorId: string, fn: (s: TalkSignal) => void): () => void {
  ensureRedis();
  emitter.on(creatorId, fn);
  return () => {
    emitter.off(creatorId, fn);
  };
}
