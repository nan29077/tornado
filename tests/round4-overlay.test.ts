import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { tokenHash } from '@/lib/crypto';
import { resetDb, seedBasics, type Fixture } from './helpers';
import {
  countOverlayConnections,
  registerOverlayConnection,
} from '@/server/services/overlay-connections';
import { handleOverlayBusMessage, revokeOverlayToken } from '@/server/services/overlay-bus';
import {
  currentOverlayTokenHash,
  isOverlayTokenStillValid,
  primeOverlayTokenHash,
} from '@/server/services/overlay-token-check';
import { handleGameBusMessage, subscribeGame } from '@/server/services/game-bus';
import { buildStudioStateShared, type GameStudioState } from '@/server/services/game-state';
import { gameStateStream } from '@/server/services/game-stream';
import { GET as overlayStreamGET } from '@/app/api/overlay/[creatorId]/stream/route';
import { NAVER_TTS_TIMEOUT_MS, synthesizeWithNaver } from '@/server/services/tts/naver';
import {
  SERVER_TTS_SYNTH_TIMEOUT_MS,
  createServerTtsGuard,
  serverTtsPreloadTimeoutMs,
  ttsGuardMs,
  ttsOuterLimitMs,
} from '@/components/overlay/overlay-tts-timing';
import { createSpinGate } from '@/components/overlay/roulette-spin-gate';

/**
 * 4차 점검 오버레이·게임 수정 회귀 테스트 (OV-1 · OV-2 · P2-16 ~ P2-19).
 */

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 스트림이 닫힐 때까지(또는 시간 초과까지) 읽는다. 닫혔으면 true. */
async function readUntilClosed(res: Response, ms: number): Promise<boolean> {
  const reader = res.body!.getReader();
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const r = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(20, deadline - Date.now()))),
      ]);
      if (!r) return false;
      if (r.done) return true;
    }
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function setToken(creatorId: string, token: string) {
  await prisma.overlaySetting.update({ where: { creatorId }, data: { tokenHash: tokenHash(token) } });
}

function gameState(overrides: Partial<GameStudioState>): GameStudioState {
  return {
    creatorId: 'creator-x',
    gameId: 'game-1',
    roundId: 'round-1',
    type: 'ROULETTE',
    title: '룰렛',
    status: 'OPEN',
    items: ['가', '나'],
    destinations: [],
    choices: [],
    topic: '',
    question: '',
    counts: null,
    participantCount: 0,
    participantNames: [],
    correctCount: null,
    goal: null,
    range: null,
    prize: '',
    joinUrl: null,
    joinCode: null,
    closesAt: null,
    result: null,
    winners: [],
    updatedAt: new Date().toISOString(),
    secret: {},
    recentParticipants: [],
    autoCloseSec: 0,
    entryMode: 'QR',
    ...overrides,
  };
}

describe('OV-1 · 토큰 재발급은 모든 인스턴스의 옛 연결을 끊는다', () => {
  it('재발급한 인스턴스: 옛 토큰 연결만 끊고 새 토큰 연결과 미리보기는 남긴다', () => {
    const closed: string[] = [];
    const offOld = registerOverlayConnection(fx.creatorId, () => closed.push('old'), 'broadcast', 'donation', {
      tokenHash: 'hash-old',
    });
    const offNew = registerOverlayConnection(fx.creatorId, () => closed.push('new'), 'broadcast', 'game', {
      tokenHash: 'hash-new',
    });
    const offPreview = registerOverlayConnection(fx.creatorId, () => closed.push('preview'), 'preview');

    expect(revokeOverlayToken(fx.creatorId, 'hash-new')).toBe(1);
    expect(closed).toEqual(['old']);
    expect(countOverlayConnections(fx.creatorId, 'broadcast')).toBe(1);
    expect(countOverlayConnections(fx.creatorId, 'preview')).toBe(1);
    offOld();
    offNew();
    offPreview();
  });

  it('Redis 로 재발급 알림을 보내고, 받은 쪽 인스턴스가 자기 옛 연결을 끊는다', () => {
    const g = globalThis as unknown as { overlayPub?: unknown };
    const saved = g.overlayPub;
    const sent: Array<{ channel: string; raw: string }> = [];
    g.overlayPub = {
      status: 'ready',
      publish: (channel: string, raw: string) => {
        sent.push({ channel, raw });
        return Promise.resolve(1);
      },
    };
    try {
      // 인스턴스 A 에서 재발급 (A 에는 연결이 없다)
      expect(revokeOverlayToken(fx.creatorId, 'hash-new')).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].channel).toBe('tornado:overlay:revoke');
      // 토큰 원문이 아니라 해시만 실린다.
      expect(JSON.parse(sent[0].raw)).toEqual({ creatorId: fx.creatorId, tokenHash: 'hash-new' });

      // 인스턴스 B 에 붙어 있던 연결들 (유출된 옛 OBS, 새 주소로 다시 붙은 OBS)
      const closed: string[] = [];
      registerOverlayConnection(fx.creatorId, () => closed.push('leaked'), 'broadcast', 'donation', {
        tokenHash: 'hash-old',
      });
      const offFresh = registerOverlayConnection(fx.creatorId, () => closed.push('fresh'), 'broadcast', 'donation', {
        tokenHash: 'hash-new',
      });

      // B 가 Redis 메시지를 받는다.
      handleOverlayBusMessage(sent[0].channel, sent[0].raw);
      expect(closed).toEqual(['leaked']);
      expect(countOverlayConnections(fx.creatorId, 'broadcast')).toBe(1);
      offFresh();
    } finally {
      g.overlayPub = saved;
    }
  });

  it('토큰 해시 조회는 같은 틱의 동시 요청을 한 번으로 묶는다', async () => {
    primeOverlayTokenHash(fx.creatorId, null);
    // 캐시를 비우기 위해 아주 오래된 값처럼 보이게 한다.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    const find = vi.spyOn(prisma.overlaySetting, 'findUnique');
    const results = await Promise.all(Array.from({ length: 6 }, () => currentOverlayTokenHash(fx.creatorId)));
    expect(find).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    spy.mockRestore();
  });

  it('토큰이 바뀌면 isOverlayTokenStillValid 가 false, DB 오류면 연결을 유지한다(true)', async () => {
    await setToken(fx.creatorId, 'tok-a');
    primeOverlayTokenHash(fx.creatorId, tokenHash('tok-a'));
    expect(await isOverlayTokenStillValid(fx.creatorId, tokenHash('tok-a'))).toBe(true);
    primeOverlayTokenHash(fx.creatorId, tokenHash('tok-b'));
    expect(await isOverlayTokenStillValid(fx.creatorId, tokenHash('tok-a'))).toBe(false);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    vi.spyOn(prisma.overlaySetting, 'findUnique').mockRejectedValueOnce(new Error('db down'));
    expect(await isOverlayTokenStillValid(fx.creatorId, tokenHash('tok-a'))).toBe(true);
  });

  it('후원 알림 스트림: Redis 알림이 없어도 하트비트(20초)에서 토큰을 다시 확인해 끊는다', async () => {
    await setToken(fx.creatorId, 'tok-old');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const req = new Request(`http://localhost/api/overlay/${fx.creatorId}/stream?token=tok-old`);
    const res = await overlayStreamGET(req, { params: Promise.resolve({ creatorId: fx.creatorId }) });
    expect(res.status).toBe(200);
    expect(countOverlayConnections(fx.creatorId, 'broadcast', 'donation')).toBe(1);

    // 다른 인스턴스에서 재발급됐다(이 인스턴스는 Redis 알림을 받지 못했다).
    await setToken(fx.creatorId, 'tok-new');

    // 19초까지는 그대로다.
    vi.advanceTimersByTime(19_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(countOverlayConnections(fx.creatorId, 'broadcast', 'donation')).toBe(1);

    vi.advanceTimersByTime(1_000);
    const closed = await readUntilClosed(res, 3000);
    expect(closed, '토큰이 바뀌었는데 연결이 열려 있습니다').toBe(true);
    expect(countOverlayConnections(fx.creatorId, 'broadcast', 'donation')).toBe(0);
  });

  it('후원 알림 스트림: 토큰이 그대로면 하트비트 뒤에도 연결을 유지한다', async () => {
    await setToken(fx.creatorId, 'tok-same');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const req = new Request(`http://localhost/api/overlay/${fx.creatorId}/stream?token=tok-same`);
    const res = await overlayStreamGET(req, { params: Promise.resolve({ creatorId: fx.creatorId }) });
    vi.advanceTimersByTime(20_000);
    const closed = await readUntilClosed(res, 800);
    expect(closed).toBe(false);
  });

  it('게임 스트림: 주기 확인(2초)에서 토큰이 바뀐 것을 보면 끊는다', async () => {
    await setToken(fx.creatorId, 'tok-old');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const req = new Request(`http://localhost/api/overlay/${fx.creatorId}/game/stream?token=tok-old`);
    const res = gameStateStream(req, fx.creatorId, 'public', 'broadcast', tokenHash('tok-old'));
    await new Promise((r) => setTimeout(r, 200));
    expect(countOverlayConnections(fx.creatorId, 'broadcast', 'game')).toBe(1);

    await setToken(fx.creatorId, 'tok-new');
    vi.advanceTimersByTime(2_000);
    const closed = await readUntilClosed(res, 3000);
    expect(closed).toBe(true);
    expect(countOverlayConnections(fx.creatorId, 'broadcast', 'game')).toBe(0);
  });
});

describe('OV-2 · Redis 로 받은 게임 상태는 스냅샷 캐시에 심고 옛 상태는 버린다', () => {
  it('받은 RESULT 가 캐시에 심겨 폴링이 옛 OPEN 을 내보내지 않는다', async () => {
    const creatorId = `remote-${Date.now()}-${Math.random()}`;
    const received: GameStudioState[] = [];
    const off = subscribeGame(creatorId, (s) => received.push(s));
    try {
      const t0 = Date.now();
      const result = gameState({ creatorId, status: 'RESULT', updatedAt: new Date(t0).toISOString() });
      handleGameBusMessage(JSON.stringify(result));
      expect(received.map((s) => s.status)).toEqual(['RESULT']);
      // DB 를 읽지 않고 캐시에서 RESULT 를 돌려준다.
      expect((await buildStudioStateShared(creatorId))?.status).toBe('RESULT');

      // 순서가 뒤바뀌어 늦게 도착한 OPEN 은 버린다.
      const stale = gameState({ creatorId, status: 'OPEN', updatedAt: new Date(t0 - 500).toISOString() });
      handleGameBusMessage(JSON.stringify(stale));
      expect(received.map((s) => s.status)).toEqual(['RESULT']);
      expect((await buildStudioStateShared(creatorId))?.status).toBe('RESULT');

      // 같은 시각(참여자 수 갱신)은 통과한다.
      handleGameBusMessage(JSON.stringify({ ...result, participantCount: 3 }));
      expect(received).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('회차가 사라진 상태(roundId 없음)는 캐시에 "없음" 으로 심는다', async () => {
    const creatorId = `remote-end-${Date.now()}-${Math.random()}`;
    handleGameBusMessage(JSON.stringify(gameState({ creatorId, roundId: '', status: 'ENDED' })));
    expect(await buildStudioStateShared(creatorId)).toBeNull();
  });
});

describe('P2-18 · 클로바에는 기본 음량만 보내고 음량은 오버레이에서 한 번만 적용한다', () => {
  it('요청 음량과 무관하게 volume=0 으로 합성한다', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    for (const volume of [0.2, 0.5, 1]) {
      const r = await synthesizeWithNaver({ clientId: 'id', clientSecret: 'secret' }, { text: '감사합니다', volume });
      expect(r.ok).toBe(true);
    }
    expect(bodies.map((b) => new URLSearchParams(b).get('volume'))).toEqual(['0', '0', '0']);
  });
});

describe('P2-16 · 서버 음성 안전장치', () => {
  it('오버레이의 합성 대기 시간은 클로바 타임아웃과 같은 값을 기준으로 한다', () => {
    expect(SERVER_TTS_SYNTH_TIMEOUT_MS).toBe(NAVER_TTS_TIMEOUT_MS);
    expect(serverTtsPreloadTimeoutMs()).toBeGreaterThan(NAVER_TTS_TIMEOUT_MS);
  });

  it('재생 전 시간 초과는 실패(ok=false)로 끝나 브라우저 음성으로 되돌아간다', () => {
    vi.useFakeTimers();
    const results: boolean[] = [];
    createServerTtsGuard('짧은 문장', 1, (ok) => results.push(ok));
    // 예전에는 문장 길이 기준 3초에 끝났다(합성 중인데도).
    vi.advanceTimersByTime(ttsGuardMs('짧은 문장', 1) + 100);
    expect(results).toEqual([]);
    vi.advanceTimersByTime(serverTtsPreloadTimeoutMs());
    expect(results).toEqual([false]);
  });

  it('메타데이터를 받으면 그 길이로 다시 세고, 그때의 시간 초과는 성공으로 본다', () => {
    vi.useFakeTimers();
    const results: boolean[] = [];
    const guard = createServerTtsGuard('짧은 문장', 1, (ok) => results.push(ok));
    vi.advanceTimersByTime(7000); // 합성에 7초 걸렸다
    guard.onMetadata(2); // 2초짜리 음성
    vi.advanceTimersByTime(3000);
    expect(results).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(results).toEqual([true]);
  });

  it('길이를 모르면 재생 시작부터 문장 길이 기준으로 센다', () => {
    vi.useFakeTimers();
    const results: boolean[] = [];
    const guard = createServerTtsGuard('짧은 문장', 1, (ok) => results.push(ok));
    guard.onMetadata(Number.NaN);
    vi.advanceTimersByTime(5000);
    guard.onPlaying();
    vi.advanceTimersByTime(ttsGuardMs('짧은 문장', 1) - 10);
    expect(results).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(results).toEqual([true]);
  });

  it('cancel 뒤에는 불리지 않는다', () => {
    vi.useFakeTimers();
    const results: boolean[] = [];
    const guard = createServerTtsGuard('문장', 1, (ok) => results.push(ok));
    guard.cancel();
    vi.advanceTimersByTime(60_000);
    expect(results).toEqual([]);
  });

  it('서버 음성 알림의 바깥 상한은 합성 대기 + 브라우저 음성 읽기 시간보다 짧지 않다', () => {
    const text = '가'.repeat(60);
    expect(ttsOuterLimitMs(text, 1, true)).toBeGreaterThanOrEqual(serverTtsPreloadTimeoutMs() + ttsGuardMs(text, 1));
    expect(ttsOuterLimitMs(text, 1, false)).toBeGreaterThanOrEqual(ttsGuardMs(text, 1));
    expect(ttsOuterLimitMs(undefined, 1, true)).toBe(20_000);
  });
});

describe('P2-19 · 룰렛은 StrictMode 이중 실행에서도 돈다', () => {
  it('실행 → 정리 → 다시 실행이면 두 번째 실행이 회전을 건다', () => {
    const gate = createSpinGate();
    const key = 'round-1:2';
    expect(gate.begin(key)).toBe(true);
    gate.abort(key); // StrictMode 정리(타이머가 지워졌다)
    expect(gate.begin(key)).toBe(true);
  });

  it('회전이 끝난 뒤에는 같은 결과로 다시 돌지 않는다', () => {
    const gate = createSpinGate();
    const key = 'round-1:2';
    gate.begin(key);
    gate.settle(key);
    gate.abort(key); // 항목 수 변화 등으로 effect 가 다시 실행됨
    expect(gate.begin(key)).toBe(false);
    gate.reset();
    expect(gate.begin(key)).toBe(true);
  });
});
