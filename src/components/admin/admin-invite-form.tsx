'use client';

import * as React from 'react';
import { MailX, UserPlus } from 'lucide-react';
import { Button, Notice } from '@/components/ui';
import { CopyButton } from '@/components/public/copy-button';
import { AdminInput, AdminSelect } from './controls';
import { initialAdminState } from './state';
import type { AdminServerAction } from './action-form';

/**
 * [SEC-A] 관리자 초대 폼.
 *
 * 이메일 발송은 아직 연동 전이다(CLAUDE.md 규칙 2). 발송한 것처럼 보이게 하지 않고,
 * 만들어진 1회용 링크를 **이 화면에서 한 번만** 보여 주며 최고관리자가 직접 전달한다.
 * 서버는 토큰 해시만 저장하므로 이 화면을 벗어나면 같은 링크를 다시 볼 수 없다
 * (잃어버렸으면 같은 이메일로 다시 초대하면 이전 링크는 자동 회수된다).
 */
export function AdminInviteForm({
  action,
  permissions,
}: {
  action: AdminServerAction;
  permissions: Array<{ value: string; label: string }>;
}) {
  const [state, formAction, pending] = React.useActionState(action, initialAdminState);
  const link = state.ok ? state.detail?.inviteLink : undefined;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm('입력한 이메일 앞으로 관리자 초대 링크를 만듭니다. 계속할까요?')) e.preventDefault();
      }}
      className="space-y-3"
    >
      <div className="grid gap-2.5 sm:grid-cols-[1fr_200px]">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">초대할 이메일</span>
          <AdminInput type="email" name="email" required placeholder="user@example.com" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">부여할 권한</span>
          <AdminSelect name="permission" defaultValue="READ_ONLY">
            {permissions.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </AdminSelect>
        </label>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? '처리 중' : '초대 링크 만들기'}
        <UserPlus size={16} strokeWidth={1.7} />
      </Button>

      {link ? (
        <Notice tone="warning" title="[MOCK] 메일 발송 미연동 — 링크를 직접 전달">
          <span className="flex items-center gap-1.5">
            <MailX size={16} strokeWidth={1.7} />
            초대 메일은 발송되지 않았습니다. 아래 링크를 초대받는 분에게 직접 전달해 주세요.
          </span>
          <span className="mt-1 block text-[12px]">
            링크는 72시간 동안 1회만 쓸 수 있고, 초대받은 이메일 계정으로 로그인한 상태에서만 수락됩니다. 이 화면을
            벗어나면 다시 볼 수 없습니다.
          </span>
          <span className="mt-2 block break-all font-mono text-[12px] font-semibold text-ink-900">{link}</span>
          <span className="mt-1.5 block">
            <CopyButton value={link} label="초대 링크" />
          </span>
        </Notice>
      ) : null}
      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
    </form>
  );
}
