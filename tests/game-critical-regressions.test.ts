import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/lib/id';
import { prisma } from '@/server/db';
import {
  buildStudioStateForRound,
  buildStudioStateShared,
  primeStudioStateCache,
  toPublicState,
  type GameStudioState,
} from '@/server/services/game-state';
import { createGame, joinByCode, joinFromDonation, revealRound, startRound } from '@/server/services/games';
import { resetDb, seedBasics, seedRegisteredDonor } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

describe('게임 핵심 회귀', () => {
  beforeEach(resetDb);

  it('결제 시각이 마감 뒤인 후원은 열린 상태로 남은 회차에 넣지 않는다', async () => {
    const fx = await seedBasics();
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '마감 검증', items: [], config: { rankCount: 1 },
      entryMode: 'DONATION', donationMinAmount: 100, autoCloseSec: 30,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    await prisma.gameRound.update({
      where: { id: roundId },
      data: { closesAt: new Date(Date.now() - 60_000) },
    });
    const donationId = newId();
    await prisma.donation.create({
      data: {
        id: donationId, transactionNo: donationId, creatorId: fx.creatorId, amount: 3_000n,
        displayName: '마감 뒤 후원자', message: 'test', status: 'BROADCASTED', paidAt: new Date(),
      },
    });

    await joinFromDonation(donationId);

    expect(await prisma.gameParticipant.count({ where: { roundId } })).toBe(0);
  });

  it('회차가 열리기 전에 결제된 후원은 새 회차에 넣지 않는다', async () => {
    const fx = await seedBasics();
    const donationId = newId();
    await prisma.donation.create({
      data: {
        id: donationId, transactionNo: donationId, creatorId: fx.creatorId, amount: 3_000n,
        displayName: '이전 후원자', message: 'test', status: 'BROADCASTED',
        paidAt: new Date(Date.now() - 60_000),
      },
    });
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '시작 검증', items: [], config: { rankCount: 1 },
      entryMode: 'DONATION', donationMinAmount: 100, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);

    await joinFromDonation(donationId);

    expect(await prisma.gameParticipant.count({ where: { roundId } })).toBe(0);
  });

  it('회차 구간 안에 결제된 후원은 정상적으로 자동 참가시킨다', async () => {
    const fx = await seedBasics();
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '정상 참가', items: [], config: { rankCount: 1 },
      entryMode: 'DONATION', donationMinAmount: 100, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const donationId = newId();
    await prisma.donation.create({
      data: {
        id: donationId, transactionNo: donationId, creatorId: fx.creatorId, amount: 3_000n,
        displayName: '정상 후원자', message: 'test', status: 'BROADCASTED', paidAt: new Date(),
      },
    });

    await joinFromDonation(donationId);

    expect(await prisma.gameParticipant.count({ where: { roundId } })).toBe(1);
  });

  it('공개 결과에서 중첩된 후원자 식별자를 제거한다', async () => {
    const fx = await seedBasics();
    const donor = await seedRegisteredDonor();
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '공개 상태', items: [], config: { rankCount: 1 },
      entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const round = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    await joinByCode(round.joinCode, {
      name: '참여자', entry: '', deviceKey: 'public-state-test', donorId: donor.id,
    });
    await revealRound(fx.creatorId, roundId);

    const studio = await buildStudioStateForRound(roundId);
    expect(studio).not.toBeNull();
    const publicState = toPublicState(studio!);

    expect(JSON.stringify(publicState)).not.toContain('donorId');
    expect(publicState).not.toHaveProperty('secret');
  });

  it('오래 걸린 조회가 더 최신으로 확정한 공유 상태를 덮어쓰지 않는다', async () => {
    const creatorId = `cache-${newId()}`;
    let finish!: (value: null) => void;
    const spy = vi.spyOn(prisma.gameRound, 'findFirst').mockImplementationOnce(
      () => new Promise<null>((resolve) => { finish = resolve; }) as never,
    );
    try {
      const pending = buildStudioStateShared(creatorId);
      const newer = { creatorId, roundId: 'new-round', status: 'RESULT' } as GameStudioState;
      primeStudioStateCache(creatorId, newer);
      finish(null);

      expect(await pending).toBe(newer);
      expect(await buildStudioStateShared(creatorId)).toBe(newer);
    } finally {
      spy.mockRestore();
    }
  });
});
