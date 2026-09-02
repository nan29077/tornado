/**
 * 오버레이 배치 값 (위치 미세 조정 · 크기 배율).
 *
 * 왜 필요한가
 *  - 후원 알림은 9칸 앵커(position)만 고를 수 있었고, 게임은 화면 정중앙 고정이었다.
 *    "내 방송 레이아웃에 맞춰 조금만 위로", "게임 카드를 조금 작게" 가 앱 안에서는 불가능해
 *    OBS 에서 소스를 직접 드래그하는 수밖에 없었다. 그렇게 하면 글자·QR 까지 통째로 줄어든다.
 *  - 오버레이는 이미 1920x1080 캔버스를 기준으로 그린다. 그래서 배치도 그 캔버스 기준의
 *    백분율로 저장한다. 방송 해상도가 달라져도 같은 위치에 놓인다.
 *
 * 단위
 *  - offsetX / offsetY : 캔버스 폭·높이 대비 백분율. -40 ~ 40
 *  - scalePct          : 크기 배율(%). 50 ~ 150
 */

export interface OverlayLayout {
  offsetX: number;
  offsetY: number;
  scalePct: number;
}

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = { offsetX: 0, offsetY: 0, scalePct: 100 };

/** 조절 범위. 화면 밖으로 완전히 밀려나거나 알아볼 수 없이 작아지는 값은 애초에 저장하지 않는다. */
export const OVERLAY_LAYOUT_LIMITS = {
  offsetMax: 40,
  scaleMin: 50,
  scaleMax: 150,
} as const;

/** 배치 기준 캔버스. overlay-canvas 와 같은 값이며, 서버에서도 쓸 수 있게 여기에 둔다. */
export const LAYOUT_CANVAS_WIDTH = 1920;
export const LAYOUT_CANVAS_HEIGHT = 1080;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 어디서 온 값이든(폼 입력·DB·이벤트 페이로드) 안전한 범위로 좁힌다. */
export function clampOverlayLayout(input: Partial<OverlayLayout> | null | undefined): OverlayLayout {
  const { offsetMax, scaleMin, scaleMax } = OVERLAY_LAYOUT_LIMITS;
  return {
    offsetX: clampInt(input?.offsetX, -offsetMax, offsetMax, 0),
    offsetY: clampInt(input?.offsetY, -offsetMax, offsetMax, 0),
    scalePct: clampInt(input?.scalePct, scaleMin, scaleMax, 100),
  };
}

export function isDefaultOverlayLayout(layout: OverlayLayout): boolean {
  return layout.offsetX === 0 && layout.offsetY === 0 && layout.scalePct === 100;
}

/**
 * CSS transform 문자열.
 *
 * 백분율을 px 로 바꿔서 넣는다. translate 의 % 는 "요소 자신의 크기" 기준이라
 * 배너 크기에 따라 이동량이 달라져 버린다. 캔버스 기준으로 움직여야 방송 화면에서
 * 본 위치와 미리보기에서 본 위치가 같다.
 */
export function overlayLayoutTransform(layout: OverlayLayout): string {
  const x = (layout.offsetX / 100) * LAYOUT_CANVAS_WIDTH;
  const y = (layout.offsetY / 100) * LAYOUT_CANVAS_HEIGHT;
  const s = layout.scalePct / 100;
  return `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${s})`;
}
