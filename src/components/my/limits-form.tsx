'use client';

import * as React from 'react';
import { Save } from '@/components/brand/icons';
import { Button, Field, Input, Notice } from '@/components/ui';
import { updateDonorLimits, type DonorActionState } from '@/app/actions/donor';

const initial: DonorActionState = { ok: false };

/**
 * 후원자 한도 설정.
 * 전역 정책보다 높은 값은 서버에서 거부되며, 여기서도 입력 상한으로 한 번 더 막는다.
 */
export function LimitsForm({
  defaultDaily,
  defaultMonthly,
  maxDaily,
  maxMonthly,
  maxDailyText,
  maxMonthlyText,
}: {
  defaultDaily: string;
  defaultMonthly: string;
  maxDaily: string;
  maxMonthly: string;
  maxDailyText: string;
  maxMonthlyText: string;
}) {
  const [state, formAction, pending] = React.useActionState(updateDonorLimits, initial);

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="1일 한도 (원)"
        hint={`비워두면 기본 정책(${maxDailyText})이 적용됩니다. 기본 정책보다 높게 설정할 수 없습니다.`}
      >
        <Input
          name="dailyLimit"
          inputMode="numeric"
          pattern="[0-9]*"
          max={maxDaily}
          defaultValue={defaultDaily}
          placeholder={maxDaily}
          className="tabular-nums"
        />
      </Field>

      <Field
        label="1개월 한도 (원)"
        hint={`비워두면 기본 정책(${maxMonthlyText})이 적용됩니다.`}
      >
        <Input
          name="monthlyLimit"
          inputMode="numeric"
          pattern="[0-9]*"
          max={maxMonthly}
          defaultValue={defaultMonthly}
          placeholder={maxMonthly}
          className="tabular-nums"
        />
      </Field>

      {state.message ? (
        <Notice tone={state.ok ? 'success' : 'warning'}>{state.message}</Notice>
      ) : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '저장 중' : '한도 저장'}
        <Save size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
