import { describe, expect, it, vi } from 'vitest';
import { publishGameState, publishGameStateThrottled, subscribeGame } from '@/server/services/game-bus';
import type { GameStudioState } from '@/server/services/game-state';

/**
 * 게임 오버레이 상태 버스 회귀 테스트.
 *
 * overlay-bus.test.ts 와 같은 이유로 존재한다 — "방송 시작을 눌러도 오버레이 미리보기에
 * 아무것도 안 뜬다" 류의 버그는 인메모리 전달 경로 자체가 아니라 주변부(Redis, SSE 라우트)
 * 에서 반복됐지만, 정작 게임 버스의 핵심 계약(발행하면 구독자가 즉시 받는다)은 테스트로
 * 고정된 적이 없었다. 테스트 환경은 REDIS_URL='' 이므로 로컬 미리보기와 같은 인메모리
 * 전용 경로를 그대로 검증한다.
 */

function sampleState(overrides: Partial<GameStudioState> = {}): GameStudioState {
  return {
    creatorId: 'creator-x',
    gameId: 'game-1',
    roundId: 'round-1',
    type: 'ROULETTE',
    title: '오늘의 벌칙 룰렛',
    status: 'OPEN',
    items: ['노래 한 곡', '물 한 컵'],
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

describe('게임 오버레이 상태 버스 (Redis 없는 인메모리 경로)', () => {
  it('발행하면 같은 creatorId 구독자에게 즉시 전달된다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const received: GameStudioState[] = [];
    const unsubscribe = subscribeGame(creatorId, (s) => received.push(s));

    try {
      const state = sampleState({ creatorId });
      publishGameState(state);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(state);
    } finally {
      unsubscribe();
    }
  });

  it('다른 creatorId 로 발행한 상태는 받지 않는다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const otherId = `creator-other-${Date.now()}`;
    const received: GameStudioState[] = [];
    const unsubscribe = subscribeGame(creatorId, (s) => received.push(s));

    try {
      publishGameState(sampleState({ creatorId: otherId }));
      expect(received).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('구독 해제 후에는 더 이상 전달되지 않는다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const received: GameStudioState[] = [];
    const unsubscribe = subscribeGame(creatorId, (s) => received.push(s));
    unsubscribe();

    publishGameState(sampleState({ creatorId }));
    expect(received).toHaveLength(0);
  });

  it('참여 폭주 시 묶어 보내는 throttled 발행도 결국 구독자에게 전달된다', async () => {
    vi.useFakeTimers();
    try {
      const creatorId = `creator-${Date.now()}-${Math.random()}`;
      const received: GameStudioState[] = [];
      const unsubscribe = subscribeGame(creatorId, (s) => received.push(s));

      try {
        const state = sampleState({ creatorId, participantCount: 5 });
        const build = vi.fn().mockResolvedValue(state);

        // 짧은 시간 안에 여러 번 호출해도 build()는 한 번만 실행되어야 한다.
        publishGameStateThrottled(creatorId, build);
        publishGameStateThrottled(creatorId, build);
        publishGameStateThrottled(creatorId, build);

        await vi.advanceTimersByTimeAsync(700);

        expect(build).toHaveBeenCalledTimes(1);
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(state);
      } finally {
        unsubscribe();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
