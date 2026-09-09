'use client';

import * as React from 'react';
import { cx } from '@/components/ui';
import { saveFanMemoAction } from '@/app/actions/studio';

const initial = { ok: false } as Awaited<ReturnType<typeof saveFanMemoAction>>;

/**
 * 팬 메모 한 줄 입력.
 *
 * 표 안에 들어가므로 공용 `ActionForm`(세로 여백 + 큰 버튼)을 쓰지 않고 따로 만든다.
 * 값이 바뀌었을 때만 [저장] 버튼이 활성화되어, 실수로 빈 값을 덮어쓰는 것을 줄인다.
 * 이 값은 크리에이터만 보는 비공개 메모다.
 */
export function FanMemoField({ donorId, defaultValue }: { donorId: string; defaultValue: string }) {
  const [state, formAction, pending] = React.useActionState(saveFanMemoAction, initial);
  const [value, setValue] = React.useState(defaultValue);
  const dirty = value !== defaultValue;

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="donorId" value={donorId} />
      <div className="flex items-center gap-1">
        <input
          name="memo"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={200}
          placeholder="비공개 메모 (200자)"
          aria-label="팬 비공개 메모"
          className="h-8 w-full min-w-[120px] rounded-lg border border-ink-200 px-2 text-[12px] text-ink-900 outline-none focus:border-brand-400"
        />
        <button
          type="submit"
          disabled={pending || !dirty}
          className="h-8 shrink-0 rounded-lg border border-ink-200 px-2 text-[11.5px] font-bold text-ink-700 disabled:opacity-40"
        >
          {pending ? '저장 중' : '저장'}
        </button>
      </div>
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
