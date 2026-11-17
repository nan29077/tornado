import * as React from 'react';
import { Info } from '@/components/brand/icons';

/** 크리에이터 화면 기능 안내 섹션 (2026-11-17) */
export function GuideCard({ title, items, footer }: { title: string; items: Array<{ head: string; body: React.ReactNode }>; footer?: React.ReactNode }) {
  return (
    <section className="mb-5 rounded-[20px] border border-brand-200 bg-[linear-gradient(135deg,#fff9e8,#ffffff)] p-4 sm:p-5">
      <p className="flex items-center gap-1.5 text-[14px] font-black text-ink-900">
        <Info size={16} className="text-brand-700" aria-hidden />
        {title}
      </p>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2">
        {items.map((it, i) => (
          <li key={it.head} className="flex gap-2.5 rounded-xl bg-white/80 p-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-900 text-[11px] font-black text-white">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-extrabold text-ink-900">{it.head}</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-600">{it.body}</span>
            </span>
          </li>
        ))}
      </ol>
      {footer ? <div className="mt-3 text-[12px] leading-relaxed text-ink-500">{footer}</div> : null}
    </section>
  );
}
