import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from '@/components/brand/icons';
import { MemberOrderList } from '@/components/shop/member-order-list';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const METHOD_LABEL: Record<string, string> = { CARD: '신용카드', TRANSFER: '간편계좌이체' };
const PAY_STATUS_LABEL: Record<string, string> = {
  READY: '결제 진행 중',
  PAID: '결제 완료',
  FAILED: '결제 실패',
  CANCELLED: '전액 취소',
  PARTIAL_CANCELLED: '부분 취소',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-[13px]">
      <dt className="w-[84px] shrink-0 font-semibold text-ink-400">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink-800">{children}</dd>
    </div>
  );
}

/**
 * 주문 상세 (8차 점검, 2026-11-20).
 * 예전에는 목록과 같은 내용(상품 · 금액 · 송장)만 보여, 배송지와 결제 정보를 확인할 곳이 없었다.
 * 배송지는 개인정보 규칙에 따라 저장된 마스킹 값만 보여 준다(원문은 판매자가 발송할 때만 열람 기록과 함께 확인).
 */
export default async function MyOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/my/orders/${id}`)}`);
  const order = await prisma.shopOrder.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      orderNo: true,
      itemsAmount: true,
      shippingFee: true,
      totalAmount: true,
      refundedAmount: true,
      recipientMasked: true,
      phoneMasked: true,
      zipcode: true,
      addressMasked: true,
      memo: true,
      paidAt: true,
      shippedAt: true,
      deliveredAt: true,
      confirmedAt: true,
      cancelledAt: true,
      payment: { select: { paymentNo: true, method: true, provider: true, status: true, amount: true, cancelledAmount: true, paidAt: true } },
    },
  });
  if (!order) notFound();
  const pay = order.payment;
  const method = pay.method ? (METHOD_LABEL[pay.method] ?? pay.method) : pay.provider === 'mock' ? '테스트 결제' : '-';
  const timeline = [
    ['결제', order.paidAt],
    ['발송', order.shippedAt],
    ['배송 완료', order.deliveredAt],
    ['구매 확정', order.confirmedAt],
    ['취소', order.cancelledAt],
  ].filter((x): x is [string, Date] => x[1] instanceof Date);

  return (
    <div>
      <Link href="/my/orders" className="mb-3 inline-flex items-center gap-1 text-[13px] font-bold text-ink-500">
        <ChevronLeft size={16} strokeWidth={2} /> 주문 목록
      </Link>
      <MemberOrderList userId={user.id} orderId={id} />

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <section className="rounded-[1.25rem] border border-warm-300/70 bg-white p-4 shadow-card">
          <h2 className="text-[14px] font-extrabold text-ink-900">배송지</h2>
          <dl className="mt-2">
            <Row label="받는 분">{order.recipientMasked}</Row>
            <Row label="연락처">{order.phoneMasked}</Row>
            <Row label="주소">
              ({order.zipcode}) {order.addressMasked}
            </Row>
            <Row label="배송 메모">{order.memo || '-'}</Row>
          </dl>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">개인정보 보호를 위해 일부만 표시합니다. 판매자는 발송할 때 전체 배송지를 확인합니다.</p>
        </section>

        <section className="rounded-[1.25rem] border border-warm-300/70 bg-white p-4 shadow-card">
          <h2 className="text-[14px] font-extrabold text-ink-900">결제 정보</h2>
          <dl className="mt-2">
            <Row label="결제 수단">{method}</Row>
            <Row label="결제 상태">{PAY_STATUS_LABEL[pay.status] ?? pay.status}</Row>
            <Row label="결제 번호">
              <span className="font-mono text-[12px]">{pay.paymentNo}</span>
            </Row>
            <Row label="상품 금액">{formatWon(order.itemsAmount)}</Row>
            <Row label="배송비">{formatWon(order.shippingFee)}</Row>
            <Row label="이 주문 합계">
              <b>{formatWon(order.totalAmount)}</b>
            </Row>
            {order.refundedAmount > 0n ? (
              <Row label="환불 금액">
                <span className="font-bold text-danger-600">{formatWon(order.refundedAmount)}</span>
              </Row>
            ) : null}
            {pay.amount !== order.totalAmount ? <Row label="결제 전체">{formatWon(pay.amount)} (여러 판매자 상품을 함께 결제)</Row> : null}
          </dl>
          {timeline.length ? (
            <ul className="mt-2 border-t border-warm-200 pt-2 text-[12px] text-ink-500">
              {timeline.map(([label, at]) => (
                <li key={label} className="flex justify-between py-0.5">
                  <span>{label}</span>
                  <span className="tabular-nums">{formatKst(at, false)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}
