'use client';

import * as React from 'react';
import { Button, Notice, cx } from '@/components/ui';
import { SecretBox } from '@/components/studio/copy';
import { ConfirmDialog, useConfirmSubmit } from '@/components/studio/confirm-dialog';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 크리에이터 관리자 공용 액션 폼.
 * 서버 컴포넌트에서 필드를 children 으로 넘기고, 서버 액션을 그대로 전달한다.
 *
 * confirmMessage 를 주면 브라우저 기본 confirm 이 아니라 도네이도 알림창을 띄우고,
 * 그 [확인] 을 눌러야 실제로 제출된다. 처리 결과도 같은 알림창에서 보여 준다.
 */

type StudioAction = (prev: StudioActionState, formData: FormData) => Promise<StudioActionState>;

const initial: StudioActionState = { ok: false };

export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'primary',
  size = 'md',
  confirmMessage,
  confirmTitle,
  confirmActionLabel,
  confirmVariant,
  doneTitle,
  scrollToId,
  className,
}: {
  action: StudioAction;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  /** 있으면 도네이도 알림창으로 한 번 물어본 뒤 제출한다. */
  confirmMessage?: string;
  /** 알림창 제목. 없으면 버튼 문구로 물어본다. */
  confirmTitle?: string;
  /** 알림창의 실행 버튼 문구. 없으면 [확인] */
  confirmActionLabel?: string;
  /** 되돌릴 수 없는 동작이면 danger 를 준다. */
  confirmVariant?: 'primary' | 'danger' | 'accent';
  /** 성공했을 때 알림창 제목. 없으면 [완료되었습니다] */
  doneTitle?: string;
  /**
   * 성공했을 때 이 id 를 가진 요소로 부드럽게 스크롤한다.
   *
   * [테스트 후원 보내기] 처럼 "결과가 화면 다른 곳에서 재생되는" 동작에 쓴다.
   * 폼을 채우려고 스크롤을 내린 상태면 재생되는 미리보기가 화면 밖이라
   * 아무 일도 일어나지 않은 것처럼 보인다.
   */
  scrollToId?: string;
  className?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initial);
  const formRef = React.useRef<HTMLFormElement>(null);
  const confirm = useConfirmSubmit(formRef, state, pending);

  // 응답이 새로 도착했고 성공이면 결과가 보이는 자리로 옮겨 준다.
  const seenState = React.useRef(state);
  React.useEffect(() => {
    if (seenState.current === state) return;
    seenState.current = state;
    if (!scrollToId || !state.ok || typeof document === 'undefined') return;
    document.getElementById(scrollToId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [state, scrollToId]);

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(e) => {
        if (confirmMessage) confirm.onSubmit(e);
      }}
      className={cx('space-y-3.5', className)}
    >
      {children}

      {confirmMessage ? (
        <ConfirmDialog
          phase={confirm.phase}
          title={confirmTitle ?? `${submitLabel}할까요?`}
          description={confirmMessage}
          confirmLabel={confirmActionLabel ?? '확인'}
          busyLabel={pendingLabel}
          variant={confirmVariant ?? (variant === 'danger' ? 'danger' : 'primary')}
          doneOk={state.ok}
          doneTitle={state.ok ? doneTitle ?? '완료되었습니다' : '처리하지 못했습니다'}
          doneDescription={state.message}
          onConfirm={confirm.confirm}
          onClose={confirm.close}
        />
      ) : null}

      {state.secret ? (
        <SecretBox label={state.secretLabel ?? '발급된 값'} value={state.secret} hint={state.secretHint} />
      ) : null}

      {state.message ? (
        <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
      ) : null}

      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}

/** 테이블 행 등에 들어가는 소형 액션 버튼 */
export function InlineActionForm({
  action,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'secondary',
  confirmMessage,
  fields,
  disabled,
  disabledReason,
}: {
  action: StudioAction;
  submitLabel: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  confirmMessage?: string;
  fields: Record<string, string>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initial);

  if (disabled) {
    return <span className="text-[12px] text-ink-300">{disabledReason ?? '처리 불가'}</span>;
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
      {state.message ? (
        <span className={cx('mt-1 block text-[11.5px] leading-snug', state.ok ? 'text-success-500' : 'text-danger-500')}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
