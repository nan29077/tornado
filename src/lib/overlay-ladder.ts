/**
 * 금액별 후원 연출 기준 (2026-11-12).
 *
 * 무엇을 정하는가
 *  - **자동 모드의 금액 구간** — 크리에이터가 구간을 만들지 않아도 금액에 따라 연출 단계(1~5)가 정해진다.
 *    기준은 전 크리에이터 공통이고 최고관리자가 고친다(system_setting).
 *  - **연속 후원 단계 상승** — 같은 후원자가 정해진 시간 안에 이어서 후원하면 단계를 올린다.
 *    누적 금액은 보지 않는다(횟수만 본다).
 *
 * 이 파일에는 React·DB 를 넣지 않는다 — 서버(broadcast-dispatch), 관리자 화면, 스튜디오 화면,
 * 테스트가 같은 계산을 함께 쓴다.
 */
import { OVERLAY_EFFECT_VALUES, type OverlayEffectValue } from '@/lib/overlay-effect-catalog';

/** 연출 단계. 1 이 가장 약하고 5 가 가장 화려하다. */
export const OVERLAY_LEVELS = [1, 2, 3, 4, 5] as const;
export type OverlayLevel = (typeof OVERLAY_LEVELS)[number];
export const MAX_OVERLAY_LEVEL: OverlayLevel = 5;

/** 단계 이름. 스튜디오·관리자 화면과 오버레이 구간 라벨이 같은 말을 쓴다. */
export const OVERLAY_LEVEL_LABEL: Record<OverlayLevel, string> = {
  1: '기본',
  2: '감사',
  3: '환호',
  4: '축제',
  5: '토네이도',
};

/**
 * 금액별 연출 방식.
 *  - AUTO   : 플랫폼 기준 금액 구간으로 자동 배정 (신규 크리에이터 기본값)
 *  - CUSTOM : 크리에이터가 만든 금액 구간(overlay_tier)을 따른다
 *  - OFF    : 금액과 무관하게 전역 표시 설정 하나로 재생한다
 */
export const OVERLAY_TIER_MODES = ['AUTO', 'CUSTOM', 'OFF'] as const;
export type OverlayTierMode = (typeof OVERLAY_TIER_MODES)[number];

/** 모르는 값은 OFF 로 본다. 모르는 값 때문에 연출이 갑자기 화려해지는 쪽보다 안전하다. */
export function tierModeOf(value: unknown): OverlayTierMode {
  const v = String(value ?? '').toUpperCase();
  return (OVERLAY_TIER_MODES as readonly string[]).includes(v) ? (v as OverlayTierMode) : 'OFF';
}

export interface LadderLevel {
  /** 이 단계가 시작되는 금액(원). 이 금액 이상이면 이 단계다. */
  minAmount: number;
  /** 이 단계에서 재생할 효과 */
  effect: OverlayEffectValue;
  /** 표시 시간(ms) */
  durationMs: number;
}

export interface ComboRule {
  /** 연속 후원 단계 상승 사용 여부 (플랫폼 전체) */
  enabled: boolean;
  /** 직전 후원으로부터 이 시간(초) 안에 다시 후원하면 연속으로 본다 */
  windowSec: number;
  /** 연속 N번째부터 +1단계 */
  plusOneAt: number;
  /** 연속 N번째부터 +2단계 */
  plusTwoAt: number;
}

export interface OverlayLadder {
  /** 정확히 5개. 인덱스 0 이 1단계다. */
  levels: LadderLevel[];
  combo: ComboRule;
}

/** 입력 허용 범위. 서버 검증과 화면 안내가 같은 값을 본다. */
export const LADDER_LIMITS = {
  minAmount: 100,
  maxAmount: 10_000_000,
  minDurationMs: 2000,
  maxDurationMs: 30000,
  minWindowSec: 10,
  maxWindowSec: 3600,
  minComboAt: 2,
  maxComboAt: 20,
} as const;

/**
 * 기본 기준.
 *  1단계 1,000원 이상 ~ 1만원 미만 / 2단계 1만원 이상 / 3단계 3만원 이상 /
 *  4단계 5만원 이상 / 5단계 10만원 이상.
 * 단계마다 서로 다른 캐릭터 효과를 쓰고, 단계가 오를수록 오래·화려하게 재생한다.
 */
export const DEFAULT_OVERLAY_LADDER: OverlayLadder = {
  levels: [
    { minAmount: 1_000, effect: 'DONAIDO_HEART_PEEK', durationMs: 5000 },
    { minAmount: 10_000, effect: 'DONAIDO_THANKS_BOW', durationMs: 7000 },
    { minAmount: 30_000, effect: 'DONAIDO_GIFT_POP', durationMs: 8000 },
    { minAmount: 50_000, effect: 'DONAIDO_FRIENDS', durationMs: 10000 },
    { minAmount: 100_000, effect: 'DONAIDO_CROWN_CEREMONY', durationMs: 12000 },
  ],
  combo: { enabled: true, windowSec: 180, plusOneAt: 2, plusTwoAt: 4 },
};

function cloneLadder(ladder: OverlayLadder): OverlayLadder {
  return { levels: ladder.levels.map((l) => ({ ...l })), combo: { ...ladder.combo } };
}

/** 단계 값을 1~5 로 좁힌다. 숫자가 아니면 1. */
export function clampOverlayLevel(value: unknown): OverlayLevel {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 1) return 1;
  if (n >= MAX_OVERLAY_LEVEL) return MAX_OVERLAY_LEVEL;
  return n as OverlayLevel;
}

function isEffect(value: unknown): value is OverlayEffectValue {
  return typeof value === 'string' && (OVERLAY_EFFECT_VALUES as readonly string[]).includes(value);
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export type LadderValidation = { ok: true; ladder: OverlayLadder } | { ok: false; message: string };

/**
 * 저장 전 검증.
 *
 * 규칙
 *  - 단계는 정확히 5개, 시작 금액은 **반드시 오름차순**(같은 금액도 안 된다).
 *    순서가 뒤집히면 "3만원이 5단계, 10만원이 3단계"처럼 고액일수록 약해지는 사고가 난다.
 *  - 연속 후원 +2 기준은 +1 기준보다 뒤여야 한다.
 */
export function validateLadder(input: unknown): LadderValidation {
  const obj = (input ?? {}) as { levels?: unknown; combo?: unknown };
  if (!Array.isArray(obj.levels) || obj.levels.length !== OVERLAY_LEVELS.length) {
    return { ok: false, message: '연출 단계는 5개여야 합니다.' };
  }

  const levels: LadderLevel[] = [];
  for (let i = 0; i < obj.levels.length; i += 1) {
    const raw = (obj.levels[i] ?? {}) as Record<string, unknown>;
    const minAmount = intIn(raw.minAmount, LADDER_LIMITS.minAmount, LADDER_LIMITS.maxAmount);
    if (minAmount === null) {
      return { ok: false, message: `${i + 1}단계 시작 금액은 100원 ~ 10,000,000원 사이의 정수로 입력해 주세요.` };
    }
    if (!isEffect(raw.effect)) {
      return { ok: false, message: `${i + 1}단계 효과를 다시 선택해 주세요.` };
    }
    const durationMs = intIn(raw.durationMs, LADDER_LIMITS.minDurationMs, LADDER_LIMITS.maxDurationMs);
    if (durationMs === null) {
      return { ok: false, message: `${i + 1}단계 표시 시간은 2,000 ~ 30,000ms 사이로 입력해 주세요.` };
    }
    const prev = levels[i - 1];
    if (prev && minAmount <= prev.minAmount) {
      return {
        ok: false,
        message: `${i + 1}단계 시작 금액은 ${i}단계(${prev.minAmount.toLocaleString('ko-KR')}원)보다 커야 합니다.`,
      };
    }
    levels.push({ minAmount, effect: raw.effect, durationMs });
  }

  const c = (obj.combo ?? {}) as Record<string, unknown>;
  const windowSec = intIn(c.windowSec, LADDER_LIMITS.minWindowSec, LADDER_LIMITS.maxWindowSec);
  if (windowSec === null) {
    return { ok: false, message: '연속 후원 인정 시간은 10초 ~ 3,600초 사이로 입력해 주세요.' };
  }
  const plusOneAt = intIn(c.plusOneAt, LADDER_LIMITS.minComboAt, LADDER_LIMITS.maxComboAt);
  const plusTwoAt = intIn(c.plusTwoAt, LADDER_LIMITS.minComboAt, LADDER_LIMITS.maxComboAt);
  if (plusOneAt === null || plusTwoAt === null) {
    return { ok: false, message: '연속 후원 기준 횟수는 2 ~ 20 사이로 입력해 주세요.' };
  }
  if (plusTwoAt <= plusOneAt) {
    return { ok: false, message: '+2단계 기준 횟수는 +1단계 기준 횟수보다 커야 합니다.' };
  }

  return {
    ok: true,
    ladder: { levels, combo: { enabled: c.enabled === true, windowSec, plusOneAt, plusTwoAt } },
  };
}

/**
 * 저장돼 있던 값을 읽을 때 쓴다. 값이 없거나 깨져 있으면 기본 기준으로 돌아간다.
 * (방송 중에 연출 기준을 못 읽었다고 알림이 사라지면 안 된다)
 */
export function ladderOf(stored: unknown): OverlayLadder {
  const v = validateLadder(stored);
  return v.ok ? v.ladder : cloneLadder(DEFAULT_OVERLAY_LADDER);
}

/**
 * 금액 → 자동 모드 연출 단계.
 * 1단계 시작 금액에 못 미치는 후원도 1단계로 재생한다(알림이 빠지는 일은 없다).
 * 경계 금액은 위 단계에 포함한다(10,000원 = 2단계).
 */
export function ladderLevelFor(ladder: OverlayLadder, amount: bigint | number): OverlayLevel {
  const won = typeof amount === 'bigint' ? amount : BigInt(Math.max(0, Math.floor(Number(amount) || 0)));
  let level: OverlayLevel = 1;
  for (let i = 0; i < ladder.levels.length; i += 1) {
    if (won >= BigInt(ladder.levels[i]!.minAmount)) level = (i + 1) as OverlayLevel;
  }
  return level;
}

/** 단계에 해당하는 자동 모드 재생값. */
export function ladderSpecOf(ladder: OverlayLadder, level: OverlayLevel): LadderLevel {
  return ladder.levels[level - 1] ?? DEFAULT_OVERLAY_LADDER.levels[level - 1]!;
}

/**
 * 연속 후원 횟수(이번 건 포함) → 올릴 단계 수.
 * 최대 +2 다. 소액을 잘게 쪼개 최고 단계를 무한정 올리는 것을 막는다.
 */
export function comboBoostOf(rule: ComboRule, comboCount: number): 0 | 1 | 2 {
  if (!rule.enabled) return 0;
  const n = Number.isFinite(comboCount) ? Math.floor(comboCount) : 1;
  if (n >= rule.plusTwoAt) return 2;
  if (n >= rule.plusOneAt) return 1;
  return 0;
}

/** 기본 단계 + 연속 후원 상승. 5단계를 넘지 않는다. */
export function boostedLevel(base: OverlayLevel, boost: number): OverlayLevel {
  return clampOverlayLevel(base + Math.max(0, Math.floor(boost)));
}

/**
 * 최근 후원 시각들로 "지금 몇 번째 연속 후원인가"를 센다.
 *
 * @param paidAtDesc 이번 건을 **포함해** 최신순으로 정렬한 결제 시각(ms)
 * @param windowSec  연속으로 인정하는 간격(초)
 * @returns 1 이면 첫 후원(연속 아님)
 *
 * 맨 앞(이번 건)에서 시작해 바로 앞 후원과의 간격이 창 안이면 이어 센다.
 * 한 번이라도 간격이 벌어지면 거기서 끊는다 — "3분 안에 계속"이라는 뜻을 그대로 옮긴 것이다.
 */
export function countComboChain(paidAtDesc: readonly number[], windowSec: number): number {
  if (paidAtDesc.length === 0) return 1;
  const windowMs = Math.max(0, windowSec) * 1000;
  let count = 1;
  for (let i = 1; i < paidAtDesc.length; i += 1) {
    const gap = paidAtDesc[i - 1]! - paidAtDesc[i]!;
    if (gap < 0 || gap > windowMs) break;
    count += 1;
  }
  return count;
}

/** 화면 표시용 구간 문구. 예: "10,000원 이상 ~ 30,000원 미만", 마지막 단계는 "100,000원 이상". */
export function ladderRangeText(ladder: OverlayLadder, level: OverlayLevel): string {
  const from = ladder.levels[level - 1]?.minAmount ?? 0;
  const next = ladder.levels[level]?.minAmount;
  const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
  return next === undefined ? `${won(from)} 이상` : `${won(from)} 이상 ~ ${won(next)} 미만`;
}
