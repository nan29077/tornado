import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Card, CardTitle, Badge, EmptyState, Notice, LinkButton } from '@/components/ui';
import { BlockToggle } from '@/components/my/block-toggle';
import { requireDonorContext, NO_DONOR_TITLE, NO_DONOR_DESC } from '@/components/my/donor';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function MyBlocksPage() {
  const { donorId } = await requireDonorContext('/my/blocks');
  if (!donorId) return <EmptyState title={NO_DONOR_TITLE} description={NO_DONOR_DESC} />;

  // 후원자가 건 차단(donorBlockedAt)과 크리에이터가 건 차단(blockedDonor)은 별개다.
  // 이 화면에서 해제할 수 있는 것은 후원자 본인이 건 차단뿐이다.
  const [links, blockedByCreators] = await Promise.all([
    prisma.donorCreatorLink.findMany({
      where: { donorId },
      // 여러 채널을 후원한 사용자는 목록이 계속 길어진다. 상한을 둔다.
      orderBy: [{ donorBlockedAt: { sort: 'desc', nulls: 'last' } }, { lastDonatedAt: 'desc' }],
      take: 200,
      select: {
        id: true,
        donorBlockedAt: true,
        totalAmount: true,
        totalCount: true,
        lastDonatedAt: true,
        creatorId: true,
        creator: { select: { displayName: true, code: true, status: true } },
      },
    }),
    prisma.blockedDonor.findMany({ where: { donorId }, select: { creatorId: true }, take: 500 }),
  ]);
  const creatorBlocked = new Set(blockedByCreators.map((b) => b.creatorId));

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/my/account"
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-400 transition-colors hover:text-ink-900"
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
          내 정보로 돌아가기
        </Link>
        <h2 className="mt-1 text-[18px] font-black tracking-[-0.025em] text-ink-900">후원 차단</h2>
      </div>
      <Notice tone="brand" title="크리에이터별 후원 차단">
        차단하면 해당 크리에이터에게 보낸 문자는 후원으로 접수되지 않습니다. 실수로 반복 발송하는 것을 막고 싶을 때
        사용하세요. 차단은 언제든 해제할 수 있습니다.
      </Notice>

      {links.length === 0 ? (
        <EmptyState
          title="후원한 크리에이터가 없습니다"
          description="문자후원을 이용하면 크리에이터별 차단을 설정할 수 있습니다."
        />
      ) : (
        <div className="space-y-2.5">
          {links.map((l) => {
            const blocked = Boolean(l.donorBlockedAt);
            const blockedByCreator = creatorBlocked.has(l.creatorId);
            return (
              <Card key={l.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[14.5px] font-bold text-ink-900">
                        {l.creator.status === 'APPROVED' ? (
                          <Link href={`/c/${l.creator.code}`} className="hover:text-brand-700">
                            {l.creator.displayName}
                          </Link>
                        ) : (
                          l.creator.displayName
                        )}
                      </p>
                      {blocked ? <Badge tone="danger">차단됨</Badge> : null}
                      {blockedByCreator ? <Badge tone="neutral">크리에이터가 차단함</Badge> : null}
                      {!blocked && !blockedByCreator ? <Badge tone="success">후원 가능</Badge> : null}
                    </div>
                    <p className="mt-1 text-[12.5px] text-ink-400">
                      누적 {formatWon(l.totalAmount)} · {formatNumber(l.totalCount)}건
                      {l.lastDonatedAt ? ` · 최근 ${formatKst(l.lastDonatedAt, false)}` : ''}
                    </p>
                    {blocked ? (
                      <p className="mt-1 text-[12px] text-ink-400">차단 일시 {formatKst(l.donorBlockedAt, false)}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    <BlockToggle linkId={l.id} blocked={blocked} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardTitle>전체 이용을 중단하고 싶다면</CardTitle>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          모든 크리에이터에 대한 문자후원을 멈추려면 등록 계좌 관리에서 자동출금 동의를 해지해 주세요.
        </p>
        <LinkButton href="/my/account" variant="secondary" size="md" className="mt-3">
          등록 계좌 관리
        </LinkButton>
      </Card>
    </div>
  );
}
