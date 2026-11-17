'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { HeartHandshake } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { VIDEO_CATEGORIES, videosHref } from '@/lib/video-hub';

/**
 * 메인 [구독자 전용] 탭 · 방송국 카테고리 칩 (2026-11-17).
 * - 모바일: 2줄 가로 스크롤 (전부 노출)
 * - PC(sm 이상): 같은 폭 칸으로 줄을 맞춰 배치하고, 처음엔 3줄까지만 보여 준다.
 *   칸이 잘리지 않도록 화면 폭에서 한 줄 칸 수를 재서 "3줄 × 칸 수" 만큼만 그리고,
 *   마지막 칸은 [+N 더보기] 버튼. 펼치면 전부 보이고 [접기]로 돌아간다.
 */
const ROWS = 3;

const base =
  'inline-flex min-h-9 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-bold transition-colors';
const normal = 'border-ink-200 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800';
const special = 'border-brand-200 bg-brand-50 text-brand-800 hover:bg-brand-100';

function Chip({ slug, label, className }: { slug: string; label: string; className?: string }) {
  return (
    <Link href={videosHref({ c: slug as never })} prefetch={false} className={cx(base, slug === 'donaido' ? special : normal, className)}>
      {slug === 'donaido' ? <HeartHandshake size={13} strokeWidth={2} aria-hidden /> : null}
      {label}
    </Link>
  );
}

export function CategoryChips({ className }: { className?: string }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      if (!grid.offsetWidth) return;
      const n = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
      if (n > 0) setCols(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, []);

  const all = VIDEO_CATEGORIES;
  const limit = cols * ROWS;
  const folded = !open && all.length > limit;
  const shown = folded ? all.slice(0, limit - 1) : all;
  const rest = all.length - shown.length;

  return (
    <div className={className}>
      {/* 모바일: 2줄 가로 스크롤 */}
      <nav aria-label="방송국 카테고리" className="sm:hidden">
        <div className="-mx-4 grid auto-cols-max grid-flow-col grid-rows-2 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {all.map((c) => <Chip key={c.slug} slug={c.slug} label={c.label} />)}
        </div>
      </nav>

      {/* PC: 같은 폭 칸, 처음엔 3줄 */}
      <nav aria-label="방송국 카테고리" className="hidden sm:block">
        <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2">
          {shown.map((c) => <Chip key={c.slug} slug={c.slug} label={c.label} className="w-full" />)}
          {folded ? (
            <button type="button" onClick={() => setOpen(true)} aria-expanded={false} className={cx(base, 'w-full border-dashed border-brand-300 bg-white text-brand-700 hover:bg-brand-50')}>
              +{rest} 더보기
            </button>
          ) : all.length > limit ? (
            <button type="button" onClick={() => setOpen(false)} aria-expanded className={cx(base, 'w-full border-ink-200 bg-ink-50 text-ink-600 hover:bg-ink-100')}>
              접기
            </button>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
