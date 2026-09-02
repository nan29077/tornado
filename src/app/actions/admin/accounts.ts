'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { notifyUser } from '@/server/services/notifications';
import { newId, newCreatorCode } from '@/lib/id';
import { env } from '@/lib/env';
import type { AdminActionState } from '@/components/admin/state';
import { issueTemporaryPassword } from '@/server/services/password-reset';
import { hasDirectTriggerWrittenApproval } from '@/server/services/financial-approval';
import { run, text, optText, money, optMoney, enumValue, requiredId } from './shared';

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
      ? `${before.displayName} 님을 승인했습니다. MO 번호 배정을 이어서 진행해 주세요.`
      : `${before.displayName} 님의 심사 상태를 변경했습니다.`;
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

    const result = await prisma.$transaction(async (tx) => {
      const total = await tx.creatorProfile.count();
      await tx.creatorProfile.updateMany({ data: { minAmount, maxAmount } });
      const below = await tx.creatorProfile.updateMany({
        where: { donationAmount: { lt: minAmount } },
        data: { donationAmount: minAmount },
      });
      const above = await tx.creatorProfile.updateMany({
        where: { donationAmount: { gt: maxAmount } },
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
      select: { id: true, permission: true, userId: true, user: { select: { email: true } } },
    });
    if (!before) throw new Error('관리자를 찾을 수 없습니다.');
    if (before.userId === admin.id && permission !== before.permission) {
      throw new Error('본인의 권한은 변경할 수 없습니다. 다른 SUPER_ADMIN 에게 요청해 주세요.');
    }
    if (before.permission === permission) throw new Error('이미 해당 권한입니다.');

    if (before.permission === 'SUPER_ADMIN' && permission !== 'SUPER_ADMIN') {
      const superCount = await prisma.adminProfile.count({ where: { permission: 'SUPER_ADMIN' } });
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
      select: { id: true, role: true, status: true, adminProfile: { select: { id: true } } },
    });
    if (!user) throw new Error('해당 이메일로 가입된 계정이 없습니다. 먼저 일반 회원가입을 완료해 주세요.');
    if (user.adminProfile) throw new Error('이미 관리자로 등록된 계정입니다.');
    if (user.role === 'CREATOR') {
      throw new Error('크리에이터 계정은 관리자를 겸할 수 없습니다. 별도 계정으로 등록해 주세요.');
    }
    if (user.status !== 'ACTIVE') throw new Error('활성 상태의 계정만 관리자로 등록할 수 있습니다.');

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } }),
      prisma.adminProfile.create({ data: { id: newId(), userId: user.id, permission } }),
    ]);

    await writeAudit({
      adminUserId: admin.id,
      action: 'ADMIN_CREATE',
      targetType: 'User',
      targetId: user.id,
      before: { role: user.role },
      after: { role: 'ADMIN', permission },
    });
    revalidatePath('/admin/admins');
    revalidatePath('/admin/users');
    return `${email} 계정을 ${permission} 권한의 관리자로 등록했습니다.`;
  });
}
