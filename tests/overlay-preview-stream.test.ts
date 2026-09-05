import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { createGame, startRound } from '@/server/services/games';
import { gameStateStream } from '@/server/services/game-stream';
import { sendTestOverlay } from '@/server/services/broadcast-dispatch';

/**
 * 스튜디오 미리보기가 실제로 무엇을 받는지 확인한다.
 *
 * 신고된 증상
 * -----------
 * 미리보기 툴바에는 [연결됨] 이 떠 있는데(= 연결은 열렸다) 화면에는 후원 알림도 게임도
 * 나타나지 않는다. 게임은 서버에서 분명히 진행 중인데도 그렇다.
 *
 * 연결이 열렸다는 것과 **내용이 흘러온다는 것은 다른 문제**다. 그래서 여기서는
 * 진짜 스트림을 열어 흘러나오는 바이트를 그대로 읽는다. 화면 없이도
 * "서버가 보내기는 하는가" 를 가른다.
 */

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  vi.useRealTimers();
});

/** 스트림에서 지정한 시간 동안 흘러나온 텍스트를 모은다. */
async function drain(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), Math.max(20, deadline - Date.now()))),
      ]);
      if (!race) break;
      if (race.done) break;
      out += decoder.decode(race.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

/** SSE 텍스트에서 지정한 이벤트의 data 줄들을 뽑는다. */
function eventsOf(raw: string, name: string): string[] {
  return raw
    .split('\n\n')
    .filter((block) => block.includes(`event: ${name}`))
    .map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      return line ? line.slice(6) : '';
    })
    .filter(Boolean);
}

describe('게임 미리보기 스트림', () => {
  it('진행 중인 게임이 있으면 미리보기에 상태가 흘러온다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'ROULETTE',
      title: '점검용 룰렛',
      items: ['가', '나', '다'],
      config: {},
      entryMode: 'FREE',
      donationMinAmount: 0,
      autoCloseSec: 0,
    });
    await startRound(fx.creatorId, gameId);

    const req = new Request('http://localhost/api/overlay/x/game/stream?preview=1');
    const res = gameStateStream(req, fx.creatorId, 'public', 'preview');
    const raw = await drain(res, 2500);

    expect(raw, 'ready 를 못 받았습니다').toContain('event: ready');

    const states = eventsOf(raw, 'state');
    expect(states.length, `state 이벤트가 없습니다.\n${raw.slice(0, 400)}`).toBeGreaterThan(0);

    const last = JSON.parse(states[states.length - 1]);
    expect(last, '상태가 null 로 나갔습니다 — 화면에는 아무것도 그려지지 않습니다').not.toBeNull();
    // roundId 가 없으면 클라이언트가 null 로 간주해 아무것도 그리지 않는다.
    expect(last.roundId, 'roundId 가 빠지면 오버레이는 화면을 비웁니다').toBeTruthy();
    expect(last.title).toBe('점검용 룰렛');
  });

  it('띄운 게임이 없으면 빈 상태를 보낸다', async () => {
    const req = new Request('http://localhost/api/overlay/x/game/stream?preview=1');
    const res = gameStateStream(req, fx.creatorId, 'public', 'preview');
    const raw = await drain(res, 1500);

    expect(raw).toContain('event: ready');
    const states = eventsOf(raw, 'state');
    expect(states.length).toBeGreaterThan(0);
    expect(JSON.parse(states[0])).toBeNull();
  });

  it('게임 오버레이 스위치가 꺼져 있어도 미리보기에는 보인다', async () => {
    // 미리보기는 "설정 확인" 이 목적이라 방송 스위치와 무관하게 그려야 한다.
    const gameId = await createGame(fx.creatorId, {
      type: 'ROULETTE',
      title: '스위치 꺼짐 확인',
      items: ['가', '나'],
      config: {},
      entryMode: 'FREE',
      donationMinAmount: 0,
      autoCloseSec: 0,
    });
    await startRound(fx.creatorId, gameId);
    await prisma.overlaySetting.update({
      where: { creatorId: fx.creatorId },
      data: { gameEnabled: false },
    });

    const req = new Request('http://localhost/api/overlay/x/game/stream?preview=1');
    const res = gameStateStream(req, fx.creatorId, 'public', 'preview');
    const raw = await drain(res, 2500);

    const states = eventsOf(raw, 'state').map((s) => JSON.parse(s));
    expect(states.some((s) => s && s.roundId), '미리보기가 비어 버렸습니다').toBe(true);
  });

  it('정답·키워드는 미리보기 경로로도 나가지 않는다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'QUIZ',
      title: '점검용 퀴즈',
      items: [],
      config: { question: '무슨 색?', choices: ['빨강', '노랑'], answerIndex: 1 },
      entryMode: 'FREE',
      donationMinAmount: 0,
      autoCloseSec: 0,
    });
    await startRound(fx.creatorId, gameId);

    const req = new Request('http://localhost/api/overlay/x/game/stream?preview=1');
    const res = gameStateStream(req, fx.creatorId, 'public', 'preview');
    const raw = await drain(res, 2500);

    expect(raw).not.toContain('answerIndex');
    expect(raw).not.toContain('"secret"');
  });

  it('프록시가 붙들지 않도록 연결 직후 빈 줄을 먼저 흘려보낸다', async () => {
    const req = new Request('http://localhost/api/overlay/x/game/stream?preview=1');
    const res = gameStateStream(req, fx.creatorId, 'public', 'preview');
    const raw = await drain(res, 800);
    // 주석 줄(':')로 시작하는 2KB 선행 전송. 없으면 일부 프록시에서 첫 이벤트가 늦게 도착한다.
    expect(raw.startsWith(':')).toBe(true);
    expect(raw.length).toBeGreaterThan(2000);
  });
});

describe('후원 알림 미리보기 스트림', () => {
  it('테스트 후원을 보내면 미리보기로 흘러온다', async () => {
    vi.resetModules();
    vi.doMock('@/server/auth', async (orig) => ({
      ...(await orig<typeof import('@/server/auth')>()),
      getSessionUser: async () => ({ id: 'u', creatorId: fx.creatorId, role: 'CREATOR' }),
    }));
    const { GET } = await import('@/app/api/overlay/[creatorId]/stream/route');

    const req = new Request(`http://localhost/api/overlay/${fx.creatorId}/stream?preview=1`);
    const res = await GET(req, { params: Promise.resolve({ creatorId: fx.creatorId }) });
    expect(res.status, '미리보기 스트림이 열리지 않았습니다').toBe(200);

    // 구독이 열린 뒤에 보낸다. (구독 전에 보낸 건은 보충 조회 기준 시각보다 앞선다)
    const collecting = drain(res, 3000);
    await new Promise((r) => setTimeout(r, 300));
    await sendTestOverlay(fx.creatorId, { donorName: '점검', amount: 3000n, message: '테스트' });

    const raw = await collecting;
    const donations = eventsOf(raw, 'donation');
    expect(donations.length, `후원 이벤트가 미리보기에 도착하지 않았습니다.\n${raw.slice(0, 400)}`).toBeGreaterThan(0);
    const payload = JSON.parse(donations[0]);
    expect(payload.donorName).toBe('점검');
    expect(payload.isTest).toBe(true);
    vi.doUnmock('@/server/auth');
  });
});
