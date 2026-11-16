'use client';

import * as React from 'react';

interface FeedItem {
  id: string;
  name: string;
  amount: string;
  message: string;
  at: string;
}

/** 샵 라이브 화면 실시간 후원 (10초마다 새로고침, 결제 완료 건만) */
export function ShopLiveFeed({ creatorCode }: { creatorCode: string }) {
  const [items, setItems] = React.useState<FeedItem[]>([]);
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/shop/${encodeURIComponent(creatorCode)}/live`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { items: FeedItem[] };
        if (alive) setItems(data.items);
      } catch {
        /* 네트워크 오류는 다음 주기에 다시 시도 */
      }
    };
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [creatorCode]);

  return (
    <div>
      <p className="text-[12.5px] font-extrabold text-ink-700">실시간 후원</p>
      {items.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-ink-400">아직 후원이 없어요. 첫 응원을 보내 보세요.</p>
      ) : (
        <ul className="mt-1.5 max-h-56 space-y-1.5 overflow-y-auto" aria-live="polite">
          {items.map((d) => (
            <li key={d.id} className="rounded-xl bg-warm-50 px-3 py-2">
              <p className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="truncate font-bold text-ink-900">{d.name}</span>
                <span className="shrink-0 font-extrabold text-brand-700">{Number(d.amount).toLocaleString('ko-KR')}원</span>
              </p>
              {d.message ? <p className="mt-0.5 break-words text-[12px] text-ink-600">{d.message}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
