'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { notifyUser } from '@/server/services/notifications';
import { newId, newCreatorCode } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { formatMoNumber } from '@/server/emma';
import type { AdminActionState } from '@/components/admin/state';
import { issueMoNumberForCreator, reclaimMoNumberForCreator } from '@/server/services/mo-number-issue';
import { issueTemporaryPassword } from '@/server/services/password-reset';
import { hasDirectTriggerWrittenApproval } from '@/server/services/financial-approval';
import { resolvePolicy } from '@/server/services/limits';
import { run, text, optText, money, optMoney, enumValue, requiredId, assertOperationAdmin } from './shared';

/**
 * 회원 / 후원자 / 크리에이터 / 코드 / 관리자 권한 관련 서버 액션.
 * 모든 변경은 writeAudit 으로 변경 전/후 값을 남긴다.
 */

// =========================================================== 회원 상태

export async function updateUserStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const userId = requiredId(fd, 'userId', '회원');
    const status = enumValue(fd, 'status', ['ACTIVE', 'SUSPENDED', 'WITHDRAWN'] as const, '회원 상태');

    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, role: true },
    });
    if (!before) throw new Error('회원을 찾을 수 없습니다.');
    if (before.id === admin.id) throw new Error('본인 계정의 상태는 변경할 수 없습니다.');
    if (before.status === status) throw new Error('이미 해당 상태입니다.');
    /**
     * 관리자 계정의 상태 변경은 최고관리자만 할 수 있다.
     *
     * 상태를 내리면 그 계정의 모든 세션이 즉시 무효화되고 재로그인도 막힌다.
     * 이 가드가 없으면 고객지원·재무 계정 하나로 **모든 최고관리자를 잠글 수 있다.**
     * (바로 아래 임시 비밀번호 발급에는 같은 가드가 이미 있었다)
     */
    if (before.role === 'ADMIN' && admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 계정의 상태 변경은 SUPER_ADMIN 만 수행할 수 있습니다.');
    }

    await prisma.user.update({ where: { id: userId }, data: { status } });
    if (status !== 'ACTIVE') {
      // 상태가 내려가면 활성 세션을 즉시 만료시킨다.
      await prisma.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await writeAudit({
      adminUserId: admin.id,
      action: 'USER_STATUS_UPDATE',
      targetType: 'User',
      targetId: userId,
      before: { status: before.status },
      after: { status },
    });
    revalidatePath('/admin/users');
    return `${before.email ?? userId} 회원 상태를 변경했습니다.`;
  });
}

/**
 * 임시 비밀번호 발급.
 *
 * 고객센터 경로로 **본인 확인을 마친 뒤에만** 사용한다. 발급 즉시 기존 비밀번호는
 * 사용할 수 없게 되고, 해당 계정의 모든 세션이 끊기며, 살아 있던 재설정 링크도 무효가 된다.
 *
 * 발급된 비밀번호는 이 응답에서 **한 번만** 볼 수 있다(해시만 저장한다).
 * 감사 로그에도 비밀번호 원문은 남기지 않는다.
 */
export async function issueTemporaryPasswordAction(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'READ_ONLY') throw new Error('읽기 전용 권한입니다.');
    const userId = requiredId(fd, 'userId', '회원');

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, deletedAt: true, role: true },
    });
    if (!target) throw new Error('회원을 찾을 수 없습니다.');
    if (target.deletedAt || target.status !== 'ACTIVE') {
      throw new Error('활성 상태의 계정에만 임시 비밀번호를 발급할 수 있습니다.');
    }
    if (target.id === admin.id) {
      throw new Error('본인 계정에는 임시 비밀번호를 발급할 수 없습니다.');
    }
    // 관리자 계정 비밀번호 초기화는 최고관리자만 할 수 있게 한다(권한 상승 경로 차단).
    if (target.role === 'ADMIN' && admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 계정의 임시 비밀번호 발급은 SUPER_ADMIN 만 수행할 수 있습니다.');
    }

    const { password } = await issueTemporaryPassword(userId);

    await writeAudit({
      adminUserId: admin.id,
      action: 'USER_TEMP_PASSWORD_ISSUE',
      targetType: 'User',
      targetId: userId,
      after: { email: target.email, sessionsRevoked: true },
    });
    revalidatePath('/admin/users');
    return {
      message: `${target.email ?? userId} 계정의 임시 비밀번호를 발급했습니다. 이 값은 지금 화면에서만 확인할 수 있습니다.`,
      detail: { tempPassword: password },
    };
  });
}

// =========================================================== 후원자

export async function unlockDonor(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const donorId = requiredId(fd, 'donorId', '후원자');
    const before = await prisma.donorProfile.findUnique({
      where: { id: donorId },
      select: { id: true, phoneMasked: true, failCount: true, lockedUntil: true },
    });
    if (!before) throw new Error('후원자를 찾을 수 없습니다.');

    await prisma.donorProfile.update({
      where: { id: donorId },
      data: { lockedUntil: null, failCount: 0 },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'DONOR_UNLOCK',
      targetType: 'DonorProfile',
      targetId: donorId,
      before: { lockedUntil: before.lockedUntil, failCount: before.failCount },
      after: { lockedUntil: null, failCount: 0 },
    });
    revalidatePath('/admin/donors');
    revalidatePath(`/admin/donors/${donorId}`);
    return `${before.phoneMasked} 후원자의 결제 실패 잠금을 해제했습니다.`;
  });
}

export async function setDonorBlock(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const donorId = requiredId(fd, 'donorId', '후원자');
    const next = enumValue(fd, 'next', ['BLOCK', 'UNBLOCK'] as const, '처리 구분');
    const reason = optText(fd, 'reason');
    if (next === 'BLOCK' && (!reason || reason.length < 2)) {
      throw new Error('이용 제한 사유를 2자 이상 입력해 주세요.');
    }

    const before = await prisma.donorProfile.findUnique({
      where: { id: donorId },
      select: { id: true, phoneMasked: true, blockedAt: true, blockedReason: true },
    });
    if (!before) throw new Error('후원자를 찾을 수 없습니다.');

    const after =
      next === 'BLOCK'
        ? { blockedAt: new Date(), blockedReason: reason }
        : { blockedAt: null, blockedReason: null };

    await prisma.donorProfile.update({ where: { id: donorId }, data: after });
    await writeAudit({
      adminUserId: admin.id,
      action: next === 'BLOCK' ? 'DONOR_BLOCK' : 'DONOR_UNBLOCK',
      targetType: 'DonorProfile',
      targetId: donorId,
      before: { blockedAt: before.blockedAt, blockedReason: before.blockedReason },
      after,
    });
    revalidatePath('/admin/donors');
    revalidatePath(`/admin/donors/${donorId}`);
    return next === 'BLOCK'
      ? `${before.phoneMasked} 후원자의 이용을 제한했습니다.`
      : `${before.phoneMasked} 후원자의 이용 제한을 해제했습니다.`;
  });
}

export async function updateDonorLimitsByAdmin(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const donorId = requiredId(fd, 'donorId', '후원자');
    const dailyLimit = optMoney(fd, 'dailyLimit', '일일 한도');
    const monthlyLimit = optMoney(fd, 'monthlyLimit', '월간 한도');
    if (dailyLimit !== null && monthlyLimit !== null && dailyLimit > monthlyLimit) {
      throw new Error('일일 한도는 월간 한도보다 클 수 없습니다.');
    }
    if ((dailyLimit !== null && dailyLimit <= 0n) || (monthlyLimit !== null && monthlyLimit <= 0n)) {
      throw new Error('한도는 0원보다 커야 합니다. 이용을 막으려면 [이용 제한]을 사용해 주세요.');
    }

    /**
     * **개인 한도는 전역 정책을 넘을 수 없다.**
     *
     * `checkLimits` 는 개인값이 있으면 정책보다 우선 적용한다. 그래서 상한 검증이 없으면
     * 관리자 화면에서 특정 후원자의 한도를 15자리까지 올려 플랫폼 한도 정책을 무제한으로
     * 우회시킬 수 있었다. 후원자 본인 화면(actions/donor.ts)은 이미 정책 초과를 막고 있으니
     * 관리자 경로도 같은 기준을 따른다. 정말 필요하면 전역 정책 자체를 바꿔야 한다.
     */
    const policy = await resolvePolicy(null, donorId);
    if (dailyLimit !== null && dailyLimit > policy.donorDailyLimit) {
      throw new Error(
        `일일 한도는 전역 정책(${policy.donorDailyLimit.toString()}원)을 넘을 수 없습니다. ` +
          '더 높이려면 한도 정책을 변경해 주세요.',
      );
    }
    if (monthlyLimit !== null && monthlyLimit > policy.donorMonthlyLimit) {
      throw new Error(
        `월간 한도는 전역 정책(${policy.donorMonthlyLimit.toString()}원)을 넘을 수 없습니다. ` +
          '더 높이려면 한도 정책을 변경해 주세요.',
      );
    }

    const before = await prisma.donorProfile.findUnique({
      where: { id: donorId },
      select: { id: true, phoneMasked: true, dailyLimit: true, monthlyLimit: true },
    });
    if (!before) throw new Error('후원자를 찾을 수 없습니다.');

    await prisma.donorProfile.update({ where: { id: donorId }, data: { dailyLimit, monthlyLimit } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'DONOR_LIMIT_UPDATE',
      targetType: 'DonorProfile',
      targetId: donorId,
      before: { dailyLimit: before.dailyLimit, monthlyLimit: before.monthlyLimit },
      after: { dailyLimit, monthlyLimit },
    });
    revalidatePath('/admin/donors');
    revalidatePath(`/admin/donors/${donorId}`);
    return `${before.phoneMasked} 후원자의 개인 한도를 저장했습니다.`;
  });
}

// =========================================================== 크리에이터 심사

export async function updateCreatorStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 승인 취소·정지는 크리에이터의 수입이 그날로 끊기는 조치다. 고객지원 권한으로 할 일이 아니다.
    assertOperationAdmin(admin, '크리에이터 심사 상태 변경');
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const status = enumValue(fd, 'status', ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const, '심사 상태');

    const before = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, userId: true, displayName: true, status: true, approvedAt: true, suspendedAt: true },
    });
    if (before && before.status === status) throw new Error('이미 같은 심사 상태입니다.');
    if (!before) throw new Error('크리에이터를 찾을 수 없습니다.');

    const now = new Date();
    const data =
      status === 'APPROVED'
        ? { status, approvedAt: before.approvedAt ?? now, suspendedAt: null }
        : status === 'SUSPENDED'
          ? { status, suspendedAt: now }
          : { status };

    await prisma.creatorProfile.update({ where: { id: creatorId }, data });

    /**
     * 승인과 동시에 MO 서브번호를 발급한다.
     *
     * 뒤 4자리는 인포뱅크 승인 없이 우리가 직접 부여하므로, 관리자가 따로 배정해 줄 때까지
     * 기다릴 이유가 없다. 승인 즉시 후원을 받을 수 있게 한다.
     *
     * 실패해도 승인 자체는 되돌리지 않는다. 대표번호 계약 전이거나 번호가 소진된 상황에서
     * 심사 승인까지 막히면 운영이 멈춘다. 대신 결과를 관리자에게 문장으로 알려 준다.
     */
    let numberNotice = '';
    if (status === 'APPROVED') {
      try {
        const issued = await issueMoNumberForCreator(creatorId);
        numberNotice = issued.reused
          ? ` (기존 배정 번호 ${formatMoNumber(issued.phoneNumber)} 유지)`
          : ` MO 번호 ${formatMoNumber(issued.phoneNumber)} 을(를) 발급했습니다.`;
      } catch (e) {
        numberNotice = ` (MO 번호 자동 발급 실패: ${(e as Error).message} — 관리자 화면에서 수동 배정해 주세요)`;
        logger.warn('크리에이터 승인 후 MO 번호 자동 발급 실패', {
          creatorId,
          message: (e as Error).message,
        });
      }
    }

    /**
     * 승인이 풀리면(정지·반려·대기) 번호를 회수한다.
     * 배정을 남겨 두면 정지된 채널로 후원 문자가 계속 들어와 결제가 일어난다.
     */
    if (before.status === 'APPROVED' && status !== 'APPROVED') {
      const reclaimed = await reclaimMoNumberForCreator(creatorId, `심사 상태 ${status} 로 변경`).catch((e) => {
        logger.warn('크리에이터 상태 변경 시 MO 번호 회수 실패', { creatorId, message: (e as Error).message });
        return 0;
      });
      if (reclaimed > 0) numberNotice = ' 배정된 MO 번호는 회수했습니다.';
    }

    await notifyUser({
      userId: before.userId,
      title: status === 'APPROVED' ? '크리에이터 승인이 완료되었습니다' : '크리에이터 심사 상태가 변경되었습니다',
      body:
        status === 'APPROVED'
          ? '이제 크리에이터 관리자에서 후원샵과 방송 연동을 설정할 수 있습니다.'
          : `${before.displayName}님의 심사 상태가 ${status}(으)로 변경되었습니다.`,
      linkUrl: '/studio',
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'CREATOR_STATUS_UPDATE',
      targetType: 'CreatorProfile',
      targetId: creatorId,
      before: { status: before.status, approvedAt: before.approvedAt, suspendedAt: before.suspendedAt },
      after: data,
    });
    revalidatePath('/admin/creators');
    revalidatePath(`/admin/creators/${creatorId}`);
    return status === 'APPROVED'
      ? `${before.displayName} 님을 승인했습니다.${numberNotice}`
      : `${before.displayName} 님의 심사 상태를 변경했습니다.${numberNotice}`;
  });
}

export async function updateCreatorPaymentMode(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const raw = text(fd, 'paymentMode');
    if (!['', 'CONFIRM_LINK', 'DIRECT_TRIGGER'].includes(raw)) throw new Error('결제 모드 값이 올바르지 않습니다.');
    const paymentMode = raw === '' ? null : (raw as 'CONFIRM_LINK' | 'DIRECT_TRIGGER');

    if (paymentMode === 'DIRECT_TRIGGER') {
      // 환경변수(ALLOW_DIRECT_TRIGGER)만으로는 열지 않는다. DB 에 금융사 서면승인
      // 레코드가 실제로 있는 경우에만 허용한다(M-3).
      if (!env.safety.allowDirectTrigger || !(await hasDirectTriggerWrittenApproval())) {
        throw new Error('금융사 서면승인이 등록되지 않아 즉시형 결제를 활성화할 수 없습니다.');
      }
    }

    const before = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, displayName: true, paymentMode: true },
    });
    if (!before) throw new Error('크리에이터를 찾을 수 없습니다.');

    await prisma.creatorProfile.update({ where: { id: creatorId }, data: { paymentMode } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'CREATOR_PAYMENT_MODE_UPDATE',
      targetType: 'CreatorProfile',
      targetId: creatorId,
      before: { paymentMode: before.paymentMode },
      after: { paymentMode, allowDirectTrigger: env.safety.allowDirectTrigger },
    });
    revalidatePath(`/admin/creators/${creatorId}`);
    return `${before.displayName} 님의 결제 모드를 ${paymentMode ?? '전역 설정'} 으로 변경했습니다.`;
  });
}


// =========================================================== 크리에이터 1건 후원금 허용 범위

/** 크리에이터의 donationAmount 를 [min, max] 범위 안으로 보정한다. */
function clampAmount(amount: bigint, min: bigint, max: bigint): bigint {
  if (amount < min) return min;
  if (amount > max) return max;
  return amount;
}

/**
 * 크리에이터 1명의 1건 후원금 허용 범위(최소/최대)를 변경한다.
 * 현재 설정된 1건 후원금이 새 범위를 벗어나면 범위 안으로 자동 보정한다.
 */
export async function updateCreatorAmountBounds(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const minAmount = money(fd, 'minAmount', '1건 최소 후원금', { min: 100n });
    const maxAmount = money(fd, 'maxAmount', '1건 최대 후원금', { min: 100n });
    if (minAmount > maxAmount) throw new Error('최소 금액이 최대 금액보다 클 수 없습니다.');

    const before = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, displayName: true, minAmount: true, maxAmount: true, donationAmount: true },
    });
    if (!before) throw new Error('크리에이터를 찾을 수 없습니다.');

    const donationAmount = clampAmount(before.donationAmount, minAmount, maxAmount);
    const clamped = donationAmount !== before.donationAmount;

    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: { minAmount, maxAmount, donationAmount },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'CREATOR_AMOUNT_BOUNDS_UPDATE',
      targetType: 'CreatorProfile',
      targetId: creatorId,
      before: { minAmount: before.minAmount, maxAmount: before.maxAmount, donationAmount: before.donationAmount },
      after: { minAmount, maxAmount, donationAmount },
    });
    revalidatePath(`/admin/creators/${creatorId}`);
    revalidatePath('/admin/creators');
    return clamped
      ? `${before.displayName} 님의 허용 범위를 변경했고, 1건 후원금을 범위에 맞게 ${donationAmount.toString()}원으로 보정했습니다.`
      : `${before.displayName} 님의 1건 후원금 허용 범위를 변경했습니다.`;
  });
}

/**
 * 모든 크리에이터의 1건 후원금 허용 범위를 공통으로 일괄 적용한다.
 * 범위를 벗어난 크리에이터의 1건 후원금은 범위 안으로 자동 보정한다.
 */
export async function applyGlobalAmountBounds(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const minAmount = money(fd, 'minAmount', '1건 최소 후원금', { min: 100n });
    const maxAmount = money(fd, 'maxAmount', '1건 최대 후원금', { min: 100n });
    if (minAmount > maxAmount) throw new Error('최소 금액이 최대 금액보다 클 수 없습니다.');

    /**
     * 되돌릴 수 없는 일괄 변경이므로 **최고관리자·운영 권한으로 제한**하고,
     * 대상도 승인된 크리에이터로 좁힌다. 예전에는 where 없이 전 행을 덮어써
     * 반려·정지 채널까지 함께 바뀌었고, 개별 조정값도 한 번에 사라졌다.
     */
    if (admin.adminPermission !== 'SUPER_ADMIN' && admin.adminPermission !== 'OPERATION') {
      throw new Error('전체 일괄 적용은 최고관리자 또는 운영 권한에서만 가능합니다.');
    }

    const scope = { status: 'APPROVED' as const };
    const result = await prisma.$transaction(async (tx) => {
      const total = await tx.creatorProfile.count({ where: scope });
      await tx.creatorProfile.updateMany({ where: scope, data: { minAmount, maxAmount } });
      const below = await tx.creatorProfile.updateMany({
        where: { ...scope, donationAmount: { lt: minAmount } },
        data: { donationAmount: minAmount },
      });
      const above = await tx.creatorProfile.updateMany({
        where: { ...scope, donationAmount: { gt: maxAmount } },
        data: { donationAmount: maxAmount },
      });
      return { total, clamped: below.count + above.count };
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'CREATOR_AMOUNT_BOUNDS_APPLY_ALL',
      targetType: 'CreatorProfile',
      targetId: 'ALL',
      after: { minAmount, maxAmount, appliedTo: result.total, clamped: result.clamped },
    });
    revalidatePath('/admin/creators');
    revalidatePath('/studio/settings');
    return `크리에이터 ${result.total}명 전체에 1건 후원금 허용 범위 ${minAmount.toString()}원 ~ ${maxAmount.toString()}원을 적용했습니다.` +
      (result.clamped > 0 ? ` 범위를 벗어난 ${result.clamped}명의 1건 후원금을 자동 보정했습니다.` : '');
  });
}

// =========================================================== 정산 계좌 실명확인

/**
 * 정산 계좌 실명확인 처리.
 *
 * 예금주 실명확인 API 가 아직 연동 전이라, 통합 관리자가 증빙(사업자등록증·통장사본 등)을
 * 확인한 뒤 수동으로 인증 상태를 전환한다. 인증되지 않은 계좌로는 정산을 요청할 수 없다.
 * 계좌를 변경하면 저장 시점에 verified 가 다시 false 로 내려가므로 재확인이 필요하다.
 */
export async function setSettlementAccountVerified(
  _prev: AdminActionState,
  fd: FormData,
): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission === 'SUPPORT') {
      throw new Error('정산 계좌 실명확인은 재무/운영 권한에서만 가능합니다.');
    }
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const verified = text(fd, 'verified') === 'true';

    const before = await prisma.settlementAccount.findUnique({
      where: { creatorId },
      select: { id: true, verified: true, verifiedAt: true, bankName: true, accountTail4: true, holderMasked: true },
    });
    if (!before) throw new Error('등록된 정산 계좌가 없습니다. 크리에이터가 계좌를 먼저 등록해야 합니다.');
    if (before.verified === verified) {
      throw new Error(verified ? '이미 인증된 계좌입니다.' : '이미 미인증 상태입니다.');
    }

    const verifiedAt = verified ? new Date() : null;
    await prisma.settlementAccount.update({
      where: { creatorId },
      data: { verified, verifiedAt },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: verified ? 'SETTLEMENT_ACCOUNT_VERIFY' : 'SETTLEMENT_ACCOUNT_UNVERIFY',
      targetType: 'SettlementAccount',
      targetId: before.id,
      before: { verified: before.verified, verifiedAt: before.verifiedAt },
      after: {
        verified,
        verifiedAt,
        bankName: before.bankName,
        accountTail4: before.accountTail4,
        holderMasked: before.holderMasked,
      },
    });

    revalidatePath(`/admin/creators/${creatorId}`);
    revalidatePath('/admin/settlements');
    revalidatePath('/studio/settlement');
    return verified
      ? '정산 계좌를 실명확인 완료로 처리했습니다. 이제 크리에이터가 정산을 요청할 수 있습니다.'
      : '정산 계좌 인증을 해제했습니다. 재확인 전까지 정산 요청이 차단됩니다.';
  });
}

// =========================================================== 크리에이터 코드

async function generateUniqueCode(): Promise<string> {
  for (let i = 0; i < 30; i += 1) {
    const candidate = newCreatorCode();
    const [dupCode, dupProfile] = await Promise.all([
      prisma.creatorCode.findUnique({ where: { code: candidate }, select: { id: true } }),
      prisma.creatorProfile.findUnique({ where: { code: candidate }, select: { id: true } }),
    ]);
    if (!dupCode && !dupProfile) return candidate;
  }
  throw new Error('사용 가능한 코드를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

export async function reissueCreatorCode(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 코드를 바꾸면 밖에 안내된 기존 코드가 전부 죽는다. 되돌릴 수 없다.
    assertOperationAdmin(admin, '후원 코드 재발급');
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const before = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, displayName: true, code: true },
    });
    if (!before) throw new Error('크리에이터를 찾을 수 없습니다.');

    const nextCode = await generateUniqueCode();
    const now = new Date();

    await prisma.$transaction([
      prisma.creatorCode.updateMany({
        where: { creatorId, active: true },
        data: { active: false, revokedAt: now },
      }),
      prisma.creatorCode.create({
        data: { id: newId(), creatorId, code: nextCode, active: true, issuedAt: now },
      }),
      prisma.creatorProfile.update({ where: { id: creatorId }, data: { code: nextCode } }),
    ]);

    await writeAudit({
      adminUserId: admin.id,
      action: 'CREATOR_CODE_REISSUE',
      targetType: 'CreatorProfile',
      targetId: creatorId,
      before: { code: before.code },
      after: { code: nextCode },
    });
    revalidatePath('/admin/codes');
    revalidatePath(`/admin/creators/${creatorId}`);
    return `${before.displayName} 님의 코드를 ${nextCode} 로 재발급했습니다. 기존 링크(/c/${before.code})는 더 이상 동작하지 않습니다.`;
  });
}

// =========================================================== 관리자 권한

export async function updateAdminPermission(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 권한 변경은 SUPER_ADMIN 만 수행할 수 있습니다.');
    }
    const profileId = requiredId(fd, 'profileId', '관리자');
    const permission = enumValue(
      fd,
      'permission',
      ['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const,
      '권한',
    );

    const before = await prisma.adminProfile.findUnique({
      where: { id: profileId },
      select: { id: true, permission: true, userId: true, revokedAt: true, user: { select: { email: true } } },
    });
    if (!before) throw new Error('관리자를 찾을 수 없습니다.');
    // 자격이 회수된 계정은 권한만 올려도 콘솔에 들어오지 못한다(role 이 USER). 오해를 막는다.
    if (before.revokedAt) {
      throw new Error('관리자 자격이 회수된 계정입니다. 다시 부여하려면 [관리자 추가]에서 이메일로 등록해 주세요.');
    }
    if (before.userId === admin.id && permission !== before.permission) {
      throw new Error('본인의 권한은 변경할 수 없습니다. 다른 SUPER_ADMIN 에게 요청해 주세요.');
    }
    if (before.permission === permission) throw new Error('이미 해당 권한입니다.');

    if (before.permission === 'SUPER_ADMIN' && permission !== 'SUPER_ADMIN') {
      const superCount = await prisma.adminProfile.count({ where: { permission: 'SUPER_ADMIN', revokedAt: null } });
      if (superCount <= 1) throw new Error('마지막 SUPER_ADMIN 의 권한은 강등할 수 없습니다.');
    }

    await prisma.adminProfile.update({ where: { id: profileId }, data: { permission } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'ADMIN_PERMISSION_UPDATE',
      targetType: 'AdminProfile',
      targetId: profileId,
      before: { permission: before.permission },
      after: { permission },
    });
    revalidatePath('/admin/admins');
    return `${before.user.email ?? profileId} 의 권한을 ${permission} 으로 변경했습니다.`;
  });
}

// =========================================================== 관리자 권한 회수

/**
 * 관리자 자격을 **완전히** 회수한다(AdminProfile 삭제 + role 을 USER 로 되돌림).
 *
 * 기존 화면에는 권한 "변경" 만 있어서, 퇴사자를 처리할 수 있는 가장 낮은 단계가
 * READ_ONLY 였다. 그런데 READ_ONLY 도 후원자 연락처·결제 이력·정산 내역을 전부 열람한다.
 * 조직을 떠난 사람의 계정이 관리자 콘솔에 계속 들어올 수 있다는 뜻이다.
 *
 * 감사로그(admin_audit_log)는 누가 무엇을 했는지의 기록이므로 **지우지 않는다.**
 * 그래서 AdminProfile 행이 사라져도 로그의 adminUserId 는 그대로 남는다.
 */
export async function revokeAdmin(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 권한 회수는 SUPER_ADMIN 만 수행할 수 있습니다.');
    }
    const profileId = requiredId(fd, 'profileId', '관리자');

    const before = await prisma.adminProfile.findUnique({
      where: { id: profileId },
      select: { id: true, permission: true, userId: true, user: { select: { email: true, role: true } } },
    });
    if (!before) throw new Error('관리자를 찾을 수 없습니다.');

    // 본인 회수는 막는다. 실수 한 번으로 콘솔에서 스스로 잠기는 사고를 만들지 않는다.
    if (before.userId === admin.id) {
      throw new Error('본인의 관리자 자격은 회수할 수 없습니다. 다른 SUPER_ADMIN 에게 요청해 주세요.');
    }
    // 마지막 SUPER_ADMIN 을 없애면 아무도 권한을 되돌릴 수 없다.
    if (before.permission === 'SUPER_ADMIN') {
      const superCount = await prisma.adminProfile.count({ where: { permission: 'SUPER_ADMIN', revokedAt: null } });
      if (superCount <= 1) throw new Error('마지막 SUPER_ADMIN 의 자격은 회수할 수 없습니다.');
    }

    /**
     * 프로필 행은 남기고 회수 표시만 한다(감사로그 FK 보존). 실제 접근 차단은
     * role 을 USER 로 되돌리는 쪽이 한다 — requireAdmin 이 role 만 본다.
     * 권한도 READ_ONLY 로 낮춰, 나중에 role 이 잘못 되돌아가도 최소 권한만 남게 한다.
     * 열려 있는 세션도 함께 끊는다. 그러지 않으면 브라우저를 켜 둔 사람은 그대로 들어온다.
     */
    await prisma.$transaction([
      prisma.adminProfile.update({
        where: { id: profileId },
        data: { revokedAt: new Date(), permission: 'READ_ONLY' },
      }),
      prisma.user.update({ where: { id: before.userId }, data: { role: 'DONOR' } }),
      prisma.userSession.updateMany({
        where: { userId: before.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await writeAudit({
      adminUserId: admin.id,
      action: 'ADMIN_REVOKE',
      targetType: 'User',
      targetId: before.userId,
      before: { role: before.user.role, permission: before.permission },
      after: { role: 'DONOR', permission: null },
    });
    revalidatePath('/admin/admins');
    revalidatePath('/admin/users');
    return `${before.user.email ?? before.userId} 계정의 관리자 자격을 회수했습니다.`;
  });
}

// =========================================================== 관리자 추가 (기존 계정 승격)

export async function createAdminByEmail(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('관리자 추가는 SUPER_ADMIN 만 수행할 수 있습니다.');
    }
    const email = text(fd, 'email').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('이메일 형식을 확인해 주세요.');
    const permission = enumValue(
      fd,
      'permission',
      ['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const,
      '권한',
    );

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, role: true, status: true,
        adminProfile: { select: { id: true, revokedAt: true } },
      },
    });
    if (!user) throw new Error('해당 이메일로 가입된 계정이 없습니다. 먼저 일반 회원가입을 완료해 주세요.');
    // 자격을 회수했던 계정은 프로필 행이 남아 있다(감사로그 보존). 새로 만들지 말고 되살린다.
    if (user.adminProfile && !user.adminProfile.revokedAt) {
      throw new Error('이미 관리자로 등록된 계정입니다.');
    }
    if (user.role === 'CREATOR') {
      throw new Error('크리에이터 계정은 관리자를 겸할 수 없습니다. 별도 계정으로 등록해 주세요.');
    }
    if (user.status !== 'ACTIVE') throw new Error('활성 상태의 계정만 관리자로 등록할 수 있습니다.');

    const reinstating = !!user.adminProfile;
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } }),
      user.adminProfile
        ? prisma.adminProfile.update({
            where: { id: user.adminProfile.id },
            data: { permission, revokedAt: null },
          })
        : prisma.adminProfile.create({ data: { id: newId(), userId: user.id, permission } }),
    ]);

    await writeAudit({
      adminUserId: admin.id,
      action: reinstating ? 'ADMIN_REINSTATE' : 'ADMIN_CREATE',
      targetType: 'User',
      targetId: user.id,
      before: { role: user.role },
      after: { role: 'ADMIN', permission },
    });
    revalidatePath('/admin/admins');
    revalidatePath('/admin/users');
    return `${email} 계정을 ${permission} 권한의 관리자로 ${reinstating ? '다시 등록' : '등록'}했습니다.`;
  });
}
