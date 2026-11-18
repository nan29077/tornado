'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Megaphone, Ticket } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { contributeSupportAction } from '@/app/actions/fanvote';
import type { VoteActionState } from '@/app/actions/vote';

/** 서포트 참여 (팬투표권 사용) */
export function SupportForm({ supportId, loggedIn, balance, min, left, path }: { supportId: string; loggedIn: boolean; balance: number; min: number; left: number; path: string }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(contributeSupportAction, { ok: false } as VoteActionState);
  const live = state.balance ?? balance;
  const [n, setN] = React.useState(Math.min(Math.max(min, 10), Math.max(min, left)));
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
  if (!loggedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(path)}`} className="grid h-12 place-items-center rounded-2xl bg-ink-900 text-[15px] font-black text-white">
        로그인하고 서포트 참여하기
      </Link>
    );
  }
  const quick = [min, min * 5, min * 10].filter((x, i, a) => x <= Math.max(left, min) && a.indexOf(x) === i);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="supportId" value={supportId} />
      <div className="flex items-center justify-between rounded-2xl bg-warm-100 px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-700">
          <Ticket size={16} className="text-brand-700" aria-hidden />내 팬투표권
        </span>
        <span className="text-[16px] font-black tabular-nums text-ink-900">{live.toLocaleString('ko-KR')}개</span>
      </div>
      <div className="flex gap-1.5">
        {quick.map((q) => (
          <button key={q} type="button" onClick={() => setN(q)} className={cx('h-10 flex-1 rounded-xl border text-[13px] font-extrabold tabular-nums', n === q ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700')}>
            {q.toLocaleString('ko-KR')}
          </button>
        ))}
        <button type="button" onClick={() => setN(Math.max(min, Math.min(live, left)))} className="h-10 flex-1 rounded-xl border border-ink-200 bg-white text-[13px] font-extrabold text-ink-700">
          최대
        </button>
      </div>
      <input
        name="tickets"
        inputMode="numeric"
        value={n}
        onChange={(e) => setN(Math.max(0, Number(e.target.value.replace(/[^\d]/g, '')) || 0))}
        className="h-11 w-full rounded-xl border border-ink-200 text-center text-[16px] font-black tabular-nums"
        aria-label="참여할 팬투표권 수"
      />
      <p className="text-[11.5px] text-ink-500">서포트에 쓴 팬투표권은 랭킹에 들어가지 않고 광고 집행에 쓰여요. 목표를 채우지 못하고 끝나면 모두 돌려드려요.</p>
      {state.message ? <p className={cx('rounded-xl px-3 py-2 text-[12.5px] font-bold', state.ok ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600')}>{state.message}</p> : null}
      {n > live ? (
        <Link href="/vote/charge" className="grid h-12 place-items-center rounded-2xl bg-brand-400 text-[15px] font-black text-ink-900">
          팬투표권 충전하러 가기
        </Link>
      ) : (
        <button type="submit" disabled={pending || n < min} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white disabled:opacity-50">
          {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Megaphone size={17} aria-hidden />}
          {n.toLocaleString('ko-KR')}개로 서포트하기
        </button>
      )}
    </form>
  );
}
