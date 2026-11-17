'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from '@/components/brand/icons';
import { cx } from '@/components/ui';

type State = { ok: boolean; message?: string; nonce?: number; redirectTo?: string };
type Action = (prev: State, fd: FormData) => Promise<State>;

/**
 * 회원 화면용 작은 액션 폼 (2026-11-17). 숨은 값 + 버튼 하나, 결과 문구를 그 자리에 보여 준다.
 * children 으로 추가 입력칸(사유 등)을 넣을 수 있다.
 */
export function MiniAction({
  action,
  fields,
  label,
  confirm,
  variant = 'dark',
  className,
  children,
  full = false,
}: {
  action: Action;
  fields: Record<string, string>;
  label: string;
  confirm?: string;
  variant?: 'dark' | 'light' | 'danger' | 'brand';
  className?: string;
  children?: React.ReactNode;
  full?: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = React.useActionState(action, { ok: false } as State);
  React.useEffect(() => {
    if (state.ok && state.nonce) {
      if (state.redirectTo) router.push(state.redirectTo);
      else router.refresh();
    }
  }, [state.ok, state.nonce, state.redirectTo, router]);
  const tone =
    variant === 'danger' ? 'border border-danger-500/40 bg-white text-danger-600 hover:bg-danger-50'
    : variant === 'light' ? 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-50'
    : variant === 'brand' ? 'bg-brand-400 text-ink-900 hover:bg-brand-300'
    : 'bg-ink-900 text-white hover:bg-ink-800';
  return (
    <form
      action={formAction}
      className={cx(full ? 'w-full' : 'inline-block', className)}
      onSubmit={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <button type="submit" disabled={pending} className={cx('inline-flex h-9 items-center justify-center gap-1 rounded-xl px-3.5 text-[12.5px] font-extrabold disabled:opacity-60', tone, full && 'w-full')}>
        {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
        {label}
      </button>
      {state.message ? <p className={cx('mt-1.5 text-[12px] font-bold', state.ok ? 'text-success-600' : 'text-danger-600')}>{state.message}</p> : null}
    </form>
  );
}
