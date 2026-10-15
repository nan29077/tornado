import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { normalizeConfig, validateGameInput, voteTopLabel } from '@/lib/game-catalog';
import {
  closeRound,
  createGame,
  joinByCode,
  joinFromDonation,
  revealRound,
  startRound,
  undoReveal,
  updateGame,
  type GameInput,
} from '@/server/services/games';
import {
  buildStudioStateForRound,
  primeStudioStateCache,
  sumDonationsSince,
  toPublicState,
  type GameStudioState,
} from '@/server/services/game-state';
import { computeEntryResult, computeLadder } from '@/server/services/game-result';
import { publishGameStateThrottled, subscribeGame } from '@/server/services/game-bus';
import { shareGameLinkToChat } from '@/server/services/game-share';
import { resetDb, seedBasics, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/**
 * 2026-10-15 3차 점검 — 방송 게임 항목(GM-A ~ GM-J) 회귀 테스트.
 */

let fx: Fixture;
let seq = 0;

function join(joinCode: string, entry: string, name = `참가${++seq}`) {
  return joinByCode(joinCode, {
    name, entry, deviceKey: `device-${seq}-${newId()}`, clientFingerprint: `v4:10.0.0.${seq % 250}`, donorId: null,
  });
}

async function quizRound(creatorId: string) {
  const input: GameInput = {
    type: 'QUIZ', title: '퀴즈', items: [],
    config: { question: '정답은?', choices: ['가', '나', '다'], answerIndex: 1, prize: '' },
    entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
  };
  const gameId = await createGame(creatorId, input);
  const roundId = await startRound(creatorId, gameId);
  const round = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
  return { gameId, roundId, joinCode: round.joinCode, input };
}

async function paidDonation(creatorId: string, amount: bigint, name: string, status: 'BROADCASTED' | 'REFUND_REQUESTED' | 'REFUNDED' = 'BROADCASTED') {
  const id = newId();
  await prisma.donation.create({
    data: {
      id, transactionNo: id, creatorId, amount, displayName: name, message: 'test', status,
      paidAt: new Date(), refundedAt: status === 'REFUNDED' ? new Date() : null,
    },
  });
  return id;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

// ───────────────────── GM-A ─────────────────────

describe('GM-A 결과가 떠 있는 동안 게임 설정을 바꿀 수 없다', () => {
  it('RESULT 상태에서 수정은 거절되고, 회차를 연 뒤 설정이 바뀌었으면 발표 취소도 거절된다', async () => {
    const { gameId, roundId, joinCode, input } = await quizRound(fx.creatorId);
    await join(joinCode, '1');
    await closeRound(fx.creatorId, roundId);
    await revealRound(fx.creatorId, roundId);

    await expect(
      updateGame(fx.creatorId, gameId, { ...input, config: { ...input.config, answerIndex: 2 } }),
    ).rejects.toThrow(/진행 중에는 설정을 바꿀 수 없습니다/);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect((game.config as Record<string, unknown>).answerIndex).toBe(1);

    // 이중 방어: 어떤 경로로든 회차를 연 뒤 설정이 바뀌었으면 발표 취소를 막는다.
    await prisma.game.update({ where: { id: gameId }, data: { title: '바뀐 퀴즈' } });
    await expect(undoReveal(fx.creatorId, roundId)).rejects.toThrow(/게임 설정이 바뀌어/);
    expect((await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } })).status).toBe('RESULT');
  });
});

// ───────────────────── GM-B ─────────────────────

describe('GM-B 빈 선택지를 지워도 정답 번호가 같은 선택지를 가리킨다', () => {
  it('정리 후 위치로 정답 번호를 옮긴다', () => {
    const a = normalizeConfig('QUIZ', { question: 'q', choices: ['가', '', '다'], answerIndex: 2 });
    expect(a.choices).toEqual(['가', '다']);
    expect(a.answerIndex).toBe(1);

    const b = normalizeConfig('QUIZ', { question: 'q', choices: ['', '나', '다'], answerIndex: 1 });
    expect(b.choices).toEqual(['나', '다']);
    expect((b.choices as string[])[b.answerIndex as number]).toBe('나');
  });

  it('빈 선택지를 정답으로 고르면 저장을 거절한다', async () => {
    const raw = { question: 'q', choices: ['가', '나', '  '], answerIndex: 2 };
    expect(validateGameInput('QUIZ', '퀴즈', [], raw)).toBe('정답 선택지를 골라 주세요.');
    await expect(
      createGame(fx.creatorId, {
        type: 'QUIZ', title: '퀴즈', items: [], config: raw, entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
      }),
    ).rejects.toThrow('정답 선택지를 골라 주세요');
  });

  it('저장된 정답이 고른 선택지 그대로다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'QUIZ', title: '퀴즈', items: [],
      config: { question: 'q', choices: ['', '나', '다', '라'], answerIndex: 2 },
      entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
    });
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    const config = game.config as { choices: string[]; answerIndex: number };
    expect(config.choices[config.answerIndex]).toBe('다');
  });
});

// ───────────────────── GM-C ─────────────────────

describe('GM-C 환불(요청)된 후원은 게임 참여·게이지에서 빠진다', () => {
  it('환불 요청된 후원으로 들어온 참여자는 인원과 추첨에서 빠진다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '후원 추첨', items: [], config: { rankCount: 2 },
      entryMode: 'DONATION', donationMinAmount: 100, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const keep = await paidDonation(fx.creatorId, 3_000n, '남는후원자');
    const refund = await paidDonation(fx.creatorId, 3_000n, '환불후원자');
    await joinFromDonation(keep);
    await joinFromDonation(refund);
    expect(await prisma.gameParticipant.count({ where: { roundId } })).toBe(2);

    await prisma.donation.update({ where: { id: refund }, data: { status: 'REFUND_REQUESTED' } });

    const state = await buildStudioStateForRound(roundId);
    expect(state!.participantCount).toBe(1);
    expect(state!.participantNames).not.toContain('환불후원자');

    await closeRound(fx.creatorId, roundId);
    const result = (await revealRound(fx.creatorId, roundId)) as { ranks: { name: string }[] };
    expect(result.ranks.map((r) => r.name)).toEqual(['남는후원자']);
    const winners = await prisma.gameWinner.findMany({ where: { roundId } });
    expect(winners.map((w) => w.displayName)).toEqual(['남는후원자']);
  });

  it('이미 환불 요청된 후원은 자동 참여시키지 않는다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '후원 추첨', items: [], config: { rankCount: 1 },
      entryMode: 'DONATION', donationMinAmount: 100, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const id = await paidDonation(fx.creatorId, 3_000n, '환불중', 'REFUND_REQUESTED');
    await joinFromDonation(id);
    expect(await prisma.gameParticipant.count({ where: { roundId } })).toBe(0);
  });

  it('후원 목표 게이지는 환불 요청·환불 완료 후원을 세지 않는다', async () => {
    const since = new Date(Date.now() - 1_000);
    await paidDonation(fx.creatorId, 3_000n, 'a');
    await paidDonation(fx.creatorId, 5_000n, 'b', 'REFUND_REQUESTED');
    const refunded = await paidDonation(fx.creatorId, 2_000n, 'c', 'REFUNDED');
    // refundedAt 이 비어 있는 REFUNDED(옛 데이터)도 상태만으로 빠져야 한다.
    await prisma.donation.update({ where: { id: refunded }, data: { refundedAt: null } });
    expect(await sumDonationsSince(fx.creatorId, since)).toBe(3_000);
  });
});

// ───────────────────── GM-D ─────────────────────

describe('GM-D 늦게 끝난 묶음 발행이 더 새 상태를 덮어쓰지 않는다', () => {
  it('조회 도중 새 상태가 심어지면 묶음 발행 결과는 버린다', async () => {
    vi.useFakeTimers();
    const creatorId = `creator-${newId()}`;
    const received: GameStudioState[] = [];
    const unsubscribe = subscribeGame(creatorId, (s) => received.push(s));
    try {
      const stale = { creatorId, status: 'OPEN' } as unknown as GameStudioState;
      const build = vi.fn(async () => {
        // 조회하는 사이 [결과 발표]가 즉시 발행으로 새 상태를 심었다.
        primeStudioStateCache(creatorId, { creatorId, status: 'RESULT' } as unknown as GameStudioState);
        return stale;
      });
      publishGameStateThrottled(creatorId, build);
      await vi.advanceTimersByTimeAsync(700);
      expect(build).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(0);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });
});

// ───────────────────── GM-E ─────────────────────

describe('GM-E 발표 취소 회차당 1회는 오래된 요청에도 지켜진다', () => {
  it('취소 → 재발표 뒤 늦게 도착한(옛 값을 읽은) 취소 요청은 거절된다', async () => {
    const { roundId, joinCode } = await quizRound(fx.creatorId);
    await join(joinCode, '1');
    await closeRound(fx.creatorId, roundId);
    await revealRound(fx.creatorId, roundId);
    await undoReveal(fx.creatorId, roundId);
    await revealRound(fx.creatorId, roundId); // revealCount = 2

    // 첫 발표 직후에 읽은 값(revealCount 1)으로 판단하는 요청을 흉내 낸다.
    const original = prisma.gameRound.findUnique.bind(prisma.gameRound);
    const spy = vi.spyOn(prisma.gameRound, 'findUnique').mockImplementationOnce((async (args: unknown) => {
      const row = await original(args as Parameters<typeof original>[0]);
      return row ? { ...row, revealCount: 1 } : row;
    }) as unknown as typeof prisma.gameRound.findUnique);
    try {
      await expect(undoReveal(fx.creatorId, roundId)).rejects.toThrow(/이미 바뀌었습니다/);
    } finally {
      spy.mockRestore();
    }
    const r = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(r.status).toBe('RESULT');
    expect(r.revealCount).toBe(2);
  });
});

// ───────────────────── GM-F ─────────────────────

describe('GM-F 발표는 상태를 먼저 선점하고, 실패하면 통째로 되돌린다', () => {
  it('참여자가 없어 발표가 실패하면 회차는 원래 상태로 남는다', async () => {
    const { roundId } = await quizRound(fx.creatorId);
    await closeRound(fx.creatorId, roundId);
    await expect(revealRound(fx.creatorId, roundId)).rejects.toThrow(/참여자가 없습니다/);
    const r = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(r.status).toBe('CLOSED');
    expect(r.revealCount).toBe(0);
  });

  it('발표 뒤 참여는 거절된다', async () => {
    const { roundId, joinCode } = await quizRound(fx.creatorId);
    await join(joinCode, '1');
    await revealRound(fx.creatorId, roundId);
    await expect(join(joinCode, '0')).rejects.toThrow(/참여를 받지 않습니다/);
  });
});

// ───────────────────── GM-G ─────────────────────

describe('GM-G 사다리 출발·도착 개수가 다르면 저장을 거절한다', () => {
  it('도착이 더 많거나 적으면 검증 오류', async () => {
    expect(validateGameInput('LADDER', '사다리', ['a', 'b'], { destinations: ['꽝', '꽝', '당첨'] })).toMatch(/개수를 같게/);
    expect(validateGameInput('LADDER', '사다리', ['a', 'b', 'c'], { destinations: ['꽝', '당첨'] })).toMatch(/개수를 같게/);
    expect(validateGameInput('LADDER', '사다리', ['a', 'b'], { destinations: ['꽝', '당첨'] })).toBeNull();
    await expect(
      createGame(fx.creatorId, {
        type: 'LADDER', title: '사다리', items: ['a', 'b'], config: { destinations: ['꽝', '꽝', '당첨'] },
        entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
      }),
    ).rejects.toThrow(/개수를 같게/);
  });

  it('옛 설정(도착이 더 많음)으로 돌려도 뒤쪽 도착 항목이 뽑힐 수 있다', () => {
    let seen = false;
    for (let i = 0; i < 200 && !seen; i++) {
      const r = computeLadder(['a', 'b'], ['꽝', '꽝', '당첨']);
      expect(r.destinations).toHaveLength(2);
      if (r.order.includes('당첨')) seen = true;
    }
    expect(seen).toBe(true);
  });
});

// ───────────────────── GM-H ─────────────────────

describe('GM-H 투표 동점은 공동 1위로 발표된다', () => {
  const p = (entry: string) => ({ displayName: '익명', entry, donorId: null, createdAt: new Date() });

  it('동점 1위를 모두 결과에 담는다', () => {
    const r = computeEntryResult('VOTE', { choices: ['가', '나', '다'] }, [p('0'), p('1'), p('0'), p('1'), p('2')]);
    expect(r.topIndices).toEqual([0, 1]);
    expect(r.tie).toBe(true);
    expect(voteTopLabel(r, ['가', '나', '다'])).toBe('공동 1위 · 가, 나');
  });

  it('단독 1위는 그대로, 옛 결과(topIndices 없음)도 표시된다', () => {
    const r = computeEntryResult('VOTE', { choices: ['가', '나'] }, [p('1'), p('1'), p('0')]);
    expect(r.topIndices).toEqual([1]);
    expect(voteTopLabel(r, ['가', '나'])).toBe('1위 · 나');
    expect(voteTopLabel({ topIndex: 0 }, ['가', '나'])).toBe('1위 · 가');
  });
});

// ───────────────────── GM-I ─────────────────────

describe('GM-I 키워드 정답자 수는 참여를 받는 동안 방송에 나가지 않는다', () => {
  it('OPEN 공개 상태의 correctCount 는 null, 크리에이터 화면과 마감 뒤에는 보인다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'KEYWORD', title: '키워드', items: [], config: { keyword: '도네', winnerCount: 1, prize: '' },
      entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const round = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    await join(round.joinCode, '도네');

    const open = await buildStudioStateForRound(roundId);
    expect(open!.correctCount).toBe(1);
    expect(toPublicState(open!).correctCount).toBeNull();

    await closeRound(fx.creatorId, roundId);
    const closed = await buildStudioStateForRound(roundId);
    expect(toPublicState(closed!).correctCount).toBe(1);
  });
});

// ───────────────────── GM-J ─────────────────────

describe('GM-J 발표 취소 가능 시간과 채팅 공유 상태 제한', () => {
  it('참여가 닫힌 회차는 채팅에 참여 링크를 올리지 않는다', async () => {
    const { roundId } = await quizRound(fx.creatorId);
    await closeRound(fx.creatorId, roundId);
    const res = await shareGameLinkToChat(fx.creatorId);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/참여를 받지 않는 회차/);
  });

  it('OPEN 회차는 상태 제한에 걸리지 않는다', async () => {
    await quizRound(fx.creatorId);
    const res = await shareGameLinkToChat(fx.creatorId);
    expect(res.message).not.toMatch(/참여를 받지 않는 회차/);
  });

  it('스튜디오 상태에 취소 가능 시각이 실리고, 방송 상태에는 실리지 않는다', async () => {
    const { roundId, joinCode } = await quizRound(fx.creatorId);
    await join(joinCode, '1');
    await revealRound(fx.creatorId, roundId);

    const fresh = await buildStudioStateForRound(roundId);
    expect(new Date(fresh!.undoUntil!).getTime()).toBeGreaterThan(Date.now());
    expect('undoUntil' in toPublicState(fresh!)).toBe(false);

    await prisma.gameRound.update({ where: { id: roundId }, data: { revealedAt: new Date(Date.now() - 200_000) } });
    const expired = await buildStudioStateForRound(roundId);
    expect(new Date(expired!.undoUntil!).getTime()).toBeLessThan(Date.now());
    await expect(undoReveal(fx.creatorId, roundId)).rejects.toThrow(/되돌릴 수 없습니다/);
  });
});
