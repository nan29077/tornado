'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, CreditCard, Landmark, Loader2 } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { bookSessionAction, subscribeTalkAction, type TalkActionState } from '@/app/actions/talk';

const initial: TalkActionState = { ok: false };

function MethodPicker({ value, onChange }: { value: 'CARD' | 'TRANSFER'; onChange: (v: 'CARD' | 'TRANSFER') => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {([
        { key: 'CARD', label: '신용카드', Icon: CreditCard },
        { key: 'TRANSFER', label: '간편계좌이체', Icon: Landmark },
      ] as const).map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onChange(m.key)}
          aria-pressed={value === m.key}
          className={cx('flex h-11 items-center justify-center gap-1.5 rounded-xl border text-[13px] font-extrabold', value === m.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700')}
        >
          <m.Icon size={16} strokeWidth={1.8} aria-hidden />
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** 소통 월 구독 결제 */
export function SubscribeForm({ creatorId, code, price, periodDays, mock, renew }: { creatorId: string; code: string; price: number; periodDays: number; mock: boolean; renew?: boolean }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(subscribeTalkAction, initial);
  const [method, setMethod] = React.useState<'CARD' | 'TRANSFER'>('CARD');
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="creatorId" value={creatorId} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="method" value={method} />
      <MethodPicker value={method} onChange={setMethod} />
      <label className="flex items-start gap-2 rounded-xl bg-warm-100 px-3 py-2.5 text-[12px] leading-relaxed text-ink-600">
        <input type="checkbox" name="agree" className="mt-0.5 h-4 w-4 accent-ink-900" />
        <span>{periodDays}일 이용권입니다(자동 결제 아님). 크리에이터 메시지를 받고 답장할 수 있어요. 결제 오류 등은 고객센터로 환불을 요청할 수 있어요.</span>
      </label>
      {mock ? <p className="text-[11.5px] font-bold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않아요.</p> : null}
      {state.message ? <p className={cx('rounded-xl px-3 py-2 text-[12.5px] font-bold', state.ok ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600')}>{state.message}</p> : null}
      <button type="submit" disabled={pending} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white disabled:opacity-60">
        {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
        {price.toLocaleString('ko-KR')}원 · {renew ? '이용 기간 연장하기' : '소통 시작하기'}
      </button>
    </form>
  );
}

export interface SlotView {
  startsAt: string;
  date: string;
  time: string;
  available: boolean;
}

/** 1:1 채팅 일정표 · 신청 */
export function SlotPicker({ creatorId, slots, price, minutes, mock, refundNote }: { creatorId: string; slots: SlotView[]; price: number; minutes: number; mock: boolean; refundNote: string }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(bookSessionAction, initial);
  const dates = [...new Set(slots.map((s) => s.date))];
  const [date, setDate] = React.useState(dates.find((d) => slots.some((s) => s.date === d && s.available)) ?? dates[0] ?? '');
  const [start, setStart] = React.useState('');
  const [method, setMethod] = React.useState<'CARD' | 'TRANSFER'>('CARD');
  React.useEffect(() => {
    if (state.ok && state.nonce && state.redirectTo) router.push(state.redirectTo);
  }, [state.ok, state.nonce, state.redirectTo, router]);

  if (slots.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white px-5 py-10 text-center">
        <CalendarDays size={24} className="mx-auto text-ink-300" aria-hidden />
        <p className="mt-2 text-[14px] font-bold text-ink-700">지금 신청할 수 있는 시간이 없어요</p>
        <p className="mt-1 text-[12.5px] text-ink-400">크리에이터가 가능 시간을 열면 여기에 표시돼요.</p>
      </div>
    );
  }
  const label = (d: string) => {
    const dt = new Date(`${d}T00:00:00+09:00`);
    return { day: dt.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' }), num: Number(d.slice(8)), month: Number(d.slice(5, 7)) };
  };
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="creatorId" value={creatorId} />
      <input type="hidden" name="startsAt" value={start} />
      <input type="hidden" name="method" value={method} />
      <div>
        <p className="mb-2 text-[13px] font-extrabold text-ink-800">날짜</p>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {dates.map((d) => {
            const l = label(d);
            const any = slots.some((s) => s.date === d && s.available);
            return (
              <button
                key={d}
                type="button"
                disabled={!any}
                onClick={() => { setDate(d); setStart(''); }}
                className={cx('flex w-14 shrink-0 flex-col items-center rounded-2xl border py-2 disabled:opacity-35', date === d ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800')}
              >
                <span className="text-[10.5px] font-bold opacity-70">{l.month}월</span>
                <span className="text-[17px] font-black">{l.num}</span>
                <span className="text-[11px] font-bold">{l.day}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="mb-2 text-[13px] font-extrabold text-ink-800">시간 <span className="font-bold text-ink-400">· 1회 {minutes}분</span></p>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
          {slots.filter((s) => s.date === date).map((s) => (
            <button
              key={s.startsAt}
              type="button"
              disabled={!s.available}
              onClick={() => setStart(s.startsAt)}
              className={cx('h-10 rounded-xl border text-[13px] font-bold tabular-nums disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-300 disabled:line-through', start === s.startsAt ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:border-brand-300')}
            >
              {s.time}
            </button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="mb-1 block text-[13px] font-extrabold text-ink-800">하고 싶은 이야기 (선택)</span>
        <textarea name="note" rows={2} maxLength={300} placeholder="크리에이터가 미리 볼 수 있어요" className="w-full rounded-xl border border-ink-200 px-3 py-2 text-[13.5px]" />
      </label>
      <MethodPicker value={method} onChange={setMethod} />
      <label className="flex items-start gap-2 rounded-xl bg-warm-100 px-3 py-2.5 text-[12px] leading-relaxed text-ink-600">
        <input type="checkbox" name="agree" className="mt-0.5 h-4 w-4 accent-ink-900" />
        <span>{refundNote}</span>
      </label>
      {mock ? <p className="text-[11.5px] font-bold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않아요.</p> : null}
      {state.message && !state.ok ? <p className="rounded-xl bg-danger-50 px-3 py-2 text-[12.5px] font-bold text-danger-600">{state.message}</p> : null}
      <button type="submit" disabled={pending || !start} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white disabled:opacity-50">
        {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
        {start ? `${price.toLocaleString('ko-KR')}원 결제하고 신청하기` : '시간을 골라 주세요'}
      </button>
    </form>
  );
}
