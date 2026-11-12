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

export type OverlayEffectLevel = 1 | 2 | 3 | 4 | 5;

/** 콤보로 인정하는 시간 간격. 같은 후원자가 이 안에 다시 후원하면 콤보가 이어진다. */
export const COMBO_WINDOW_MS = 30_000;

/** 콤보가 끊긴 뒤 최고 기록을 보여 주는 시간. */
export const COMBO_SUMMARY_MS = 2_600;

/**
 * 후원 금액 이하인 구간의 개수(rank) → 효과 레벨.
 *  - 0 (구간을 안 쓰거나 최저 구간에도 못 미침) → 레벨 1
 *  - 1 → 1, 2 → 2, 3 → 3, 4 이상 → 4
 *
 * **5단계(2026-11-12)는 여기서 나오지 않는다.** 구간에 연출 단계를 직접 지정하지 않은
 * 예전 구간은 지금까지와 똑같이 최대 4단계로 재생돼야 하기 때문이다.
 * 5단계는 자동 모드, 구간에 직접 지정한 단계, 연속 후원 상승으로만 도달한다.
 */
export function effectLevelOfRank(rank: number): OverlayEffectLevel {
  const n = Number.isFinite(rank) ? Math.floor(rank) : 0;
  if (n >= 4) return 4;
  if (n === 3) return 3;
  if (n === 2) return 2;
  return 1;
}

/** 페이로드로 실려 온 값을 안전한 레벨(1~5)로 좁힌다. 값이 없는 예전 이벤트는 레벨 1. */
export function effectLevelOf(value: unknown): OverlayEffectLevel {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 1) return 1;
  if (n >= 5) return 5;
  return n as OverlayEffectLevel;
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
export type MascotSize = 'none' | 'small' | 'large' | 'huge' | 'giant';

export interface EffectLevelSpec {
  /** 기본 파티클 개수 (콤보 배율을 곱하기 전) */
  particles: number;
  /** 파티클 모양 */
  shape: 'CIRCLE' | 'STAR' | 'HEART' | 'MIXED';
  /** 파티클 색 팔레트 */
  colors: readonly string[];
  /** 캐릭터 등장 크기 */
  mascot: MascotSize;
  /** 1920×1080 기준 인라인 캐릭터 크기와 화면 소품 수 */
  stickerSize: number;
  ambientParticles: number;
  /** 폭죽(2차 폭발) 추가 여부 */
  firework: boolean;
  /** 화면 테두리 빛나기 */
  screenGlow: boolean;
  /** 회오리 화면 전체 연출 (5단계 전용) */
  tornado: boolean;
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
    stickerSize: 136,
    ambientParticles: 4,
    firework: false,
    screenGlow: false,
    tornado: false,
  },
  2: {
    particles: 15,
    shape: 'STAR',
    colors: ['#4ba3f2', '#7cc4ff', '#2f7fd4'],
    mascot: 'small',
    stickerSize: 172,
    ambientParticles: 8,
    firework: false,
    screenGlow: false,
    tornado: false,
  },
  3: {
    particles: 20,
    shape: 'HEART',
    colors: ['#ffc632', '#eda600', '#ffd97a'],
    mascot: 'large',
    stickerSize: 210,
    ambientParticles: 12,
    firework: false,
    screenGlow: false,
    tornado: false,
  },
  4: {
    particles: 30,
    shape: 'MIXED',
    colors: ['#f4506b', '#fbb914', '#4ba3f2', '#5ecf8b', '#a06bf0', '#ff8f4d'],
    mascot: 'huge',
    stickerSize: 244,
    ambientParticles: 16,
    firework: true,
    screenGlow: true,
    tornado: false,
  },
  // 5단계 — 가장 화려하다. 회오리가 화면을 한 번 휩쓸고, 왕관을 쓴 캐릭터가 가장 크게 등장한다.
  5: {
    particles: 42,
    shape: 'MIXED',
    colors: ['#ffd24a', '#ffac54', '#ffe5a3', '#a06bf0', '#ce9bff', '#fff6d2'],
    mascot: 'giant',
    stickerSize: 296,
    ambientParticles: 20,
    firework: true,
    screenGlow: true,
    tornado: true,
  },
};

/** 캔버스가 한 번에 그리는 파티클 상한. 넘으면 OBS 프레임이 떨어진다. */
export const MAX_PARTICLES = 140;

/** 가벼운 효과 모드의 파티클 상한. 저사양 방송 PC 에서도 프레임이 떨어지지 않는 수준이다. */
export const LIGHT_MAX_PARTICLES = 36;

/**
 * 레벨 + 콤보 배율 → 실제로 뿌릴 파티클 개수.
 * 가벼운 효과 모드(light)에서는 절반만 뿌리고 상한도 낮춘다.
 */
export function particleCountFor(level: OverlayEffectLevel, multiplier: number, light = false): number {
  const base = EFFECT_LEVELS[level].particles;
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  if (light) return Math.min(LIGHT_MAX_PARTICLES, Math.max(6, Math.round((base * m) / 2)));
  return Math.min(MAX_PARTICLES, Math.round(base * m));
}
