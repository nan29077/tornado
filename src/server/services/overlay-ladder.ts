import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { PAID_STATUSES } from '@/components/studio/shared';
import {
  DEFAULT_OVERLAY_LADDER,
  boostedLevel,
  clampOverlayLevel,
  comboBoostOf,
  countComboChain,
  ladderLevelFor,
  ladderOf,
  ladderSpecOf,
  tierModeOf,
  validateLadder,
  OVERLAY_LEVEL_LABEL,
  type OverlayLadder,
  type OverlayLevel,
  type OverlayTierMode,
} from '@/lib/overlay-ladder';
import { effectLevelOfRank } from '@/lib/overlay-effect-level';
import { resolveOverlayTier, countOverlayTiersAtOrBelow, type ResolvedTier } from './overlay-tiers';

/**
 * 금액별 후원 연출 — 서버 쪽 계산 (2026-11-12).
 *
 *  1) 플랫폼 기준(자동 모드 금액 구간 · 연속 후원 규칙)을 system_setting 에서 읽고 쓴다.
 *  2) 후원 한 건이 "어느 구간 · 몇 단계 · 어떤 효과"로 재생될지 정한다.
 *
 * 실제 후원(buildOverlayPayload)과 테스트 후원(sendTestOverlay)이 **같은 함수**를 쓴다.
 * 두 경로가 갈라지면 "미리보기와 방송이 다르다"는 문제가 다시 생긴다.
 */

export const OVERLAY_LADDER_KEY = 'overlay.ladder';

/**
 * 기준 조회 캐시.
 * 후원마다 system_setting 을 읽으면 후원이 몰릴 때 조회가 그만큼 늘어난다. 기준은 거의 바뀌지 않으므로
 * 짧게 캐시한다. 관리자가 저장하면 이 인스턴스는 즉시, 다른 인스턴스는 TTL 뒤에 새 값을 쓴다
 * (관리자 화면 안내 문구도 "잠시 뒤 다음 후원부터"로 맞춘다).
 */
const CACHE_TTL_MS = 5_000;
const globalForLadder = globalThis as unknown as {
  overlayLadderCache?: { at: number; ladder: OverlayLadder } | null;
};

export function invalidateOverlayLadderCache(): void {
  globalForLadder.overlayLadderCache = null;
}

/** 현재 적용 중인 기준. 저장된 값이 없거나 깨져 있으면 기본 기준이다. */
export async function getOverlayLadder(): Promise<OverlayLadder> {
  const cached = globalForLadder.overlayLadderCache;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ladder;

  let ladder: OverlayLadder;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: OVERLAY_LADDER_KEY } });
    ladder = ladderOf(row?.value);
  } catch (e) {
    // 기준을 못 읽었다고 후원 알림이 막히면 안 된다. 기본 기준으로 재생한다.
    logger.warn('후원 연출 기준 조회 실패. 기본 기준으로 재생합니다.', { message: (e as Error).message });
    ladder = ladderOf(null);
  }
  globalForLadder.overlayLadderCache = { at: Date.now(), ladder };
  return ladder;
}

/** 관리자 화면용. 저장된 적이 있는지(configured)와 마지막 수정 정보를 함께 돌려준다. */
export async function getOverlayLadderView(): Promise<{
  ladder: OverlayLadder;
  configured: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}> {
  const row = await prisma.systemSetting.findUnique({ where: { key: OVERLAY_LADDER_KEY } }).catch(() => null);
  const valid = row ? validateLadder(row.value).ok : false;
  return {
    ladder: ladderOf(row?.value),
    configured: Boolean(row) && valid,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/** 기준 저장. 검증은 호출측(관리자 액션)이 validateLadder 로 먼저 끝낸다. */
export async function saveOverlayLadder(ladder: OverlayLadder, adminUserId: string): Promise<void> {
  const json = ladder as unknown as Prisma.InputJsonObject;
  await prisma.systemSetting.upsert({
    where: { key: OVERLAY_LADDER_KEY },
    create: {
      key: OVERLAY_LADDER_KEY,
      value: json,
      memo: '금액별 후원 연출 기준 (관리자 화면에서 관리)',
      updatedBy: adminUserId,
    },
    update: { value: json, updatedBy: adminUserId },
  });
  invalidateOverlayLadderCache();
}

/** 기본 기준으로 되돌린다(행을 지우지 않고 기본값을 저장해 감사 추적이 이어지게 한다). */
export async function resetOverlayLadder(adminUserId: string): Promise<OverlayLadder> {
  const ladder = ladderOf(DEFAULT_OVERLAY_LADDER);
  await saveOverlayLadder(ladder, adminUserId);
  return ladder;
}

// ---------------------------------------------------------------- 연속 후원

/** 연속 후원을 셀 때 한 번에 읽는 최근 후원 수. +2 기준(최대 20)보다 넉넉하면 된다. */
const COMBO_LOOKBACK = 25;

/**
 * 이 후원이 같은 후원자의 몇 번째 연속 후원인가.
 *
 * - **후원자 식별값(donor_id)** 으로 센다. 표시 이름으로 세면 서로 다른 익명 후원자가 한 사람으로 묶인다.
 * - 결제가 끝난 후원만 센다(PAID_STATUSES). 환불 요청·환불 완료 건은 빠진다.
 * - 후원자를 알 수 없는 건(donor_id 없음)은 연속으로 보지 않는다.
 */
export async function countDonorCombo(input: {
  creatorId: string;
  donorId: string | null;
  donationId: string;
  paidAt: Date | null;
  windowSec: number;
}): Promise<number> {
  if (!input.donorId) return 1;
  const anchor = input.paidAt ?? new Date();
  const rows = await prisma.donation.findMany({
    where: {
      creatorId: input.creatorId,
      donorId: input.donorId,
      id: { not: input.donationId },
      status: { in: PAID_STATUSES },
      paidAt: { not: null, lte: anchor },
    },
    orderBy: { paidAt: 'desc' },
    take: COMBO_LOOKBACK,
    select: { paidAt: true },
  });
  const times = [anchor.getTime(), ...rows.map((r) => r.paidAt!.getTime())];
  return countComboChain(times, input.windowSec);
}

// ------------------------------------------------------------------ 재생값

export interface OverlayPlay {
  mode: OverlayTierMode;
  /** CUSTOM 모드에서 적용된 구간. AUTO·OFF 에서는 null (TTS 는 전역 설정을 따른다). */
  tier: ResolvedTier | null;
  effect: string;
  banner: boolean;
  durationMs: number;
  tierLabel: string;
  /** 연속 후원 상승 전 단계 */
  baseLevel: OverlayLevel;
  /** 실제로 재생할 단계 */
  level: OverlayLevel;
  /** 서버가 센 연속 후원 횟수. 세지 않았으면 null (테스트 · 상승 끔 · OFF 모드) */
  comboCount: number | null;
  lightEffects: boolean;
}

export interface OverlayPlayCreator {
  id: string;
  overlayTierMode: string;
  overlayComboBoost: boolean;
  overlayLightEffects: boolean;
}

/**
 * 후원 한 건의 재생값을 정한다.
 *
 * @param donation 실제 후원이면 넘긴다. 테스트 후원·구간 미리보기는 null — 연속 후원을 세지 않는다.
 */
export async function resolveOverlayPlay(
  creator: OverlayPlayCreator,
  overlay: { durationMs: number; stickerSet: string } | null,
  amount: bigint,
  donation: { id: string; donorId: string | null; paidAt: Date | null } | null,
): Promise<OverlayPlay> {
  const mode = tierModeOf(creator.overlayTierMode);
  const lightEffects = Boolean(creator.overlayLightEffects);
  const globalEffect = overlay?.stickerSet ?? 'DEFAULT';
  const globalDuration = overlay?.durationMs ?? 7000;

  // OFF — 금액과 무관하게 전역 설정 하나. 구간이 없던 예전 크리에이터의 동작 그대로다.
  if (mode === 'OFF') {
    return {
      mode,
      tier: null,
      effect: globalEffect,
      banner: true,
      durationMs: globalDuration,
      tierLabel: '',
      baseLevel: 1,
      level: 1,
      comboCount: null,
      lightEffects,
    };
  }

  const ladder = await getOverlayLadder();

  let tier: ResolvedTier | null = null;
  let effect = globalEffect;
  let banner = true;
  let durationMs = globalDuration;
  let tierLabel = '';
  let baseLevel: OverlayLevel = 1;

  if (mode === 'CUSTOM') {
    const [found, rank] = await Promise.all([
      resolveOverlayTier(creator.id, amount),
      countOverlayTiersAtOrBelow(creator.id, amount),
    ]);
    tier = found;
    if (found) {
      effect = found.effect;
      banner = found.banner;
      durationMs = found.durationMs;
      tierLabel = found.label;
      // 단계를 직접 지정한 구간은 그 값을, 지정하지 않은 예전 구간은 지금까지처럼 순위로 정한다.
      baseLevel = found.intensity !== null ? clampOverlayLevel(found.intensity) : effectLevelOfRank(rank);
    }
    // 최저 구간에도 못 미치면 전역 설정 · 1단계 (기존 동작).
  } else {
    baseLevel = ladderLevelFor(ladder, amount);
    const spec = ladderSpecOf(ladder, baseLevel);
    effect = spec.effect;
    durationMs = spec.durationMs;
    tierLabel = OVERLAY_LEVEL_LABEL[baseLevel];
  }

  // 연속 후원 단계 상승. 플랫폼 스위치와 크리에이터 스위치가 모두 켜져 있고 실제 후원일 때만 센다.
  let comboCount: number | null = null;
  let level = baseLevel;
  if (donation && ladder.combo.enabled && creator.overlayComboBoost) {
    try {
      comboCount = await countDonorCombo({
        creatorId: creator.id,
        donorId: donation.donorId,
        donationId: donation.id,
        paidAt: donation.paidAt,
        windowSec: ladder.combo.windowSec,
      });
      level = boostedLevel(baseLevel, comboBoostOf(ladder.combo, comboCount));
    } catch (e) {
      // 연속 후원은 부가 연출이다. 세다가 실패해도 알림은 기본 단계로 나가야 한다.
      logger.warn('연속 후원 횟수 조회 실패. 기본 단계로 재생합니다.', { message: (e as Error).message });
      comboCount = null;
    }
  }

  // 자동 모드에서 단계가 올랐으면 효과·표시 시간도 오른 단계의 것을 쓴다.
  // (직접 설정 모드는 크리에이터가 고른 효과를 그대로 두고 세기만 올린다)
  if (mode === 'AUTO' && level !== baseLevel) {
    const spec = ladderSpecOf(ladder, level);
    effect = spec.effect;
    durationMs = spec.durationMs;
    tierLabel = OVERLAY_LEVEL_LABEL[level];
  }

  return { mode, tier, effect, banner, durationMs, tierLabel, baseLevel, level, comboCount, lightEffects };
}
