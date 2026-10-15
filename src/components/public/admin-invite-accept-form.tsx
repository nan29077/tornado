'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, LinkButton, Notice } from '@/components/ui';
import { acceptAdminInviteAction, type AcceptInviteState } from '@/app/actions/admin-invite';

/**
 * [SEC-A] 관리자 초대 수락 버튼.
 * 서버가 현재 로그인 계정의 이메일과 초대 이메일을 다시 대조한다. 화면 표시는 안내일 뿐이다.
 */
const initial: AcceptInviteState = { ok: false };

export function AdminInviteAcceptForm({ token }: { token: string }) {
  const [state, formAction, pending] = React.useActionState(acceptAdminInviteAction, initial);

  if (state.ok) {
    return (
      <div className="space-y-3">
        <Notice tone="success" title="관리자 초대를 수락했습니다">
          {state.message}
        </Notice>
        <LinkButton href="/admin" size="lg">
          관리자 콘솔로 이동
          <ShieldCheck size={16} strokeWidth={1.7} />
        </LinkButton>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state.message ? <Notice tone="danger">{state.message}</Notice> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '처리 중' : '초대 수락하고 관리자 권한 받기'}
        <ShieldCheck size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
