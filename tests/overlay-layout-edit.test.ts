import { describe, expect, it } from 'vitest';
import { fallbackRect, offscreenRatio } from '@/components/studio/broadcast-preview';
import {
  DEFAULT_OVERLAY_LAYOUT,
  OVERLAY_LAYOUT_LIMITS,
  clampOverlayLayout,
  overlayLayoutTransform,
} from '@/lib/overlay-layout';

/**
 * 배치 조정 상자(드래그로 옮기고 크기를 바꾸는 상자)의 위치 계산.
 *
 * 왜 필요한가
 * -----------
 * 예전에는 오버레이(iframe)가 자기 자리를 알려 줄 때까지 **상자를 아예 그리지 않았다.**
 * 오버레이가 아직 안 떴거나 실시간 연결이 끊긴 상태에서는 [위치·크기 조정]을 켜도
 * 화면에 아무것도 나타나지 않아 **끌 것이 없었다.** 기능이 없는 게 아니라 잡을 것이 없는 상태다.
 * 이제 실제 자리를 못 받아도 근사 상자를 그린다. 그 상자가 늘 화면 안에 있어야
 * 사용자가 잡을 수 있으므로, 조절 한도 끝에서도 그런지 검사한다.
 */

const TARGETS = ['donation', 'game'] as const;
const { offsetMax, scaleMin, scaleMax } = OVERLAY_LAYOUT_LIMITS;

/** 상자의 어느 정도가 화면 안에 있는지 (0~1) */
function visibleRatio(r: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(1, r.x + r.w);
  const y1 = Math.min(1, r.y + r.h);
  const inside = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return r.w * r.h > 0 ? inside / (r.w * r.h) : 0;
}

describe('배치 조정 상자 — 잡을 것이 항상 있어야 한다', () => {
  it('기본 배치에서는 화면 한가운데 쪽에 온전히 들어온다', () => {
    for (const t of TARGETS) {
      const r = fallbackRect(t, DEFAULT_OVERLAY_LAYOUT);
      expect(visibleRatio(r), `${t} 상자가 화면을 벗어났습니다`).toBeCloseTo(1, 6);
      expect(r.w).toBeGreaterThan(0.1);
      expect(r.h).toBeGreaterThan(0.1);
    }
  });

  it('가로·세로를 옮기면 그만큼 움직인다', () => {
    for (const t of TARGETS) {
      const base = fallbackRect(t, DEFAULT_OVERLAY_LAYOUT);
      const moved = fallbackRect(t, { offsetX: 10, offsetY: -10, scalePct: 100 });
      expect(moved.x - base.x).toBeCloseTo(0.1, 6);
      expect(moved.y - base.y).toBeCloseTo(-0.1, 6);
      // 크기는 그대로다.
      expect(moved.w).toBeCloseTo(base.w, 6);
      expect(moved.h).toBeCloseTo(base.h, 6);
    }
  });

  it('크기를 키우면 가운데를 유지한 채 커진다', () => {
    for (const t of TARGETS) {
      const base = fallbackRect(t, DEFAULT_OVERLAY_LAYOUT);
      const big = fallbackRect(t, { offsetX: 0, offsetY: 0, scalePct: 150 });
      expect(big.w).toBeGreaterThan(base.w);
      expect(big.h).toBeGreaterThan(base.h);
      // 중심이 움직이면 끌던 자리가 손에서 미끄러진다.
      expect(big.x + big.w / 2).toBeCloseTo(base.x + base.w / 2, 6);
      expect(big.y + big.h / 2).toBeCloseTo(base.y + base.h / 2, 6);
    }
  });

  it('상자와 화면 밖 판정이 서로 맞는다', () => {
    // 화면 밖 경고는 이 계산으로 뜬다. 둘이 어긋나면 경고가 엉뚱하게 뜨거나 안 뜬다.
    for (const t of TARGETS) {
      for (const offsetX of [-offsetMax, -20, 0, 20, offsetMax]) {
        for (const offsetY of [-offsetMax, -20, 0, 20, offsetMax]) {
          for (const scalePct of [scaleMin, 100, scaleMax]) {
            const r = fallbackRect(t, { offsetX, offsetY, scalePct });
            expect(offscreenRatio(r)).toBeCloseTo(1 - visibleRatio(r), 6);
          }
        }
      }
    }
  });
});

/**
 * 조절 한도(±40%) 안에서도 오버레이를 **완전히 화면 밖으로** 밀어낼 수 있다.
 * 그 상태로 저장하면 OBS 화면에 아무것도 나오지 않는데 이유를 알 수 없다.
 * 값 자체를 막지는 않되(일부러 빼 두는 경우도 있다) 경고는 반드시 떠야 한다.
 */
describe('방송 화면 밖으로 밀려남 경고', () => {
  it('기본 배치에서는 경고하지 않는다', () => {
    for (const t of TARGETS) {
      expect(offscreenRatio(fallbackRect(t, DEFAULT_OVERLAY_LAYOUT))).toBeCloseTo(0, 6);
    }
  });

  it('아래로 끝까지 내린 후원 배너는 화면 밖으로 나간 것으로 잡힌다', () => {
    // 아래쪽에 붙는 배너를 세로 +40% 로 내리면 캔버스 아래로 사라진다.
    const r = fallbackRect('donation', { offsetX: 0, offsetY: offsetMax, scalePct: 100 });
    expect(offscreenRatio(r)).toBeGreaterThan(0.5);
  });

  it('경고 값은 항상 0~1 사이다', () => {
    for (const t of TARGETS) {
      for (const offsetX of [-offsetMax, 0, offsetMax]) {
        for (const offsetY of [-offsetMax, 0, offsetMax]) {
          const v = offscreenRatio(fallbackRect(t, { offsetX, offsetY, scalePct: scaleMax }));
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('배치 값 안전장치', () => {
  it('한도를 넘는 값은 저장 전에 잘린다', () => {
    const wild = clampOverlayLayout({ offsetX: 999, offsetY: -999, scalePct: 9999 });
    expect(wild.offsetX).toBe(offsetMax);
    expect(wild.offsetY).toBe(-offsetMax);
    expect(wild.scalePct).toBe(scaleMax);
  });

  it('값이 없거나 이상해도 기본 배치로 되돌아간다', () => {
    expect(clampOverlayLayout(null)).toEqual(DEFAULT_OVERLAY_LAYOUT);
    expect(clampOverlayLayout({ offsetX: NaN, offsetY: undefined, scalePct: 'abc' as unknown as number }))
      .toEqual(DEFAULT_OVERLAY_LAYOUT);
  });

  it('이동은 캔버스 기준 px 로 변환된다 (배너 크기에 따라 달라지지 않는다)', () => {
    // % 를 그대로 쓰면 translate 의 기준이 "요소 자신의 크기" 라 배너가 클수록 더 멀리 간다.
    // 미리보기에서 잡은 자리와 방송 화면의 자리가 어긋나는 원인이므로 px 로 고정한다.
    expect(overlayLayoutTransform({ offsetX: 10, offsetY: 10, scalePct: 100 })).toBe(
      'translate(192px, 108px) scale(1)',
    );
    expect(overlayLayoutTransform({ offsetX: 0, offsetY: 0, scalePct: 150 })).toBe(
      'translate(0px, 0px) scale(1.5)',
    );
  });
});
