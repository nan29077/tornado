'use client';

import { useEffect, useRef } from 'react';

/**
 * 가로로 넘기는 칩 줄 (2026-11-18). 고른 칩(aria-current="page")이 화면 밖에 있으면
 * 처음 그릴 때 가운데로 옮겨 보여 준다 — 끝쪽 카테고리를 눌러도 선택한 칩이 가려지지 않는다.
 */
export function ChipScroller({ activeKey, className, children }: { activeKey: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const on = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2);
  }, [activeKey]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
