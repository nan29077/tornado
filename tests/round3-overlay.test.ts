import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 3차 점검(2026-10-15) 오버레이 서버 로직 — OV-C · OV-D · OV-F.
 * DB 없이 돌도록 TTS 합성 라우트의 의존성은 모두 가짜로 둔다.
 */

const h = vi.hoisted(() => {
  const state = {
    rateCalls: [] as Array<{ scope: string; key: string | null | undefined }>,
    missCount: 0,
    synthCalls: 0,
    synthGate: null as null | Promise<void>,
  };
  return { state };
});

// tests/setup.ts 의 afterAll(resetDb · $disconnect)도 이 가짜를 쓴다. 이 파일은 DB 에 아무것도 쓰지 않는다.
vi.mock('@/server/db', () => ({
  prisma: {
    overlayEvent: { findUnique: vi.fn(async () => null) },
    $executeRawUnsafe: vi.fn(async () => 0),
    $disconnect: vi.fn(async () => undefined),
  },
}));
vi.mock('@/server/services/overlay-access', () => ({
  authorizeOverlay: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/server/services/overlay-bus', () => ({
  findOverlayTtsGrant: vi.fn((eventId: string, creatorId: string) =>
    eventId.startsWith('ok-')
      ? { creatorId, text: '감사합니다', voice: 'nara', speed: 1, pitch: 1, volume: 1, expiresAt: Date.now() + 60_000 }
      : null,
  ),
}));
vi.mock('@/server/rate-limit', () => ({
  clientIpFromRequest: vi.fn(() => '203.0.113.7'),
  consumeRateLimit: vi.fn(async (scope: string, key: string | null | undefined, max: number) => {
    h.state.rateCalls.push({ scope, key });
    if (scope === 'tts-miss') {
      h.state.missCount += 1;
      return { ok: h.state.missCount <= max, count: h.state.missCount };
    }
    return { ok: true, count: 1 };
  }),
}));
vi.mock('@/server/services/tts/naver', () => ({
  normalizeSpeaker: (v: string) => v,
  resolveEffectiveTtsProvider: vi.fn(async () => 'naver'),
  resolveNaverCredentials: vi.fn(async () => ({ clientId: 'x', clientSecret: 'y' })),
  synthesizeWithNaver: vi.fn(async () => {
    h.state.synthCalls += 1;
    if (h.state.synthGate) await h.state.synthGate;
    return { ok: true, audio: new Uint8Array([1, 2, 3]) };
  }),
}));
vi.mock('@/server/services/tts-platform', () => ({
  getPlatformTtsRuntime: vi.fn(async () => ({ speaker: 'nara' })),
}));

import { GET as synthesize } from '@/app/api/tts/synthesize/route';
import { dedupeInFlight } from '@/server/services/tts/inflight';
import {
  SWEEP_OVERLAP_MS,
  SWEEP_TAKE,
  advanceSweepCursor,
  createSweepCursor,
  sweepWhere,
} from '@/server/services/overlay-sweep';

let seq = 0;
const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;
const req = (eventId: string) =>
  new Request(`http://localhost:3025/api/tts/synthesize?creatorId=c1&token=t&eventId=${eventId}`);

beforeEach(() => {
  h.state.rateCalls = [];
  h.state.missCount = 0;
  h.state.synthCalls = 0;
  h.state.synthGate = null;
});

describe('OV-C 같은 이벤트의 동시 합성은 한 번만', () => {
  it('dedupeInFlight: 겹친 호출은 같은 결과를 받고, 끝나면 기록을 지운다', async () => {
    const map = new Map<string, Promise<number>>();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = async () => {
      runs += 1;
      await gate;
      return 42;
    };
    const a = dedupeInFlight(map, 'k', job);
    const b = dedupeInFlight(map, 'k', job);
    expect(map.size).toBe(1);
    release();
    expect(await Promise.all([a, b])).toEqual([42, 42]);
    expect(runs).toBe(1);
    expect(map.size).toBe(0);
    // 끝난 뒤의 호출은 새로 실행한다.
    await dedupeInFlight(map, 'k', job);
    expect(runs).toBe(2);
  });

  it('dedupeInFlight: 실패도 공유하되 붙잡아 두지 않는다', async () => {
    const map = new Map<string, Promise<number>>();
    const fail = () => Promise.reject(new Error('boom'));
    await expect(dedupeInFlight(map, 'k', fail)).rejects.toThrow('boom');
    expect(map.size).toBe(0);
  });

  it('라우트: 같은 이벤트 요청 두 건이 겹쳐도 제공사는 한 번만 부른다', async () => {
    let release!: () => void;
    h.state.synthGate = new Promise<void>((r) => (release = r));
    const eventId = uniq('ok-');
    const p1 = synthesize(req(eventId));
    const p2 = synthesize(req(eventId));
    // 두 요청이 모두 대기 지점에 닿을 때까지 기다린다.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(h.state.synthCalls).toBe(1);

    // 이후 요청은 캐시 적중이라 상한도 쓰지 않는다.
    const before = h.state.rateCalls.length;
    const r3 = await synthesize(req(eventId));
    expect(r3.status).toBe(200);
    expect(h.state.synthCalls).toBe(1);
    expect(h.state.rateCalls.length).toBe(before);
  });
});

describe('OV-D 상한은 허가 확인 뒤에 쓴다', () => {
  it('모르는 이벤트는 크리에이터 상한을 쓰지 않고 IP 별 상한으로 센다', async () => {
    const res = await synthesize(req(uniq('bogus-')));
    expect(res.status).toBe(404);
    expect(h.state.rateCalls).toEqual([{ scope: 'tts-miss', key: '203.0.113.7' }]);
  });

  it('엉터리 요청이 몰리면 IP 상한(429)에 걸리지만 정상 이벤트의 합성은 막히지 않는다', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) statuses.push((await synthesize(req(uniq('bogus-')))).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    expect(h.state.rateCalls.some((c) => c.scope === 'tts')).toBe(false);

    const ok = await synthesize(req(uniq('ok-')));
    expect(ok.status).toBe(200);
    expect(h.state.rateCalls.filter((c) => c.scope === 'tts')).toEqual([{ scope: 'tts', key: 'c1' }]);
  });
});

describe('OV-F 보충 조회는 겹쳐 읽고, 같은 행에 갇히지 않는다', () => {
  const t0 = new Date('2026-10-15T00:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('연결 직후에는 연결 시각보다 앞을 읽지 않는다', () => {
    const cur = createSweepCursor(t0);
    expect(sweepWhere('c1', cur)).toEqual({ creatorId: 'c1', createdAt: { gt: t0 } });
  });

  it('읽은 뒤에는 기준 시각보다 겹침 구간만큼 앞부터 읽고, 이미 읽은 행은 뺀다', () => {
    const cur = createSweepCursor(t0);
    advanceSweepCursor(cur, [
      { id: 'e1', createdAt: at(15_000) },
      { id: 'e2', createdAt: at(30_000) },
    ]);
    const where = sweepWhere('c1', cur);
    expect(where.createdAt.gt.getTime()).toBe(at(30_000).getTime() - SWEEP_OVERLAP_MS);
    // e1(15초)은 겹침 구간(20초~) 밖이라 기록에서 빠지고, e2 만 제외한다.
    expect(where).toMatchObject({ id: { notIn: ['e2'] } });
  });

  it('늦게 커밋된 앞선 이벤트(기준 시각보다 이른 createdAt)도 겹침 구간 안이면 읽힌다', () => {
    const cur = createSweepCursor(t0);
    advanceSweepCursor(cur, [{ id: 'late-later', createdAt: at(30_000) }]);
    const lateEarlier = at(25_000); // 30초 행보다 먼저 시작했지만 늦게 커밋됨
    const where = sweepWhere('c1', cur);
    expect(lateEarlier > where.createdAt.gt).toBe(true);
  });

  it('겹침 구간에 take 보다 많은 행이 있어도 매번 새 행으로 나아간다', () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}`, createdAt: at(1000 + i * 100) }));
    const cur = createSweepCursor(t0);
    const seen: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const where = sweepWhere('c1', cur);
      const exclude = new Set((where as { id?: { notIn: string[] } }).id?.notIn ?? []);
      const batch = rows
        .filter((r) => r.createdAt > where.createdAt.gt && !exclude.has(r.id))
        .slice(0, SWEEP_TAKE);
      seen.push(...batch.map((r) => r.id));
      advanceSweepCursor(cur, batch);
    }
    expect(new Set(seen).size).toBe(45);
    expect(seen).toHaveLength(45);
  });
});
