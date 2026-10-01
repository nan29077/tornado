import { isServiceInMockMode } from '@/server/service-mode';
import type { Metadata } from 'next';
import { MessageSquare, MonitorPlay, Wallet, ShieldCheck } from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { CreatorApplyForm } from '@/components/public/creator-apply-form';
import { Card, CardTitle, Notice, LinkButton, Badge } from '@/components/ui';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { creatorStatusLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '크리에이터 가입 신청 | 도네이도',
  description: '문자후원 번호를 배정받고 방송에 후원 알림을 연결하려면 크리에이터 가입을 신청하세요.',
};

export default async function CreatorApplyPage() {
  const user = await getSessionUser();
  const existing = user
    ? await prisma.creatorProfile.findUnique({
        where: { userId: user.id },
        select: { code: true, status: true, displayName: true },
      })
    : null;

  return (
    <PublicShell aside={<ApplyAside />}>
      <PageHeader
        eyebrow="크리에이터"
        title="크리에이터 가입 신청"
        description="신청 후 관리자 심사를 거쳐 승인되면 전용 후원 번호가 배정됩니다."
      />

      {existing ? (
        <Card>
          <div className="flex items-center gap-2">
            <CardTitle>이미 신청한 계정입니다</CardTitle>
            <Badge tone={creatorStatusLabel[existing.status].tone}>{creatorStatusLabel[existing.status].text}</Badge>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
            {existing.status === 'PENDING'
              ? '관리자 심사가 진행 중입니다. 승인되면 MO 후원 번호가 배정되고 후원 페이지가 공개됩니다.'
              : existing.status === 'APPROVED'
                ? '승인이 완료되었습니다. 크리에이터 콘솔에서 방송 연동과 정산을 설정하세요.'
                : '신청 상태에 대한 자세한 안내가 필요하면 고객센터로 문의해 주세요.'}
          </p>
          <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
            <p className="text-[12px] font-semibold text-brand-700">크리에이터 코드</p>
            <p className="mt-1 font-mono text-[20px] font-extrabold tracking-[0.1em] text-ink-900">{existing.code}</p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <LinkButton href="/studio" variant="primary" size="md" className="w-full">
              크리에이터 콘솔
            </LinkButton>
            <LinkButton href="/support" variant="secondary" size="md" className="w-full">
              고객센터 문의
            </LinkButton>
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-4">
            <Notice tone="warning" title="MO 후원 번호는 승인 후 배정됩니다">
              신청 즉시 문자후원이 시작되지 않습니다. 관리자 승인 후 전용 번호(또는 대표번호 + 키워드)가 배정되며, 그
              전까지는 후원 페이지가 공개되지 않습니다.
            </Notice>
          </div>
          <CreatorApplyForm loggedIn={Boolean(user)} sessionEmail={user?.email ?? null} mockMode={isServiceInMockMode()} />
        </>
      )}
    </PublicShell>
  );
}

function ApplyAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>승인 후 제공되는 기능</CardTitle>
        <div className="mt-3 space-y-2.5">
          {[
            { icon: <MessageSquare size={17} strokeWidth={1.7} />, title: '전용 후원 번호', body: '전용 번호 또는 대표번호 + 키워드를 배정합니다.' },
            { icon: <MonitorPlay size={17} strokeWidth={1.7} />, title: '방송 연동', body: '유튜브 채팅, OBS · PRISM 오버레이, 음성 안내를 설정합니다.' },
            { icon: <Wallet size={17} strokeWidth={1.7} />, title: '정산 관리', body: '후원금과 수수료, 정산 가능 금액을 확인합니다.' },
            { icon: <ShieldCheck size={17} strokeWidth={1.7} />, title: '금칙어 · 차단', body: '부적절한 메시지와 후원자를 차단합니다.' },
          ].map((f) => (
            <div key={f.title} className="flex gap-3">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
                {f.icon}
              </span>
              <div>
                <p className="text-[13.5px] font-bold text-ink-900">{f.title}</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardTitle>심사 기준</CardTitle>
        <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-ink-500">
          <li>실제 운영 중인 채널인지 확인</li>
          <li>불법 · 성인 · 도박 콘텐츠 여부</li>
          <li>본인 확인 및 정산 정보의 일치</li>
        </ul>
      </Card>
    </div>
  );
}
