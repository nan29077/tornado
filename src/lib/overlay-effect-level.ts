/**
 * 금액별 차등 효과 레벨.
 *
 * 왜 필요한가
 *  - 금액 구간(OverlayTier)은 이미 "효과 종류 · 배너 · TTS"를 갈랐지만, 연출의 **세기**는
 *    구간과 무관하게 늘 같았다. 1,000원과 100,000원이 같은 파티클을 뿌린다.
 *  - 구간을 몇 개 만들었든 "몇 번째 구간인가"만 알면 세기를 정할 수 있다.
 *    구간을 쓰지 않는 크리에이터는 언제나 레벨 1로 동작한다(기존 동작 유지).
 *
 * 이 파일에는 React 를 넣지 않는다 — 서버(broadcast-dispatch)와 오버레이가 함께 쓴다.
 */

export type OverlayEffectLevel = 1 | 2 | 3 | 4;

/** 콤보로 인정하는 시간 간격. 같은 후원자가 이 안에 다시 후원하면 콤보가 이어진다. */
export const COMBO_WINDOW_MS = 30_000;

/** 콤보가 끊긴 뒤 최고 기록을 보여 주는 시간. */
export const COMBO_SUMMARY_MS = 2_600;

/**
 * 후원 금액 이하인 구간의 개수(rank) → 효과 레벨.
 *  - 0 (구간을 안 쓰거나 최저 구간에도 못 미침) → 레벨 1
 *  - 1 → 1, 2 → 2, 3 → 3, 4 이상 → 4
 */
export function effectLevelOfRank(rank: number): OverlayEffectLevel {
  const n = Number.isFinite(rank) ? Math.floor(rank) : 0;
  if (n >= 4) return 4;
  if (n === 3) return 3;
  if (n === 2) return 2;
  return 1;
}

/** 페이로드로 실려 온 값을 안전한 레벨로 좁힌다. 값이 없는 예전 이벤트는 레벨 1. */
export function effectLevelOf(value: unknown): OverlayEffectLevel {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return effectLevelOfRank(n);
}

/**
 * 콤보 수 → 효과 증폭 배율.
 * 2콤보 1.5배, 3콤보 2배, 4콤보 이상 3배. 그 이상은 늘리지 않는다
 * (파티클이 수백 개가 되면 OBS 브라우저 소스의 프레임이 떨어진다).
 */
export function comboMultiplier(combo: number): number {
  const n = Number.isFinite(combo) ? Math.floor(combo) : 1;
  if (n >= 4) return 3;
  if (n === 3) return 2;
  if (n === 2) return 1.5;
  return 1;
}

/** 캐릭터 등장 크기. none = 등장하지 않음. */
export type MascotSize = 'none' | 'small' | 'large' | 'huge';

export interface EffectLevelSpec {
  /** 기본 파티클 개수 (콤보 배율을 곱하기 전) */
  particles: number;
  /** 파티클 모양 */
  shape: 'CIRCLE' | 'STAR' | 'HEART' | 'MIXED';
  /** 파티클 색 팔레트 */
  colors: readonly string[];
  /** 캐릭터 등장 크기 */
  mascot: MascotSize;
  /** 폭죽(2차 폭발) 추가 여부 */
  firework: boolean;
  /** 화면 테두리 빛나기 */
  screenGlow: boolean;
}

/**
 * 레벨별 연출 정의.
 * 색·개수는 요구 사항의 구간 정의를 그대로 옮긴 것이다.
 */
export const EFFECT_LEVELS: Record<OverlayEffectLevel, EffectLevelSpec> = {
  1: {
    particles: 10,
    shape: 'CIRCLE',
    colors: ['#ffffff', '#e7e7ea', '#c9c9d1'],
    mascot: 'none',
    firework: false,
    screenGlow: false,
  },
  2: {
    particles: 15,
    shape: 'STAR',
    colors: ['#4ba3f2', '#7cc4ff', '#2f7fd4'],
    mascot: 'small',
    firework: false,
    screenGlow: false,
  },
  3: {
    particles: 20,
    shape: 'HEART',
    colors: ['#ffc632', '#eda600', '#ffd97a'],
    mascot: 'large',
    firework: false,
    screenGlow: false,
  },
  4: {
    particles: 30,
    shape: 'MIXED',
    colors: ['#f4506b', '#fbb914', '#4ba3f2', '#5ecf8b', '#a06bf0', '#ff8f4d'],
    mascot: 'huge',
    firework: true,
    screenGlow: true,
  },
};

/** 캔버스가 한 번에 그리는 파티클 상한. 넘으면 OBS 프레임이 떨어진다. */
export const MAX_PARTICLES = 140;

/** 레벨 + 콤보 배율 → 실제로 뿌릴 파티클 개수. */
export function particleCountFor(level: OverlayEffectLevel, multiplier: number): number {
  const base = EFFECT_LEVELS[level].particles;
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return Math.min(MAX_PARTICLES, Math.round(base * m));
}
