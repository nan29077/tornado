import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import { ActionForm } from '@/components/admin/action-form';
import { reconcilePaymentAction } from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { paymentTxStatusLabel, donationStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { PaymentTxStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/** 상단 "결과 확인 필요" 목록에 한 번에 띄우는 최대 건수. */
const NEEDS_CHECK_LIMIT = 200;

const STATUSES: PaymentTxStatus[] = ['REQUESTED', 'APPROVED', 'FAILED', 'CANCELED', 'TIMEOUT', 'UNKNOWN'];

const txSelect = {
  id: true, orderNo: true, provider: true, providerTid: true, amount: true, status: true,
  resultCode: true, resultMessage: true, requestedAt: true, approvedAt: true, canceledAt: true,
  donation: {
    select: {
      id: true, transactionNo: true, status: true, paymentMode: true, channel: true,
      creator: { select: { id: true, displayName: true } },
      donor: { select: { id: true, phoneMasked: true } },
    },
  },
  attempts: {
    orderBy: { attemptNo: 'asc' as const },
    // 재시도가 많이 쌓인 거래는 시도 이력이 길어진다. 25행 x 시도 N개가 그대로 응답 크기가 되므로 상한을 둔다.
    take: 20,
    select: { id: true, attemptNo: true, operation: true, latencyMs: true, errorCode: true, errorMessage: true, createdAt: true },
  },
} satisfies Prisma.PaymentTransactionSelect;

type TxRow = Prisma.PaymentTransactionGetPayload<{ select: typeof txSelect }>;

function TxRows({ rows, reconcilable = false }: { rows: TxRow[]; reconcilable?: boolean }) {
  return (
    <tbody>
      {rows.map((t) => (
        <tr key={t.id}>
          <Td className="font-mono text-[12px]">
            {t.orderNo}
            <span className="mt-0.5 block text-[11px] text-ink-400">{t.provider}</span>
          </Td>
          <Td className="font-mono text-[12px]">{t.donation.transactionNo}</Td>
          <Td>
            <Link href={`/admin/creators/${t.donation.creator.id}`} className="font-semibold text-brand-700">
              {t.donation.creator.displayName}
            </Link>
            {t.donation.donor ? (
              <Link href={`/admin/donors/${t.donation.donor.id}`} className="mt-0.5 block text-[11px] text-ink-400">
                {t.donation.donor.phoneMasked}
              </Link>
            ) : null}
          </Td>
          <Td className="text-right tabular-nums">{formatWon(t.amount)}</Td>
          <Td>
            <Badge tone={paymentTxStatusLabel[t.status].tone}>{paymentTxStatusLabel[t.status].text}</Badge>
            <span className="mt-0.5 block text-[11px] text-ink-400">
              {donationStatusLabel[t.donation.status].text}
            </span>
            <span className="mt-0.5 block text-[11px] font-semibold text-ink-300">
              {t.donation.channel === 'WEB' ? '웹(PC) 후원' : '문자(MO) 후원'}
            </span>
          </Td>
          <Td className="max-w-[200px] break-words">
            {t.resultCode ?? '-'}
            {t.resultMessage ? <span className="block text-[11px] text-ink-400">{t.resultMessage}</span> : null}
          </Td>
          <Td className="whitespace-nowrap">
            {formatKst(t.requestedAt, false)}
            {t.approvedAt ? <span className="mt-0.5 block text-[11px] text-success-500">승인 {formatKst(t.approvedAt, false)}</span> : null}
            {t.canceledAt ? <span className="mt-0.5 block text-[11px] text-danger-500">취소 {formatKst(t.canceledAt, false)}</span> : null}
          </Td>
          <Td>
            <details>
              <summary className="cursor-pointer text-[12px] font-semibold text-brand-700">
                시도 {t.attempts.length}건
              </summary>
              <div className="mt-2 space-y-1.5">
                {t.attempts.length === 0 ? (
                  <p className="text-[12px] text-ink-400">기록된 시도가 없습니다.</p>
                ) : (
                  t.attempts.map((a) => (
                    <div key={a.id} className="rounded-lg border border-ink-100 bg-ink-50 px-2.5 py-1.5 text-[11px] leading-relaxed">
                      <span className="font-semibold text-ink-700">
                        #{a.attemptNo} {a.operation}
                      </span>
                      <span className="ml-2 text-ink-400">{formatKst(a.createdAt, false)}</span>
                      <span className="ml-2 tabular-nums text-ink-400">{a.latencyMs != null ? `${a.latencyMs}ms` : '-'}</span>
                      {a.errorCode ? (
                        <span className="block text-danger-500">
                          {a.errorCode} {a.errorMessage ?? ''}
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </details>
          </Td>
          {reconcilable ? (
            <Td>
              <ReconcileCell transactionId={t.id} orderNo={t.orderNo} />
            </Td>
          ) : null}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * 결과 미확인 결제의 수동 확정.
 * PG 관리자 화면에서 실제 승인 여부를 대사한 뒤에만 사용한다. 되돌릴 수 없다.
 */
function ReconcileCell({ transactionId, orderNo }: { transactionId: string; orderNo: string }) {
  return (
    <div className="flex min-w-[210px] flex-col gap-2">
      <ActionForm
        action={reconcilePaymentAction}
        submitLabel="결제 확정"
        variant="primary"
        compact
        confirm={`${orderNo} 건을 결제 승인으로 확정합니다.
PG 관리자에서 실제 출금을 확인하셨나요? 정산 원장에 분개가 추가되며 되돌릴 수 없습니다.`}
      >
        <input type="hidden" name="transactionId" value={transactionId} />
        <input type="hidden" name="decision" value="APPROVE" />
        <input
          name="memo"
          placeholder="대사 근거 (예: PG 조회 결과 승인)"
          className="h-8 w-full rounded-lg border border-ink-200 px-2 text-[12px] text-ink-900 focus:border-brand-400 focus:outline-none"
        />
      </ActionForm>
      <ActionForm
        action={reconcilePaymentAction}
        submitLabel="결제 취소"
        variant="danger"
        compact
        confirm={`${orderNo} 건을 결제 취소로 확정합니다.
출금이 없었음을 확인하셨나요? 후원은 실패로 확정되며 되돌릴 수 없습니다.`}
      >
        <input type="hidden" name="transactionId" value={transactionId} />
        <input type="hidden" name="decision" value="CANCEL" />
        <input
          name="memo"
          placeholder="대사 근거 (예: PG 조회 결과 미승인)"
          className="h-8 w-full rounded-lg border border-ink-200 px-2 text-[12px] text-ink-900 focus:border-brand-400 focus:outline-none"
        />
      </ActionForm>
    </div>
  );
}

const HEAD = (
  <thead>
    <tr>
      <Th>주문번호</Th>
      <Th>거래번호</Th>
      <Th>크리에이터 / 후원자</Th>
      <Th className="text-right">금액</Th>
      <Th>상태</Th>
      <Th>결과</Th>
      <Th>시각</Th>
      <Th>PG 시도 이력</Th>
    </tr>
  </thead>
);

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const status = STATUSES.includes(sp.status as PaymentTxStatus) ? (sp.status as PaymentTxStatus) : undefined;

  const where: Prisma.PaymentTransactionWhereInput = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { orderNo: { contains: q, mode: 'insensitive' as const } },
            { providerTid: { contains: q, mode: 'insensitive' as const } },
            { donation: { transactionNo: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [total, rows, needsCheck, grouped] = await Promise.all([
    prisma.paymentTransaction.count({ where }),
    prisma.paymentTransaction.findMany({
      where,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: txSelect,
    }),
    /**
     * 미확인 결제는 **전부** 처리 가능해야 한다.
     *
     * 예전에는 20건만 가져오면서 타일에는 전체 수를 표시했다. 57건이면 37건은
     * 수동 확정 UI 에 접근할 방법이 아예 없었다(하단 목록에는 확정 버튼이 없다).
     * 미확인 결제는 방치될수록 손실이 커지므로 넉넉한 상한으로 올리고, 그마저 넘으면
     * 화면에 남은 건수를 명시한다.
     */
    prisma.paymentTransaction.findMany({
      where: { status: { in: ['UNKNOWN', 'TIMEOUT'] } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: NEEDS_CHECK_LIMIT,
      select: txSelect,
    }),
    prisma.paymentTransaction.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/payments', { q, status: status ?? '' }, page, lastPage, total);
  const countOf = (s: PaymentTxStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const needsCheckTotal = countOf('UNKNOWN') + countOf('TIMEOUT');
  const approvedSum = grouped.find((g) => g.status === 'APPROVED')?._sum.amount ?? 0n;

  return (
    <>
      <PageHeader
        title="결제 관리"
        description="PG 결제 거래와 후원 거래를 함께 조회합니다. 결과를 확인할 수 없는 건은 상단에 별도로 모아 표시합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="승인" value={formatNumber(countOf('APPROVED'))} sub={formatWon(approvedSum)} tone="success" />
        <StatTile label="실패" value={formatNumber(countOf('FAILED'))} tone={countOf('FAILED') > 0 ? 'danger' : 'neutral'} />
        <StatTile label="취소" value={formatNumber(countOf('CANCELED'))} />
        <StatTile
          label="결과 확인 필요"
          value={formatNumber(countOf('UNKNOWN') + countOf('TIMEOUT'))}
          sub="UNKNOWN + TIMEOUT"
          tone={countOf('UNKNOWN') + countOf('TIMEOUT') > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {needsCheck.length > 0 ? (
        <section className="mb-6">
          <Notice
            tone="danger"
            title={
              needsCheckTotal > needsCheck.length
                ? `결과 확인이 필요한 결제 ${needsCheckTotal}건 (아래에 최근 ${needsCheck.length}건 표시)`
                : `결과 확인이 필요한 결제 ${needsCheckTotal}건`
            }
          >
            PG 응답이 타임아웃되었거나 결과를 알 수 없는 거래입니다. 실제 승인 여부를 PG 관리자에서 대사한 뒤 오른쪽
            [수동 확정]으로 결론을 반영해 주세요. 확인 전까지는 중복 결제를 유발할 수 있는 재시도를 하지 마세요.
            [결제 확정]은 정산 원장에 분개를 추가하고, [결제 취소]는 후원을 실패로 확정하며 한도 집계를 되돌립니다.
            어느 쪽도 되돌릴 수 없으므로 대사 근거를 반드시 남겨 주세요. 대사 시점에는 방송이 끝났을 수 있어
            오버레이·유튜브 송출은 다시 하지 않습니다.
          </Notice>
          <div className="mt-3">
            <Table className="min-w-[1400px]">
              <thead>
                <tr>
                  <Th>주문번호</Th>
                  <Th>거래번호</Th>
                  <Th>크리에이터 / 후원자</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>결과</Th>
                  <Th>시각</Th>
                  <Th>PG 시도 이력</Th>
                  <Th>수동 확정</Th>
                </tr>
              </thead>
              <TxRows rows={needsCheck} reconcilable />
            </Table>
          </div>
        </section>
      ) : null}

      <SectionTitle title="결제 거래 목록" />

      <FilterBar action="/admin/payments" resetHref="/admin/payments">
        <AdminField label="주문번호·거래번호·PG TID" className="w-64">
          <AdminInput name="q" defaultValue={q} placeholder="TOR2026... 또는 TRD-2026..." />
        </AdminField>
        <AdminField label="상태" className="w-40">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {paymentTxStatusLabel[s].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </FilterBar>

      {rows.length === 0 ? (
        <EmptyState title="조건에 맞는 결제 거래가 없습니다" />
      ) : (
        <>
          <Table className="min-w-[1200px]">
            {HEAD}
            <TxRows rows={rows} />
          </Table>
          <Pager
            basePath="/admin/payments"
            params={{ q, status: status ?? '' }}
            page={page}
            lastPage={lastPage}
            total={total}
          />
        </>
      )}
    </>
  );
}
