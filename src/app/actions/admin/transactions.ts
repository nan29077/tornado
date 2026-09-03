'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { formatMoNumber, splitMoNumber } from '@/server/emma';
import {
  describeLegacyReissue,
  reissueLegacyMoNumbers,
  reissueMoNumberForCreator,
} from '@/server/services/mo-number-issue';
import { requestRefund, approveRefund, rejectRefund, retryRefundRecovery } from '@/server/services/refund';
import { reconcileUnknownPayment } from '@/server/services/payment-reconcile';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, money, enumValue, requiredId, assertFinanceAdmin, assertOperationAdmin } from './shared';

/**
 * MO 번호 재고 / 환불 / 이상거래 처리 액션.
 */

// =========================================================== MO 번호

/**
 * MO 수신번호 형식.
 *
 * 체계는 하나뿐이다 — **대표번호 + 서브번호** (인포뱅크 EMMA).
 * `1688-□□□□-XXXX` 처럼 앞 8자리는 계약한 대표번호로 고정이고 뒤 4자리를 크리에이터에게 부여한다.
 * 15xx/16xx/18xx 계열 전국대표번호 8자리 + 서브번호 4자리 = 12자리다.
 *
 * 구 050 안심번호(MTONET 체계)는 **더 이상 등록할 수 없다.** 재고에 섞이면 배정은 되는데
 * 수신이 되지 않는 유령 번호가 생기고, 크리에이터는 그 사실을 알 방법이 없다.
 * 남아 있는 구 번호는 `reissueLegacyMoNumbers()` 로 일괄 전환한다.
 *
 * 형식을 강제하는 이유는 오등록 때문이다. 자리수 하나가 틀린 번호를 배정하면 그 크리에이터는
 * 후원 문자를 한 통도 못 받는데, 화면상으로는 정상 배정으로 보인다.
 */
const REPRESENTATIVE_NUMBER_RE = /^1[5678][0-9]{2}[0-9]{4}[0-9]{4}$/;

function isValidMoNumber(value: string): boolean {
  return REPRESENTATIVE_NUMBER_RE.test(value);
}

export async function createMoNumber(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const phoneNumber = text(fd, 'phoneNumber').replace(/[^0-9]/g, '');
    if (!isValidMoNumber(phoneNumber)) {
      throw new Error(
        '수신번호 형식이 올바르지 않습니다. ' +
          '대표번호+서브번호 12자리(예: 168812345678) 로 입력해 주세요. ' +
          '구 050 안심번호는 더 이상 등록할 수 없습니다.',
      );
    }

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

    /**
     * 전용번호는 대표번호 / 서브번호 축으로도 쪼개 둔다.
     * 자동 발급(mo-number-issue.ts)과 같은 형태로 저장해야 소진 현황 집계와
     * 중복 방지 인덱스(creator_mo_number_base_sub_uniq)가 두 경로에 똑같이 적용된다.
     * 대표번호를 공유하는 키워드 방식은 번호를 나눠 쓰는 개념이 아니므로 비워 둔다.
     */
    const split = effectiveKeyword === null ? splitMoNumber(phoneNumber) : null;

    const created = await prisma.creatorMoNumber.create({
      data: {
        id: newId(),
        phoneNumber,
        keyword: effectiveKeyword,
        baseNumber: split?.base ?? null,
        subCode: split?.sub ?? null,
        mode,
        monthlyCost,
        memo,
        status: 'AVAILABLE',
      },
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
    // MO 번호 배정은 문자후원 라우팅 그 자체다. 잘못 건드리면 후원이 통째로 끊긴다.
    assertOperationAdmin(admin, 'MO 번호 배정');
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
    assertOperationAdmin(admin, 'MO 번호 상태 변경');
    const id = requiredId(fd, 'id', 'MO 번호');
    const status = enumValue(fd, 'status', ['AVAILABLE', 'RESERVED', 'RECLAIMED', 'DISABLED'] as const, '상태');

    const before = await prisma.creatorMoNumber.findUnique({
      where: { id },
      include: { creator: { select: { displayName: true } } },
    });
    if (!before) throw new Error('MO 번호를 찾을 수 없습니다.');

    /**
     * 배정된 번호를 회수·사용중지하면 **그 크리에이터의 문자후원 라우팅이 끊긴다.**
     * 조용히 처리하지 않고 명시적으로 막는다. 회수(RECLAIMED)로 배정을 먼저 푼 뒤
     * 사용중지하도록 두 단계로 강제한다.
     */
    if (status === 'DISABLED' && before.creatorId) {
      throw new Error(
        `이 번호는 ${before.creator?.displayName ?? '크리에이터'} 님에게 배정되어 있습니다. ` +
          '먼저 [회수]로 배정을 해제한 뒤 사용중지해 주세요. (지금 중지하면 그 채널의 문자후원이 즉시 끊깁니다)',
      );
    }

    /**
     * 배정 상태가 아닌 값으로 바꿀 때는 **반드시 creatorId 를 함께 비운다.**
     * 예전에는 AVAILABLE·RESERVED 전이에서 status 만 바꿔, "재고인데 크리에이터가 붙어 있는"
     * 모순 상태가 만들어질 수 있었다(라우팅은 살아 있고 배정 화면에는 재고로 보임).
     */
    const data =
      status === 'RECLAIMED' || status === 'DISABLED'
        ? { status, creatorId: null, releasedAt: new Date() }
        : { status, creatorId: null, releasedAt: before.creatorId ? new Date() : before.releasedAt };

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

// =========================================================== 구 번호 체계 정리 / 재발급

/**
 * 구 체계 번호를 쓰는 크리에이터 전원을 현재 대표번호 체계로 옮긴다.
 *
 * 언제 쓰는가
 *  1) 0505·1588 등 구 번호가 남아 있을 때 (1회성 정리)
 *  2) **인포뱅크 계약으로 대표번호가 확정·교체됐을 때** — `.env` 의 EMMA_MO_BASE_NUMBER 를
 *     새 번호로 바꾸고 서버를 재시작한 뒤 이 버튼을 누르면 전원이 새 대표번호로 옮겨진다.
 *
 * 주의: 실행하면 후원자들이 알고 있던 번호가 바뀐다. 방송 안내 문구를 다시 내보내도록
 * 크리에이터에게 알림이 나가야 하므로, 결과를 관리자에게 건별로 돌려준다.
 */
// 입력값이 없는 액션이지만 서버 액션 시그니처는 (prev, formData) 로 고정이라 두 자리를 남긴다.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function reissueLegacyMoNumbersAction(_prev: AdminActionState, _fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, 'MO 번호 일괄 재발급');

    const result = await reissueLegacyMoNumbers();

    // 한 건도 바뀌지 않았으면 감사로그를 남기지 않는다(로그가 의미 없이 불어난다).
    const touched =
      result.reissued.length +
      result.reclaimedOnly.length +
      result.failed.length +
      result.retiredStock.length;
    if (touched > 0) {
      await writeAudit({
        adminUserId: admin.id,
        action: 'MO_NUMBER_LEGACY_REISSUE',
        targetType: 'CreatorMoNumber',
        targetId: result.baseNumber,
        after: {
          baseNumber: result.baseNumber,
          reissued: result.reissued.map((r) => `${r.displayName}: ${r.from} → ${r.to}`),
          reclaimedOnly: result.reclaimedOnly.map((r) => `${r.displayName}: ${r.from}`),
          failed: result.failed.map((r) => `${r.displayName}: ${r.from} (${r.message})`),
          retiredStock: result.retiredStock.map((r) => `${r.phoneNumber} (${r.previousStatus})`),
        },
      });
    }

    revalidatePath('/admin/mo-numbers');
    revalidatePath('/admin/creators');

    // 어떤 번호가 어떤 번호로 바뀌었는지 화면에 그대로 보여 준다.
    // (크리에이터에게 안내할 때 관리자가 이 목록을 그대로 쓴다)
    const detail: Record<string, string> = {};
    for (const r of result.reissued) {
      detail[r.displayName] = `${formatMoNumber(r.from)} → ${formatMoNumber(r.to)}`;
    }
    for (const r of result.reclaimedOnly) {
      detail[r.displayName] = `${formatMoNumber(r.from)} → 회수 (미승인 채널)`;
    }
    for (const r of result.failed) {
      detail[r.displayName] = `${formatMoNumber(r.from)} → 실패: ${r.message}`;
    }
    for (const r of result.retiredStock) {
      detail[`(재고) ${formatMoNumber(r.phoneNumber)}`] = `${r.previousStatus} → 사용중지`;
    }

    return { message: describeLegacyReissue(result), detail };
  });
}

/**
 * 크리에이터 한 명의 번호를 새로 발급한다.
 * 번호 유출·오배정 신고처럼 지금 쓰는 번호를 버려야 하는 상황에 쓴다.
 */
export async function reissueCreatorMoNumberAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, 'MO 번호 재발급');
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const reason = text(fd, 'reason') || '관리자 수동 재발급';

    const issued = await reissueMoNumberForCreator(creatorId, reason);

    await writeAudit({
      adminUserId: admin.id,
      action: 'MO_NUMBER_REISSUE',
      targetType: 'CreatorProfile',
      targetId: creatorId,
      before: issued.replaced ? { phoneNumber: issued.replaced } : undefined,
      after: { phoneNumber: issued.phoneNumber, reason },
    });

    revalidatePath('/admin/mo-numbers');
    revalidatePath(`/admin/creators/${creatorId}`);
    return issued.replaced
      ? `MO 번호를 ${formatMoNumber(issued.replaced)} 에서 ${formatMoNumber(issued.phoneNumber)} 으로 재발급했습니다. 크리에이터에게 방송 안내 문구 교체를 알려 주세요.`
      : `MO 번호 ${formatMoNumber(issued.phoneNumber)} 을(를) 발급했습니다.`;
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
    assertFinanceAdmin(admin, '환불 승인');
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
    // 환불 승인·재시도·직접환불과 같은 문턱을 적용한다.
    // 거절만 열려 있으면 고객지원이 후원자의 환불 요청을 임의로 반려할 수 있다.
    assertFinanceAdmin(admin, '환불 처리');
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
    assertFinanceAdmin(admin, '환불 재시도');
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
    assertFinanceAdmin(admin, '직접 환불');
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
