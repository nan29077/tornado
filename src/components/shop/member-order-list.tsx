import Link from 'next/link';
import { Package } from '@/components/brand/icons';
import { Badge } from '@/components/ui';
import { prisma } from '@/server/db';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { CLAIM_STATUS_LABEL, CLAIM_TYPE_LABEL, ORDER_STATUS_LABEL } from '@/server/services/shop/orders';
import { OrderActions } from './order-actions';

const TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  PENDING_PAYMENT: 'neutral', PAID: 'brand', PREPARING: 'brand', SHIPPED: 'warning', DELIVERED: 'success', CONFIRMED: 'success', CANCELLED: 'danger', RETURNED: 'danger',
};

/** 회원 주문 목록 (마이페이지·샵 공용). 결제 실패·대기 주문은 숨긴다 */
export async function MemberOrderList({ userId, detailBase, orderId }: { userId: string; detailBase?: string; orderId?: string }) {
  const orders = await prisma.shopOrder.findMany({
    where: { userId, ...(orderId ? { id: orderId } : {}), status: { not: 'PENDING_PAYMENT' }, payment: { status: { not: 'FAILED' } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { items: true, claims: { orderBy: { createdAt: 'desc' } } },
  });
  const creatorIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.shopCreatorId)))];
  const shops = await prisma.creatorProfile.findMany({ where: { id: { in: creatorIds } }, select: { id: true, displayName: true } });
  const nameOf = new Map(shops.map((s) => [s.id, s.displayName]));
  if (orders.length === 0) {
    return (
      <div className="rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-12 text-center">
        <Package size={28} strokeWidth={1.5} className="mx-auto text-ink-300" />
        <p className="mt-2 text-[14px] font-bold text-ink-700">주문 내역이 없어요</p>
        <p className="mt-1 text-[12.5px] text-ink-400">크리에이터의 도네이도 샵에서 상품을 둘러보세요.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {orders.map((o) => {
        const open = o.claims.find((c) => c.status === 'REQUESTED');
        const last = o.claims[0];
        return (
          <li key={o.id} className="rounded-[1.25rem] border border-warm-300/70 bg-white p-4 shadow-card">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11.5px] text-ink-400">
                  {formatKst(o.createdAt, false)} · {o.orderNo}
                </p>
                <p className="text-[12px] font-bold text-ink-600">
                  {o.sellerType === 'DONAIDO' ? '도네이도 판매' : '크리에이터 직접 판매'} · {nameOf.get(o.items[0]?.shopCreatorId ?? '') ?? ''} 샵
                </p>
              </div>
              <Badge tone={TONE[o.status] ?? 'neutral'}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
            </div>
            <ul className="mt-2 space-y-1">
              {o.items.map((it) => (
                <li key={it.id} className="flex justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate text-ink-800">
                    {it.productName} <span className="text-ink-400">/ {it.variantName} × {it.quantity}</span>
                  </span>
                  <span className="shrink-0 font-bold">{formatWon(it.amount)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex justify-between border-t border-warm-200 pt-2 text-[13px]">
              <span className="text-ink-500">배송비 {formatWon(o.shippingFee)}</span>
              <span className="font-extrabold">합계 {formatWon(o.totalAmount)}</span>
            </p>
            {o.trackingNo ? (
              <p className="mt-1 text-[12px] text-ink-500">
                {o.courier} · 송장 {o.trackingNo}
              </p>
            ) : null}
            {last && last.status !== 'REQUESTED' ? (
              <p className="mt-1 text-[12px] text-ink-500">
                {CLAIM_TYPE_LABEL[last.type]} {CLAIM_STATUS_LABEL[last.status]}
                {last.rejectReason ? ` · ${last.rejectReason}` : ''}
                {last.refundAmount ? ` · 환불 ${formatWon(last.refundAmount)}` : ''}
              </p>
            ) : null}
            <div className="mt-3">
              <OrderActions orderId={o.id} status={o.status} hasOpenClaim={Boolean(open)} />
            </div>
            {detailBase ? (
              <Link href={`${detailBase}/${o.id}`} className="mt-2 inline-block text-[12px] font-bold text-brand-700">
                주문 상세
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
