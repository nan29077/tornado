'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cx } from '@/components/ui';
import type { ShopActionState } from '@/app/actions/shop';

type Action = (prev: ShopActionState, fd: FormData) => Promise<ShopActionState>;

/**
 * 도네이도 샵 공용 폼. 결과 문구를 보여 주고, redirectTo 가 오면 이동한다.
 * children 은 함수로 받을 수 있어 pending 상태를 버튼에 반영한다.
 */
export function ShopActionForm({
  action,
  children,
  className,
  confirm,
  onDone,
  hideMessage = false,
}: {
  action: Action;
  children: React.ReactNode | ((pending: boolean) => React.ReactNode);
  className?: string;
  confirm?: string;
  onDone?: (s: ShopActionState) => void;
  hideMessage?: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = React.useActionState(action, { ok: false } as ShopActionState);
  const last = React.useRef<ShopActionState | null>(null);

  React.useEffect(() => {
    if (state === last.current || (!state.message && !state.redirectTo && !state.ok)) return;
    last.current = state;
    if (state.redirectTo) router.push(state.redirectTo);
    else if (state.ok) router.refresh();
    onDone?.(state);
  }, [state, router, onDone]);

  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {typeof children === 'function' ? children(pending) : children}
      {!hideMessage && state.message ? (
        <p role="status" aria-live="polite" className={cx('mt-2 text-[12.5px] font-semibold', state.ok ? 'text-success-600' : 'text-danger-600')}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
