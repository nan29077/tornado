'use client';

import * as React from 'react';
import { Ban, Check } from '@/components/brand/icons';
import { Button, Notice } from '@/components/ui';
import { toggleCreatorBlock, type DonorActionState } from '@/app/actions/donor';

const initial: DonorActionState = { ok: false };

/** 크리에이터별 후원 차단 토글. 소유권 검증은 서버 액션에서 수행한다. */
export function BlockToggle({ linkId, blocked }: { linkId: string; blocked: boolean }) {
  const [state, formAction, pending] = React.useActionState(toggleCreatorBlock, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="linkId" value={linkId} />
      <input type="hidden" name="next" value={blocked ? 'UNBLOCK' : 'BLOCK'} />
      <Button type="submit" variant={blocked ? 'secondary' : 'danger'} size="sm" disabled={pending}>
        {blocked ? <Check size={15} strokeWidth={1.8} /> : <Ban size={15} strokeWidth={1.7} />}
        {pending ? '처리 중' : blocked ? '차단 해제' : '후원 차단'}
      </Button>
      {state.message && !state.ok ? <Notice tone="warning">{state.message}</Notice> : null}
    </form>
  );
}
