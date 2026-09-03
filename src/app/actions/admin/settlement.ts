'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import {
  markSettlementPaid,
  markSettlementPayoutFailed,
  fileWithholdingAndPurgeResident,
  purgeResidentIfNotFilable,
} from '@/server/services/settlement';
import { notifyUser } from '@/server/services/notifications';
import { formatWon } from '@/lib/money';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, money, rate, enumValue, requiredId, optDate, assertFinanceAdmin } from './shared';

/**
 * 정산 요청 처리 / 수수료 정책 관리 / 지급대행(쿠콘) 운영.
 * 정산 원장(SettlementLedger)은 append-only 이므로 여기서 수정/삭제하지 않는다.
 */

async function creatorUserId(creatorId: string): Promise<string | null> {
  const c = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { userId: true } });
  return c?.userId ?? null;
}

/** 정산 상태 변경을 크리에이터 알림함에 남긴다. */
async function notifySettlement(creatorId: string, title: string, body: string) {
  const uid = await creatorUserId(creatorId);
  if (uid) await notifyUser({ userId: uid, title, body, linkUrl: '/studio/settlement?tab=request' }).catch(() => undefined);
}

export async function updateSettlementRequestStatus(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '정산 처리');
    const requestId = requiredId(fd, 'requestId', '정산 요청');
    const status = enumValue(fd, 'status', ['REVIEWING', 'APPROVED', 'PAID', 'PAYOUT_FAILED', 'REJECTED'] as const, '정산 상태');
    const memo = optText(fd, 'memo');

    const before = await prisma.settlementRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true, amount: true, payoutAmount: true, creatorId: true, payoutIssuedAt: true },
    });
    if (!before) throw new Error('정산 요청을 찾을 수 없습니다.');
    if (before.status === 'PAID' && status !== 'PAYOUT_FAILED') throw new Error('이미 지급 완료된 요청입니다.');
    if (before.status === 'REJECTED') throw new Error('이미 반려된 요청입니다.');
    // 이체파일이 이미 발급된 건을 반려/검토로 되돌리면, 이후 지급대행 결과(SUCCESS)를 반영할 수 없어
    // 돈은 나갔는데 원장에 지급 분개가 없는 상태가 된다. 지급 실패 결과를 먼저 반영해야 한다.
    if (before.payoutIssuedAt && (status === 'REJECTED' || status === 'REVIEWING')) {
      throw new Error('이체파일이 이미 발급된 요청입니다. 지급대행 결과(성공/실패)를 먼저 반영한 뒤 처리해 주세요.');
    }

    // 반려·지급실패는 사유가 반드시 있어야 크리에이터가 원인을 안다.
    if ((status === 'REJECTED' || status === 'PAYOUT_FAILED') && !memo) {
      throw new Error(status === 'REJECTED' ? '반려 사유를 입력해 주세요.' : '지급 실패 사유를 입력해 주세요.');
    }

    const now = new Date();
    if (status === 'PAID') {
      if (before.status !== 'APPROVED') throw new Error('승인된 요청만 지급 완료 처리할 수 있습니다.');
      await markSettlementPaid(requestId, admin.id);
      await notifySettlement(before.creatorId, '정산 지급이 완료되었습니다', `${formatWon(before.payoutAmount)}이 지급 처리되었습니다.`);
    } else if (status === 'PAYOUT_FAILED') {
      await markSettlementPayoutFailed(requestId, memo!, admin.id);
      await notifySettlement(before.creatorId, '정산 지급이 실패했습니다', `사유: ${memo}. 계좌를 확인하고 다시 요청해 주세요.`);
    } else {
      const data =
        status === 'APPROVED'
          ? { status, approvedAt: now, adminId: admin.id, adminMemo: memo ?? undefined }
          : status === 'REJECTED'
            ? { status, rejectedAt: now, adminId: admin.id, adminMemo: memo ?? undefined }
            : { status, adminId: admin.id, adminMemo: memo ?? undefined };
      /**
       * 위 가드가 읽은 상태(before.status)가 **그대로 남아 있을 때만** 쓴다.
       *
       * 조건 없이 update 하면 두 관리자가 거의 동시에 서로 다른 상태를 누를 때 둘 다 옛 상태로
       * 가드를 통과하고 나중 쓰기가 이긴다. 반려된 요청이 다시 APPROVED 로 덮이면
       * markSettlementPaid 의 전제 조건을 충족해 지급 대상으로 되돌아온다.
       * (돈이 나가는 markSettlementPaid 자체는 advisory lock 으로 멱등하므로 중복 지급은
       *  발생하지 않지만, 상태 기계가 뚫리는 것 자체를 막는다)
       */
      const claimed = await prisma.settlementRequest.updateMany({
        where: { id: requestId, status: before.status },
        data,
      });
      if (claimed.count === 0) {
        throw new Error('상태가 이미 변경되었습니다. 화면을 새로고침한 뒤 다시 확인해 주세요.');
      }
      if (status === 'APPROVED') await notifySettlement(before.creatorId, '정산 요청이 승인되었습니다', '지급대행을 통해 곧 지급됩니다.');
      if (status === 'REJECTED') await notifySettlement(before.creatorId, '정산 요청이 반려되었습니다', `사유: ${memo}`);
    }

    // 반려·지급실패 건은 원천징수 신고 대상이 아니므로 주민등록번호를 보관할 근거가 없다.
    // "신고 후 즉시 파기" 안내를 지키기 위해 상태 전이 시점에 바로 파기한다.
    await purgeResidentIfNotFilable(requestId);

    await writeAudit({
      adminUserId: admin.id,
      action: `SETTLEMENT_${status}`,
      targetType: 'SettlementRequest',
      targetId: requestId,
      before: { status: before.status, amount: before.amount },
      after: { status, memo, payoutAmount: before.payoutAmount },
    });
    revalidatePath('/admin/settlements');
    return status === 'PAID'
      ? '지급 완료로 처리했습니다. 원장에 PAYOUT / 원천징수 분개가 추가되었습니다.'
      : status === 'PAYOUT_FAILED'
        ? '지급 실패로 처리했습니다. 이미 지급 분개가 있었다면 잔액으로 환입되었습니다.'
        : '정산 요청 상태를 변경했습니다.';
  });
}

/**
 * 정산 요청 일괄 처리.
 * 선택한 여러 건을 한 번에 승인/반려 또는 지급 완료한다.
 * 지급대행 파일로 이체를 실행한 뒤 결과를 한꺼번에 반영할 때 쓴다.
 */
export async function bulkUpdateSettlementAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '정산 처리');
    const action = enumValue(fd, 'bulkAction', ['APPROVE', 'REJECT', 'PAY'] as const, '일괄 작업');
    const memo = optText(fd, 'memo');
    const ids = fd.getAll('requestId').map((v) => String(v)).filter(Boolean);
    if (ids.length === 0) throw new Error('처리할 정산 요청을 선택해 주세요.');
    if (action === 'REJECT' && !memo) throw new Error('반려 사유를 입력해 주세요.');

    const now = new Date();
    let done = 0;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        const req = await prisma.settlementRequest.findUnique({
          where: { id },
          select: { id: true, status: true, creatorId: true, payoutAmount: true, payoutIssuedAt: true },
        });
        if (!req) continue;

        if (action === 'APPROVE') {
          if (!(req.status === 'REQUESTED' || req.status === 'REVIEWING')) {
            errors.push(`${id.slice(-6)}: 승인 불가 상태(${req.status})`);
            continue;
          }
          await prisma.settlementRequest.update({
            where: { id },
            data: { status: 'APPROVED', approvedAt: now, adminId: admin.id, adminMemo: memo ?? undefined },
          });
          await notifySettlement(req.creatorId, '정산 요청이 승인되었습니다', '지급대행을 통해 곧 지급됩니다.');
        } else if (action === 'REJECT') {
          if (req.status === 'PAID' || req.status === 'REJECTED') {
            errors.push(`${id.slice(-6)}: 반려 불가 상태(${req.status})`);
            continue;
          }
          if (req.payoutIssuedAt) {
            errors.push(`${id.slice(-6)}: 이체파일 발급 건은 지급대행 결과를 먼저 반영해야 합니다`);
            continue;
          }
          await prisma.settlementRequest.update({
            where: { id },
            data: { status: 'REJECTED', rejectedAt: now, adminId: admin.id, adminMemo: memo },
          });
          await notifySettlement(req.creatorId, '정산 요청이 반려되었습니다', `사유: ${memo}`);
          // 반려 건은 원천징수 신고 대상이 아니므로 주민등록번호를 즉시 파기한다.
          await purgeResidentIfNotFilable(id);
        } else {
          // PAY: 승인 건만 지급 완료. 잠금·재검증은 markSettlementPaid 내부에서 처리.
          await markSettlementPaid(id, admin.id);
          await notifySettlement(req.creatorId, '정산 지급이 완료되었습니다', `${formatWon(req.payoutAmount)}이 지급 처리되었습니다.`);
        }
        done += 1;
      } catch (e) {
        errors.push(`${id.slice(-6)}: ${(e as Error).message}`);
      }
    }

    await writeAudit({
      adminUserId: admin.id,
      action: `SETTLEMENT_BULK_${action}`,
      targetType: 'SettlementRequest',
      targetId: ids.join(','),
      after: { done, total: ids.length },
    });
    revalidatePath('/admin/settlements');

    const base = `${done}건을 처리했습니다.`;
    return errors.length ? `${base} (건너뜀 ${errors.length}건: ${errors.slice(0, 3).join(' / ')}${errors.length > 3 ? ' …' : ''})` : base;
  });
}

/**
 * 지급대행 결과 반영.
 * 쿠콘 결과 파일 내용을 붙여넣으면 각 건을 지급완료/지급실패로 반영한다.
 * 형식: 각 줄에 "요청ID,SUCCESS|FAIL,사유(선택)"
 */
export async function applyPayoutResultsAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '정산 처리');
    const raw = text(fd, 'results');
    if (!raw) throw new Error('결과 내용을 붙여넣어 주세요.');
    /**
     * 이체파일 배치번호. **필수**다.
     *
     * 예전에는 비워 두면 검사 자체를 건너뛰었다. 그래서 지난 배치의 결과 파일을 실수로
     * 다시 붙여넣으면, 2차 배치로 정상 지급된 건이 1차 결과(FAIL)로 되돌아가 원장이
     * 환입되고 잔액이 되살아났다. 실제로는 나간 돈인데 재신청·재지급 경로가 열린다.
     * 화면 안내가 "이 사고를 막습니다"라고 적혀 있으니 실제로 막아야 한다.
     */
    const batchNo = text(fd, 'batchNo').trim().toUpperCase();
    if (!batchNo) {
      throw new Error('이체파일 배치번호를 입력해 주세요. (지난 결과 파일을 잘못 반영하는 사고를 막습니다)');
    }
    if (!/^B[A-Z0-9]{6,20}$/.test(batchNo)) {
      throw new Error('배치번호 형식이 올바르지 않습니다. 이체파일을 내려받을 때 안내된 값(B로 시작)을 그대로 입력해 주세요.');
    }

    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let ok = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const line of lines) {
      const [id, result, ...rest] = line.split(',').map((s) => s.trim());
      if (!id || !result) continue;
      const reason = rest.join(',').trim();
      try {
        const up = result.toUpperCase();
        const req = await prisma.settlementRequest.findUnique({
          where: { id },
          select: {
            creatorId: true, payoutAmount: true, status: true,
            payoutBatchNo: true, payoutIssuedAt: true,
          },
        });
        if (!req) {
          errors.push(`${id.slice(-6)}: 요청을 찾을 수 없음`);
          continue;
        }

        // ── 지난 결과 파일 재반영 방지 ─────────────────────────────────
        // 예전 파일을 다시 붙여넣으면 이미 정상 지급된 건이 '지급 실패'로 되돌아가
        // 원장이 환입되고 잔액이 되살아난다(= 이중 지급의 씨앗).
        if (!req.payoutIssuedAt) {
          errors.push(`${id.slice(-6)}: 이체파일이 발급된 적 없는 건`);
          continue;
        }
        if (req.payoutBatchNo !== batchNo) {
          errors.push(`${id.slice(-6)}: 배치번호 불일치(${req.payoutBatchNo ?? '없음'})`);
          continue;
        }

        if (up === 'SUCCESS' || up === 'OK' || up === '성공') {
          if (req.status === 'PAID') { ok += 1; continue; } // 이미 반영됨 (멱등)
          await markSettlementPaid(id, admin.id, reason || undefined);
          await notifySettlement(req.creatorId, '정산 지급이 완료되었습니다', `${formatWon(req.payoutAmount)}이 지급 처리되었습니다.`);
          ok += 1;
        } else if (up === 'FAIL' || up === 'ERROR' || up === '실패') {
          if (req.status === 'PAYOUT_FAILED') { failed += 1; continue; } // 이미 반영됨 (멱등)
          await markSettlementPayoutFailed(id, reason || '지급대행 실패', admin.id);
          await notifySettlement(req.creatorId, '정산 지급이 실패했습니다', `사유: ${reason || '지급대행 실패'}. 계좌를 확인하고 다시 요청해 주세요.`);
          // 지급 실패 건도 신고 대상이 아니므로 주민등록번호를 파기한다.
          await purgeResidentIfNotFilable(id);
          failed += 1;
        } else {
          errors.push(`${id.slice(-6)}: 알 수 없는 결과 '${result}'`);
        }
      } catch (e) {
        errors.push(`${id.slice(-6)}: ${(e as Error).message}`);
      }
    }

    await writeAudit({
      adminUserId: admin.id,
      action: 'SETTLEMENT_PAYOUT_RESULT',
      targetType: 'SettlementRequest',
      after: { ok, failed, lines: lines.length },
    });
    revalidatePath('/admin/settlements');
    const base = `지급 완료 ${ok}건, 지급 실패 ${failed}건 반영했습니다.`;
    return errors.length ? `${base} (오류 ${errors.length}건: ${errors.slice(0, 3).join(' / ')})` : base;
  });
}

/**
 * 원천징수 신고 완료 + 주민등록번호 파기.
 * 지급명세서 신고를 마친 뒤 호출한다. 주민등록번호 원문만 삭제하고 회계 기록은 유지한다.
 */
export async function fileWithholdingAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '정산 처리');
    const ids = fd.getAll('requestId').map((v) => String(v)).filter(Boolean);
    const single = optText(fd, 'requestIdSingle');
    if (single) ids.push(single);
    if (ids.length === 0) throw new Error('처리할 정산 요청을 선택해 주세요.');

    let purged = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const r = await fileWithholdingAndPurgeResident(id, admin.id);
        if (r.purged) purged += 1;
      } catch (e) {
        errors.push(`${id.slice(-6)}: ${(e as Error).message}`);
      }
    }

    await writeAudit({
      adminUserId: admin.id,
      action: 'SETTLEMENT_WITHHOLDING_FILED',
      targetType: 'SettlementRequest',
      targetId: ids.join(','),
      after: { count: ids.length, purged },
    });
    revalidatePath('/admin/settlements');
    return `원천징수 신고 완료 처리했습니다. 주민등록번호 ${purged}건을 파기했습니다.`;
  });
}

// =========================================================== 수수료 정책

export async function createFeePolicy(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '수수료 정책 변경');
    const scope = enumValue(fd, 'scope', ['GLOBAL', 'CREATOR'] as const, '적용 범위');
    const creatorId = scope === 'CREATOR' ? requiredId(fd, 'creatorId', '크리에이터') : null;
    const pgFeeRate = rate(fd, 'pgFeeRate', '결제');
    const platformFeeRate = rate(fd, 'platformFeeRate', '플랫폼');
    const pgFixedFee = money(fd, 'pgFixedFee', '결제 건당 고정비');
    const smsCost = money(fd, 'smsCost', '문자 원가');
    const vatIncluded = text(fd, 'vatIncluded') === 'on';
    const effectiveFrom = optDate(fd, 'effectiveFrom', '적용 시작일') ?? new Date();

    // 각 요율만 0~1 로 보면 0.95 + 0.1 같은 조합이 통과한다.
    // 그러면 수수료 합이 후원금을 넘어 크리에이터 정산금이 음수가 되고,
    // 화면에는 0원으로 보이는데 원장에는 마이너스가 쌓여 다른 후원의 정산 가능액까지 깎인다.
    // (자릿수를 하나 잘못 찍는 실수를 여기서 잡는다)
    if (Number(pgFeeRate) + Number(platformFeeRate) >= 1) {
      throw new Error('결제 수수료와 플랫폼 수수료의 합이 100% 이상입니다. 요율을 다시 확인해 주세요.');
    }

    if (creatorId) {
      const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { id: true } });
      if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');
    }

    const previous = await prisma.feePolicy.findMany({
      where: { active: true, scope, creatorId },
      select: { id: true, pgFeeRate: true, platformFeeRate: true },
    });

    const created = await prisma.$transaction(async (tx) => {
      // 이력 보존: 기존 정책은 삭제하지 않고 마감한다.
      await tx.feePolicy.updateMany({
        where: { active: true, scope, creatorId },
        data: { active: false, effectiveTo: effectiveFrom },
      });
      return tx.feePolicy.create({
        data: {
          id: newId(),
          scope,
          creatorId,
          pgFeeRate,
          pgFixedFee,
          platformFeeRate,
          smsCost,
          vatIncluded,
          active: true,
          effectiveFrom,
        },
      });
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'FEE_POLICY_CREATE',
      targetType: 'FeePolicy',
      targetId: created.id,
      before: { closed: previous.map((p) => ({ id: p.id, pgFeeRate: p.pgFeeRate.toString(), platformFeeRate: p.platformFeeRate.toString() })) },
      after: { scope, creatorId, pgFeeRate, pgFixedFee, platformFeeRate, smsCost, vatIncluded, effectiveFrom },
    });
    revalidatePath('/admin/fees');
    return '새 수수료 정책을 등록했습니다. 기존 정책은 마감 처리되었습니다.';
  });
}

export async function deactivateFeePolicy(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '수수료 정책 변경');
    const id = requiredId(fd, 'id', '수수료 정책');
    const before = await prisma.feePolicy.findUnique({ where: { id } });
    if (!before) throw new Error('수수료 정책을 찾을 수 없습니다.');
    if (!before.active) throw new Error('이미 마감된 정책입니다.');

    await prisma.feePolicy.update({ where: { id }, data: { active: false, effectiveTo: new Date() } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'FEE_POLICY_DEACTIVATE',
      targetType: 'FeePolicy',
      targetId: id,
      before: { active: true, scope: before.scope, creatorId: before.creatorId },
      after: { active: false },
    });
    revalidatePath('/admin/fees');
    return '수수료 정책을 마감했습니다.';
  });
}
