'use client';

import * as React from 'react';
import { cx } from '@/components/ui';

/** 메인 [구독자 전용] 투표 랭킹 섹션의 기간 탭 (페이지 이동 없이 전환) */
export function VoteHomeTabs({ tabs }: { tabs: Array<{ key: string; label: string; panel: React.ReactNode; badge?: string | null }> }) {
  const [active, setActive] = React.useState(tabs[0]?.key ?? '');
  return (
    <div>
      <div role="tablist" aria-label="랭킹 기간" className="mb-3 flex gap-1 overflow-x-auto rounded-2xl bg-ink-100/70 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setActive(t.key)}
            className={cx(
              'relative flex h-9 min-w-[4.2rem] flex-1 shrink-0 items-center justify-center gap-1 rounded-xl px-2 text-[12.5px] font-extrabold transition-colors',
              active === t.key ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900',
            )}
          >
            {t.label}
            {t.badge ? <span className="h-1.5 w-1.5 rounded-full bg-danger-500" aria-label={t.badge} /> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" hidden={active !== t.key}>
          {t.panel}
        </div>
      ))}
    </div>
  );
}
