import * as React from 'react';
import Link from 'next/link';
import { Activity, CircleAlert, Flag, Wallet } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, SectionTitle, StatTile, Table, Th, Td, Badge, EmptyState, LinkButton } from '@/components/ui';
import { SafetyBanner } from '@/components/admin/safety-banner';
import { BannerStrip } from '@/components/public/banner-strip';
import { PAID_DONATION_STATUSES } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstDateKey, kstStartOfDay, kstStartOfMonth } from '@/lib/datetime';
import { getSessionUser } from '@/server/auth';
import { donationStatusLabel } from '@/lib/labels';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin');

  const todayStart = kstStartOfDay();
  const monthStart = kstStartOfMonth();
  const session = await getSessionUser().catch(() => null);
  const canSeeInquiries = session?.adminPermission === 'SUPER_ADMIN';

  const [
    todayPaid,
    monthPaid,
    todayReceived,
    txTotal,
    txApproved,
    unregistered,
    limitBlocked,
    youtubeFailed,
    settlementPending,
    openReports,
    openRisks,
    openInquiries,
    recentDonations,
  ] = await Promise.all([
    prisma.donation.aggregate({
      where: { status: { in: PAID_DONATION_STATUSES }, paidAt: { gte: todayStart } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.donation.aggregate({
      where: { status: { in: PAID_DONATION_STATUSES }, paidAt: { gte: monthStart } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.donation.count({ where: { receivedAt: { gte: todayStart } } }),
    prisma.paymentTransaction.count({ where: { requestedAt: { gte: todayStart } } }),
    prisma.paymentTransaction.count({ where: { requestedAt: { gte: todayStart }, status: 'APPROVED' } }),
    prisma.moInboundMessage.count({ where: { receivedAt: { gte: todayStart }, result: 'UNREGISTERED_DONOR' } }),
    prisma.donation.count({ where: { receivedAt: { gte: todayStart }, status: 'LIMIT_BLOCKED' } }),
    prisma.youTubeChatDelivery.count({ where: { createdAt: { gte: todayStart }, status: 'FAILED' } }),
    prisma.settlementRequest.aggregate({
      where: { status: { in: ['REQUESTED', 'REVIEWING'] } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.report.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
    prisma.riskDetection.count({ where: { resolved: false } }),
    prisma.supportInquiry.count({ where: { status: 'OPEN' } }),
    prisma.donation.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        transactionNo: true,
        amount: true,
        status: true,
        receivedAt: true,
        creator: { select: { displayName: true } },
        donor: { select: { phoneMasked: true } },
      },
    }),
  ]);

  const successRate = txTotal === 0 ? null : Math.round((txApproved / txTotal) * 1000) / 10;

  // 처리 대기 건이 하나라도 있으면 '확인이 필요한 건' 섹션을 지표보다 위에 배치한다.
  // 운영자가 접속해서 가장 먼저 할 일이 화면 순서와 일치하도록.
  const pendingTotal =
    unregistered + limitBlocked + youtubeFailed + openRisks + settlementPending._count._all + openReports + openInquiries;

  /** 오늘 기준 타일에서 이동할 때 같은 날짜 조건을 그대로 넘긴다. */
  const todayParam = `from=${kstDateKey(todayStart)}&to=${kstDateKey(todayStart)}`;

  const needsAttention = (
    <section>
      <SectionTitle title="확인이 필요한 건" description="숫자를 누르면 같은 조건의 관리 화면으로 이동합니다." />
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Link href={`/admin/mo-messages?result=UNREGISTERED_DONOR&${todayParam}`}>
          <StatTile
            label="오늘 미등록 응답"
            value={formatNumber(unregistered)}
            sub="계좌 미등록 후원자에게 안내 발송"
            tone={unregistered > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        {/* 값은 donation.status='LIMIT_BLOCKED' 기준이므로 수신 문자 화면이 아니라 한도·이상거래 화면으로 보낸다. */}
        <Link href="/admin/risk">
          <StatTile
            label="오늘 한도 차단"
            value={formatNumber(limitBlocked)}
            sub="한도·속도 제한에 걸린 후원"
            tone={limitBlocked > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        <Link href="/admin/youtube">
          <StatTile
            label="오늘 유튜브 전송 실패"
            value={formatNumber(youtubeFailed)}
            sub="결제 결과와는 무관"
            tone={youtubeFailed > 0 ? 'danger' : 'neutral'}
          />
        </Link>
        <Link href="/admin/risk?resolved=NO">
          <StatTile
            label="미해결 이상거래"
            value={formatNumber(openRisks)}
            sub="해결 처리 필요"
            tone={openRisks > 0 ? 'danger' : 'neutral'}
          />
        </Link>
        <Link href="/admin/settlements">
          <StatTile
            label="정산 요청 대기"
            value={formatNumber(settlementPending._count._all)}
            sub={formatWon(settlementPending._sum.amount ?? 0n)}
            tone={settlementPending._count._all > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        <Link href="/admin/moderation">
          <StatTile
            label="미해결 신고"
            value={formatNumber(openReports)}
            sub="접수·검토중 합계"
            tone={openReports > 0 ? 'warning' : 'neutral'}
          />
        </Link>
        {/* 문의 관리는 최고관리자 전용 화면이다. 다른 등급에게 타일만 보여 주면 눌렀을 때 권한 거부가 뜬다. */}
        {canSeeInquiries ? (
          <Link href="/admin/inquiries?status=OPEN">
            <StatTile
              label="답변 대기 문의"
              value={formatNumber(openInquiries)}
              sub="1:1 문의 답변 대기"
              tone={openInquiries > 0 ? 'warning' : 'neutral'}
            />
          </Link>
        ) : null}
        <Link href="/admin/refunds">
          <StatTile label="환불 관리" value="바로가기" sub="요청 승인·거절 처리" />
        </Link>
        <Link href="/admin/creators">
          <StatTile label="크리에이터 심사" value="바로가기" sub="대기 건 확인" />
        </Link>
      </div>
    </section>
  );

  const paymentSummary = (
    <section>
      <SectionTitle title="후원·결제" description="금액은 결제가 승인된 건만 집계합니다. 환불 완료 건은 제외됩니다." />
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="오늘 결제 완료"
          value={formatNumber(todayPaid._count._all)}
          sub={formatWon(todayPaid._sum.amount ?? 0n)}
          tone="brand"
        />
        <StatTile
          label="이번 달 결제 완료"
          value={formatNumber(monthPaid._count._all)}
          sub={formatWon(monthPaid._sum.amount ?? 0n)}
        />
        <StatTile label="오늘 문자 접수" value={formatNumber(todayReceived)} sub="결제 이전 단계 포함" />
        <StatTile
          label="오늘 결제 성공률"
          value={successRate === null ? '-' : `${successRate}%`}
          sub={`요청 ${formatNumber(txTotal)}건 중 승인 ${formatNumber(txApproved)}건`}
          tone={successRate !== null && successRate < 90 ? 'warning' : 'success'}
        />
      </div>
    </section>
  );

  return (
    <>
      <PageHeader
        title="운영 대시보드"
        description="오늘(KST) 기준 후원·결제·방송 지표와 즉시 처리해야 할 대기 건을 함께 보여줍니다."
      />

      <div className="space-y-5">
        <SafetyBanner />
        <BannerStrip position="CONSOLE_TOP" />

        {/*
          "확인이 필요한 건" 과 "후원·결제" 두 섹션은 대기 건 유무에 따라 **순서만** 바뀐다.
          예전에는 두 벌을 통째로 복제해 두어 (1) 약 95줄이 중복이었고 (2) 복제본이 서로
          어긋나 같은 타일이 서로 다른 화면으로 이동했다. 한 벌만 두고 순서를 바꾼다.
        */}
        {(pendingTotal > 0 ? [needsAttention, paymentSummary] : [paymentSummary, needsAttention]).map((node, i) => (
          <React.Fragment key={i}>{node}</React.Fragment>
        ))}

        <section>
          <SectionTitle title="최근 후원 10건" />
          {recentDonations.length === 0 ? (
            <EmptyState
              title="아직 후원 내역이 없습니다"
              description="MO 시뮬레이터로 문자 수신부터 결제까지 전체 흐름을 검증할 수 있습니다."
              action={
                <LinkButton href="/admin/simulator" variant="secondary" size="sm">
                  MO 시뮬레이터 열기
                </LinkButton>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>거래번호</Th>
                  <Th>크리에이터</Th>
                  <Th>후원자</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>수신 시각</Th>
                </tr>
              </thead>
              <tbody>
                {recentDonations.map((d) => {
                  const label = donationStatusLabel[d.status];
                  return (
                    <tr key={d.id}>
                      <Td className="font-mono text-[12px]">{d.transactionNo}</Td>
                      <Td>{d.creator.displayName}</Td>
                      <Td>{d.donor?.phoneMasked ?? '-'}</Td>
                      <Td className="text-right tabular-nums">{formatWon(d.amount)}</Td>
                      <Td>
                        <Badge tone={label.tone}>{label.text}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap">{formatKst(d.receivedAt, false)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Activity size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>지표 집계 기준</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              모든 날짜 경계는 KST(UTC+9) 기준입니다. 결제 금액은 승인 시각(paidAt) 기준이며, 문자 접수 건수는 수신
              시각(receivedAt) 기준입니다.
            </p>
          </Card>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <CircleAlert size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>결제와 방송은 분리됩니다</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              유튜브 전송 실패는 결제 결과를 바꾸지 않습니다. 전송 실패 건은 별도로 재처리 대상입니다.
            </p>
          </Card>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Wallet size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>정산 원장은 수정 불가</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              정산 원장은 append-only 이며 정정은 반대 분개로만 처리합니다. 환불 승인 시 자동으로 반대 분개가 쌓입니다.
            </p>
          </Card>
        </div>

        <Card>
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Flag size={16} strokeWidth={1.7} />
            </span>
            <CardTitle>바로가기</CardTitle>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { href: '/admin/system', label: '시스템 상태' },
              { href: '/admin/mo-messages', label: '수신 문자' },
              { href: '/admin/payments', label: '결제 관리' },
              { href: '/admin/settlements', label: '정산 관리' },
              { href: '/admin/policies', label: '한도 정책' },
              { href: '/admin/audit', label: '감사로그' },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700 hover:bg-ink-50"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
