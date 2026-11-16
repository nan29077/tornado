'use client';

import * as React from 'react';
import { Radio, Users } from '@/components/brand/icons';

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
    <section aria-label="실시간 시청 현황" className="mt-4 overflow-hidden rounded-2xl border border-brand-200 bg-[linear-gradient(135deg,#fff8e1_0%,#ffe9a8_100%)] px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-danger-600 shadow-sm">
          <span className="absolute inset-0 animate-ping rounded-full bg-danger-600/15 motion-reduce:hidden" aria-hidden />
          {viewers != null ? <Users size={20} strokeWidth={1.8} /> : <Radio size={20} strokeWidth={1.8} />}
        </span>
        <div className="min-w-0">
          {viewers != null ? (
            <p className="text-[19px] font-black tracking-[-0.02em] text-ink-900" aria-live="off">
              지금 <span className="tabular-nums text-brand-800">{value.toLocaleString('ko-KR')}</span>명이 시청 중
            </p>
          ) : (
            <p className="text-[17px] font-black text-ink-900">지금 {liveCount.toLocaleString('ko-KR')}개 방송이 진행 중</p>
          )}
          <p className="mt-0.5 text-[12px] text-ink-600">
            {liveCount > 0 ? `라이브 ${liveCount.toLocaleString('ko-KR')}개 방송 · ` : ''}도네이도 방송국 실시간 현황
          </p>
        </div>
      </div>
    </section>
  );
}
