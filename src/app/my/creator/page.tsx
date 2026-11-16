import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ExternalLink, Sparkles, Star } from '@/components/brand/icons';
import { Badge, Card, CardTitle, LinkButton, Notice } from '@/components/ui';
import { CreatorApplyForm } from '@/components/public/creator-apply-form';
import { CreatorResubmitForm } from '@/components/my/creator-resubmit-form';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { applicationStage } from '@/server/services/creator-application';
import { isServiceInMockMode } from '@/server/service-mode';
import { formatFollowerCount, platformCountLabel, platformLabel } from '@/lib/creator-channels';
import { categoryLabel } from '@/lib/video-hub';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const STAGE: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger'; body: string }> = {
  REVIEW: { text: '심사 대기', tone: 'warning', body: '최고관리자가 채널과 신청 내용을 확인하고 있어요. 결과는 알림으로 알려 드립니다.' },
  REVISION: { text: '보완 요청', tone: 'danger', body: '아래 보완 요청 내용을 확인하고 신청서를 고쳐 다시 제출해 주세요.' },
  REJECTED: { text: '반려', tone: 'danger', body: '반려 사유를 확인하고, 고쳐서 다시 신청할 수 있어요.' },
  SUSPENDED: { text: '이용 정지', tone: 'danger', body: '이용이 정지된 크리에이터 계정입니다. 고객센터로 문의해 주세요.' },
  APPROVED: { text: '승인 완료', tone: 'success', body: '크리에이터 스튜디오에서 도네이도 샵과 방송 연동을 설정하세요.' },
};

/** 마이페이지 > 크리에이터 전환 신청 · 상태 · 보완 후 재제출 */
export default async function MyCreatorPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/my/creator');
  if (user.role === 'CREATOR') redirect('/studio');

  const profile = await prisma.creatorProfile.findUnique({
    where: { userId: user.id },
    select: {
      id: true, code: true, displayName: true, description: true, status: true, contentCategory: true,
      rejectReason: true, reviewNote: true, reviewRequestedAt: true, submittedAt: true, createdAt: true,
      channels: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { platform: true, url: true, title: true, followerCount: true, isPrimary: true } },
    },
  });

  if (!profile) {
    return (
      <div className="space-y-4">
        <Card className="border border-brand-100">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-800">
              <Sparkles size={19} strokeWidth={1.8} />
            </span>
            <div>
              <CardTitle>크리에이터로 전환하기</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
                지금 계정 그대로 크리에이터 신청을 할 수 있어요. 최고관리자 승인 후 크리에이터 계정으로 바뀌고, 후원·구독·주문
                내역은 그대로 유지됩니다. 승인되면 나만의 도네이도 샵이 열립니다.
              </p>
            </div>
          </div>
        </Card>
        <CreatorApplyForm loggedIn sessionEmail={user.email ?? null} mockMode={isServiceInMockMode()} />
      </div>
    );
  }

  const stage = applicationStage(profile);
  const meta = STAGE[stage];
  const canEdit = stage === 'REVIEW' || stage === 'REVISION' || stage === 'REJECTED';
  const primaryIndex = Math.max(0, profile.channels.findIndex((c) => c.isPrimary));

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>크리에이터 신청</CardTitle>
          <Badge tone={meta.tone}>{meta.text}</Badge>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">{meta.body}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]">
          <div className="rounded-xl bg-ink-50 px-3 py-2">
            <dt className="text-ink-400">표시명</dt>
            <dd className="mt-0.5 font-bold text-ink-900">{profile.displayName}</dd>
          </div>
          <div className="rounded-xl bg-ink-50 px-3 py-2">
            <dt className="text-ink-400">크리에이터 코드</dt>
            <dd className="mt-0.5 font-mono font-bold text-ink-900">{profile.code}</dd>
          </div>
          <div className="rounded-xl bg-ink-50 px-3 py-2">
            <dt className="text-ink-400">카테고리</dt>
            <dd className="mt-0.5 font-bold text-ink-900">{profile.contentCategory ? categoryLabel(profile.contentCategory) : '-'}</dd>
          </div>
          <div className="rounded-xl bg-ink-50 px-3 py-2">
            <dt className="text-ink-400">제출일</dt>
            <dd className="mt-0.5 font-bold text-ink-900">{formatKst(profile.submittedAt ?? profile.createdAt)}</dd>
          </div>
        </dl>
      </Card>

      {stage === 'REVISION' && profile.reviewNote ? (
        <Notice tone="warning" title={`보완 요청${profile.reviewRequestedAt ? ` · ${formatKst(profile.reviewRequestedAt)}` : ''}`}>
          {profile.reviewNote}
        </Notice>
      ) : null}
      {stage === 'REJECTED' && profile.rejectReason ? <Notice tone="danger" title="반려 사유">{profile.rejectReason}</Notice> : null}

      <Card>
        <CardTitle>등록한 채널</CardTitle>
        <ul className="mt-3 space-y-2">
          {profile.channels.map((c) => (
            <li key={c.url} className="flex items-center gap-3 rounded-xl border border-warm-200 px-3 py-2.5">
              <span className="w-20 shrink-0 text-[12px] font-bold text-ink-500">{platformLabel(c.platform)}</span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 truncate text-[13.5px] font-bold text-ink-900">
                  {c.isPrimary ? <Star size={13} strokeWidth={2} className="shrink-0 fill-current text-brand-600" /> : null}
                  {c.title ?? c.url}
                </p>
                <p className="text-[12px] text-ink-400">
                  {platformCountLabel(c.platform)} {formatFollowerCount(c.followerCount)}
                </p>
              </div>
              <a href={c.url} target="_blank" rel="noopener noreferrer" aria-label="채널 열기" className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-ink-50">
                <ExternalLink size={15} strokeWidth={1.8} />
              </a>
            </li>
          ))}
          {profile.channels.length === 0 ? <li className="text-[13px] text-ink-400">등록된 채널이 없습니다. 아래에서 추가해 주세요.</li> : null}
        </ul>
      </Card>

      {canEdit ? (
        <CreatorResubmitForm
          displayName={profile.displayName}
          description={profile.description}
          contentCategory={profile.contentCategory}
          channels={profile.channels.map((c) => ({
            platform: c.platform,
            url: c.url,
            title: c.title ?? '',
            followers: c.followerCount != null ? String(c.followerCount) : '',
          }))}
          primaryIndex={primaryIndex}
        />
      ) : stage === 'SUSPENDED' ? (
        <LinkButton href="/support" variant="secondary" size="md">
          고객센터 문의
        </LinkButton>
      ) : null}

      <p className="text-center text-[12px] text-ink-400">
        심사 기준이 궁금하신가요? <Link href="/faq" className="font-semibold text-brand-700">자주 묻는 질문</Link>
      </p>
    </div>
  );
}
