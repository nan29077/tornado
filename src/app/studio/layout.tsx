import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ConsoleShell, type NavGroup } from '@/components/layout/console-shell';
import { getSessionUser, requireCreator } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '크리에이터 관리자 | 도네이도',
  robots: { index: false, follow: false },
};

const groups: NavGroup[] = [
  {
    title: '현황',
    items: [
      { href: '/studio', label: '대시보드', icon: 'dashboard' },
      { href: '/studio/donations', label: '후원 내역', icon: 'donations' },
      { href: '/studio/messages', label: '문자 관리', icon: 'messages' },
      { href: '/studio/fans', label: '팬 관리', icon: 'donors' },
    ],
  },
  {
    title: '방송',
    items: [
      { href: '/studio/youtube', label: '유튜브 채널 연결', icon: 'youtube' },
      { href: '/studio/overlay', label: '후원·게임 오버레이', icon: 'overlay' },
    ],
  },
  {
    title: '운영',
    items: [
      { href: '/studio/settings', label: '후원 설정', icon: 'settings' },
      { href: '/studio/moderation', label: '금칙어·차단', icon: 'moderation' },
      { href: '/studio/reports', label: '신고', icon: 'reports' },
    ],
  },
  {
    title: '정산',
    items: [
      { href: '/studio/settlement', label: '정산 관리', icon: 'settlement' },
    ],
  },
  {
    title: '계정',
    items: [{ href: '/studio/profile', label: '프로필 설정', icon: 'profile' }],
  },
];

const STATUS_NOTICE: Record<string, { title: string; body: string }> = {
  PENDING: {
    title: '채널 심사가 진행 중입니다',
    body: '가입해 주셔서 감사합니다. 담당자가 채널 정보를 확인하고 있으며, 승인이 완료되면 등록하신 연락처로 안내드립니다. 승인 후 스튜디오의 모든 기능을 사용하실 수 있습니다.',
  },
  REJECTED: {
    title: '채널 심사가 반려되었습니다',
    body: '제출하신 채널 정보로는 승인이 어려웠습니다. 사유 확인과 재심사 요청은 고객센터 문의로 접수해 주세요.',
  },
  SUSPENDED: {
    title: '채널이 정지되었습니다',
    body: '운영정책 위반 또는 관리자 조치로 채널이 정지된 상태입니다. 정지 사유와 해제 절차는 고객센터로 문의해 주세요.',
  },
};

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser().catch(() => null);
  if (!session?.creatorId) redirect('/login?next=/studio');

  // 미승인·반려·정지 채널은 스튜디오 기능 대신 상태 안내만 노출한다.
  if (session.creatorStatus !== 'APPROVED') {
    const notice = STATUS_NOTICE[session.creatorStatus ?? 'PENDING'] ?? STATUS_NOTICE.PENDING;
    return (
      <div className="console-canvas mx-auto flex min-h-screen max-w-[560px] flex-col justify-center px-5 py-16">
        <div className="card p-7">
          <h1 className="text-[19px] font-bold text-ink-900">{notice.title}</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-500">{notice.body}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/" className="rounded-xl bg-ink-900 px-4 py-2.5 text-[13px] font-semibold text-white">
              메인으로
            </Link>
            <Link href="/support" className="rounded-xl border border-ink-200 px-4 py-2.5 text-[13px] font-semibold text-ink-700">
              고객센터 문의
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const user = await requireCreator().catch(() => null);
  if (!user) redirect('/login?next=/studio');

  return (
    <ConsoleShell
      title="크리에이터 관리자"
      groups={groups}
      user={{
        id: user.id,
        name: user.name ?? '크리에이터',
        role: '크리에이터',
        avatarUrl: user.creatorAvatarUrl,
        avatarSeed: user.creatorCode ?? user.id,
        avatarIndex: user.avatarIndex,
      }}
    >
      {children}
    </ConsoleShell>
  );
}
