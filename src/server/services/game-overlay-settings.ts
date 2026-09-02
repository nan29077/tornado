import { prisma } from '@/server/db';
import { endRound } from '@/server/services/games';
import { findActiveRound } from '@/server/services/game-state';

export class GameOverlaySettingError extends Error {}

/** 게임 방송 화면의 독립 사용 여부. URL 미발급 상태는 아직 사용할 수 없는 상태로 본다. */
export async function isGameOverlayEnabled(creatorId: string): Promise<boolean> {
  const setting = await prisma.overlaySetting.findUnique({
    where: { creatorId },
    select: { gameEnabled: true },
  });
  return Boolean(setting?.gameEnabled);
}

/**
 * 게임 오버레이 사용 여부를 저장한다.
 * 끄는 순간 진행 중 회차도 종료해, 화면만 숨은 채 참여가 계속 접수되는 상황을 막는다.
 */
export async function setGameOverlayEnabled(
  creatorId: string,
  enabled: boolean,
): Promise<{ enabled: boolean; endedActiveRound: boolean }> {
  const setting = await prisma.overlaySetting.findUnique({
    where: { creatorId },
    select: { id: true },
  });
  if (!setting) throw new GameOverlaySettingError('먼저 브라우저 소스 URL을 발급해 주세요.');

  await prisma.overlaySetting.update({ where: { creatorId }, data: { gameEnabled: enabled } });

  if (enabled) return { enabled: true, endedActiveRound: false };

  const active = await findActiveRound(creatorId);
  if (!active) return { enabled: false, endedActiveRound: false };

  await endRound(creatorId, active.id);
  return { enabled: false, endedActiveRound: true };
}
