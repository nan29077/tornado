'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, CreditCard, Landmark, Loader2, Package } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { quoteBundleAction, subscribeBundleAction, type TalkActionState } from '@/app/actions/talk';
import type { BundleQuote } from '@/server/services/talk/talk';

interface Candidate {
  id: string;
  code: string;
  name: string;
  avatarUrl: string | null;
  avatarIndex: number;
  price: number;
}

/** 여러 크리에이터 팬챗 묶음 구독 (함께 구독하면 할인) */
export function BundleBuilder({ candidates, tiers, periodDays, mock }: { candidates: Candidate[]; tiers: Array<{ count: number; rate: number }>; periodDays: number; mock: boolean }) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<string[]>([]);
  const [quote, setQuote] = React.useState<BundleQuote | null>(null);
  const [quoting, setQuoting] = React.useState(false);
  const [method, setMethod] = React.useState<'CARD' | 'TRANSFER'>('CARD');
  const [state, action, pending] = React.useActionState(subscribeBundleAction, { ok: false } as TalkActionState);

  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);

  const toggle = async (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setPicked(next);
    if (next.length < 2) {
      setQuote(null);
      return;
    }
    setQuoting(true);
    const q = await quoteBundleAction(next).catch(() => null);
    setQuoting(false);
    setQuote(q);
  };

  const best = tiers.length ? tiers[tiers.length - 1] : null;
  return (
    <section className="mt-6 rounded-[22px] bg-white p-4 shadow-card sm:p-5">
      <div className="flex items-start gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-800">
          <Package size={19} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-black text-ink-900">묶음 구독으로 함께 시작하기</h2>
          <p className="mt-0.5 text-[12px] text-ink-500">
            {tiers.map((t) => `${t.count}명 ${Math.round(t.rate * 100)}%`).join(' · ')} 할인{best ? ` (최대 ${Math.round(best.rate * 100)}%)` : ''} · {periodDays}일 이용권
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {candidates.map((c) => {
          const on = picked.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => void toggle(c.id)}
              aria-pressed={on}
              className={cx('relative flex flex-col items-center rounded-2xl border-2 p-2.5 text-center transition-colors', on ? 'border-ink-900 bg-brand-50' : 'border-transparent bg-warm-50 hover:border-brand-200')}
            >
              {on ? (
                <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-white">
                  <Check size={12} strokeWidth={2.6} aria-hidden />
                </span>
              ) : null}
              <ProfileAvatar seed={c.code} avatarIndex={c.avatarIndex} name={c.name} imageUrl={c.avatarUrl} className="h-11 w-11" />
              <span className="mt-1.5 w-full truncate text-[12px] font-extrabold text-ink-900">{c.name}</span>
              <span className="text-[11px] tabular-nums text-ink-400">{c.price.toLocaleString('ko-KR')}원</span>
            </button>
          );
        })}
      </div>

      {picked.length >= 2 ? (
        <form action={action} className="mt-4 space-y-3">
          {picked.map((id) => (
            <input key={id} type="hidden" name="creatorId" value={id} />
          ))}
          <input type="hidden" name="method" value={method} />
          <div className="rounded-2xl bg-warm-50 px-4 py-3">
            {quoting ? (
              <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-500">
                <Loader2 size={14} className="animate-spin" aria-hidden />
                금액을 계산하고 있어요
              </p>
            ) : quote && !quote.ok ? (
              <p className="text-[12.5px] font-bold text-danger-600">{quote.message}</p>
            ) : quote ? (
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] text-ink-500">
                  {quote.lines.length}명 · <s className="tabular-nums">{quote.listPrice.toLocaleString('ko-KR')}원</s>
                  {quote.discountRate > 0 ? <b className="ml-1 text-accent-600">{Math.round(quote.discountRate * 100)}% 할인</b> : null}
                </span>
                <span className="text-[20px] font-black tabular-nums text-ink-900">{quote.price.toLocaleString('ko-KR')}원</span>
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([
              { key: 'CARD', label: '신용카드', Icon: CreditCard },
              { key: 'TRANSFER', label: '간편계좌이체', Icon: Landmark },
            ] as const).map((m) => (
              <button key={m.key} type="button" onClick={() => setMethod(m.key)} aria-pressed={method === m.key} className={cx('flex h-11 items-center justify-center gap-1.5 rounded-xl border text-[13px] font-extrabold', method === m.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700')}>
                <m.Icon size={16} strokeWidth={1.8} aria-hidden />
                {m.label}
              </button>
            ))}
          </div>
          <label className="flex items-start gap-2 rounded-xl bg-warm-100 px-3 py-2.5 text-[12px] leading-relaxed text-ink-600">
            <input type="checkbox" name="agree" className="mt-0.5 h-4 w-4 accent-ink-900" />
            <span>크리에이터마다 {periodDays}일 이용권이 생겨요(자동 결제 아님). 이미 구독 중이면 남은 기간 뒤로 이어져요.</span>
          </label>
          {mock ? <p className="text-[11.5px] font-bold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않아요.</p> : null}
          {state.message ? <p className={cx('rounded-xl px-3 py-2 text-[12.5px] font-bold', state.ok ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600')}>{state.message}</p> : null}
          <button type="submit" disabled={pending || quoting || !quote?.ok} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white disabled:opacity-50">
            {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
            {quote?.ok ? `${quote.price.toLocaleString('ko-KR')}원 · ${quote.lines.length}명 함께 구독하기` : '함께 구독하기'}
          </button>
        </form>
      ) : (
        <p className="mt-3 text-center text-[12px] text-ink-400">크리에이터를 2명 이상 고르면 할인된 금액이 보여요.</p>
      )}
    </section>
  );
}
