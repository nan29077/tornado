'use client';

import * as React from 'react';

/**
 * 구독자 전용 탭 맨 위 "지금 N명이 시청 중".
 * - viewers 가 있으면(더미 데이터 또는 실제 집계) 숫자를 보여 주고, 몇 초마다 ±0.4% 안에서 살짝 움직인다.
 * - viewers 가 없으면 숫자를 만들지 않고 "N개 방송이 진행 중"만 보여 준다.
 */
export function WatchingCounter({ viewers, liveCount }: { viewers: number | null; liveCount: number }) {
  const [value, setValue] = React.useState(viewers ?? 0);

  React.useEffect(() => {
    if (viewers == null) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const id = window.setInterval(() => {
      setValue((v) => {
        const drift = Math.round(viewers * (Math.random() * 0.008 - 0.004));
        const next = v + drift;
        // 기준값에서 3% 이상 벗어나지 않게 잡아 둔다
        return Math.min(Math.round(viewers * 1.03), Math.max(Math.round(viewers * 0.97), next));
      });
    }, 4000);
    return () => window.clearInterval(id);
  }, [viewers]);

  if (viewers == null && liveCount === 0) return null;

  return (
    <section
      aria-label="실시간 시청 현황"
      className="inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-warm-300 bg-white/85 px-2 text-[11.5px] font-semibold leading-none text-ink-600 min-[360px]:px-2.5 sm:min-h-9 sm:gap-2 sm:px-3.5 sm:text-[12px]"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-danger-500" aria-hidden />
      {viewers != null ? (
        <span>
          <strong className="text-[13px] font-extrabold tabular-nums text-brand-800 sm:text-[14px]">{value.toLocaleString('ko-KR')}</strong>명 시청 중
        </span>
      ) : (
        <span>
          <strong className="text-[13px] font-extrabold tabular-nums text-brand-800 sm:text-[14px]">{liveCount.toLocaleString('ko-KR')}</strong>개 방송 중
        </span>
      )}
      {viewers != null && liveCount > 0 ? (
        <span className="hidden border-l border-warm-300 pl-2.5 sm:inline">{liveCount.toLocaleString('ko-KR')}개 방송 중</span>
      ) : null}
    </section>
  );
}
