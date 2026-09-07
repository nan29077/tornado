import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { quietRedisWhenUnavailable } from '@/server/redis-quiet';

/**
 * Redis 가 없는 로컬에서 로그가 조용해야 한다.
 *
 * 실제 로그가 이랬다.
 * ```
 * warn  redis error          connect ECONNREFUSED 127.0.0.1:6379   ← 수십 줄
 * warn  overlay pub error    connect ECONNREFUSED 127.0.0.1:6379
 * warn  게임 상태 Redis 전파 실패  Connection is closed.
 * ```
 * 기능은 멀쩡했다(두 버스 모두 같은 프로세스 안에서 먼저 전달한다). 그런데 로그만 보면
 * 오버레이가 고장 난 것처럼 읽혀, 진짜 문제를 쫓는 동안 계속 시선을 끌었다.
 */

/** ioredis 흉내 — on/status/disconnect 만 있으면 된다. */
function fakeRedis(): Redis & { fire: (ev: string, arg?: unknown) => void; status: string } {
  const e = new EventEmitter();
  const client = {
    status: 'connecting',
    on(ev: string, fn: (...a: unknown[]) => void) {
      e.on(ev, fn);
      return client;
    },
    disconnect: vi.fn(),
    fire(ev: string, arg?: unknown) {
      e.emit(ev, arg);
    },
  };
  return client as unknown as Redis & { fire: (ev: string, arg?: unknown) => void; status: string };
}

describe('Redis 가 없을 때', () => {
  it('재접속을 포기하면 클라이언트를 놓고 조용해진다', () => {
    const client = fakeRedis();
    const giveUp = vi.fn();
    quietRedisWhenUnavailable(client, '게임 상태 발행', giveUp);

    // 연결 오류가 여러 번 나도 그것만으로는 포기하지 않는다(잠깐 끊긴 것일 수 있다).
    client.fire('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    client.fire('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    expect(giveUp).not.toHaveBeenCalled();

    // 재시도 한도를 다 쓰면 ioredis 가 'end' 를 낸다. 그때 한 번만 정리한다.
    client.fire('end');
    expect(giveUp).toHaveBeenCalledTimes(1);

    // 여러 번 나도 한 번만 알린다(같은 문장이 쌓이지 않게).
    client.fire('end');
    client.fire('end');
    expect(giveUp).toHaveBeenCalledTimes(1);
  });

  it('연결이 이미 끝난 뒤의 오류에서도 정리한다', () => {
    const client = fakeRedis();
    const giveUp = vi.fn();
    quietRedisWhenUnavailable(client, '후원 알림 발행', giveUp);

    client.status = 'end';
    client.fire('error', new Error('Connection is closed.'));
    expect(giveUp).toHaveBeenCalledTimes(1);
  });
});
