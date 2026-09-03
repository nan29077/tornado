import Link from 'next/link';
import { EmptyState, LinkButton, Badge, Card } from '@/components/ui';
import { RefundRequestForm } from '@/components/my/refund-request-form';
import { requireDonorContext, NO_DONOR_TITLE, NO_DONOR_DESC } from '@/components/my/donor';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { donationStatusLabel, refundStatusLabel } from '@/lib/labels';
import type { DonationStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

/**
 * **표시용** 누적 집계 상태.
 *
 * 환불 요청 가능 여부(REFUNDABLE)와 같은 집합을 누적 금액에도 쓰면, 환불을 요청만 해도
 * (승인 전) 누적 금액이 줄어 후원자가 "돈이 사라졌다"고 오인한다. 환불이 확정될 때까지는
 * 누적에 남긴다.
 */
const COUNTED_FOR_TOTAL: DonationStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
  'REFUND_REQUESTED',
];

/** 결제가 완료되어 환불 요청이 가능한 상태 */
const REFUNDABLE: DonationStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * 후원 내역.
 * 카드에는 크리에이터 / 후원 메시지 / 금액만 두고,
 * 거래번호·송출 상태·환불처럼 가끔 필요한 정보는 접어둔다.
 */
export default async function MyDonationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { donorId } = await requireDonorContext('/my');
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  if (!donorId) {
    return (
      <>
        <EmptyState title={NO_DONOR_TITLE} description={NO_DONOR_DESC} />
        <div className="mt-4">
          <LinkButton href="/my/account#phone-link" size="md" className="w-full">
            휴대폰 번호 연결하기
          </LinkButton>
        </div>
      </>
    );
  }

  const [total, donations, paidAgg] = await Promise.all([
    prisma.donation.count({ where: { donorId } }),
    prisma.donation.findMany({
      where: { donorId },
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        transactionNo: true,
        amount: true,
        message: true,
        status: true,
        receivedAt: true,
        paidAt: true,
        creator: { select: { displayName: true, code: true } },
        refunds: {
          orderBy: { requestedAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    }),
    prisma.donation.aggregate({
      where: { donorId, status: { in: COUNTED_FOR_TOTAL } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* 요약 한 줄 */}
      <div className="flex items-end justify-between rounded-2xl bg-ink-900 px-5 py-4 text-white">
        <div>
          <p className="text-[11.5px] font-semibold text-white/60">누적 후원</p>
          <p className="mt-1 text-[24px] font-black tracking-[-0.035em] tabular-nums">
            {formatWon(paidAgg._sum.amount ?? 0n)}
          </p>
        </div>
        <p className="text-[12.5px] font-semibold text-white/70 tabular-nums">
          결제 완료 {formatNumber(paidAgg._count._all)}건
        </p>
      </div>

      {donations.length === 0 ? (
        <EmptyState title="후원 내역이 없습니다" description="크리에이터의 후원 번호로 문자를 보내면 이곳에 표시됩니다." />
      ) : (
        <ul className="space-y-2">
          {donations.map((d) => {
            const status = donationStatusLabel[d.status];
            const refund = d.refunds[0] ?? null;
            const refundOpen = refund ? ['REQUESTED', 'APPROVED', 'DONE'].includes(refund.status) : false;
            const canRefund = REFUNDABLE.includes(d.status) && !refundOpen;

            return (
              <li key={d.id}>
                <Card className="p-4 sm:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={`/c/${d.creator.code}`}
                          className="text-[14.5px] font-bold text-ink-900 hover:text-brand-700"
                        >
                          {d.creator.displayName}
                        </Link>
                        <Badge tone={status.tone}>{status.text}</Badge>
                        {refund && d.status !== 'REFUND_REQUESTED' && d.status !== 'REFUNDED' ? (
                          <Badge tone={refundStatusLabel[refund.status].tone}>
                            환불 {refundStatusLabel[refund.status].text}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-2 break-words text-[13.5px] leading-relaxed text-ink-700">
                        {d.message || '(내용 없음)'}
                      </p>
                      <p className="mt-1.5 text-[11.5px] tabular-nums text-ink-400">
                        {formatKst(d.receivedAt, false)}
                      </p>
                    </div>
                    <p className="shrink-0 text-[17px] font-extrabold tracking-tight tabular-nums text-ink-900">
                      {formatWon(d.amount)}
                    </p>
                  </div>

                  {/* 자세한 정보는 접어둔다 */}
                  <details className="group mt-3 border-t border-ink-100 pt-2.5">
                    <summary className="cursor-pointer list-none text-[12px] font-semibold text-ink-400 transition-colors hover:text-ink-700">
                      자세히 보기
                    </summary>
                    <dl className="mt-2.5 space-y-1.5 text-[12px]">
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-400">거래번호</dt>
                        <dd className="break-all text-right font-mono font-semibold text-ink-900">{d.transactionNo}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-ink-400">결제 일시</dt>
                        <dd className="tabular-nums text-ink-700">{d.paidAt ? formatKst(d.paidAt, false) : '-'}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 space-y-2">
                      <RefundRequestForm
                        donationId={d.id}
                        disabled={!canRefund}
                        disabledReason={
                          refundOpen
                            ? `환불 ${refundStatusLabel[refund!.status].text} 상태`
                            : '결제 완료 건만 환불 요청 가능'
                        }
                      />
                      <p className="text-right">
                        <Link
                          href={`/support?tx=${encodeURIComponent(d.transactionNo)}`}
                          className="text-[12px] font-semibold text-ink-400 hover:text-brand-700"
                        >
                          이 건 문의하기
                        </Link>
                      </p>
                    </div>
                  </details>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {lastPage > 1 ? (
        <nav className="flex items-center justify-between gap-3">
          {page > 1 ? (
            <LinkButton href={`/my?page=${page - 1}`} variant="secondary" size="sm">
              이전
            </LinkButton>
          ) : (
            <span />
          )}
          <span className="text-[12.5px] font-semibold tabular-nums text-ink-500">
            {page} / {lastPage}
          </span>
          {page < lastPage ? (
            <LinkButton href={`/my?page=${page + 1}`} variant="secondary" size="sm">
              다음
            </LinkButton>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
