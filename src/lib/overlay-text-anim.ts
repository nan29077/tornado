/**
 * 감사 텍스트 애니메이션 카탈로그.
 *
 * 서버 검증(updateOverlaySettingAction), 스튜디오 설정 화면, OBS 오버레이가
 * 같은 값을 공유해야 한다. 이 파일에는 React 를 넣지 않는다 — 서버에서도 import 한다.
 *
 * AUTO 는 금액 구간 레벨(1~4)에 맞춰 자동으로 고른다는 뜻이다.
 * 구간을 쓰지 않는 크리에이터는 항상 레벨 1(SLIDE_UP)로 동작한다.
 */

export const OVERLAY_TEXT_ANIM_VALUES = [
  'AUTO',
  'SLIDE_UP',
  'SLIDE_DOWN',
  'BOUNCE',
  'TYPEWRITER',
  'FADE_ZOOM',
  'SHAKE',
] as const;

export type OverlayTextAnim = (typeof OVERLAY_TEXT_ANIM_VALUES)[number];

/** AUTO 를 제외한 실제 재생 가능한 값. */
export type ResolvedTextAnim = Exclude<OverlayTextAnim, 'AUTO'>;

export const DEFAULT_OVERLAY_TEXT_ANIM: OverlayTextAnim = 'AUTO';

/**
 * DB·페이로드에 담긴 문자열을 알고 있는 값으로 좁힌다.
 * 모르는 값은 AUTO 로 떨어뜨린다. 방송 중에 알림이 통째로 사라지는 것보다
 * 기본 동작으로라도 뜨는 편이 낫다.
 */
export function textAnimOf(value?: string | null): OverlayTextAnim {
  const v = (value || '').toUpperCase();
  return (OVERLAY_TEXT_ANIM_VALUES as readonly string[]).includes(v)
    ? (v as OverlayTextAnim)
    : DEFAULT_OVERLAY_TEXT_ANIM;
}

/**
 * 레벨별 자동 선택값.
 * 금액이 클수록 임팩트가 커지는 순서다 (요구 사항 4번의 매핑).
 */
export const TEXT_ANIM_BY_LEVEL: Record<1 | 2 | 3 | 4, ResolvedTextAnim> = {
  1: 'SLIDE_UP',
  2: 'BOUNCE',
  3: 'TYPEWRITER',
  4: 'SHAKE',
};

/** 크리에이터가 고른 값 + 효과 레벨 → 실제로 재생할 애니메이션. */
export function resolveTextAnim(value: string | undefined | null, level: number): ResolvedTextAnim {
  const chosen = textAnimOf(value);
  if (chosen !== 'AUTO') return chosen;
  const lv = level >= 4 ? 4 : level === 3 ? 3 : level === 2 ? 2 : 1;
  return TEXT_ANIM_BY_LEVEL[lv];
}

/**
 * globals.css 에 정의된 클래스 이름.
 * TYPEWRITER 는 글자를 하나씩 드러내는 방식이라 CSS 만으로 처리하지 않는다
 * (한글은 글자 폭이 제각각이라 steps() 로 자르면 줄이 흔들린다).
 * 대신 등장은 페이드로 처리하고, 글자 노출은 오버레이가 직접 센다.
 */
export const TEXT_ANIM_CLASS: Record<ResolvedTextAnim, string> = {
  SLIDE_UP: 'animate-text-slide-up',
  SLIDE_DOWN: 'animate-text-slide-down',
  BOUNCE: 'animate-text-bounce',
  TYPEWRITER: 'animate-text-typewriter',
  FADE_ZOOM: 'animate-text-fade-zoom',
  SHAKE: 'animate-text-shake',
};

export interface TextAnimOption {
  value: OverlayTextAnim;
  label: string;
  desc: string;
}

/** 스튜디오 설정 화면의 선택지. 순서가 곧 화면 순서다. */
export const TEXT_ANIM_OPTIONS: readonly TextAnimOption[] = [
  { value: 'AUTO', label: '자동', desc: '금액 구간이 커질수록 강한 효과로' },
  { value: 'SLIDE_UP', label: '아래에서 위로', desc: '차분하게 밀려 올라옵니다' },
  { value: 'SLIDE_DOWN', label: '위에서 아래로', desc: '위쪽에서 내려옵니다' },
  { value: 'BOUNCE', label: '통통 튀기', desc: '탄력 있게 두 번 튑니다' },
  { value: 'TYPEWRITER', label: '타이핑', desc: '글자가 하나씩 찍힙니다' },
  { value: 'FADE_ZOOM', label: '페이드 줌', desc: '흐리게 나타나며 커집니다' },
  { value: 'SHAKE', label: '진동', desc: '강하게 흔들립니다 (고액용)' },
];
