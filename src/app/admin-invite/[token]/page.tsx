import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, Notice } from '@/components/ui';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { AdminInviteAcceptForm } from '@/components/public/admin-invite-accept-form';
import { loadAdminInvite, normalizeInviteEmail } from '@/server/services/admin-invite';
import { getSessionUser } from '@/server/auth';
import { adminPermissionLabel } from '@/lib/labels';
import { formatKst } from '@/lib/datetime';

/**
 * [SEC-A] 관리자 초대 수락 화면.
 *
 * - 토큰은 URL 경로에만 있고 화면에 다시 노출하지 않는다.
 * - 로그인하지 않았으면 로그인 후 이 화면으로 돌아오게 안내한다.
 * - 초대 이메일은 마스킹해서만 보여 준다. 실제 대조는 서버 액션이 한다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '관리자 초대 | 도네이도',
  robots: { index: false, follow: false },
};

const INVALID_MESSAGE: Record<string, string> = {
  NOT_FOUND: '유효하지 않은 초대 링크입니다. 링크가 잘못되었거나 새 초대가 발급되었습니다.',
  EXPIRED: '초대 링크가 만료되었습니다. 초대 링크는 발급 후 72시간 동안만 사용할 수 있습니다.',
  USED: '이미 사용된 초대 링크입니다.',
  REVOKED: '최고관리자가 회수한 초대 링크입니다.',
};

export default async function AdminInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [loaded, me] = await Promise.all([loadAdminInvite(token), getSessionUser()]);
  const selfPath = `/admin-invite/${encodeURIComponent(token)}`;

  return (
    <PublicShell>
      <PageHeader
        eyebrow="관리자 초대"
        title="관리자 초대 수락"
        description="초대받은 이메일 계정으로 로그인한 상태에서만 수락할 수 있습니다."
      />
      <Card>
        {loaded.state !== 'VALID' ? (
          <Notice tone="danger" title="이 링크로는 초대를 수락할 수 없습니다">
            {INVALID_MESSAGE[loaded.state] ?? INVALID_MESSAGE.NOT_FOUND}
          </Notice>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-[100px_1fr] gap-y-1.5 text-[13px]">
              <dt className="text-ink-400">초대 이메일</dt>
              <dd className="font-semibold text-ink-900">{loaded.emailMasked}</dd>
              <dt className="text-ink-400">부여 권한</dt>
              <dd className="font-semibold text-ink-900">
                {loaded.permission ? adminPermissionLabel[loaded.permission] : '-'}
              </dd>
              <dt className="text-ink-400">만료</dt>
              <dd className="text-ink-700">{formatKst(loaded.expiresAt ?? null)}</dd>
            </dl>
            {/*
              다른 계정으로 로그인한 상태면 수락 버튼 대신 안내를 보여 준다.
              (눌러도 서버가 거절하지만, 누를 수 있는 버튼을 보여 주면 헷갈린다 — 3차 시뮬레이션에서 확인)
            */}
            {me && (!me.email || normalizeInviteEmail(me.email) !== loaded.email) ? (
              <Notice tone="warning" title="초대받은 계정이 아닙니다">
                지금 로그인한 계정으로는 이 초대를 수락할 수 없습니다. 초대받은 이메일({loaded.emailMasked}) 계정으로
                다시 로그인한 뒤 이 링크를 열어 주세요.
              </Notice>
            ) : me && me.role === 'CREATOR' ? (
              <Notice tone="warning" title="크리에이터 계정은 관리자를 겸할 수 없습니다">
                별도 계정으로 초대를 받아 주세요.
              </Notice>
            ) : me ? (
              <AdminInviteAcceptForm token={token} />
            ) : (
              <Notice tone="warning" title="로그인이 필요합니다">
                초대받은 이메일로 가입한 계정으로 로그인한 뒤 이 링크를 다시 열어 주세요.{' '}
                <Link href={`/login?next=${encodeURIComponent(selfPath)}`} className="font-semibold text-brand-700">
                  로그인하기
                </Link>
              </Notice>
            )}
          </div>
        )}
      </Card>
    </PublicShell>
  );
}
