import { prisma } from '@/server/db';
import { OVERLAY_EFFECT_VALUES } from '@/lib/overlay-effect-catalog';

/**
 * 금액 구간별 오버레이 효과.
 *
 * 규칙
 *  - 후원 금액 이하인 구간 중 minAmount 가 가장 큰 구간 하나만 적용한다.
 *  - 구간이 하나도 없으면 null 을 돌려주고, 호출측은 OverlaySetting 의 전역 값으로 동작한다.
 *    (구간 기능을 쓰지 않는 기존 크리에이터의 동작을 그대로 유지하기 위함)
 */

/** 파티클 효과 종류. 오버레이 클라이언트의 렌더러와 값이 일치해야 한다. */
export const OVERLAY_EFFECTS = OVERLAY_EFFECT_VALUES;

export interface ResolvedTier {
  id: string;
  label: string;
  minAmount: bigint;
  effect: string;
  banner: boolean;
  durationMs: number;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsSpeed: number;
  ttsPitch: number;
}

export async function listOverlayTiers(creatorId: string): Promise<ResolvedTier[]> {
  const rows = await prisma.overlayTier.findMany({
    where: { creatorId },
    orderBy: { minAmount: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    minAmount: r.minAmount,
    effect: r.effect,
    banner: r.banner,
    durationMs: r.durationMs,
    ttsEnabled: r.ttsEnabled,
    ttsVoice: r.ttsVoice,
    ttsSpeed: r.ttsSpeed,
    ttsPitch: r.ttsPitch,
  }));
}

/**
 * 후원 금액 이하인 구간의 개수.
 *
 * 이 값이 곧 "몇 번째 구간인가"(1부터)이며, 금액별 차등 효과의 레벨을 정한다.
 * 구간이 하나도 없거나 최저 구간에도 못 미치면 0 이고, 호출측이 레벨 1로 본다.
 * (구간 기능을 쓰지 않는 기존 크리에이터의 연출을 그대로 유지하기 위함)
 */
export async function countOverlayTiersAtOrBelow(creatorId: string, amount: bigint): Promise<number> {
  return prisma.overlayTier.count({ where: { creatorId, minAmount: { lte: amount } } });
}

/** 후원 금액에 해당하는 구간을 고른다. 해당 구간이 없으면 null. */
export async function resolveOverlayTier(creatorId: string, amount: bigint): Promise<ResolvedTier | null> {
  const row = await prisma.overlayTier.findFirst({
    where: { creatorId, minAmount: { lte: amount } },
    orderBy: { minAmount: 'desc' },
  });
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    minAmount: row.minAmount,
    effect: row.effect,
    banner: row.banner,
    durationMs: row.durationMs,
    ttsEnabled: row.ttsEnabled,
    ttsVoice: row.ttsVoice,
    ttsSpeed: row.ttsSpeed,
    ttsPitch: row.ttsPitch,
  };
}
