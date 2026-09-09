'use client';

import * as React from 'react';
import { Flame } from 'lucide-react';
import { COMBO_WINDOW_MS, COMBO_SUMMARY_MS, comboMultiplier } from '@/lib/overlay-effect-level';

/**
 * 콤보(연속 후원) 카운터.
 *
 * 규칙
 *  - 같은 후원자가 {@link COMBO_WINDOW_MS} 안에 다시 후원하면 콤보가 이어진다.
 *  - 콤보 정보는 **이 브라우저의 메모리에만** 있다. DB 에 저장하지 않는다.
 *    방송 중에만 의미가 있는 값이고, 기록으로 남기면 후원자별 행동 로그가 되어 버린다.
 *  - 콤보가 끊기면(시간이 지나면) 최고 기록을 잠깐 보여 주고 사라진다.
 *  - 이모지를 쓰지 않는다. 불꽃은 lucide-react 의 Flame 라인 아이콘이다.
 *
 * 왜 서버가 아니라 클라이언트인가
 *  - 콤보는 "방금 방송 화면에 뜬 알림"들 사이의 관계다. 서버가 계산하려면 오버레이가
 *    실제로 언제 재생했는지를 알아야 하는데(대기열 때문에 도착 순서와 재생 순서가 다르다),
 *    그 값을 서버로 되돌려 보내는 통로를 새로 만드는 것보다 화면에서 세는 편이 정확하다.
 */

export interface ComboView {
  /** 콤보를 이어 가는 후원자 표시명 */
  donorName: string;
  /** 현재 콤보 수 (진행 중) 또는 최고 기록 (끊긴 뒤) */
  count: number;
  /** true 면 콤보가 끊겨 최고 기록을 보여 주는 중이다 */
  ended: boolean;
}

export interface ComboTracker {
  /**
   * 알림이 재생되기 시작할 때 부른다.
   * @returns 이번 후원까지 포함한 콤보 수 (1 이면 첫 후원)
   */
  register: (donorName: string) => number;
  /** 화면에 그릴 콤보 상태. 2콤보 미만이면 null 이다. */
  combo: ComboView | null;
  /** 현재 콤보의 효과 증폭 배율 */
  multiplier: number;
}

export function useComboTracker(): ComboTracker {
  const [combo, setCombo] = React.useState<ComboView | null>(null);
  const [multiplier, setMultiplier] = React.useState(1);

  /** 진행 중인 콤보. 렌더와 무관하게 유지돼야 하므로 ref 에 둔다. */
  const current = React.useRef<{ donorName: string; count: number; at: number } | null>(null);
  const breakTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = React.useCallback(() => {
    if (breakTimer.current) clearTimeout(breakTimer.current);
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    breakTimer.current = null;
    summaryTimer.current = null;
  }, []);

  React.useEffect(() => clearTimers, [clearTimers]);

  const register = React.useCallback(
    (donorName: string): number => {
      const now = Date.now();
      const prev = current.current;
      const continuing =
        prev !== null && prev.donorName === donorName && now - prev.at <= COMBO_WINDOW_MS;
      const count = continuing ? prev.count + 1 : 1;

      current.current = { donorName, count, at: now };
      clearTimers();

      setMultiplier(comboMultiplier(count));
      // 1콤보(첫 후원)는 배지를 띄우지 않는다. 매 후원마다 "1 COMBO" 가 뜨면 의미가 없다.
      setCombo(count >= 2 ? { donorName, count, ended: false } : null);

      // 시간이 지나면 콤보가 끊긴다. 2콤보 이상이었다면 최고 기록을 잠깐 남긴다.
      breakTimer.current = setTimeout(() => {
        const best = current.current?.count ?? 0;
        const name = current.current?.donorName ?? donorName;
        current.current = null;
        setMultiplier(1);
        if (best >= 2) {
          setCombo({ donorName: name, count: best, ended: true });
          summaryTimer.current = setTimeout(() => setCombo(null), COMBO_SUMMARY_MS);
        } else {
          setCombo(null);
        }
      }, COMBO_WINDOW_MS);

      return count;
    },
    [clearTimers],
  );

  return { register, combo, multiplier };
}

/** 콤보 수에 따른 배지 색. 숫자가 커질수록 뜨거워진다. */
function toneOf(count: number): { bg: string; ring: string; text: string } {
  if (count >= 4) return { bg: 'rgba(244,80,107,0.92)', ring: 'rgba(255,143,77,0.9)', text: '#fff7ed' };
  if (count === 3) return { bg: 'rgba(237,166,0,0.92)', ring: 'rgba(255,214,102,0.9)', text: '#1b1405' };
  return { bg: 'rgba(75,163,242,0.92)', ring: 'rgba(160,210,255,0.9)', text: '#f2f9ff' };
}

/**
 * 콤보 배지.
 *
 * 방송 화면 오른쪽 위에 붙인다. 후원 알림은 보통 아래쪽·가운데에 뜨므로 겹치지 않는다.
 * 1920x1080 캔버스 기준 px 로 그린다(미리보기는 캔버스째 축소되므로 vh 를 쓰지 않는다).
 */
export function ComboBadge({ combo }: { combo: ComboView | null }) {
  if (!combo) return null;
  const tone = toneOf(combo.count);

  return (
    <div
      aria-hidden
      className="animate-combo-pop pointer-events-none absolute right-[72px] top-[120px] z-30"
    >
      <div
        className="flex items-center gap-3 rounded-full px-6 py-3"
        style={{
          background: tone.bg,
          color: tone.text,
          boxShadow: `0 0 0 4px ${tone.ring}, 0 18px 40px rgba(0,0,0,0.35)`,
        }}
      >
        <Flame
          size={44}
          strokeWidth={1.7}
          className={combo.ended ? undefined : 'animate-combo-flame'}
        />
        <span className="flex flex-col leading-none">
          <span className="text-[46px] font-black tabular-nums tracking-tight">
            {combo.count} COMBO{combo.ended ? '' : '!'}
          </span>
          <span className="mt-1.5 text-[20px] font-bold opacity-90">
            {combo.ended ? `${combo.donorName}님 최고 기록` : `${combo.donorName}님 연속 후원`}
          </span>
        </span>
      </div>
    </div>
  );
}
