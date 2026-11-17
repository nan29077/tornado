import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Table, Td, Th, cx } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput } from '@/components/admin/controls';
import { adminClaimAction, resumeClaimAction } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';
import { CLAIM_STATUS_LABEL, CLAIM_TYPE_LABEL, ORDER_STATUS_LABEL } from '@/server/services/shop/orders';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 도네이도 샵 > 취소·반품 (승인 시 전액 환불 · 재고 복구) */
export default async function AdminShopClaimsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  await requireAdminPage('/admin/shop/claims');
  const sp = await searchParams;
  const showAll = sp.all === '1';
  const claims = await prisma.orderClaim.findMany({
    where: showAll ? {} : { OR: [{ status: 'REQUESTED' }, { status: 'APPROVED', refundAmount: { not: null } }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { order: { select: { orderNo: true, status: true, totalAmount: true, sellerType: true, items: { select: { productName: true }, take: 1 } } } },
  });

  return (
    <div>
      <PageHeader title="취소·반품" description="결제 완료 단계의 취소는 자동 승인·환불됩니다. 발송 이후 반품·취소 요청은 여기서 확인 후 승인(전액 환불)하거나 거절합니다. 크리에이터 직접 상품 요청도 최종 중재할 수 있습니다." />
      <div className="mb-3 flex gap-2">
        <Link href="/admin/shop/claims" className={cx('rounded-full px-3 py-1.5 text-[12.5px] font-bold', !showAll ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}>
          처리 대기
        </Link>
        <Link href="/admin/shop/claims?all=1" className={cx('rounded-full px-3 py-1.5 text-[12.5px] font-bold', showAll ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}>
          전체
        </Link>
      </div>
      {claims.length === 0 ? (
        <EmptyState title={showAll ? '접수된 요청이 없습니다' : '처리할 요청이 없습니다'} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>접수</Th>
              <Th>주문</Th>
              <Th>유형 · 사유</Th>
              <Th>상태</Th>
              <Th>처리</Th>
            </tr>
          </thead>
          <tbody>
            {claims.map((c) => (
              <tr key={c.id}>
                <Td className="whitespace-nowrap">{formatKst(c.createdAt, false)}</Td>
                <Td>
                  <div className="font-mono text-[12px] font-bold">{c.order.orderNo}</div>
                  <div className="text-[12px] text-ink-500">
                    {c.order.items[0]?.productName ?? ''} · {formatWon(c.order.totalAmount)} · {ORDER_STATUS_LABEL[c.order.status] ?? c.order.status}
                    {c.order.sellerType === 'CREATOR' ? ' · 크리에이터 직접' : ''}
                  </div>
                </Td>
                <Td>
                  <Badge>{CLAIM_TYPE_LABEL[c.type] ?? c.type}</Badge> <span className="text-[12.5px]">{c.reason}</span>
                </Td>
                <Td>
                  <Badge tone={c.status === 'REJECTED' ? 'danger' : c.status === 'REQUESTED' ? 'warning' : 'success'}>{CLAIM_STATUS_LABEL[c.status] ?? c.status}</Badge>
                  {c.refundAmount ? <div className="text-[11.5px] text-ink-500">환불 {formatWon(c.refundAmount)}</div> : null}
                  {c.rejectReason ? <div className="text-[11.5px] text-ink-500">거절 사유: {c.rejectReason}</div> : null}
                </Td>
                <Td className="min-w-[240px]">
                  {c.status === 'REQUESTED' ? (
                    <div className="space-y-1">
                      <ActionForm action={adminClaimAction} submitLabel="승인 · 전액 환불" compact confirm="승인하면 결제 금액 전액을 환불하고 재고를 되돌립니다.">
                        <input type="hidden" name="claimId" value={c.id} />
                        <input type="hidden" name="decision" value="APPROVE" />
                      </ActionForm>
                      <ActionForm action={adminClaimAction} submitLabel="거절" variant="secondary" compact>
                        <input type="hidden" name="claimId" value={c.id} />
                        <input type="hidden" name="decision" value="REJECT" />
                        <AdminInput name="reason" placeholder="거절 사유 (구매자에게 보입니다)" required maxLength={200} />
                      </ActionForm>
                    </div>
                  ) : c.status === 'APPROVED' && c.refundAmount != null ? (
                    <div className="space-y-1">
                      <p className="text-[12px] font-semibold text-danger-600">결제 취소는 끝났고 재고·결제 반영이 멈췄습니다.</p>
                      <ActionForm action={resumeClaimAction} submitLabel="재처리" compact>
                        <input type="hidden" name="claimId" value={c.id} />
                      </ActionForm>
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
