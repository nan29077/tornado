import Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Redis (ElastiCache) 클라이언트.
 * 로컬/테스트에서 Redis 가 없을 때는 인메모리 폴백을 사용한다.
 * 운영에서는 ALLOW_INMEMORY_FALLBACK=false 로 두어 폴백을 금지한다.
 */

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  incr(key: string, ttlSec?: number): Promise<number>;
  del(key: string): Promise<void>;
  /** 원자적 선점. 이미 존재하면 false */
  setnx(key: string, value: string, ttlSec: number): Promise<boolean>;
  /**
   * Redis 명령 실패로 인메모리 폴백으로 강등된 상태인지.
   * 폴백 중에는 인스턴스마다 카운터가 따로 놀아 속도 제한이 실제로는 우회될 수 있으므로,
   * 호출부가 이 값을 보고 보수적으로 판단할 수 있게 노출한다(L-1).
   */
  isDegraded(): boolean;
}

class MemoryStore implements KvStore {
  private map = new Map<string, { v: string; exp: number }>();

  private alive(key: string) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string) {
    return this.alive(key)?.v ?? null;
  }

  async set(key: string, value: string, ttlSec?: number) {
    this.map.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }

  async incr(key: string, ttlSec?: number) {
    const cur = Number((await this.get(key)) ?? 0) + 1;
    const existing = this.alive(key);
    this.map.set(key, {
      v: String(cur),
      exp: existing?.exp || (ttlSec ? Date.now() + ttlSec * 1000 : 0),
    });
    return cur;
  }

  async del(key: string) {
    this.map.delete(key);
  }

  async setnx(key: string, value: string, ttlSec: number) {
    if (this.alive(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }

  isDegraded() {
    return false;
  }
}

/** INCR 후 값이 1(최초 생성)일 때만 EXPIRE 를 같은 호출 안에서 원자적으로 건다. */
const INCR_WITH_TTL_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then
  local ttl = tonumber(ARGV[1])
  if ttl and ttl > 0 then
    redis.call('EXPIRE', KEYS[1], ttl)
  end
end
return v
`;

/**
 * Redis 스토어.
 * 개발 환경에서 Redis 가 떠 있지 않아도 앱이 죽지 않도록,
 * 명령 실패 시 인메모리 스토어로 자동 강등한다(운영에서는 폴백 금지).
 */
class RedisStore implements KvStore {
  private fallback: MemoryStore | null = null;

  constructor(private client: Redis) {}

  private degrade(e: unknown): MemoryStore {
    if (!env.allowInMemoryFallback) throw e;
    if (!this.fallback) {
      logger.warn('Redis 명령 실패. 인메모리 폴백으로 전환합니다(개발 전용).', {
        message: (e as Error)?.message,
      });
      this.fallback = new MemoryStore();
    }
    return this.fallback;
  }

  async get(key: string) {
    if (this.fallback) return this.fallback.get(key);
    try {
      return await this.client.get(key);
    } catch (e) {
      return this.degrade(e).get(key);
    }
  }

  async set(key: string, value: string, ttlSec?: number) {
    if (this.fallback) return this.fallback.set(key, value, ttlSec);
    try {
      if (ttlSec) await this.client.set(key, value, 'EX', ttlSec);
      else await this.client.set(key, value);
    } catch (e) {
      await this.degrade(e).set(key, value, ttlSec);
    }
  }

  async incr(key: string, ttlSec?: number) {
    if (this.fallback) return this.fallback.incr(key, ttlSec);
    try {
      // INCR 다음에 EXPIRE 를 따로 호출하면 그 사이에 프로세스가 죽었을 때
      // 카운터가 TTL 없이 영구히 남는다(L-7). Lua 스크립트로 한 번에 묶어 원자적으로 처리한다.
      const n = await this.client.eval(INCR_WITH_TTL_SCRIPT, 1, key, String(ttlSec ?? 0));
      return Number(n);
    } catch (e) {
      return this.degrade(e).incr(key, ttlSec);
    }
  }

  async del(key: string) {
    if (this.fallback) return this.fallback.del(key);
    try {
      await this.client.del(key);
    } catch (e) {
      await this.degrade(e).del(key);
    }
  }

  async setnx(key: string, value: string, ttlSec: number) {
    if (this.fallback) return this.fallback.setnx(key, value, ttlSec);
    try {
      const r = await this.client.set(key, value, 'EX', ttlSec, 'NX');
      return r === 'OK';
    } catch (e) {
      return this.degrade(e).setnx(key, value, ttlSec);
    }
  }

  isDegraded() {
    return this.fallback !== null;
  }
}

const globalForKv = globalThis as unknown as { kv?: KvStore; redis?: Redis };

function build(): KvStore {
  if (!env.redisUrl) {
    if (!env.allowInMemoryFallback) throw new Error('REDIS_URL 이 필요합니다.');
    logger.warn('REDIS_URL 미설정. 인메모리 폴백을 사용합니다.');
    return new MemoryStore();
  }
  try {
    const client = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      // 오프라인 큐를 끄면 연결 불가 시 즉시 에러가 나므로 폴백이 빠르게 동작한다
      enableOfflineQueue: !env.allowInMemoryFallback,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 300, 2000)),
    });
    client.on('error', (e: Error) => logger.warn('redis error', { message: e.message }));
    globalForKv.redis = client;
    return new RedisStore(client);
  } catch (e) {
    if (!env.allowInMemoryFallback) throw e;
    logger.warn('Redis 연결 실패. 인메모리 폴백을 사용합니다.');
    return new MemoryStore();
  }
}

export const kv: KvStore = globalForKv.kv ?? build();
if (process.env.NODE_ENV !== 'production') globalForKv.kv = kv;
