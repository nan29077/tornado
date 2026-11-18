/**
 * 팬투표권 충전(결제) · 환불 (2026-11-17).
 *
 * - 결제는 도네이도 샵 결제 모듈(shop_payment + 결제 어댑터)을 그대로 쓴다. 지금은 테스트 결제(mock)이며 화면에 표시한다.
 * - 결제 수단: 신용카드(CARD) / 간편계좌이체(TRANSFER). 실 PG 계약 후 어댑터만 바꾸면 된다.
 * - 기본 수량은 유료(PAID) 묶음, 덤은 보너스(BONUS) 묶음으로 따로 지급한다(환불 계산을 위해 분리).
 * - 환불: 결제 후 N일(관리자 설정) 이내이고 **유료 묶음을 하나도 쓰지 않은** 결제만 전액 환불. 보너스는 남은 만큼 회수.
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { getShopPaymentAdapter, shopPaymentClosedMessage } from '@/server/adapters/shop-payment';
import { getVoteConfig } from '@/server/services/engagement/config';
import { cancelShopPayment } from '@/server/services/shop/payment-cancel';
import { grantTickets, revokeLot } from './wallet';

export type PayMethod = 'CARD' | 'TRANSFER';

export const PAY_METHOD_LABEL: Record<PayMethod, string> = { CARD: '신용카드', TRANSFER: '간편계좌이체' };

export function parsePayMethod(v: unknown): PayMethod | null {
  return v === 'CARD' || v === 'TRANSFER' ? v : null;
}

export async function listTicketProducts(includeInactive = false) {
  return prisma.voteTicketProduct.findMany({ where: includeInactive ? {} : { active: true }, orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] });
}

/** 기본 팬투표권 상품 (상품이 하나도 없을 때 관리자 화면의 [기본 상품 만들기]) */
export const DEFAULT_TICKET_PRODUCTS = [
  { name: '팬투표권 100개', price: 1_100n, tickets: 100, bonus: 0, badge: null },
  { name: '팬투표권 500개', price: 5_500n, tickets: 500, bonus: 30, badge: null },
  { name: '팬투표권 1,000개', price: 11_000n, tickets: 1_000, bonus: 100, badge: '인기' },
  { name: '팬투표권 3,000개', price: 33_000n, tickets: 3_000, bonus: 450, badge: 'BEST' },
  { name: '팬투표권 5,000개', price: 55_000n, tickets: 5_000, bonus: 1_000, badge: null },
] as const;

export interface PurchaseResult {
  ok: boolean;
  message: string;
  orderNo?: string;
  tickets?: number;
  bonus?: number;
}

export async function purchaseTickets(user: { id: string; name: string | null }, productId: string, method: PayMethod): Promise<PurchaseResult> {
  const closed = shopPaymentClosedMessage();
  if (closed) return { ok: false, message: closed };
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.purchaseEnabled) return { ok: false, message: '지금은 팬투표권을 판매하지 않습니다.' };
  const product = await prisma.voteTicketProduct.findFirst({ where: { id: productId, active: true } });
  if (!product) return { ok: false, message: '판매 중인 팬투표권 상품이 아닙니다.' };
  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true } });
  if (!account || account.status !== 'ACTIVE') return { ok: false, message: '결제할 수 없는 계정입니다.' };

  const adapter = getShopPaymentAdapter();
  const orderId = newId();
  const orderNo = `VT${Date.now().toString(36).toUpperCase()}${orderId.slice(-6)}`;
  const paymentId = newId();
  await prisma.$transaction([
    prisma.shopPayment.create({ data: { id: paymentId, paymentNo: orderNo, userId: user.id, kind: 'VOTE_TICKET', method, amount: product.price, provider: adapter.provider } }),
    prisma.voteTicketOrder.create({
      data: { id: orderId, orderNo, userId: user.id, productId: product.id, productName: product.name, method, price: product.price, tickets: product.tickets, bonus: product.bonus, paymentId },
    }),
  ]);

  const approved = await adapter
    .approve({ paymentNo: orderNo, amount: product.price, buyerName: user.name ?? '회원', itemName: product.name })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '결제 오류' }));
  if (!approved.ok) {
    await prisma.$transaction([
      prisma.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'FAILED', failReason: approved.reason.slice(0, 200) } }),
      prisma.voteTicketOrder.updateMany({ where: { id: orderId, status: 'READY' }, data: { status: 'FAILED' } }),
    ]);
    return { ok: false, message: `결제에 실패했습니다: ${approved.reason}` };
  }

  const now = new Date();
  const done = await prisma.$transaction(async (tx) => {
    const moved = await tx.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'PAID', providerTx: approved.providerTx, paidAt: now } });
    if (moved.count === 0) return false;
    const paidLotId = await grantTickets(tx, {
      userId: user.id,
      bucket: 'PAID',
      amount: product.tickets,
      source: 'PURCHASE',
      ledgerType: 'PURCHASE',
      refType: 'VOTE_TICKET_ORDER',
      refId: orderId,
      valueWon: product.price,
      expiresInDays: cfg.paidExpiryDays,
      memo: `${product.name} 구매 ${orderNo}`,
    }, now);
    let bonusLotId: string | null = null;
    if (product.bonus > 0) {
      bonusLotId = await grantTickets(tx, {
        userId: user.id,
        bucket: 'BONUS',
        amount: product.bonus,
        source: 'PURCHASE_BONUS',
        ledgerType: 'PURCHASE_BONUS',
        refType: 'VOTE_TICKET_ORDER',
        refId: orderId,
        expiresInDays: cfg.bonusExpiryDays,
        memo: `${product.name} 보너스 ${orderNo}`,
      }, now);
    }
    await tx.voteTicketOrder.update({ where: { id: orderId }, data: { status: 'PAID', paidAt: now, paidLotId, bonusLotId } });
    return true;
  });
  if (!done) return { ok: true, message: '이미 처리된 결제입니다.', orderNo };
  return { ok: true, message: `팬투표권 ${product.tickets.toLocaleString('ko-KR')}개${product.bonus > 0 ? ` + 보너스 ${product.bonus.toLocaleString('ko-KR')}개` : ''}가 충전되었어요.`, orderNo, tickets: product.tickets, bonus: product.bonus };
}

export interface RefundCheck {
  refundable: boolean;
  reason?: string;
}

/** 환불 가능 여부 (화면 표시용과 실제 처리 모두 같은 규칙) */
export async function checkTicketRefund(orderId: string, now: Date = new Date(), opts: { ignoreWindow?: boolean } = {}): Promise<RefundCheck> {
  const order = await prisma.voteTicketOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'PAID' || !order.paidLotId) return { refundable: false, reason: '환불할 수 있는 결제가 아닙니다.' };
  const cfg = await getVoteConfig();
  if (!opts.ignoreWindow && order.paidAt && now.getTime() - order.paidAt.getTime() > cfg.refundDays * 86_400_000) {
    return { refundable: false, reason: `결제 후 ${cfg.refundDays}일이 지나 환불할 수 없습니다.` };
  }
  const lot = await prisma.voteTicketLot.findUnique({ where: { id: order.paidLotId }, select: { remaining: true, amount: true } });
  if (!lot || lot.remaining !== lot.amount) return { refundable: false, reason: '이미 사용한 팬투표권이 있어 환불할 수 없습니다. (사용하지 않은 결제만 환불)' };
  // [5차 PAY-B] 보너스도 하나도 쓰지 않았어야 한다. (보너스만 쓰고 전액 환불 → 재구매로 표를 무한히 만드는 경로 차단)
  if (order.bonusLotId) {
    // 만료로 0 이 된 것은 사용이 아니다 → 실제 팬투표 사용 이력으로 판단한다
    const spent = await prisma.voteTicketLedger.count({ where: { lotId: order.bonusLotId, type: 'VOTE_SPEND' } });
    if (spent > 0) {
      return { refundable: false, reason: '함께 받은 보너스 팬투표권을 사용해 환불할 수 없습니다. (보너스까지 사용하지 않은 결제만 환불)' };
    }
  }
  return { refundable: true };
}

/** 미사용 결제 전액 환불. by = 'USER'(본인 요청) | 관리자 ID */
export async function refundTicketOrder(orderId: string, by: { type: 'USER'; userId: string } | { type: 'ADMIN'; userId: string }, reason: string): Promise<{ ok: boolean; message: string }> {
  const order = await prisma.voteTicketOrder.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, message: '결제를 찾을 수 없습니다.' };
  if (by.type === 'USER' && order.userId !== by.userId) return { ok: false, message: '본인 결제만 환불할 수 있습니다.' };
  const check = await checkTicketRefund(orderId, new Date(), { ignoreWindow: by.type === 'ADMIN' });
  if (!check.refundable) return { ok: false, message: check.reason ?? '환불할 수 없습니다.' };

  // 1) 팬투표권부터 회수 (회수와 상태 변경을 한 트랜잭션에서 — 회수 후에는 팬투표에 쓸 수 없다)
  const now = new Date();
  const revoked = await prisma.$transaction(async (tx) => {
    const lockedLot = await tx.$queryRaw<Array<{ remaining: number; amount: number }>>`
      SELECT remaining, amount FROM vote_ticket_lot WHERE id = ${order.paidLotId} FOR UPDATE`;
    if (!lockedLot[0] || lockedLot[0].remaining !== lockedLot[0].amount) return false;
    if (order.bonusLotId) {
      // 보너스 묶음도 잠근 뒤 사용 이력을 본다 (동시에 팬투표가 들어와도 잠금 순서로 직렬화된다)
      await tx.$queryRaw`SELECT id FROM vote_ticket_lot WHERE id = ${order.bonusLotId} FOR UPDATE`;
      const spent = await tx.voteTicketLedger.count({ where: { lotId: order.bonusLotId, type: 'VOTE_SPEND' } });
      if (spent > 0) return false;
    }
    const moved = await tx.voteTicketOrder.updateMany({ where: { id: orderId, status: 'PAID' }, data: { status: 'REFUNDED', refundedAt: now, refundReason: reason.slice(0, 200) } });
    if (moved.count === 0) return false;
    await revokeLot(tx, order.paidLotId!, 'REFUND', `환불 ${order.orderNo}`, { refType: 'VOTE_TICKET_ORDER', refId: order.id });
    if (order.bonusLotId) await revokeLot(tx, order.bonusLotId, 'REFUND', `환불 보너스 회수 ${order.orderNo}`, { refType: 'VOTE_TICKET_ORDER', refId: order.id });
    return true;
  });
  if (!revoked) return { ok: false, message: '방금 사용된 팬투표권(보너스 포함)이 있어 환불할 수 없습니다.' };

  // 2) 결제 취소 (실패해도 팬투표권은 이미 회수됨 → 재시도 대기로 남기고 관리자가 다시 취소한다)
  const cancel = await cancelShopPayment(order.paymentId, order.price, reason);
  if (!cancel.done) return { ok: true, message: '팬투표권은 회수되었고, 결제 취소는 확인 중입니다. 영업일 기준 1~3일 안에 처리됩니다.' };
  return { ok: true, message: `${order.productName} 결제를 환불했습니다.` };
}
