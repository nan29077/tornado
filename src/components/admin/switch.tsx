import * as React from 'react';
import { cx } from '@/components/ui';

/**
 * 켜기/끄기 스위치 (2026-11-18). 서버·클라이언트 컴포넌트 어디서나 쓴다(상태 훅 없음, CSS 로만 움직인다).
 *
 * 폼 값: 켜면 name=on 이 전송되고, 끄면 아무 값도 전송되지 않는다.
 * 서버 액션은 `값 === 'on'` 으로 읽는다(예전 켜기/끄기 선택칸과 같은 규칙).
 * 스타일은 globals.css 의 .donaido-switch-* 를 쓴다.
 */
export function Switch({
  name,
  defaultChecked,
  onLabel = '켜기',
  offLabel = '끄기',
  disabled,
  ariaLabel,
  className,
}: {
  name: string;
  defaultChecked: boolean;
  onLabel?: string;
  offLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <input
        type="checkbox"
        role="switch"
        name={name}
        value="on"
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-label={ariaLabel}
        className="donaido-switch-input sr-only"
      />
      <span className="donaido-switch-track" aria-hidden />
      <span className="donaido-switch-text min-w-[3.2em] text-[13px] font-bold" aria-hidden>
        <span className="donaido-switch-on text-brand-800">{onLabel}</span>
        <span className="donaido-switch-off text-ink-400">{offLabel}</span>
      </span>
    </span>
  );
}

/**
 * 설정 한 줄: 왼쪽 이름·설명, 오른쪽 스위치. 줄 어디를 눌러도 켜고 끈다.
 * 모바일은 한 줄씩, PC 는 감싸는 그리드에 따라 2열.
 */
export function SwitchField({
  label,
  hint,
  name,
  value,
  onLabel,
  offLabel,
  disabled,
  tone = 'default',
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  name: string;
  value: boolean;
  onLabel?: string;
  offLabel?: string;
  disabled?: boolean;
  /** danger: 끄면 서비스가 멈추는 중요한 스위치 */
  tone?: 'default' | 'danger';
  className?: string;
}) {
  return (
    <label
      className={cx(
        'flex min-h-[60px] cursor-pointer items-center justify-between gap-3 rounded-2xl border bg-white px-3.5 py-3 transition-colors hover:border-brand-200 hover:bg-brand-50/30',
        tone === 'danger' ? 'border-danger-500/25' : 'border-ink-100',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-[13.5px] font-bold leading-snug text-ink-900">{label}</span>
        {hint ? <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-400">{hint}</span> : null}
      </span>
      <Switch name={name} defaultChecked={value} onLabel={onLabel} offLabel={offLabel} disabled={disabled} ariaLabel={label} className="shrink-0" />
    </label>
  );
}
