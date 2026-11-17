'use client';

import * as React from 'react';

/**
 * 표 → 모바일 카드 변환 (2026-11-18).
 *
 * 관리자·스튜디오의 모든 표(공용 <Table>)가 이 래퍼를 쓴다. 휴대폰 폭(640px 미만)에서는 CSS(globals.css 의
 * .donaido-table-cards)가 표 머리를 숨기고 한 행을 한 장의 카드로 그린다. 각 칸 앞에 붙는 항목 이름은
 * 표 머리(<th>) 글자를 칸마다 data-label 로 복사해서 쓴다 — 페이지마다 표를 고치지 않고 한 곳에서 처리한다.
 * 행이 바뀌면(필터·새로고침) 다시 붙인다. PC 에서는 아무것도 바뀌지 않는다.
 */
export function TableCards({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const label = () => {
      for (const table of Array.from(root.querySelectorAll('table'))) {
        const headRow = table.tHead?.rows[table.tHead.rows.length - 1];
        const heads: string[] = [];
        if (headRow) {
          for (const th of Array.from(headRow.cells)) {
            const text = (th.textContent ?? '').replace(/\s+/g, ' ').trim();
            for (let i = 0; i < Math.max(1, th.colSpan); i++) heads.push(text);
          }
        }
        const total = heads.length;
        for (const section of [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])]) {
          for (const tr of Array.from(section.rows)) {
            let col = 0;
            for (const cell of Array.from(tr.cells)) {
              const span = Math.max(1, cell.colSpan);
              const text = heads[col] ?? '';
              if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
              // 여러 칸을 합친 칸(빈 목록 안내 등)은 카드 전체 폭으로 그린다
              const full = span > 1 && (total === 0 || span >= Math.min(total, 2));
              if (full) cell.setAttribute('data-full', '');
              else if (cell.hasAttribute('data-full')) cell.removeAttribute('data-full');
              col += span;
            }
          }
        }
      }
    };
    label();
    const mo = new MutationObserver(() => label());
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
