import { describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { kv } from '@/server/redis';

/**
 * P2-21b. EMMA MO 크론 잠금은 **자기 토큰일 때만** 지운다.
 *
 * 실행이 잠금 TTL 을 넘기면 다음 실행이 새 잠금을 잡는다. 앞 실행이 끝나며 잠금을 무조건 지우면
 * 뒤 실행의 잠금이 사라져 세 번째 실행까지 겹친다.
 */
const LOCK_KEY = 'cron:emma-mo:lock';

vi.mock('@/server/services/emma-mo-ingest', () => ({
  runEmmaMoPolling: vi.fn(async () => {
    // 실행 도중 잠금이 만료되고 다른 실행이 새 잠금을 잡은 상황
    await kv.set(LOCK_KEY, 'other-run-token', 50);
    return { fetched: 0, handed: 0, skipped: 0, failed: 0, deferred: 0, abandoned: 0, skippedRatio: 0, details: [] };
  }),
}));

describe('EMMA MO 크론 잠금', () => {
  it('다른 실행이 잡은 잠금은 지우지 않는다', async () => {
    const prevSecret = env.cron.secret;
    (env.cron as { secret: string }).secret = 'test-cron-secret';
    try {
      await kv.del(LOCK_KEY);
      const { GET } = await import('@/app/api/cron/emma-mo/route');
      const res = await GET(new Request('http://localhost/api/cron/emma-mo', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skippedRatio).toBe(0);
      expect(await kv.get(LOCK_KEY)).toBe('other-run-token');
    } finally {
      (env.cron as { secret: string }).secret = prevSecret;
      await kv.del(LOCK_KEY);
    }
  });

  it('자기 잠금은 끝나면 지운다', async () => {
    const { runEmmaMoPolling } = await import('@/server/services/emma-mo-ingest');
    vi.mocked(runEmmaMoPolling).mockImplementationOnce(async () => ({
      fetched: 0, handed: 0, skipped: 0, failed: 0, deferred: 0, abandoned: 0, skippedRatio: 0, details: [],
    }));
    const prevSecret = env.cron.secret;
    (env.cron as { secret: string }).secret = 'test-cron-secret';
    try {
      await kv.del(LOCK_KEY);
      const { GET } = await import('@/app/api/cron/emma-mo/route');
      await GET(new Request('http://localhost/api/cron/emma-mo', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }));
      expect(await kv.get(LOCK_KEY)).toBeNull();
    } finally {
      (env.cron as { secret: string }).secret = prevSecret;
    }
  });
});
