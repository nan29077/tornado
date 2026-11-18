'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, CirclePlay, ClipboardList, CreditCard, Gift, Landmark, Loader2, MousePointerClick, PenLine } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { completeMockMissionAction, purchaseTicketsAction, type VoteActionState } from '@/app/actions/vote';

const initial: VoteActionState = { ok: false };

// ---------------------------------------------------------------------- 구매

export interface PackView {
  id: string;
  name: string;
  price: number;
  tickets: number;
  bonus: number;
  badge: string | null;
}

export function TicketShop({ packs, mock, loggedIn }: { packs: PackView[]; mock: boolean; loggedIn: boolean }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(purchaseTicketsAction, initial);
  const [selected, setSelected] = React.useState(packs.find((p) => p.badge)?.id ?? packs[0]?.id ?? '');
  const [method, setMethod] = React.useState<'CARD' | 'TRANSFER'>('CARD');
  const pack = packs.find((p) => p.id === selected);

  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);

  return (
    <form action={action}>
      <input type="hidden" name="productId" value={selected} />
      <input type="hidden" name="method" value={method} />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {packs.map((p) => {
          const active = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.id)}
              aria-pressed={active}
              className={cx(
                'relative flex flex-col items-start rounded-2xl border-2 bg-white p-3.5 text-left transition-all',
                active ? 'border-ink-900 shadow-[0_10px_24px_rgba(23,22,26,0.12)]' : 'border-transparent shadow-card hover:border-brand-200',
              )}
            >
              {p.badge ? <span className="absolute right-2.5 top-2.5 rounded-full bg-warning-500 px-2 py-0.5 text-[10px] font-black text-white">{p.badge}</span> : null}
              <span className="text-[12px] font-bold text-ink-500">{p.name}</span>
              <span className="mt-1 text-[20px] font-black tabular-nums tracking-[-0.03em] text-ink-900">{p.tickets.toLocaleString('ko-KR')}<span className="ml-0.5 text-[13px]">개</span></span>
              {p.bonus > 0 ? <span className="mt-0.5 text-[12px] font-extrabold text-accent-600">+ 보너스 {p.bonus.toLocaleString('ko-KR')}개</span> : <span className="mt-0.5 h-[18px]" />}
              <span className="mt-2 text-[14px] font-black tabular-nums text-ink-800">{p.price.toLocaleString('ko-KR')}원</span>
              {active ? <Check size={16} strokeWidth={2.6} className="absolute bottom-3 right-3 text-ink-900" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      <p className="mb-2 mt-5 text-[13px] font-extrabold text-ink-800">결제 수단</p>
      <div className="grid grid-cols-2 gap-2">
        {([
          { key: 'CARD', label: '신용카드', Icon: CreditCard },
          { key: 'TRANSFER', label: '간편계좌이체', Icon: Landmark },
        ] as const).map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMethod(m.key)}
            aria-pressed={method === m.key}
            className={cx('flex h-12 items-center justify-center gap-1.5 rounded-xl border text-[13.5px] font-extrabold', method === m.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700')}
          >
            <m.Icon size={17} strokeWidth={1.8} aria-hidden />
            {m.label}
          </button>
        ))}
      </div>

      <label className="mt-4 flex items-start gap-2 rounded-xl bg-warm-100 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-600">
        <input type="checkbox" name="agree" className="mt-0.5 h-4 w-4 accent-ink-900" />
        <span>
          팬투표권은 <b>팬투표 전용</b>이며 현금 환급·양도·상품 구매에 쓸 수 없어요. 사용하지 않은 결제분은 결제 후 정해진 기간 안에 마이페이지에서 환불할 수 있어요(일부라도 사용하면 환불 불가, 보너스는 회수).
        </span>
      </label>

      {mock ? <p className="mt-2 text-[11.5px] font-bold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않아요. (금액 끝자리 999 = 실패 시험)</p> : null}
      {state.message ? (
        <p className={cx('mt-3 rounded-xl px-3 py-2 text-[13px] font-bold', state.ok ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600')}>{state.message}</p>
      ) : null}
      {loggedIn ? (
        <button type="submit" disabled={pending || !pack} className="mt-4 flex h-13 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 py-3.5 text-[15px] font-black text-white disabled:opacity-60">
          {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
          {pack ? `${pack.price.toLocaleString('ko-KR')}원 결제하고 충전하기` : '상품을 골라 주세요'}
        </button>
      ) : (
        <a href="/login?next=%2Fvote%2Fcharge%3Ft%3Dbuy" className="mt-4 grid h-12 place-items-center rounded-2xl bg-ink-900 text-[15px] font-black text-white">로그인하고 충전하기</a>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------- 무료 (테스트 광고)

export interface MissionView {
  id: string;
  kind: 'VIDEO' | 'QUIZ' | 'VISIT' | 'SURVEY';
  title: string;
  advertiser: string;
  points: number;
  tickets: number;
  seconds?: number;
  quiz?: { question: string; options: string[] };
  done: boolean;
}

const KIND_ICON = { VIDEO: CirclePlay, QUIZ: PenLine, VISIT: MousePointerClick, SURVEY: ClipboardList };
const KIND_LABEL = { VIDEO: '광고 시청', QUIZ: '퀴즈', VISIT: '페이지 방문', SURVEY: '설문' };

export function MockOfferwall({ missions, loggedIn }: { missions: MissionView[]; loggedIn: boolean }) {
  return (
    <ul className="space-y-2.5">
      {missions.map((m) => (
        <MissionCard key={m.id} m={m} loggedIn={loggedIn} />
      ))}
    </ul>
  );
}

function MissionCard({ m, loggedIn }: { m: MissionView; loggedIn: boolean }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(completeMockMissionAction, initial);
  const [phase, setPhase] = React.useState<'idle' | 'running' | 'ready'>('idle');
  const [left, setLeft] = React.useState(m.seconds ?? 0);
  const [answer, setAnswer] = React.useState<number | null>(null);
  const Icon = KIND_ICON[m.kind];
  const done = m.done || state.ok;

  React.useEffect(() => {
    if (phase !== 'running') return;
    const t = window.setTimeout(() => {
      if (left <= 1) setPhase('ready');
      setLeft(Math.max(0, left - 1));
    }, 1000);
    return () => window.clearTimeout(t);
  }, [phase, left]);

  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);

  const start = () => {
    if (m.seconds) {
      setLeft(m.seconds);
      setPhase('running');
    } else setPhase('ready');
  };

  return (
    <li className={cx('rounded-2xl bg-white p-3.5 shadow-card ring-1', done ? 'ring-success-500/20' : 'ring-ink-100')}>
      <div className="flex items-center gap-3">
        <span className={cx('grid h-11 w-11 shrink-0 place-items-center rounded-xl', done ? 'bg-success-50 text-success-600' : 'bg-brand-50 text-brand-700')}>
          {done ? <Check size={20} strokeWidth={2.4} aria-hidden /> : <Icon size={20} strokeWidth={1.8} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-extrabold text-ink-900">{m.title}</p>
          <p className="text-[11.5px] text-ink-400">{KIND_LABEL[m.kind]} · {m.advertiser}</p>
        </div>
        <span className="shrink-0 rounded-full bg-warning-500/10 px-2.5 py-1 text-[12px] font-black text-accent-600">
          <Gift size={12} className="mr-0.5 inline" aria-hidden />+{m.tickets}
        </span>
      </div>

      {done ? (
        <p className="mt-2.5 text-[12px] font-bold text-success-600">{state.ok ? state.message : '오늘 참여 완료 · 내일 다시 받을 수 있어요'}</p>
      ) : !loggedIn ? (
        <a href="/login?next=%2Fvote%2Fcharge" className="mt-3 grid h-10 place-items-center rounded-xl bg-ink-900 text-[13px] font-extrabold text-white">로그인하고 받기</a>
      ) : phase === 'idle' ? (
        <button type="button" onClick={start} className="mt-3 h-10 w-full rounded-xl bg-ink-900 text-[13px] font-extrabold text-white">
          참여하기
        </button>
      ) : phase === 'running' ? (
        <div className="mt-3">
          <div className="grid aspect-[16/6] place-items-center rounded-xl bg-[repeating-linear-gradient(45deg,#fff3cf_0_12px,#ffe9ad_12px_24px)] text-[13px] font-extrabold text-brand-800">
            테스트 광고 재생 중 · {left}초
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.round((((m.seconds ?? 1) - left) / (m.seconds ?? 1)) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <form action={action} className="mt-3">
          <input type="hidden" name="missionId" value={m.id} />
          {m.quiz ? (
            <fieldset>
              <legend className="mb-2 text-[13px] font-bold text-ink-800">{m.quiz.question}</legend>
              <div className="grid gap-1.5">
                {m.quiz.options.map((o, i) => (
                  <label key={o} className={cx('flex h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-[13px] font-bold', answer === i ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 text-ink-700')}>
                    <input type="radio" name="answer" value={i} className="sr-only" onChange={() => setAnswer(i)} />
                    {o}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {state.message && !state.ok ? <p className="mt-2 text-[12.5px] font-bold text-danger-600">{state.message}</p> : null}
          <button type="submit" disabled={pending || (Boolean(m.quiz) && answer == null)} className="mt-2.5 flex h-10 w-full items-center justify-center gap-1 rounded-xl bg-brand-400 text-[13px] font-black text-ink-900 disabled:opacity-50">
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Gift size={16} aria-hidden />}
            팬투표권 {m.tickets}개 받기
          </button>
        </form>
      )}
    </li>
  );
}
