import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, AdminTextarea, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import {
  approveRefundAction,
  rejectRefundAction,
  createAdminRefund,
  retryRefundRecoveryAction,
} from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { refundStatusLabel, donationStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { RefundStatus } from '@/generated/prisma/enums';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

const STATUSES: RefundStatus[] = ['REQUESTED', 'APPROVED', 'PENDING_RECOVERY', 'REJECTED', 'DONE', 'FAILED'];

export default async function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/refunds');

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const status = STATUSES.includes(sp.status as RefundStatus) ? (sp.status as RefundStatus) : undefined;

  const where: Prisma.RefundWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { donation: { transactionNo: { contains: q, mode: 'insensitive' as const } } } : {}),
  };

  const [total, refunds, grouped, waiting] = await Promise.all([
    prisma.refund.count({ where }),
    prisma.refund.findMany({
      where,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, amount: true, reason: true, status: true, requestedAt: true, processedAt: true,
        resultCode: true, resultMessage: true,
        donation: {
          select: {
            id: true, transactionNo: true, status: true, paidAt: true, settledAt: true,
            creator: { select: { id: true, displayName: true } },
            donor: { select: { id: true, phoneMasked: true } },
          },
        },
      },
    }),
    prisma.refund.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
    prisma.refund.count({ where: { status: 'REQUESTED' } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/refunds', { q, status: status ?? '' }, page, lastPage, total);
  const countOf = (s: RefundStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const doneSum = grouped.find((g) => g.status === 'DONE')?._sum.amount ?? 0n;

  return (
    <>
      <PageHeader
        title="환불 관리"
        description="환불이 승인되면 결제 취소와 함께 정산 원장에 반대 분개가 추가됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <StatTile label="처리 대기" value={formatNumber(waiting)} tone={waiting > 0 ? 'warning' : 'neutral'} />
        <StatTile
          label="재시도 대기"
          value={formatNumber(countOf('PENDING_RECOVERY'))}
          tone={countOf('PENDING_RECOVERY') > 0 ? 'danger' : 'neutral'}
        />
        <StatTile label="환불 완료" value={formatNumber(countOf('DONE'))} sub={formatWon(doneSum)} tone="success" />
        <StatTile label="거절" value={formatNumber(countOf('REJECTED'))} />
        <StatTile label="실패" value={formatNumber(countOf('FAILED'))} tone={countOf('FAILED') > 0 ? 'danger' : 'neutral'} />
      </div>

      <Notice tone="warning" title="환불이 정산에 미치는 영향">
        환불 승인 시 정산 원장에 환불(-) 분개와 플랫폼 수수료 환입(+) 분개가 추가됩니다. 정산 원장은 append-only 이므로
        기존 분개를 수정하지 않습니다. 이미 지급이 끝난 건을 환불하면 해당 크리에이터의 잔액이 마이너스로 남아 다음
        정산에서 자동 차감됩니다.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>관리자 직접 환불</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            후원자 요청 없이 운영 판단으로 환불합니다. 요청 생성과 승인이 한 번에 진행되므로 신중히 사용하세요.
          </p>
          <ActionForm
            action={createAdminRefund}
            submitLabel="즉시 환불 처리"
            variant="danger"
            confirm="입력한 거래를 즉시 환불합니다. 되돌릴 수 없습니다."
          >
            <AdminField label="거래번호" hint="예: TRD-20260819-XXXXXXXX">
              <AdminInput name="transactionNo" placeholder="TRD-20260819-XXXXXXXX" required />
            </AdminField>
            <AdminField label="환불 사유">
              <AdminTextarea name="reason" rows={3} placeholder="예: 오발송 민원 처리" required />
            </AdminField>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <FilterBar action="/admin/refunds" resetHref="/admin/refunds">
            <AdminField label="거래번호 검색" className="w-56">
              <AdminInput name="q" defaultValue={q} placeholder="TRD-20260819-XXXXXXXX" />
            </AdminField>
            <AdminField label="상태" className="w-40">
              <AdminSelect name="status" defaultValue={status ?? ''}>
                <option value="">전체</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {refundStatusLabel[s].text}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
          </FilterBar>

          <Notice tone="neutral" title="처리 순서">
            요청 상태의 건만 승인 또는 거절할 수 있습니다. 거절하면 후원 거래는 정산 대기 상태로 되돌아갑니다.
          </Notice>
        </div>
      </div>

      <div className="mt-5">
        <SectionTitle title="환불 요청 목록" />
        {refunds.length === 0 ? (
          <EmptyState title="조건에 맞는 환불 요청이 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>요청 시각</Th>
                  <Th>거래번호</Th>
                  <Th>크리에이터 / 후원자</Th>
                  <Th className="text-right">환불 금액</Th>
                  <Th>사유</Th>
                  <Th>상태</Th>
                  <Th>정산 상태</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">
                      {formatKst(r.requestedAt, false)}
                      {r.processedAt ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">처리 {formatKst(r.processedAt, false)}</span>
                      ) : null}
                    </Td>
                    <Td className="font-mono text-[12px]">{r.donation.transactionNo}</Td>
                    <Td>
                      <Link href={`/admin/creators/${r.donation.creator.id}`} className="font-semibold text-brand-700">
                        {r.donation.creator.displayName}
                      </Link>
                      {r.donation.donor ? (
                        <Link href={`/admin/donors/${r.donation.donor.id}`} className="mt-0.5 block text-[11px] text-ink-400">
                          {r.donation.donor.phoneMasked}
                        </Link>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                    <Td className="max-w-[200px] break-words">{r.reason ?? '-'}</Td>
                    <Td>
                      <Badge tone={refundStatusLabel[r.status].tone}>{refundStatusLabel[r.status].text}</Badge>
                      {r.resultMessage ? (
                        <span className="mt-0.5 block max-w-[160px] text-[11px] break-words text-ink-400">
                          {r.resultCode ? `${r.resultCode} ` : ''}
                          {r.resultMessage}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={donationStatusLabel[r.donation.status].tone}>
                        {donationStatusLabel[r.donation.status].text}
                      </Badge>
                      {r.donation.settledAt ? (
                        <span className="mt-0.5 block text-[11px] text-warning-500">
                          지급 완료분 · 다음 정산 차감
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {r.status === 'REQUESTED' ? (
                        <div className="flex flex-col gap-1.5">
                          <ActionButton
                            action={approveRefundAction}
                            values={{ refundId: r.id }}
                            label="승인"
                            variant="primary"
                            confirm="환불을 승인하고 결제를 취소합니다. 되돌릴 수 없습니다."
                          />
                          <details>
                            <summary className="cursor-pointer text-[12px] text-ink-500">거절</summary>
                            <div className="mt-1.5 w-48">
                              <ActionForm action={rejectRefundAction} submitLabel="거절 처리" variant="secondary" compact>
                                <input type="hidden" name="refundId" value={r.id} />
                                <AdminField label="거절 사유">
                                  <AdminInput name="memo" placeholder="예: 정상 후원 확인" />
                                </AdminField>
                              </ActionForm>
                            </div>
                          </details>
                        </div>
                      ) : r.status === 'PENDING_RECOVERY' ? (
                        <ActionButton
                          action={retryRefundRecoveryAction}
                          values={{ refundId: r.id }}
                          label="재시도"
                          variant="primary"
                          confirm="PG 취소 결과를 다시 확인하고 재시도합니다."
                        />
                      ) : (
                        <span className="text-[12px] text-ink-300">처리 완료</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/refunds"
              params={{ q, status: status ?? '' }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>
    </>
  );
}
