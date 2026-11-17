/**
 * 도네이도 샵 결제 취소 공용 (2026-11-18, 5차 P2-2).
 *
 * 투표권 환불·소통 구독 환불·1:1 채팅 환불이 모두 이 함수로 결제를 취소한다.
 * 결제사 취소가 실패하면 예전에는 로그만 남기고 화면에는 "환불됨"으로 보였다.
 * 이제는 실패한 금액을 shop_payment.cancel_pending_amount 에 쌓아 두고, 최고관리자 [결제 취소 재시도]
 * 화면(관리자 > 결제)에서 다시 시도한다. 성공하면 대기 금액을 0 으로 비운다.
 */
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { getShopPaymentAdapter } from '@/server/adapters/shop-payment';
import { notifySuperAdmins } from '@/server/services/notifications';

export interface CancelOutcome {
  /** 결제사 취소까지 끝났는가 (false 면 재시도 대기로 남았다) */
  done: boolean;
}

/** 결제를 amount 만큼 취소한다. 실패해도 예외를 던지지 않고 재시도 대기로 남긴다. */
export async function cancelShopPayment(paymentId: string | null, amount: bigint, reason: string): Promise<CancelOutcome> {
  if (!paymentId || amount <= 0n) return { done: true };
  const payment = await prisma.shopPayment.findUnique({ where: { id: paymentId } });
  if (!payment) return { done: true };
  const r = await getShopPaymentAdapter()
    .cancel({ paymentNo: payment.paymentNo, providerTx: payment.providerTx, amount, reason })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '취소 오류' }));
  if (!r.ok) {
    logger.error('샵 결제 취소 실패 — 재시도 대기로 남김', { paymentNo: payment.paymentNo, reason: r.reason });
    await prisma.shopPayment.update({
      where: { id: payment.id },
      data: { cancelPendingAmount: { increment: amount }, cancelPendingReason: `${reason} · 실패: ${r.reason}`.slice(0, 300) },
    });
    await notifySuperAdmins({
      title: '결제 취소에 실패했습니다',
      body: `${payment.paymentNo} · ${amount.toString()}원. 관리자 > 결제에서 [취소 재시도]를 눌러 주세요.`,
      linkUrl: '/admin/payments?tab=shop-cancel',
    }).catch(() => undefined);
    return { done: false };
  }
  await applyCancelled(payment.id, amount);
  return { done: true };
}

async function applyCancelled(paymentId: string, amount: bigint) {
  await prisma.$transaction(async (tx) => {
    const p = await tx.shopPayment.update({ where: { id: paymentId }, data: { cancelledAmount: { increment: amount } } });
    await tx.shopPayment.update({ where: { id: paymentId }, data: { status: p.cancelledAmount >= p.amount ? 'CANCELLED' : 'PARTIAL_CANCELLED' } });
  });
}

/** 관리자: 취소 대기 금액을 다시 취소한다. 선점(대기 금액 → 0) 후 결제사에 보내 두 번 눌러도 한 번만 나간다 */
export async function retryPendingShopCancel(paymentId: string): Promise<{ ok: boolean; message: string }> {
  const payment = await prisma.shopPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.cancelPendingAmount <= 0n) return { ok: false, message: '취소를 기다리는 결제가 아닙니다.' };
  const amount = payment.cancelPendingAmount;
  const claimed = await prisma.shopPayment.updateMany({ where: { id: paymentId, cancelPendingAmount: amount }, data: { cancelPendingAmount: 0n } });
  if (claimed.count === 0) return { ok: false, message: '다른 처리가 먼저 진행되었습니다. 새로고침해 주세요.' };
  const r = await getShopPaymentAdapter()
    .cancel({ paymentNo: payment.paymentNo, providerTx: payment.providerTx, amount, reason: payment.cancelPendingReason ?? '관리자 재시도' })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '취소 오류' }));
  if (!r.ok) {
    await prisma.shopPayment.update({ where: { id: paymentId }, data: { cancelPendingAmount: { increment: amount }, cancelPendingReason: `${payment.cancelPendingReason ?? ''} · 재시도 실패: ${r.reason}`.slice(0, 300) } });
    return { ok: false, message: `취소에 다시 실패했습니다: ${r.reason}` };
  }
  await applyCancelled(paymentId, amount);
  await prisma.shopPayment.update({ where: { id: paymentId }, data: { cancelPendingReason: null } });
  return { ok: true, message: `${payment.paymentNo} 결제 ${amount.toLocaleString('ko-KR')}원을 취소했습니다.` };
}

export async function listPendingShopCancels(limit = 100) {
  return prisma.shopPayment.findMany({ where: { cancelPendingAmount: { gt: 0n } }, orderBy: { updatedAt: 'desc' }, take: limit, include: { user: { select: { id: true, name: true, email: true } } } });
}
