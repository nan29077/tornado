import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { createGame, GameError, startRound } from '@/server/services/games';
import { findActiveRound } from '@/server/services/game-state';
import {
  isGameOverlayEnabled,
  setGameOverlayEnabled,
} from '@/server/services/game-overlay-settings';
import { resetDb, seedBasics } from './helpers';

describe('게임 오버레이 독립 사용 설정', () => {
  beforeEach(resetDb);

  it('기본값은 사용이며 후원 오버레이 설정과 독립적으로 저장된다', async () => {
    const fx = await seedBasics();
    expect(await isGameOverlayEnabled(fx.creatorId)).toBe(true);

    await setGameOverlayEnabled(fx.creatorId, false);
    const setting = await prisma.overlaySetting.findUniqueOrThrow({ where: { creatorId: fx.creatorId } });
    expect(setting.gameEnabled).toBe(false);
    expect(setting.enabled).toBe(true);
  });

  it('사용 중지하면 진행 중 회차를 화면에서 내린다', async () => {
    const fx = await seedBasics();
    const gameId = await createGame(fx.creatorId, {
      type: 'ROULETTE',
      title: '점검용 룰렛',
      items: ['하나', '둘'],
      config: {},
      entryMode: 'LINK',
      donationMinAmount: 0,
      autoCloseSec: 0,
    });
    await startRound(fx.creatorId, gameId);
    expect(await findActiveRound(fx.creatorId)).not.toBeNull();

    const result = await setGameOverlayEnabled(fx.creatorId, false);
    expect(result.endedActiveRound).toBe(true);
    expect(await findActiveRound(fx.creatorId)).toBeNull();
  });

  it('사용 안 함 상태에서는 새 게임을 방송에 띄울 수 없고 다시 켜면 가능하다', async () => {
    const fx = await seedBasics();
    const gameId = await createGame(fx.creatorId, {
      type: 'ROULETTE',
      title: '점검용 룰렛',
      items: ['하나', '둘'],
      config: {},
      entryMode: 'LINK',
      donationMinAmount: 0,
      autoCloseSec: 0,
    });

    await setGameOverlayEnabled(fx.creatorId, false);
    await expect(startRound(fx.creatorId, gameId)).rejects.toBeInstanceOf(GameError);

    await setGameOverlayEnabled(fx.creatorId, true);
    await expect(startRound(fx.creatorId, gameId)).resolves.toBeTypeOf('string');
  });
});
