/**
 * 멈춘 샵 결제 정리 (2026-11-18, 5차 P2-1·P2-3).
 *
 * 결제 행(READY)을 만든 뒤 승인 결과를 DB 에 반영하기 전에 서버가 죽으면 결제가 READY 로 남는다.
 *  - 주문: PENDING_PAYMENT 주문의 재고가 묶인 채 풀리지 않는다
 *  - 1:1 채팅: 그 시간 자리가 계속 잡혀 있다
 * 30분이 지난 READY 결제를 정리한다.
 *
 * 테스트 결제(mock)는 승인 기록이 메모리에만 있어 실제 돈이 오가지 않았으므로 실패로 확정하고 묶인 것을 푼다.
 * 실제 PG 를 붙이면 결과조회(조회 API)로 승인 여부를 확인한 뒤 처리해야 하므로, mock 이 아니면 확정하지 않고
 * 최고관리자에게만 알린다. (PG 연동 때 이 함수에 결과조회를 붙인다)
 */
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { isShopPaymentMock } from '@/server/adapters/shop-payment';
import { notifySuperAdmins } from '@/server/services/notifications';
import { finalizeOrderPayment } from './orders';

export const STALE_READY_MS = 30 * 60_000;

export async function reconcileStaleShopPayments(now: Date = new Date()): Promise<{ failed: number; waiting: number }> {
  const stale = await prisma.shopPayment.findMany({
    where: { status: 'READY', createdAt: { lte: new Date(now.getTime() - STALE_READY_MS) } },
    select: { id: true, kind: true, paymentNo: true },
    take: 200,
    orderBy: { createdAt: 'asc' },
  });
  if (stale.length === 0) return { failed: 0, waiting: 0 };
  if (!isShopPaymentMock()) {
    await notifySuperAdmins({ title: '결과를 확인하지 못한 샵 결제가 있습니다', body: `결제 대기(READY) ${stale.length}건이 30분 넘게 남아 있습니다. 결제사 관리자에서 승인 여부를 확인해 주세요.`, linkUrl: '/admin/payments?tab=shop-cancel' }).catch(() => undefined);
    return { failed: 0, waiting: stale.length };
  }
  const reason = '결제 시간 초과 (승인 결과 미반영)';
  let failed = 0;
  for (const p of stale) {
    try {
      if (p.kind === 'ORDER') {
        // 주문 취소 + 재고 복구까지 한 번에 (중복 호출 안전)
        await finalizeOrderPayment(p.id, { ok: false, reason });
      } else {
        await prisma.$transaction(async (tx) => {
          const moved = await tx.shopPayment.updateMany({ where: { id: p.id, status: 'READY' }, data: { status: 'FAILED', failReason: reason } });
          if (moved.count === 0) return;
          if (p.kind === 'TALK_SESSION') {
            await tx.talkSession.updateMany({ where: { paymentId: p.id, status: 'REQUESTED' }, data: { status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: reason } });
          } else if (p.kind === 'VOTE_TICKET') {
            await tx.voteTicketOrder.updateMany({ where: { paymentId: p.id, status: 'READY' }, data: { status: 'FAILED' } });
          }
        });
      }
      failed++;
    } catch (e) {
      logger.warn('shop: 멈춘 결제 정리 실패', { paymentNo: p.paymentNo, error: (e as Error).message });
    }
  }
  return { failed, waiting: 0 };
}
