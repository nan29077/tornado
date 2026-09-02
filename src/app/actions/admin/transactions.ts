'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { requestRefund, approveRefund, rejectRefund, retryRefundRecovery } from '@/server/services/refund';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, money, enumValue, requiredId } from './shared';

/**
 * MO 번호 재고 / 환불 / 이상거래 처리 액션.
 */

// =========================================================== MO 번호

// MO 수신번호는 050(0505/0507 등) 안심번호 체계를 사용한다.
// 크리에이터마다 고유 번호를 부여하므로 형식을 강제해 오등록을 막는다.
const PHONE_RE = /^050[0-9]{7,10}$/;

export async function createMoNumber(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const phoneNumber = text(fd, 'phoneNumber').replace(/[^0-9]/g, '');
    if (!PHONE_RE.test(phoneNumber)) throw new Error('수신번호는 050 으로 시작하는 숫자 10~13자리로 입력해 주세요. (예: 05051001001)');

    const mode = enumValue(fd, 'mode', ['DEDICATED', 'SHARED_PREFIX'] as const, '수신 모드');
    const rawKeyword = optText(fd, 'keyword');
    const keyword = rawKeyword ? rawKeyword.toUpperCase().replace(/\s+/g, '') : null;
    if (mode === 'SHARED_PREFIX' && !keyword) {
      throw new Error('대표번호 공유 모드에서는 키워드가 반드시 필요합니다.');
    }
    // 전용번호에는 키워드를 붙이지 않는다. (붙으면 유니크 키가 갈라져 중복 등록이 뚫린다)
    const effectiveKeyword = mode === 'DEDICATED' ? null : keyword;
    const monthlyCost = money(fd, 'monthlyCost', '월 비용');
    const memo = optText(fd, 'memo');

    // 같은 번호에 전용/대표번호공유가 섞이면 라우팅이 전용으로 쏠려
    // 대표번호를 쓰던 크리에이터들의 후원이 통째로 엉뚱한 사람에게 들어간다.
    // 번호 단위로 먼저 검사해 모드 혼재 자체를 막는다.
    const siblings = await prisma.creatorMoNumber.findMany({
      where: { phoneNumber },
      select: { id: true, mode: true, keyword: true },
    });
    if (siblings.some((s) => s.mode !== mode)) {
      throw new Error(
        '같은 번호에 전용번호와 대표번호(키워드) 방식을 함께 등록할 수 없습니다. 기존 등록을 먼저 정리해 주세요.',
      );
    }
    if (mode === 'DEDICATED' && siblings.length > 0) {
      throw new Error('이미 등록된 전용번호입니다. 전용번호는 번호당 하나만 등록할 수 있습니다.');
    }
    if (siblings.some((s) => s.keyword === effectiveKeyword)) {
      throw new Error('이미 등록된 번호/키워드 조합입니다.');
    }

    const created = await prisma.creatorMoNumber.create({
      data: { id: newId(), phoneNumber, keyword: effectiveKeyword, mode, monthlyCost, memo, status: 'AVAILABLE' },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MO_NUMBER_CREATE',
      targetType: 'CreatorMoNumber',
      targetId: created.id,
      after: { phoneNumber, keyword: effectiveKeyword, mode, monthlyCost, status: 'AVAILABLE' },
    });
    revalidatePath('/admin/mo-numbers');
    return `${phoneNumber}${effectiveKeyword ? ` (${effectiveKeyword})` : ''} 번호를 재고에 등록했습니다.`;
  });
}

export async function assignMoNumber(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = requiredId(fd, 'id', 'MO 번호');
    if (!optText(fd, 'creatorId')) throw new Error('배정할 크리에이터를 선택해 주세요.');
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');

    const before = await prisma.creatorMoNumber.findUnique({ where: { id } });
    if (!before) throw new Error('MO 번호를 찾을 수 없습니다.');
    if (before.status === 'ASSIGNED') throw new Error('이미 배정된 번호입니다. 먼저 회수해 주세요.');
    if (before.status === 'DISABLED') throw new Error('사용 중지된 번호는 배정할 수 없습니다.');

    const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, displayName: true, status: true },
    });
    if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');
    if (creator.status !== 'APPROVED') throw new Error('승인된 크리에이터에게만 번호를 배정할 수 있습니다.');

    await prisma.creatorMoNumber.update({
      where: { id },
      data: { status: 'ASSIGNED', creatorId, assignedAt: new Date(), releasedAt: null },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MO_NUMBER_ASSIGN',
      targetType: 'CreatorMoNumber',
      targetId: id,
      before: { status: before.status, creatorId: before.creatorId },
      after: { status: 'ASSIGNED', creatorId },
    });
    revalidatePath('/admin/mo-numbers');
    revalidatePath(`/admin/creators/${creatorId}`);
    return `${before.phoneNumber} 번호를 ${creator.displayName} 님에게 배정했습니다.`;
  });
}

export async function changeMoNumberStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = requiredId(fd, 'id', 'MO 번호');
    const status = enumValue(fd, 'status', ['AVAILABLE', 'RESERVED', 'RECLAIMED', 'DISABLED'] as const, '상태');

    const before = await prisma.creatorMoNumber.findUnique({ where: { id } });
    if (!before) throw new Error('MO 번호를 찾을 수 없습니다.');

    const data =
      status === 'RECLAIMED'
        ? { status, creatorId: null, releasedAt: new Date() }
        : status === 'DISABLED'
          ? { status, creatorId: null, releasedAt: new Date() }
          : { status };

    await prisma.creatorMoNumber.update({ where: { id }, data });
    await writeAudit({
      adminUserId: admin.id,
      action: `MO_NUMBER_${status}`,
      targetType: 'CreatorMoNumber',
      targetId: id,
      before: { status: before.status, creatorId: before.creatorId },
      after: data,
    });
    revalidatePath('/admin/mo-numbers');
    return `${before.phoneNumber} 번호 상태를 변경했습니다.`;
  });
}

// =========================================================== 결과 미확인 결제 수동 대사

/**
 * UNKNOWN / TIMEOUT 결제의 수동 확정.
 *
 * PG 관리자 화면에서 **실제 승인 여부를 대사한 뒤에만** 사용한다.
 *  - [결제 확정] : 출금이 확인된 건. 정산 원장에 분개가 추가된다.
 *  - [결제 취소] : 출금이 없었던 건. 후원은 실패로 확정되고 한도 집계가 되돌아간다.
 *
 * 되돌릴 수 없는 작업이므로 재무/운영 권한에서만 허용하고, 근거를 메모로 남기게 한다.
 */
export async function reconcilePaymentAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'SUPPORT') {
      throw new Error('결제 수동 확정은 재무/운영 권한에서만 가능합니다.');
    }
    const transactionId = requiredId(fd, 'transactionId', '결제 거래');
    const decision = enumValue(fd, 'decision', ['APPROVE', 'CANCEL'] as const, '처리 구분');
    const memo = optText(fd, 'memo');
    if (!memo || memo.length < 2) {
      throw new Error('PG 대사 근거를 2자 이상 입력해 주세요. (예: PG 관리자 조회 결과 승인됨)');
    }

    const before = await prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: { id: true, orderNo: true, status: true, donation: { select: { status: true } } },
    });
    if (!before) throw new Error('결제 거래를 찾을 수 없습니다.');

    const result = await reconcileUnknownPayment(transactionId, decision, memo);

    await writeAudit({
      adminUserId: admin.id,
      action: decision === 'APPROVE' ? 'PAYMENT_RECONCILE_APPROVE' : 'PAYMENT_RECONCILE_CANCEL',
      targetType: 'PaymentTransaction',
      targetId: transactionId,
      before: { status: before.status, donationStatus: before.donation.status },
      after: { status: decision === 'APPROVE' ? 'APPROVED' : 'CANCELED', orderNo: before.orderNo, memo },
    });
    revalidatePath('/admin/payments');
    revalidatePath('/admin/settlements');
    return result.message;
  });
}

// =========================================================== 환불

export async function approveRefundAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'SUPPORT') throw new Error('환불 승인은 재무/운영 권한에서만 가능합니다.');
    const refundId = requiredId(fd, 'refundId', '환불 요청');

    const before = await prisma.refund.findUnique({
      where: { id: refundId },
      select: { id: true, status: true, amount: true, donationId: true },
    });
    if (!before) throw new Error('환불 요청을 찾을 수 없습니다.');

    await approveRefund(refundId, admin.id);
    await writeAudit({
      adminUserId: admin.id,
      action: 'REFUND_APPROVE',
      targetType: 'Refund',
      targetId: refundId,
      before: { status: before.status },
      after: { status: 'DONE', amount: before.amount, donationId: before.donationId },
    });
    revalidatePath('/admin/refunds');
    revalidatePath('/admin/settlements');
    return '환불을 승인했습니다. 정산 원장에 반대 분개가 추가되었습니다.';
  });
}

export async function rejectRefundAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const refundId = requiredId(fd, 'refundId', '환불 요청');
    const memo = optText(fd, 'memo');
    if (!memo || memo.length < 2) throw new Error('거절 사유를 2자 이상 입력해 주세요.');

    const before = await prisma.refund.findUnique({ where: { id: refundId }, select: { status: true } });
    if (!before) throw new Error('환불 요청을 찾을 수 없습니다.');
    if (before.status !== 'REQUESTED') throw new Error('요청 상태의 환불만 거절할 수 있습니다.');

    await rejectRefund(refundId, admin.id, memo);
    await writeAudit({
      adminUserId: admin.id,
      action: 'REFUND_REJECT',
      targetType: 'Refund',
      targetId: refundId,
      before: { status: before.status },
      after: { status: 'REJECTED', memo },
    });
    revalidatePath('/admin/refunds');
    return '환불 요청을 거절했습니다.';
  });
}

/** PG 취소 API 오류로 재시도 대기(PENDING_RECOVERY) 에 머문 환불을 다시 시도한다. */
export async function retryRefundRecoveryAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'SUPPORT') throw new Error('환불 재시도는 재무/운영 권한에서만 가능합니다.');
    const refundId = requiredId(fd, 'refundId', '환불 요청');

    const before = await prisma.refund.findUnique({
      where: { id: refundId },
      select: { id: true, status: true, amount: true, donationId: true },
    });
    if (!before) throw new Error('환불 요청을 찾을 수 없습니다.');

    await retryRefundRecovery(refundId, admin.id);
    await writeAudit({
      adminUserId: admin.id,
      action: 'REFUND_RETRY_RECOVERY',
      targetType: 'Refund',
      targetId: refundId,
      before: { status: before.status },
      after: { status: 'DONE', amount: before.amount, donationId: before.donationId },
    });
    revalidatePath('/admin/refunds');
    revalidatePath('/admin/settlements');
    return '환불 취소를 다시 시도해 완료했습니다.';
  });
}

/** 관리자 직접 환불: 요청 생성 후 즉시 승인한다. */
export async function createAdminRefund(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'SUPPORT') throw new Error('직접 환불은 재무/운영 권한에서만 가능합니다.');
    const keyword = text(fd, 'transactionNo');
    const reason = text(fd, 'reason');
    if (!keyword) throw new Error('거래번호를 입력해 주세요.');
    if (reason.length < 2) throw new Error('환불 사유를 2자 이상 입력해 주세요.');

    const donation = await prisma.donation.findFirst({
      where: { OR: [{ transactionNo: keyword }, { id: keyword }] },
      select: { id: true, transactionNo: true, amount: true, status: true },
    });
    if (!donation) throw new Error('해당 거래번호의 후원 건을 찾을 수 없습니다.');

    const refund = await requestRefund({ donationId: donation.id, reason, requestedBy: admin.id });
    await approveRefund(refund.id, admin.id);

    await writeAudit({
      adminUserId: admin.id,
      action: 'REFUND_ADMIN_DIRECT',
      targetType: 'Refund',
      targetId: refund.id,
      before: { donationStatus: donation.status },
      after: { transactionNo: donation.transactionNo, amount: donation.amount, reason },
    });
    revalidatePath('/admin/refunds');
    revalidatePath('/admin/settlements');
    return `${donation.transactionNo} 건을 환불 처리했습니다.`;
  });
}

// =========================================================== 이상거래

export async function resolveRiskDetection(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const riskId = requiredId(fd, 'riskId', '탐지 건');
    const before = await prisma.riskDetection.findUnique({
      where: { id: riskId },
      select: { id: true, resolved: true, type: true, level: true },
    });
    if (!before) throw new Error('탐지 건을 찾을 수 없습니다.');
    if (before.resolved) throw new Error('이미 해결 처리된 건입니다.');

    const now = new Date();
    await prisma.riskDetection.update({
      where: { id: riskId },
      data: { resolved: true, resolvedBy: admin.id, resolvedAt: now },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'RISK_RESOLVE',
      targetType: 'RiskDetection',
      targetId: riskId,
      before: { resolved: false, type: before.type, level: before.level },
      after: { resolved: true, resolvedBy: admin.id, resolvedAt: now },
    });
    revalidatePath('/admin/risk');
    return '이상거래 탐지 건을 해결 처리했습니다.';
  });
}
