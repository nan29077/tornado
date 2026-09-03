import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { getPaymentAdapter, type PaymentAdapter } from '@/server/adapters/payment';
import { calculateFees, postRefundSettlement } from './settlement';
import { rollbackCounters } from './limits';
import { sendMtForDonor } from './donation-flow';
import { notifySuperAdmins } from './notifications';
import { logger } from '@/lib/logger';
import type { Prisma } from '@/generated/prisma/client';
import * as tpl from './mt-templates';

/**
 * 환불 처리.
 * - 정산 원장은 수정하지 않고 반대 분개를 추가한다.
 * - 이미 정산 지급된 건의 환불은 마이너스 잔액으로 남아 다음 정산에서 차감된다.
 */

export async function requestRefund(input: {
  donationId: string;
  reason: string;
  requestedBy?: string;
}) {
  const donation = await prisma.donation.findUnique({ where: { id: input.donationId } });
  if (!donation) throw new Error('후원 거래를 찾을 수 없습니다.');
  if (!['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(donation.status)) {
    throw new Error('결제가 완료된 거래만 환불할 수 있습니다.');
  }
  const existing = await prisma.refund.findFirst({
    where: { donationId: input.donationId, status: { in: ['REQUESTED', 'APPROVED', 'DONE'] } },
  });
  if (existing) throw new Error('이미 환불이 요청된 거래입니다.');

  // 더블클릭·동시 요청으로 REQUESTED 가 두 건 생기지 않도록, 후원 상태 전이를 조건부 UPDATE 로 선점한다.
  const claimed = await prisma.donation.updateMany({
    where: { id: donation.id, status: donation.status },
    data: { status: 'REFUND_REQUESTED' },
  });
  if (claimed.count !== 1) throw new Error('이미 환불이 요청된 거래입니다.');

  const refund = await prisma.refund.create({
    data: {
      id: newId(),
      donationId: donation.id,
      amount: donation.amount,
      reason: input.reason,
      requestedBy: input.requestedBy ?? null,
    },
  });
  // 거절 시 이전 상태로 되돌릴 수 있도록 전이 이력을 남긴다.
  await prisma.donationStatusLog.create({
    data: {
      id: newId(),
      donationId: donation.id,
      fromStatus: donation.status,
      toStatus: 'REFUND_REQUESTED',
      actor: input.requestedBy ?? 'system',
      reason: input.reason.slice(0, 200),
    },
  });
  return refund;
}

type RefundWithDonation = Prisma.RefundGetPayload<{
  include: { donation: { include: { creator: true; transactions: true } } };
}>;
type RefundTxn = RefundWithDonation['donation']['transactions'][number];

export async function approveRefund(refundId: string, adminUserId?: string) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { donation: { include: { creator: true, transactions: true } } },
  });
  if (!refund) throw new Error('환불 요청을 찾을 수 없습니다.');
  if (refund.status === 'DONE') return refund;

  // 이중 승인 방어.
  // (1) 요청 상태가 아닌 건(거절·실패)을 되살려 다시 취소·반대분개하지 않는다.
  // (2) 동시에 두 관리자가 승인해도 조건부 UPDATE 로 한쪽만 선점하게 한다.
  //     append-only 원장에 환불 분개가 두 번 쌓이면 되돌릴 수 없으므로 PG 취소 호출 전에 APPROVED 로 선점한다.
  if (refund.status !== 'REQUESTED') {
    throw new Error('요청 상태의 환불만 승인할 수 있습니다. 목록을 새로고침해 현재 상태를 확인해 주세요.');
  }
  /**
   * 승인된 결제 거래 확인은 **선점보다 먼저** 한다.
   *
   * 예전에는 REQUESTED → APPROVED 로 선점한 뒤에 거래를 찾고, 없으면 throw 했다.
   * 그러면 환불은 APPROVED 로 남는데 승인(REQUESTED 만 허용)·거절(REQUESTED 만 선점)·
   * 재시도(PENDING_RECOVERY 만 허용) 어느 액션으로도 빠져나올 수 없어 영구 고착됐다.
   */
  const txn = refund.donation.transactions.find((t) => t.status === 'APPROVED');
  if (!txn) throw new Error('승인된 결제 거래가 없습니다.');

  const claimed = await prisma.refund.updateMany({
    where: { id: refundId, status: 'REQUESTED' },
    data: { status: 'APPROVED' },
  });
  if (claimed.count === 0) {
    throw new Error('이미 다른 처리가 진행 중인 환불입니다. 잠시 후 상태를 다시 확인해 주세요.');
  }

  const adapter = getPaymentAdapter();
  const res = await callCancel(adapter, refund, txn, refundId);
  await finishRefundCancel(refund, txn, res, adminUserId);
  return prisma.refund.findUnique({ where: { id: refundId } });
}

/**
 * PG 취소 API 를 호출한다. 타임아웃/네트워크 오류로 예외가 나면
 * "취소가 실제로 됐는지 알 수 없는" 상태이므로 FAILED 로 단정하지 않고
 * PENDING_RECOVERY 로 옮겨 재시도(retryRefundRecovery)로 이어가게 한다.
 * (H-1: 이 예외를 못 잡으면 환불이 APPROVED 에 영구 고착된다)
 */
async function callCancel(
  adapter: PaymentAdapter,
  refund: Pick<RefundWithDonation, 'id' | 'amount' | 'reason'>,
  txn: RefundTxn,
  refundId: string,
) {
  try {
    return await adapter.cancel({
      orderNo: txn.orderNo,
      providerTid: txn.providerTid ?? '',
      amount: refund.amount,
      reason: refund.reason ?? '고객 요청',
    });
  } catch (e) {
    const message = (e as Error).message;
    logger.error('환불 취소 API 오류 — 복구 대기로 전환', { refundId, orderNo: txn.orderNo, message });
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'PENDING_RECOVERY',
        resultCode: 'CANCEL_API_ERROR',
        resultMessage: `취소 API 오류: ${message}`.slice(0, 500),
      },
    });
    await notifySuperAdmins({
      title: '환불 취소 처리 중 오류가 발생했습니다',
      body: `환불 ID ${refundId} · 주문번호 ${txn.orderNo}. PG 취소 결과를 확인하지 못했습니다. 환불 관리 화면에서 재시도해 주세요.`,
      linkUrl: '/admin/refunds',
    });
    throw new Error('환불 취소 처리 중 오류가 발생했습니다. 자동으로 재시도 대기 상태로 전환되었습니다. 잠시 후 다시 시도해 주세요.');
  }
}

/**
 * 결제사 조회로 "이미 취소된 거래"인지 확인한다.
 * 조회 자체가 실패하면 단정하지 않고 false 를 돌려준다(실패 확정 경로로 간다).
 */
async function confirmAlreadyCanceled(orderNo: string): Promise<boolean> {
  try {
    const adapter = getPaymentAdapter();
    const inq = await adapter.inquire(orderNo);
    return Boolean(inq.ok && inq.data?.status === 'CANCELED');
  } catch {
    return false;
  }
}

/** cancel() 응답(성공/실패 확정)을 받아 환불을 마무리한다. */
async function finishRefundCancel(
  refund: RefundWithDonation,
  txn: RefundTxn,
  resInput: Awaited<ReturnType<PaymentAdapter['cancel']>>,
  adminUserId?: string,
) {
  let res = resInput;
  const refundId = refund.id;

  if (!res.ok) {
    /**
     * 실패로 단정하기 전에 **한 번 더 조회한다.**
     *
     * 취소 재시도(정리 배치)가 이미 취소된 거래에 들어가면 결제사는 "이미 취소됨"을
     * 오류로 회신한다. 그걸 그대로 실패로 확정하면 **실제로는 환불된 건이 FAILED 로 남아**
     * 후원자에게는 돈이 돌아갔는데 우리 원장에는 반대분개가 없는 상태가 된다.
     */
    const confirmed = await confirmAlreadyCanceled(txn.orderNo);
    if (confirmed) {
      logger.warn('취소 응답은 실패였지만 조회 결과 이미 취소됨 — 환불 완료로 확정', {
        refundId,
        orderNo: txn.orderNo,
        code: res.code ?? null,
      });
      res = { ok: true, data: { canceledAt: new Date() } } as typeof res;
    }
  }

  if (!res.ok) {
    // 선점(APPROVED)했다가 PG 취소에 실패한 건은 FAILED 로 확정한다.
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: 'FAILED', resultCode: res.code ?? null, resultMessage: res.message ?? null },
    });
    /**
     * **후원 상태도 되돌린다.**
     *
     * 되돌리지 않으면 후원이 `REFUND_REQUESTED` 에 갇힌다. `requestRefund` 의 허용 상태
     * 목록에 그 상태가 없으므로 재환불 요청조차 불가능해지고, 화면에는 "처리 완료"라는
     * 회색 문구만 남아 관리자는 잠긴 사실조차 알 수 없었다.
     */
    await restoreDonationStatusAfterRefundFailure(refund.donationId, refundId);
    throw new Error(res.message ?? '환불 처리에 실패했습니다.');
  }

  const fees = await calculateFees(refund.donation.creatorId, refund.amount);
  const now = new Date();

  // 환불 확정 기록과 정산 원장 반대 분개는 반드시 같은 트랜잭션이어야 한다.
  // 분리하면 커밋 사이에 프로세스가 죽었을 때 "환불은 완료인데 원장에는 없는" 상태가 된다.
  await prisma.$transaction(async (tx) => {
    await tx.refund.update({
      where: { id: refundId },
      data: { status: 'DONE', approvedBy: adminUserId ?? null, processedAt: now, providerTid: txn.providerTid },
    });
    await tx.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'CANCELED', canceledAt: now } });
    await tx.donation.update({
      where: { id: refund.donationId },
      data: { status: 'REFUNDED', refundedAt: now },
    });
    await tx.donationStatusLog.create({
      data: { id: newId(), donationId: refund.donationId, toStatus: 'REFUNDED', actor: adminUserId ?? 'admin', reason: refund.reason },
    });
    await postRefundSettlement(
      {
        creatorId: refund.donation.creatorId,
        donationId: refund.donationId,
        refundId: refund.id,
        amount: refund.amount,
        fees,
        occurredAt: now,
      },
      tx,
    );
  });

  if (refund.donation.donorId && refund.donation.paidAt) {
    await rollbackCounters(refund.donation.donorId, refund.donation.creatorId, refund.amount, refund.donation.paidAt);
    await prisma.donorCreatorLink.updateMany({
      where: { donorId: refund.donation.donorId, creatorId: refund.donation.creatorId },
      data: { totalAmount: { decrement: refund.amount }, totalCount: { decrement: 1 } },
    });
    await sendMtForDonor(
      refund.donation.donorId,
      tpl.tplRefundDone(refund.donation.creator.displayName, refund.amount),
      refund.donationId,
      refund.donation.creatorId,
    );
  }
}

/**
 * PG 취소 API 오류로 PENDING_RECOVERY 에 머문 환불을 재시도한다.
 *
 * 결제사 거래결과조회(inquire)로 실제 취소 여부를 먼저 확인해, 이미 취소된 것으로
 * 확인되면 취소 API 를 다시 부르지 않고 그 결과로 완료 처리한다(같은 취소를 두 번
 * 요청해서 생길 수 있는 사고를 피한다). 확인되지 않으면 취소를 다시 요청한다.
 *
 * 관리자 화면(수동)과 정리 배치(자동, retryAllPendingRefundRecoveries) 양쪽에서 호출한다.
 */
export async function retryRefundRecovery(refundId: string, adminUserId?: string) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { donation: { include: { creator: true, transactions: true } } },
  });
  if (!refund) throw new Error('환불 요청을 찾을 수 없습니다.');
  if (refund.status !== 'PENDING_RECOVERY') {
    throw new Error('재시도 대기 상태의 환불만 다시 시도할 수 있습니다.');
  }

  const txn = refund.donation.transactions.find((t) => t.status === 'APPROVED');
  if (!txn) throw new Error('연결된 결제 거래를 찾을 수 없습니다.');

  const adapter = getPaymentAdapter();

  let confirmedCanceled = false;
  try {
    const inq = await adapter.inquire(txn.orderNo);
    if (inq.ok && inq.data?.status === 'CANCELED') confirmedCanceled = true;
  } catch (e) {
    logger.warn('환불 재시도 — 거래결과조회 실패, 취소를 다시 요청합니다', { refundId, message: (e as Error).message });
  }

  const res: Awaited<ReturnType<PaymentAdapter['cancel']>> = confirmedCanceled
    ? { ok: true, data: { canceledAt: new Date() } }
    : await callCancel(adapter, refund, txn, refundId);

  await finishRefundCancel(refund, txn, res, adminUserId);
  return prisma.refund.findUnique({ where: { id: refundId } });
}

/**
 * 정리 배치(/api/cron/cleanup) 훅 포인트.
 * PENDING_RECOVERY 상태 환불을 모두 순회하며 재시도한다. 한 건이 실패해도 나머지는 계속 진행한다.
 */
export async function retryAllPendingRefundRecoveries(): Promise<number> {
  const stale = await prisma.refund.findMany({
    where: { status: 'PENDING_RECOVERY' },
    select: { id: true },
  });
  let count = 0;
  for (const r of stale) {
    try {
      await retryRefundRecovery(r.id);
      count += 1;
    } catch (e) {
      logger.warn('환불 복구 자동 재시도 실패', { refundId: r.id, message: (e as Error).message });
    }
  }
  return count;
}

/**
 * 환불이 확정 실패했을 때 후원 상태를 요청 직전으로 되돌린다.
 *
 * 되돌리지 않으면 후원이 `REFUND_REQUESTED` 에 갇혀 재환불 요청이 불가능해진다.
 * 상태 로그가 없는 예전 건은 정산 대기로 둔다(거절 경로와 같은 규칙).
 */
async function restoreDonationStatusAfterRefundFailure(donationId: string, refundId: string) {
  const transition = await prisma.donationStatusLog.findFirst({
    where: { donationId, toStatus: 'REFUND_REQUESTED' },
    orderBy: { createdAt: 'desc' },
    select: { fromStatus: true },
  });
  const back = transition?.fromStatus ?? 'SETTLEMENT_PENDING';
  await prisma.donation
    .updateMany({
      where: { id: donationId, status: 'REFUND_REQUESTED' },
      data: { status: back as never, statusReason: '환불 처리 실패 — 재요청 가능' },
    })
    .catch((e) => {
      logger.error('환불 실패 후 후원 상태 복원 실패', { donationId, refundId, message: (e as Error).message });
    });
  await prisma.donationStatusLog
    .create({
      data: {
        id: newId(),
        donationId,
        fromStatus: 'REFUND_REQUESTED',
        toStatus: back,
        reason: '환불 처리 실패로 상태 복원',
        actor: 'system',
      },
    })
    .catch(() => undefined);
}

export async function rejectRefund(refundId: string, adminUserId?: string, memo?: string) {
  const refund = await prisma.refund.findUnique({ where: { id: refundId } });
  if (!refund) throw new Error('환불 요청을 찾을 수 없습니다.');
  // 동시 승인·거절 경합 방어: 요청(REQUESTED) 상태만 조건부 UPDATE 로 선점한다.
  // 무조건 REJECTED 로 덮으면 승인 흐름이 먼저 선점한 건(APPROVED·DONE)까지 되돌려 원장과 어긋난다.
  const claimed = await prisma.refund.updateMany({
    where: { id: refundId, status: 'REQUESTED' },
    data: { status: 'REJECTED', approvedBy: adminUserId ?? null, resultMessage: memo ?? null, processedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new Error('이미 처리된 환불입니다. 목록을 새로고침해 현재 상태를 확인해 주세요.');
  }
  // 환불 요청 직전 상태(BROADCASTED·SETTLED 등)로 되돌린다. 이력이 없는 예전 건은 정산대기로 둔다.
  const transition = await prisma.donationStatusLog.findFirst({
    where: { donationId: refund.donationId, toStatus: 'REFUND_REQUESTED' },
    orderBy: { createdAt: 'desc' },
    select: { fromStatus: true },
  });
  await prisma.donation.update({
    where: { id: refund.donationId },
    data: { status: transition?.fromStatus ?? 'SETTLEMENT_PENDING', statusReason: '환불 거절' },
  });
  return refund;
}
