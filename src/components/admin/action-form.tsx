'use client';

import * as React from 'react';
import { Button, Notice, cx } from '@/components/ui';
import { initialAdminState, type AdminActionState } from './state';

/**
 * 관리자 화면 공용 액션 폼.
 * - 모든 변경은 서버 액션을 통해 수행하고 결과 메시지를 그 자리에서 보여준다.
 * - 되돌릴 수 없는 작업에는 confirm 문구를 반드시 지정한다.
 */

export type AdminServerAction = (
  prev: AdminActionState,
  formData: FormData,
) => Promise<AdminActionState>;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'primary',
  confirm,
  className,
  disabled,
  compact = false,
}: {
  action: AdminServerAction;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: Variant;
  confirm?: string;
  className?: string;
  disabled?: boolean;
  /** true 이면 버튼과 메시지를 한 줄 크기로 압축해 표/목록 안에서 사용한다. */
  compact?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className={cx(compact ? 'flex flex-col items-start gap-1' : 'space-y-3', className)}
    >
      {children}
      <Button type="submit" variant={variant} size={compact ? 'sm' : 'md'} disabled={pending || disabled}>
        {pending ? pendingLabel : submitLabel}
      </Button>
      {state.message ? (
        compact ? (
          <span
            role="status"
            aria-live="polite"
            className={cx(
              'block max-w-[220px] text-[11px] leading-tight',
              state.ok ? 'text-success-600' : 'text-danger-600',
            )}
          >
            {state.message}
          </span>
        ) : (
          <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
        )
      ) : null}
    </form>
  );
}

/** 숨은 값 + 버튼 하나로 끝나는 단순 액션 (표 안에서 사용) */
export function ActionButton({
  action,
  values,
  label,
  variant = 'secondary',
  confirm,
  disabled,
  className,
}: {
  action: AdminServerAction;
  values: Record<string, string>;
  label: string;
  variant?: Variant;
  confirm?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ActionForm action={action} submitLabel={label} variant={variant} confirm={confirm} disabled={disabled} compact className={className}>
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </ActionForm>
  );
}

/**
 * 목록에서 하나를 골라 실행하는 폼. **선택지를 행마다 렌더하지 않는다.**
 *
 * `SelectActionForm` 은 `<option>` 을 행마다 새로 그린다. MO 번호 화면처럼
 * 200행 x 크리에이터 300명이면 `<option>` 이 6만 개가 되어 페이지가 사실상 열리지 않는다.
 * 여기서는 `<datalist>` 를 화면에 **한 번만** 두고 각 행은 그것을 참조한다(`list` 속성).
 * 선택지 DOM 은 목록 크기와 무관하게 한 벌이다.
 *
 * 입력값은 사람이 읽는 라벨이고, 제출 직전에 라벨 → 값으로 바꿔 보낸다.
 * 목록에 없는 값을 손으로 적어 넣으면 제출을 막는다(서버도 다시 검증한다).
 */
export function DatalistActionForm({
  action,
  values,
  name,
  listId,
  options,
  placeholder = '이름 입력 또는 선택',
  submitLabel = '변경',
  confirm,
  hint,
  disabled,
}: {
  action: AdminServerAction;
  values: Record<string, string>;
  name: string;
  /** 화면에 한 번만 렌더된 <datalist> 의 id */
  listId: string;
  /** 라벨 → 값 대조표. <option> 을 그리지는 않는다. */
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  submitLabel?: string;
  confirm?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);
  const [label, setLabel] = React.useState('');

  const byLabel = React.useMemo(() => new Map(options.map((o) => [o.label, o.value])), [options]);
  const matched = byLabel.get(label.trim());
  const typedButUnmatched = label.trim() !== '' && !matched;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!matched) {
          e.preventDefault();
          return;
        }
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="flex flex-col gap-1"
    >
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {/* 서버로는 라벨이 아니라 실제 값이 간다. */}
      <input type="hidden" name={name} value={matched ?? ''} />
      <div className="flex items-center gap-1.5">
        <input
          list={listId}
          aria-label={placeholder}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className="h-9 w-44 rounded-lg border border-ink-200 bg-white px-2 text-[13px] text-ink-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50 disabled:text-ink-400"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={pending || disabled || !matched}>
          {pending ? '처리 중' : submitLabel}
        </Button>
      </div>
      {typedButUnmatched ? (
        <span className="text-[11px] leading-tight font-semibold text-danger-600">
          목록에 없는 이름입니다. 칸을 비우면 전체 목록이 나옵니다.
        </span>
      ) : hint ? (
        <span className="text-[11px] leading-tight text-ink-400">{hint}</span>
      ) : null}
      {state.message ? (
        <span
          role="status"
          aria-live="polite"
          className={cx('text-[11px] leading-tight', state.ok ? 'text-success-600' : 'text-danger-600')}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** 표 안에서 선택값 하나를 바꾸는 액션 (상태 변경 등) */
export function SelectActionForm({
  action,
  values,
  name,
  options,
  defaultValue,
  submitLabel = '변경',
  confirm,
  hint,
  disabled,
  ariaLabel,
}: {
  action: AdminServerAction;
  values: Record<string, string>;
  name: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  defaultValue?: string;
  submitLabel?: string;
  confirm?: string;
  hint?: string;
  disabled?: boolean;
  /**
   * 표 안에 홀로 놓인 <select> 라 연결된 <label> 이 없다. 화면 낭독기에서는
   * "콤보 상자"라고만 읽혀 무엇을 고르는 칸인지 알 수 없었다.
   * 주지 않으면 name 을 쓰되, 사람이 읽을 이름을 주는 편이 낫다.
   */
  ariaLabel?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className="flex flex-col gap-1"
    >
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="flex items-center gap-1.5">
        <select
          name={name}
          aria-label={ariaLabel ?? name}
          defaultValue={defaultValue}
          disabled={disabled}
          className="h-9 rounded-lg border border-ink-200 bg-white px-2 text-[13px] text-ink-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50 disabled:text-ink-400"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="secondary" disabled={pending || disabled}>
          {pending ? '처리 중' : submitLabel}
        </Button>
      </div>
      {hint ? <span className="text-[11px] leading-tight text-ink-400">{hint}</span> : null}
      {state.message ? (
        <span
          role="status"
          aria-live="polite"
          className={cx('text-[11px] leading-tight', state.ok ? 'text-success-600' : 'text-danger-600')}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/**
 * 실행 결과의 부가 정보(detail)를 함께 보여주는 폼.
 * MO 시뮬레이터처럼 실행 결과 자체가 화면 산출물인 경우에 사용한다.
 */
export function ActionFormWithDetail({
  action,
  children,
  submitLabel,
  detailLabels,
  confirm,
}: {
  action: AdminServerAction;
  children?: React.ReactNode;
  submitLabel: string;
  detailLabels: Record<string, string>;
  confirm?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className="space-y-3"
    >
      {children}
      <Button type="submit" size="md" disabled={pending}>
        {pending ? '실행 중' : submitLabel}
      </Button>
      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
      {state.detail ? (
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-3">
          {Object.entries(detailLabels).map(([key, label]) =>
            state.detail?.[key] ? (
              <div key={key} className="flex items-start justify-between gap-4 border-b border-ink-100 py-1.5 last:border-0">
                <span className="text-[12px] text-ink-400">{label}</span>
                <span className="text-right text-[12px] font-semibold break-all text-ink-900">{state.detail[key]}</span>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </form>
  );
}

/**
 * 결과가 **목록으로 나오는** 일괄 작업용 폼. (MO 번호 일괄 재발급 등)
 *
 * `DetailActionForm` 은 미리 정해 둔 라벨 목록(detailLabels)만 렌더하므로,
 * 대상이 실행 시점에 정해지는 일괄 작업에는 쓸 수 없다. 여기서는 서버가 돌려준
 * detail 을 있는 그대로 전부 그린다.
 *
 * 결과를 화면에 남겨 두는 이유: 번호가 바뀐 크리에이터에게 관리자가 직접 안내해야 하는데,
 * 그 목록이 사라지면 감사로그를 다시 뒤져야 한다.
 */
export function BulkActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = '처리 중',
  variant = 'primary',
  confirm,
  emptyLabel = '변경된 항목이 없습니다.',
}: {
  action: AdminServerAction;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: Variant;
  confirm?: string;
  emptyLabel?: string;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);
  const entries = Object.entries(state.detail ?? {});

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className="space-y-3"
    >
      {children}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>

      {state.message ? (
        <div role="status" aria-live="polite">
          <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice>
        </div>
      ) : null}

      {state.ok && state.message ? (
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-3">
          {entries.length === 0 ? (
            <p className="text-[12px] text-ink-400">{emptyLabel}</p>
          ) : (
            <ul className="space-y-1">
              {entries.map(([name, change]) => (
                <li key={name} className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                  <span className="font-semibold text-ink-700">{name}</span>
                  <span className="font-mono text-[11.5px] break-all text-ink-900">{change}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </form>
  );
}
