'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

/** 마감까지 남은 시간 (1초마다) */
export function Countdown({ endsAt, prefix = '마감까지' }: { endsAt: string; prefix?: string }) {
  const end = React.useMemo(() => new Date(endsAt).getTime(), [endsAt]);
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, []);
  if (now == null) return <span className="tabular-nums">{prefix} --:--:--</span>;
  const ms = Math.max(0, end - now);
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="tabular-nums">
      {prefix} {d > 0 ? `${d}일 ` : ''}
      {p(h)}:{p(m)}:{p(sec)}
    </span>
  );
}

/** 화면이 보이는 동안 N초마다 서버 데이터를 새로 받는다 (실시간 랭킹) */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  React.useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, Math.max(5, seconds) * 1000);
    return () => window.clearInterval(t);
  }, [router, seconds]);
  return null;
}
