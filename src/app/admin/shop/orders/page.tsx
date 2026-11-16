import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Table, Td, Th, cx } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput } from '@/components/admin/controls';
import { adminOrderOp, runAutoConfirmAction } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';
import { ORDER_STATUS_LABEL } from '@/server/services/shop/orders';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: string; label: string; statuses?: string[] }> = [
  { key: 'todo', label: '처리할 주문', statuses: ['PAID', 'PREPARING'] },
  { key: 'shipping', label: '배송 중', statuses: ['SHIPPED', 'DELIVERED'] },
  { key: 'done', label: '구매 확정', statuses: ['CONFIRMED'] },
  { key: 'cancel', label: '취소·반품', statuses: ['CANCELLED', 'RETURNED'] },
  { key: 'all', label: '전체' },
];

/** 최고관리자 > 도네이도 샵 > 주문·배송 */
export default async function AdminShopOrdersPage({ searchParams }: { searchParams: Promise<{ f?: string; seller?: string; q?: string }> }) {
  await requireAdminPage('/admin/shop/orders');
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.f) ?? FILTERS[0];
  const seller = sp.seller === 'creator' ? 'CREATOR' : sp.seller === 'all' ? null : 'DONAIDO';
  const q = (sp.q ?? '').trim().slice(0, 40);
  const orders = await prisma.shopOrder.findMany({
    where: {
      status: filter.statuses ? { in: filter.statuses } : { not: 'PENDING_PAYMENT' },
      ...(seller ? { sellerType: seller } : {}),
      ...(q ? { orderNo: { contains: q.toUpperCase() } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      items: { select: { productName: true, variantName: true, quantity: true, shopCreatorId: true } },
      claims: { where: { status: 'REQUESTED' }, select: { id: true } },
    },
  });
  const creatorIds = [...new Set(orders.flatMap((o) => [o.sellerCreatorId, ...o.items.map((i) => i.shopCreatorId)]).filter((v): v is string => Boolean(v)))];
  const creators = await prisma.creatorProfile.findMany({ where: { id: { in: creatorIds } }, select: { id: true, displayName: true } });
  const nameOf = new Map(creators.map((c) => [c.id, c.displayName]));
  const qs = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ f: filter.key, seller: seller === 'CREATOR' ? 'creator' : seller ? 'donaido' : 'all', ...(q ? { q } : {}), ...patch });
    return `/admin/shop/orders?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader title="주문·배송" description="도네이도 판매(관리자 상품) 주문은 여기서 발주·발송합니다. 크리에이터 직접 상품은 크리에이터가 발송하며 여기서는 확인·중재만 합니다." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link key={f.key} href={qs({ f: f.key })} className={cx('rounded-full px-3 py-1.5 text-[12.5px] font-bold', f.key === filter.key ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}>
            {f.label}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-ink-200" />
        {[
          ['donaido', '도네이도 판매'],
          ['creator', '크리에이터 직접'],
          ['all', '판매자 전체'],
        ].map(([k, label]) => {
          const active = (k === 'donaido' && seller === 'DONAIDO') || (k === 'creator' && seller === 'CREATOR') || (k === 'all' && !seller);
          return (
            <Link key={k} href={qs({ seller: k })} className={cx('rounded-full px-3 py-1.5 text-[12.5px] font-bold', active ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700')}>
              {label}
            </Link>
          );
        })}
        <form className="ml-auto flex gap-2" action="/admin/shop/orders">
          <input type="hidden" name="f" value={filter.key} />
          <input type="hidden" name="seller" value={seller === 'CREATOR' ? 'creator' : seller ? 'donaido' : 'all'} />
          <AdminInput name="q" defaultValue={q} placeholder="주문번호" className="w-40" />
        </form>
      </div>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-[12.5px] text-ink-600">
          <span>배송 완료 후 기간이 지나면 자동 구매 확정됩니다. (설정에서 기간 변경) 지금 바로 돌릴 수도 있습니다.</span>
          <ActionForm action={runAutoConfirmAction} submitLabel="자동 구매 확정 실행" variant="secondary" compact />
        </div>
      </Card>
      {orders.length === 0 ? (
        <EmptyState title="해당하는 주문이 없습니다" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>주문</Th>
              <Th>상품</Th>
              <Th>판매자 / 샵</Th>
              <Th>금액</Th>
              <Th>받는 분</Th>
              <Th>상태</Th>
              <Th>처리</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const first = o.items[0];
              const shopName = first ? nameOf.get(first.shopCreatorId) : undefined;
              const donaido = o.sellerType === 'DONAIDO';
              return (
                <tr key={o.id}>
                  <Td className="whitespace-nowrap">
                    <div className="font-mono text-[12px] font-bold">{o.orderNo}</div>
                    <div className="text-[11.5px] text-ink-400">{formatKst(o.paidAt ?? o.createdAt, false)}</div>
                  </Td>
                  <Td>
                    {first ? `${first.productName}${first.variantName ? ` · ${first.variantName}` : ''} ×${first.quantity}` : '-'}
                    {o.items.length > 1 ? <span className="text-ink-400"> 외 {o.items.length - 1}건</span> : null}
                  </Td>
                  <Td className="text-[12px]">
                    {donaido ? <Badge tone="brand">도네이도</Badge> : <Badge>크리에이터 {nameOf.get(o.sellerCreatorId ?? '') ?? ''}</Badge>}
                    <div className="mt-0.5 text-ink-400">샵: {shopName ?? '-'}</div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatWon(o.totalAmount)}
                    {o.refundedAmount > 0n ? <div className="text-[11.5px] text-danger-600">환불 {formatWon(o.refundedAmount)}</div> : null}
                  </Td>
                  <Td className="text-[12px]">
                    {o.recipientMasked} · {o.phoneMasked}
                    {o.trackingNo ? (
                      <div className="text-ink-400">
                        {o.courier} {o.trackingNo}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Badge tone={o.status === 'CANCELLED' || o.status === 'RETURNED' ? 'danger' : o.status === 'CONFIRMED' ? 'success' : 'neutral'}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
                    {o.claims.length > 0 ? (
                      <Link href="/admin/shop/claims" className="mt-1 block text-[11.5px] font-bold text-danger-600 underline">
                        취소·반품 접수
                      </Link>
                    ) : null}
                  </Td>
                  <Td className="min-w-[220px]">
                    {donaido && o.status === 'PAID' ? (
                      <ActionForm action={adminOrderOp} submitLabel="상품 준비중" variant="secondary" compact>
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="op" value="preparing" />
                      </ActionForm>
                    ) : null}
                    {donaido && (o.status === 'PAID' || o.status === 'PREPARING') ? (
                      <ActionForm action={adminOrderOp} submitLabel="발송 처리" compact className="mt-1">
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="op" value="ship" />
                        <div className="flex gap-1">
                          <AdminInput name="courier" placeholder="택배사" className="w-20" required />
                          <AdminInput name="trackingNo" placeholder="송장번호" className="w-28" required />
                        </div>
                      </ActionForm>
                    ) : null}
                    {o.status === 'SHIPPED' ? (
                      <ActionForm action={adminOrderOp} submitLabel="배송 완료로" variant="secondary" compact>
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="op" value="delivered" />
                      </ActionForm>
                    ) : null}
                    {o.status === 'DELIVERED' ? (
                      <ActionForm action={adminOrderOp} submitLabel="구매 확정" variant="secondary" compact confirm="구매 확정하면 크리에이터 수익이 정산 원장에 적립됩니다.">
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="op" value="confirm" />
                      </ActionForm>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
