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
/**
 * 표 머리 글자를 각 칸의 data-label 로 붙인다.
 * 이 함수는 글자 그대로 인라인 스크립트로도 실행되므로(아래 설명) 바깥 변수를 쓰지 않고 옛 문법으로만 쓴다.
 */
function labelTables(root: HTMLElement): void {
  const tables = root.querySelectorAll('table');
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    const headRow = table.tHead ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    const heads: string[] = [];
    if (headRow) {
      for (let h = 0; h < headRow.cells.length; h++) {
        const th = headRow.cells[h];
        const text = (th.textContent || '').replace(/\s+/g, ' ').trim();
        for (let k = 0; k < Math.max(1, th.colSpan); k++) heads.push(text);
      }
    }
    const total = heads.length;
    const sections: HTMLTableSectionElement[] = [];
    for (let b = 0; b < table.tBodies.length; b++) sections.push(table.tBodies[b]);
    if (table.tFoot) sections.push(table.tFoot);
    for (let s = 0; s < sections.length; s++) {
      const rows = sections[s].rows;
      for (let r = 0; r < rows.length; r++) {
        let col = 0;
        const cells = rows[r].cells;
        for (let c = 0; c < cells.length; c++) {
          const cell = cells[c];
          const span = Math.max(1, cell.colSpan);
          const label = heads[col] || '';
          if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label);
          // 여러 칸을 합친 칸(빈 목록 안내 등)은 카드 전체 폭으로 그린다
          const full = span > 1 && (total === 0 || span >= Math.min(total, 2));
          if (full) {
            if (!cell.hasAttribute('data-full')) cell.setAttribute('data-full', '');
          } else if (cell.hasAttribute('data-full')) cell.removeAttribute('data-full');
          col += span;
        }
      }
    }
  }
}

/**
 * [6차 P2-8] 첫 화면에서 항목 이름이 잠깐 비어 보이던 문제.
 * 예전에는 화면이 뜬 뒤(하이드레이션 뒤)에야 이름을 붙여, 느린 휴대폰에서는 이름 없는 카드가 먼저 보였다.
 * 서버가 보낸 HTML 에 같은 함수를 인라인 스크립트로 넣어, 표가 그려지는 즉시 이름을 붙인다.
 * 스크립트는 서버 HTML 에만 있고(하이드레이션 직후 제거), 화면 안에서 이동해 그릴 때는 아래 layout effect 가 그리기 전에 붙인다.
 */
const INLINE_LABEL = `(function(){var s=document.currentScript;var r=s&&s.parentElement;if(r){(${labelTables.toString()})(r);}})()`;

const noopSubscribe = () => () => undefined;

export function TableCards({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const fromServer = React.useSyncExternalStore(noopSubscribe, () => false, () => true);

  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    labelTables(root);
    const mo = new MutationObserver(() => labelTables(root));
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
      {fromServer ? <script dangerouslySetInnerHTML={{ __html: INLINE_LABEL }} /> : null}
    </div>
  );
}
