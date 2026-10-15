import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * public/sse-hub.js (SharedWorker) 단위 테스트 — 3차 점검 SSE-A.
 *
 * 워커 스크립트를 가짜 SharedWorker 전역(vm)에 올린다. EventSource·타이머·시계·포트는 모두 가짜로
 * 두고 시간을 직접 넘겨 가며 확인한다.
 */

// DB 를 쓰지 않는 테스트다. tests/setup.ts 의 afterAll(resetDb · $disconnect)이 실제 DB 에 닿지 않게 한다.
vi.mock('@/server/db', () => ({
  prisma: { $executeRawUnsafe: vi.fn(async () => 0), $disconnect: vi.fn(async () => undefined) },
}));

const HUB_SRC = fs.readFileSync(path.resolve(__dirname, '../public/sse-hub.js'), 'utf8');

interface Msg {
  type: string;
  id?: string;
  event?: string;
  data?: string;
}

class FakeEventSource {
  static all: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(ev: { data: string; lastEventId: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (ev: { data: string; lastEventId: string }) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: string, lastEventId = '') {
    for (const fn of this.listeners.get(name) ?? []) fn({ data, lastEventId });
  }
}

class FakePort {
  received: Msg[] = [];
  onmessage: ((m: { data: unknown }) => void) | null = null;
  postMessage(msg: Msg) {
    this.received.push(msg);
  }
  start() {}
  send(data: unknown) {
    this.onmessage?.({ data });
  }
  take(): Msg[] {
    const out = this.received;
    this.received = [];
    return out;
  }
}

function loadHub() {
  FakeEventSource.all = [];
  let now = 1_000_000;
  let timerSeq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  const ctx: Record<string, unknown> = {
    URL,
    Map,
    Set,
    Array,
    Math,
    String,
    Date: { now: () => now },
    EventSource: FakeEventSource,
    setTimeout: (fn: () => void, ms: number) => {
      timerSeq += 1;
      timers.set(timerSeq, { at: now + ms, fn });
      return timerSeq;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => void, ms: number) => {
      timerSeq += 1;
      timers.set(timerSeq, { at: now + ms, fn, every: ms });
      return timerSeq;
    },
    location: { origin: 'http://localhost:3025' },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(HUB_SRC, ctx);

  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of timers) {
        if (t.at <= end && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const t = timers.get(nextId)!;
      now = t.at;
      if (t.every) t.at = now + t.every;
      else timers.delete(nextId);
      t.fn();
    }
    now = end;
  };

  const connect = () => {
    const port = new FakePort();
    (ctx.onconnect as (e: { ports: FakePort[] }) => void)({ ports: [port] });
    return port;
  };

  return { connect, advance };
}

const URL_A = 'http://localhost:3025/api/overlay/c1/stream?preview=1';

describe('SSE-A 공유기: 현재 상태 이벤트 재생', () => {
  it('나중에 붙은 화면은 ready 를 바로 받고, 지나간 donation 은 받지 않는다', () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: URL_A, events: ['ready', 'donation'] });
    expect(FakeEventSource.all).toHaveLength(1);
    const es = FakeEventSource.all[0];
    es.onopen?.();
    es.emit('ready', '{"r":1}');
    es.emit('donation', '{"d":1}', 'E1');
    expect(a.take().map((m) => m.event ?? m.type)).toEqual(['open', 'ready', 'donation']);

    const b = hub.connect();
    // lastEventId 만 다른 주소는 같은 연결로 묶인다.
    b.send({ type: 'sub', id: 'b1', url: `${URL_A}&lastEventId=E1`, events: ['ready', 'donation'] });
    expect(FakeEventSource.all).toHaveLength(1);
    const got = b.take();
    expect(got.map((m) => m.event ?? m.type)).toEqual(['open', 'ready']);
    expect(got.find((m) => m.event === 'donation')).toBeUndefined();
  });

  it('[OV-E] 쿼리(c=크리에이터)가 다르면 연결과 저장 상태를 나누지 않는다', () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: 'http://localhost:3025/api/studio/games/stream?c=A', events: ['state'] });
    FakeEventSource.all[0].onopen?.();
    FakeEventSource.all[0].emit('state', '{"answer":"A"}');
    const b = hub.connect();
    b.send({ type: 'sub', id: 'b1', url: 'http://localhost:3025/api/studio/games/stream?c=B', events: ['state'] });
    expect(FakeEventSource.all).toHaveLength(2);
    expect(b.take().find((m) => m.event === 'state')).toBeUndefined();
  });
});

describe('SSE-A 공유기: 생존 신호 시간 초과', () => {
  it('35초 정도 늦어진 생존 신호로는 끊지 않는다(백그라운드 탭 1분 주기 대응)', () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: URL_A, events: ['donation'] });
    a.take();
    hub.advance(60_000);
    a.send({ type: 'ping' });
    hub.advance(60_000);
    expect(a.take().filter((m) => m.type === 'error')).toEqual([]);
    expect(FakeEventSource.all[0].closed).toBe(false);
  });

  it('시간 초과로 정리할 때 각 구독에 error 를 보낸다', () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: URL_A, events: ['donation'] });
    a.send({ type: 'sub', id: 'a2', url: URL_A, events: ['ready'] });
    a.take();
    hub.advance(170_000);
    const errors = a.take().filter((m) => m.type === 'error').map((m) => m.id);
    expect(errors.sort()).toEqual(['a1', 'a2']);
    // 구독자가 없어 실제 연결도 닫힌다.
    expect(FakeEventSource.all[0].closed).toBe(true);
  });

  it('정리된 화면이 다시 말을 걸면 새로 등록되고, 다음 시간 초과에도 정리된다(누수 없음)', () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: URL_A, events: ['donation'] });
    hub.advance(170_000);
    a.take();

    // error 를 받은 화면이 다시 구독한다.
    a.send({ type: 'sub', id: 'a3', url: URL_A, events: ['donation'] });
    expect(FakeEventSource.all).toHaveLength(2);
    const es2 = FakeEventSource.all[1];
    es2.emit('donation', '{"d":2}', 'E2');
    expect(a.take().some((m) => m.event === 'donation' && m.id === 'a3')).toBe(true);

    // 다시 등록됐으므로 이번에도 시간 초과 정리 대상이 된다(예전에는 영영 남았다).
    hub.advance(170_000);
    expect(a.take().some((m) => m.type === 'error' && m.id === 'a3')).toBe(true);
    expect(es2.closed).toBe(true);
  });
});

describe('SSE-A 공유기: check', () => {
  it('공유기가 모르는 구독 id 에만 error 를 돌려준다', () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: URL_A, events: ['donation'] });
    a.take();
    a.send({ type: 'check', ids: ['a1', 'gone'] });
    expect(a.take()).toEqual([{ type: 'error', id: 'gone' }]);
  });

  it("'bye' 뒤 bfcache 로 돌아온 화면의 check 는 모든 구독을 다시 열게 한다", () => {
    const hub = loadHub();
    const a = hub.connect();
    a.send({ type: 'sub', id: 'a1', url: URL_A, events: ['donation'] });
    a.send({ type: 'bye' });
    a.take();
    a.send({ type: 'check', ids: ['a1'] });
    expect(a.take()).toEqual([{ type: 'error', id: 'a1' }]);
    // check 로 다시 등록된 포트는 이후 시간 초과 정리도 받는다.
    a.send({ type: 'sub', id: 'a2', url: URL_A, events: ['donation'] });
    a.take();
    hub.advance(170_000);
    expect(a.take().some((m) => m.type === 'error' && m.id === 'a2')).toBe(true);
  });
});
