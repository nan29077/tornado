import Link from 'next/link';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { ReportStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const REPORT_STATUS: Record<ReportStatus, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' }> = {
  OPEN: { text: '접수', tone: 'warning' },
  REVIEWING: { text: '검토중', tone: 'brand' },
  RESOLVED: { text: '처리완료', tone: 'success' },
  DISMISSED: { text: '반려', tone: 'neutral' },
};

export default async function StudioReportsPage() {
  const { creatorId } = await requireCreator();

  /**
   * `select` 를 명시한다.
   *
   * 스키마 주석이 "reporterUserId 는 크리에이터 화면에 절대 노출하지 않는다"고 못 박아 두었고
   * 화면 안내도 "신고자 정보는 표시되지 않습니다"라고 하는데, 예전에는 select 없이 조회해
   * 신고자 식별자가 렌더러 손에 들어와 있었다. 유출 한 발짝 전이었다.
   */
  const [reports, statusGroups] = await Promise.all([
    prisma.report.findMany({
      where: { creatorId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        category: true,
        content: true,
        status: true,
        donationId: true,
        createdAt: true,
        handledAt: true,
      },
    }),
    // 통계는 **전체 기준**으로 집계한다.
    // 예전에는 최근 100건 배열을 filter().length 로 세어, 신고가 100건을 넘는 순간
    // "접수 N건"이 실제보다 작게 표시됐다.
    prisma.report.groupBy({ by: ['status'], where: { creatorId }, _count: { _all: true } }),
  ]);

  const donationIds = reports.map((r) => r.donationId).filter((v): v is string => Boolean(v));
  const donations = donationIds.length
    ? await prisma.donation.findMany({
        where: { id: { in: donationIds }, creatorId },
        select: { id: true, transactionNo: true },
      })
    : [];
  const donationMap = new Map(donations.map((d) => [d.id, d.transactionNo]));

  const countOf = (s: ReportStatus) => statusGroups.find((g) => g.status === s)?._count._all ?? 0;
  const counts = {
    OPEN: countOf('OPEN'),
    REVIEWING: countOf('REVIEWING'),
    RESOLVED: countOf('RESOLVED'),
    DISMISSED: countOf('DISMISSED'),
  };
  const totalReports = statusGroups.reduce((a, g) => a + g._count._all, 0);

  return (
    <>
      <PageHeader
        title="신고 내역"
        description={`내 채널과 관련해 접수된 신고 ${formatNumber(totalReports)}건 중 최근 ${formatNumber(Math.min(totalReports, 100))}건을 표시합니다. 위 통계는 전체 기준입니다.`}
      />

      <div className="space-y-5">
        <Notice tone="neutral" title="신고는 통합 관리자가 처리합니다">
          크리에이터는 신고 내용을 확인만 할 수 있고 상태를 직접 변경할 수 없습니다. 조치가 필요한 후원자는
          금칙어·차단 메뉴에서 직접 차단할 수 있습니다. 신고자 정보는 개인정보 보호를 위해 표시되지 않습니다.
        </Notice>

        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="접수" value={`${formatNumber(counts.OPEN)}건`} tone="warning" />
          <StatTile label="검토중" value={`${formatNumber(counts.REVIEWING)}건`} tone="brand" />
          <StatTile label="처리완료" value={`${formatNumber(counts.RESOLVED)}건`} tone="success" />
          <StatTile label="반려" value={`${formatNumber(counts.DISMISSED)}건`} />
        </div>

        <section>
          <SectionTitle title="신고 목록" />
          {reports.length === 0 ? (
            <EmptyState title="접수된 신고가 없습니다" description="시청자 신고가 들어오면 여기에 표시됩니다." />
          ) : (
            <Table className="min-w-full">
              <thead>
                <tr>
                  <Th>접수일</Th>
                  <Th>분류</Th>
                  <Th>내용</Th>
                  <Th>관련 거래</Th>
                  <Th>상태</Th>
                  <Th>처리일</Th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const st = REPORT_STATUS[r.status];
                  const txNo = r.donationId ? donationMap.get(r.donationId) : null;
                  return (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(r.createdAt, false)}</Td>
                      <Td className="whitespace-nowrap">{r.category}</Td>
                      <Td className="max-w-[360px]">
                        <span className="line-clamp-3">{r.content}</span>
                      </Td>
                      <Td>
                        {r.donationId && txNo ? (
                          <Link
                            href={`/studio/donations/${r.donationId}`}
                            className="font-mono text-[12px] font-semibold text-brand-700 underline-offset-2 hover:underline"
                          >
                            {txNo}
                          </Link>
                        ) : (
                          <span className="text-ink-300">-</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={st.tone}>{st.text}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(r.handledAt, false)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
