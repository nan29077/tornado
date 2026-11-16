import Link from 'next/link';
import { Badge, EmptyState, Input, SectionTitle, StatTile, Table, Td, Th, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { creatorClaimAction, creatorOrderOpAction, revealShippingAddressAction } from '@/app/actions/studio-shop';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { CLAIM_TYPE_LABEL, ORDER_STATUS_LABEL } from '@/server/services/shop/orders';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const REFERRAL_LABEL: Record<string, string> = { PENDING: '확정 대기', CONFIRMED: '적립 완료', CANCELLED: '취소' };

/** 크리에이터 관리자 > 도네이도 샵 > 주문·수익 */
export default async function StudioShopOrdersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;
  const tab = sp.tab === 'referral' ? 'referral' : 'direct';
  const [refAgg, directAgg] = await Promise.all([
    prisma.referralCommission.groupBy({ by: ['status'], where: { creatorId }, _sum: { amount: true } }),
    prisma.shopOrder.groupBy({ by: ['status'], where: { sellerType: 'CREATOR', sellerCreatorId: creatorId, status: { not: 'PENDING_PAYMENT' } }, _sum: { totalAmount: true }, _count: true }),
  ]);
  const refSum = (s: string) => refAgg.find((r) => r.status === s)?._sum.amount ?? 0n;
  const directConfirmed = directAgg.find((r) => r.status === 'CONFIRMED')?._sum.totalAmount ?? 0n;
  const directOpen = directAgg.filter((r) => ['PAID', 'PREPARING'].includes(r.status)).reduce((n, r) => n + r._count, 0);

  let body: React.ReactNode;
  if (tab === 'direct') {
    const orders = await prisma.shopOrder.findMany({
      where: { sellerType: 'CREATOR', sellerCreatorId: creatorId, status: { not: 'PENDING_PAYMENT' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { items: { select: { productName: true, variantName: true, quantity: true } }, claims: { where: { status: 'REQUESTED' } } },
    });
    body =
      orders.length === 0 ? (
        <EmptyState title="직접 상품 주문이 없습니다" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>주문</Th>
              <Th>상품</Th>
              <Th>금액</Th>
              <Th>받는 분</Th>
              <Th>상태</Th>
              <Th>처리</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td className="whitespace-nowrap">
                  <div className="font-mono text-[12px] font-bold">{o.orderNo}</div>
                  <div className="text-[11.5px] text-ink-400">{formatKst(o.paidAt ?? o.createdAt, false)}</div>
                </Td>
                <Td>
                  {o.items.map((i, idx) => (
                    <div key={idx} className="text-[12.5px]">
                      {i.productName}
                      {i.variantName ? ` · ${i.variantName}` : ''} ×{i.quantity}
                    </div>
                  ))}
                  {o.memo ? <div className="text-[11.5px] text-ink-400">메모: {o.memo}</div> : null}
                </Td>
                <Td className="whitespace-nowrap">{formatWon(o.totalAmount)}</Td>
                <Td className="text-[12px]">
                  {o.recipientMasked} · {o.phoneMasked}
                  <div className="text-ink-400">{o.addressMasked}</div>
                  {o.trackingNo ? (
                    <div className="text-ink-400">
                      {o.courier} {o.trackingNo}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={o.status === 'CANCELLED' || o.status === 'RETURNED' ? 'danger' : o.status === 'CONFIRMED' ? 'success' : 'neutral'}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
                </Td>
                <Td className="min-w-[230px] space-y-1">
                  {o.claims.map((c) => (
                    <div key={c.id} className="rounded-lg bg-danger-50 p-2 text-[12px]">
                      <p className="font-bold text-danger-600">
                        {CLAIM_TYPE_LABEL[c.type]} 요청 · {c.reason}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <ActionForm action={creatorClaimAction} submitLabel="승인 · 전액 환불" size="sm" confirmMessage="승인하면 결제 금액 전액이 구매자에게 환불됩니다." confirmVariant="danger">
                          <input type="hidden" name="claimId" value={c.id} />
                          <input type="hidden" name="decision" value="APPROVE" />
                        </ActionForm>
                      </div>
                      <ActionForm action={creatorClaimAction} submitLabel="거절" variant="secondary" size="sm" className="mt-1">
                        <input type="hidden" name="claimId" value={c.id} />
                        <input type="hidden" name="decision" value="REJECT" />
                        <Input name="reason" placeholder="거절 사유 (구매자에게 보입니다)" required maxLength={200} />
                      </ActionForm>
                    </div>
                  ))}
                  {['PAID', 'PREPARING', 'SHIPPED'].includes(o.status) ? (
                    <ActionForm action={revealShippingAddressAction} submitLabel="배송지 전체 보기" variant="ghost" size="sm">
                      <input type="hidden" name="orderId" value={o.id} />
                    </ActionForm>
                  ) : null}
                  {o.status === 'PAID' ? (
                    <ActionForm action={creatorOrderOpAction} submitLabel="상품 준비중" variant="secondary" size="sm">
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="op" value="preparing" />
                    </ActionForm>
                  ) : null}
                  {(o.status === 'PAID' || o.status === 'PREPARING') && o.claims.length === 0 ? (
                    <ActionForm action={creatorOrderOpAction} submitLabel="발송 처리" size="sm">
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="op" value="ship" />
                      <div className="flex gap-1">
                        <Input name="courier" placeholder="택배사" required className="w-24" />
                        <Input name="trackingNo" placeholder="송장번호" required className="w-32" />
                      </div>
                    </ActionForm>
                  ) : null}
                  {o.status === 'SHIPPED' ? (
                    <ActionForm action={creatorOrderOpAction} submitLabel="배송 완료로" variant="secondary" size="sm">
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="op" value="delivered" />
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      );
  } else {
    const items = await prisma.shopOrderItem.findMany({
      where: { shopCreatorId: creatorId, order: { sellerType: 'DONAIDO', status: { not: 'PENDING_PAYMENT' } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { order: { select: { orderNo: true, status: true } }, referral: { select: { amount: true, status: true } } },
    });
    body =
      items.length === 0 ? (
        <EmptyState title="아직 판매된 도네이도 상품이 없습니다" description="상품 관리에서 도네이도 상품을 진열해 보세요." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>일시</Th>
              <Th>상품</Th>
              <Th>판매 금액</Th>
              <Th>내 수익</Th>
              <Th>주문 상태</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <Td className="whitespace-nowrap">{formatKst(i.createdAt, false)}</Td>
                <Td>
                  {i.productName}
                  {i.variantName ? ` · ${i.variantName}` : ''} ×{i.quantity}
                </Td>
                <Td>{formatWon(i.amount)}</Td>
                <Td>
                  {formatWon(i.referral?.amount ?? i.referralAmount)}
                  <div className="text-[11.5px] text-ink-400">{REFERRAL_LABEL[i.referral?.status ?? 'PENDING']}</div>
                </Td>
                <Td>{ORDER_STATUS_LABEL[i.order.status] ?? i.order.status}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      );
  }

  return (
    <>
      <PageHeader title="주문·수익" description="구매 확정(배송 완료 후 구매자 확정 또는 자동 확정)되면 수익이 정산 원장에 적립되어 기존 정산과 함께 지급됩니다." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="상품 수익 적립" value={formatWon(refSum('CONFIRMED'))} tone="brand" />
        <StatTile label="상품 수익 확정 대기" value={formatWon(refSum('PENDING'))} />
        <StatTile label="직접 판매 확정 매출" value={formatWon(directConfirmed)} sub="중개 수수료 차감 전" />
        <StatTile label="발송할 직접 주문" value={String(directOpen)} tone={directOpen > 0 ? 'warning' : 'neutral'} />
      </div>
      <SectionTitle title={tab === 'direct' ? '직접 상품 주문' : '도네이도 상품 판매(레퍼럴)'} />
      <div className="mb-3 flex gap-2">
        {[
          ['direct', '직접 상품 주문'],
          ['referral', '도네이도 상품 판매'],
        ].map(([k, label]) => (
          <Link key={k} href={`/studio/shop/orders?tab=${k}`} className={cx('rounded-full px-3.5 py-1.5 text-[13px] font-bold', k === tab ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}>
            {label}
          </Link>
        ))}
      </div>
      {body}
      <p className="mt-4 text-[12px] text-ink-400">받는 분 정보는 일부만 보입니다. 발송할 때 [배송지 전체 보기]로 확인하세요. 열람 기록이 남습니다.</p>
    </>
  );
}
