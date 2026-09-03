'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, money, int, bool, enumValue, requiredId, optDate } from './shared';
import { bannedNeedle } from '@/server/services/content-filter';

/**
 * 한도 정책 / 약관 버전 / 신고·금칙어 운영 액션.
 */

// =========================================================== 한도 정책

function readLimitFields(fd: FormData) {
  const defaultAmount = money(fd, 'defaultAmount', '기본 후원금', { min: 1n });
  const minAmount = money(fd, 'minAmount', '1회 최소', { min: 1n });
  const maxAmount = money(fd, 'maxAmount', '1회 최대', { min: 1n });
  const donorDailyLimit = money(fd, 'donorDailyLimit', '후원자 일 한도', { min: 1n });
  const donorMonthlyLimit = money(fd, 'donorMonthlyLimit', '후원자 월 한도', { min: 1n });
  const perCreatorDailyLimit = money(fd, 'perCreatorDailyLimit', '크리에이터별 일 한도', { min: 1n });
  const newDonorFirstDayLimit = money(fd, 'newDonorFirstDayLimit', '신규 후원자 첫날 한도', { min: 1n });
  const manualReviewAmount = money(fd, 'manualReviewAmount', '수동 검수 기준', { min: 1n });
  const ttsMinAmount = money(fd, 'ttsMinAmount', 'TTS 최소 후원금');

  const donorDailyMaxCount = int(fd, 'donorDailyMaxCount', { min: 1, max: 10000, label: '1인 1일 최대 건수' });
  const velocityWindowSec = int(fd, 'velocityWindowSec', { min: 1, max: 86400, label: '속도 제한 구간(초)' });
  const velocityMaxCount = int(fd, 'velocityMaxCount', { min: 1, max: 1000, label: '속도 제한 건수' });
  const cooldownAfterCount = int(fd, 'cooldownAfterCount', { min: 1, max: 1000, label: '연속 후원 기준 건수' });
  const cooldownSec = int(fd, 'cooldownSec', { min: 1, max: 86400, label: '연속 후원 대기(초)' });
  const failureLockThreshold = int(fd, 'failureLockThreshold', { min: 1, max: 50, label: '결제 실패 허용' });

  if (minAmount > maxAmount) throw new Error('1회 최소 금액이 최대 금액보다 클 수 없습니다.');
  if (defaultAmount < minAmount || defaultAmount > maxAmount) {
    throw new Error('기본 후원금은 1회 최소~최대 범위 안에 있어야 합니다.');
  }
  if (donorDailyLimit > donorMonthlyLimit) throw new Error('후원자 일 한도가 월 한도보다 클 수 없습니다.');
  if (newDonorFirstDayLimit > donorDailyLimit) throw new Error('신규 후원자 첫날 한도가 일 한도보다 클 수 없습니다.');

  return {
    defaultAmount, minAmount, maxAmount,
    donorDailyLimit, donorMonthlyLimit, perCreatorDailyLimit, donorDailyMaxCount,
    velocityWindowSec, velocityMaxCount, cooldownAfterCount, cooldownSec,
    failureLockThreshold, newDonorFirstDayLimit, manualReviewAmount, ttsMinAmount,
  };
}

export async function saveLimitPolicy(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = optText(fd, 'id');
    const values = readLimitFields(fd);
    const active = bool(fd, 'active');
    const effectiveFrom = optDate(fd, 'effectiveFrom', '적용 시작일') ?? new Date();

    if (id) {
      const before = await prisma.donationLimitPolicy.findUnique({ where: { id } });
      if (!before) throw new Error('한도 정책을 찾을 수 없습니다.');

      /**
       * "활성 전역 정책은 1개" 규칙은 **수정 경로에도** 적용해야 한다.
       *
       * 예전에는 신규 생성 분기에만 있어서, 비활성 전역 정책을 수정하며 활성으로 바꾸면
       * 활성 전역 정책이 둘이 됐다. limits.ts 는 시행일 순으로 하나만 집으므로
       * 어느 한도가 적용되는지 비결정적이 되고, 결제 한도는 이상거래 방어선이라 영향이 크다.
       */
      if (before.scope === 'GLOBAL' && active) {
        const otherActive = await prisma.donationLimitPolicy.count({
          where: { scope: 'GLOBAL', active: true, id: { not: id } },
        });
        if (otherActive > 0) {
          throw new Error('활성 전역 정책이 이미 있습니다. 기존 정책을 먼저 비활성화해 주세요.');
        }
      }

      await prisma.donationLimitPolicy.update({ where: { id }, data: { ...values, active, effectiveFrom } });
      await writeAudit({
        adminUserId: admin.id,
        action: 'LIMIT_POLICY_UPDATE',
        targetType: 'DonationLimitPolicy',
        targetId: id,
        before: {
          scope: before.scope,
          defaultAmount: before.defaultAmount, minAmount: before.minAmount, maxAmount: before.maxAmount,
          donorDailyLimit: before.donorDailyLimit, donorMonthlyLimit: before.donorMonthlyLimit,
          perCreatorDailyLimit: before.perCreatorDailyLimit,
          donorDailyMaxCount: before.donorDailyMaxCount,
          velocityWindowSec: before.velocityWindowSec, velocityMaxCount: before.velocityMaxCount,
          cooldownAfterCount: before.cooldownAfterCount, cooldownSec: before.cooldownSec,
          failureLockThreshold: before.failureLockThreshold,
          newDonorFirstDayLimit: before.newDonorFirstDayLimit,
          manualReviewAmount: before.manualReviewAmount, ttsMinAmount: before.ttsMinAmount,
          active: before.active,
        },
        after: { ...values, active, effectiveFrom },
      });
      revalidatePath('/admin/policies');
      return '한도 정책을 저장했습니다.';
    }

    const scope = enumValue(fd, 'scope', ['GLOBAL', 'CREATOR', 'DONOR'] as const, '적용 범위');
    const creatorId = scope === 'CREATOR' ? requiredId(fd, 'creatorId', '크리에이터') : null;
    const donorId = scope === 'DONOR' ? requiredId(fd, 'donorId', '후원자') : null;

    if (scope === 'GLOBAL') {
      const existingGlobal = await prisma.donationLimitPolicy.count({ where: { scope: 'GLOBAL', active: true } });
      if (existingGlobal > 0 && active) {
        throw new Error('활성 전역 정책이 이미 있습니다. 기존 정책을 먼저 비활성화해 주세요.');
      }
    }
    if (creatorId) {
      const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { id: true } });
      if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');
    }
    if (donorId) {
      const donor = await prisma.donorProfile.findUnique({ where: { id: donorId }, select: { id: true } });
      if (!donor) throw new Error('후원자를 찾을 수 없습니다.');
    }

    const created = await prisma.donationLimitPolicy.create({
      data: { id: newId(), scope, creatorId, donorId, ...values, active, effectiveFrom },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'LIMIT_POLICY_CREATE',
      targetType: 'DonationLimitPolicy',
      targetId: created.id,
      after: { scope, creatorId, donorId, ...values, active, effectiveFrom },
    });
    revalidatePath('/admin/policies');
    return '새 한도 정책을 등록했습니다.';
  });
}

export async function toggleLimitPolicy(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = requiredId(fd, 'id', '한도 정책');
    const before = await prisma.donationLimitPolicy.findUnique({
      where: { id },
      select: { id: true, active: true, scope: true },
    });
    if (!before) throw new Error('한도 정책을 찾을 수 없습니다.');

    const active = !before.active;
    // 활성화하는 경우에만 검사한다(비활성화는 언제나 안전하다).
    if (active && before.scope === 'GLOBAL') {
      const otherActive = await prisma.donationLimitPolicy.count({
        where: { scope: 'GLOBAL', active: true, id: { not: id } },
      });
      if (otherActive > 0) {
        throw new Error('활성 전역 정책이 이미 있습니다. 기존 정책을 먼저 비활성화한 뒤 활성화해 주세요.');
      }
    }
    await prisma.donationLimitPolicy.update({
      where: { id },
      data: { active, effectiveTo: active ? null : new Date() },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'LIMIT_POLICY_TOGGLE',
      targetType: 'DonationLimitPolicy',
      targetId: id,
      before: { active: before.active, scope: before.scope },
      after: { active },
    });
    revalidatePath('/admin/policies');
    return active ? '정책을 활성화했습니다.' : '정책을 비활성화했습니다.';
  });
}

// =========================================================== 약관 버전

export async function createTermsVersion(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 약관은 법적 효력이 있는 문서다. 새 버전을 발행하면 기존 버전이 비활성화된다.
    // 정산·수수료보다 낮은 문턱으로 열어 둘 이유가 없다.
    if (admin.adminPermission !== 'SUPER_ADMIN') {
      throw new Error('약관 버전 발행은 최고관리자만 할 수 있습니다.');
    }
    const type = enumValue(
      fd,
      'type',
      ['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM', 'MARKETING'] as const,
      '약관 유형',
    );
    const version = text(fd, 'version');
    const title = text(fd, 'title');
    const content = text(fd, 'content');
    const required = bool(fd, 'required');
    const effectiveFrom = optDate(fd, 'effectiveFrom', '시행일') ?? new Date();

    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$|^v?[0-9]+(\.[0-9]+)*$/.test(version)) {
      throw new Error('버전은 1.0 또는 2026-01-01 형식으로 입력해 주세요.');
    }
    if (title.length < 2) throw new Error('약관 제목을 입력해 주세요.');
    if (content.length < 10) throw new Error('약관 본문을 10자 이상 입력해 주세요.');

    const dup = await prisma.termsVersion.findUnique({ where: { type_version: { type, version } } });
    if (dup) throw new Error('같은 유형의 동일 버전이 이미 있습니다.');

    const created = await prisma.$transaction(async (tx) => {
      // 기존 버전은 비활성 처리만 한다. 동의 이력 보존을 위해 삭제하지 않는다.
      await tx.termsVersion.updateMany({ where: { type, active: true }, data: { active: false } });
      return tx.termsVersion.create({
        data: { id: newId(), type, version, title, content, required, effectiveFrom, active: true },
      });
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'TERMS_VERSION_CREATE',
      targetType: 'TermsVersion',
      targetId: created.id,
      after: { type, version, title, required, effectiveFrom },
    });
    revalidatePath('/admin/terms');
    return `${type} ${version} 버전을 등록했습니다. 이전 버전은 비활성 처리되었습니다.`;
  });
}

// =========================================================== 신고 / 금칙어

export async function updateReportStatus(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const reportId = requiredId(fd, 'reportId', '신고');
    const status = enumValue(fd, 'status', ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'] as const, '처리 상태');

    const before = await prisma.report.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, category: true },
    });
    if (!before) throw new Error('신고를 찾을 수 없습니다.');
    if (before.status === status) throw new Error('이미 해당 상태입니다.');

    const closed = status === 'RESOLVED' || status === 'DISMISSED';
    await prisma.report.update({
      where: { id: reportId },
      data: { status, handledBy: admin.id, handledAt: closed ? new Date() : null },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'REPORT_STATUS_UPDATE',
      targetType: 'Report',
      targetId: reportId,
      before: { status: before.status },
      after: { status, handledBy: admin.id },
    });
    revalidatePath('/admin/moderation');
    return '신고 처리 상태를 변경했습니다.';
  });
}

export async function createBannedWord(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const word = text(fd, 'word');
    const action = enumValue(fd, 'action', ['BLOCK', 'MASK', 'FLAG'] as const, '처리 방식');
    if (word.length < 1 || word.length > 40) throw new Error('금칙어는 1 ~ 40자로 입력해 주세요.');
    // 비교에서 무시하는 문자(공백·구두점)만으로 된 단어는 금칙어 구실을 못 한다.
    if (!bannedNeedle(word)) throw new Error('공백이나 기호(. _ - * ~ = + /)만으로는 금칙어를 만들 수 없습니다.');

    const dup = await prisma.bannedWord.findFirst({ where: { scope: 'GLOBAL', word } });
    if (dup) throw new Error('이미 등록된 전역 금칙어입니다.');

    const created = await prisma.bannedWord.create({
      data: { id: newId(), word, action, scope: 'GLOBAL', active: true },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'BANNED_WORD_CREATE',
      targetType: 'BannedWord',
      targetId: created.id,
      after: { word, action, scope: 'GLOBAL' },
    });
    revalidatePath('/admin/moderation');
    return `금칙어 "${word}" 를 등록했습니다.`;
  });
}

export async function deleteBannedWord(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = requiredId(fd, 'id', '금칙어');
    const before = await prisma.bannedWord.findUnique({ where: { id } });
    if (!before) throw new Error('금칙어를 찾을 수 없습니다.');
    if (before.scope !== 'GLOBAL') throw new Error('크리에이터 개별 금칙어는 통합 관리자에서 삭제할 수 없습니다.');

    await prisma.bannedWord.delete({ where: { id } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'BANNED_WORD_DELETE',
      targetType: 'BannedWord',
      targetId: id,
      before: { word: before.word, action: before.action, scope: before.scope },
    });
    revalidatePath('/admin/moderation');
    return `금칙어 "${before.word}" 를 삭제했습니다.`;
  });
}
