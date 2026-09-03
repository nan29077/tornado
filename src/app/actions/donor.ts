'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { getSessionUser, destroySession } from '@/server/auth';
import { revokePaymentMethod } from '@/server/services/donor-registration';
import { requestRefund } from '@/server/services/refund';
import { resolvePolicy } from '@/server/services/limits';
import { validateDonorName } from '@/server/services/donor-name';
import { newId } from '@/lib/id';

/**
 * 후원자 마이페이지 서버 액션.
 *
 * 공통 규칙
 *  - 반드시 로그인 사용자의 DonorProfile 을 먼저 확인한다.
 *  - 모든 대상 레코드는 해당 donorId 소유인지 검증한 뒤에만 변경한다.
 */

export interface DonorActionState {
  ok: boolean;
  message?: string;
}

/** 로그인 사용자의 후원자 프로필. 없으면 null */
async function currentDonor() {
  const user = await getSessionUser();
  if (!user) return null;
  const donor = await prisma.donorProfile.findUnique({
    where: { userId: user.id },
    select: { id: true, dailyLimit: true, monthlyLimit: true },
  });
  if (!donor) return null;
  return { user, donor };
}

const NO_DONOR = '문자후원 이용 내역이 없어 처리할 수 없습니다.';
const NO_SESSION = '로그인이 필요합니다.';

// ---------------------------------------------------------------- 자동출금 해지

export async function revokeAutoWithdrawal(
  _prev: DonorActionState,
  _formData: FormData,
): Promise<DonorActionState> {
  const ctx = await currentDonor();
  if (!ctx) return { ok: false, message: NO_DONOR };

  try {
    const revoked = await revokePaymentMethod(ctx.donor.id);
    revalidatePath('/my/account');
    return revoked
      ? { ok: true, message: '자동출금 동의가 해지되었습니다. 등록된 결제수단이 폐기되었습니다.' }
      : { ok: false, message: '해지할 활성 결제수단이 없습니다.' };
  } catch (e) {
    // 실패를 조용히 삼키면 "탈퇴했는데 자동출금이 살아 있는" 상태를 아무도 모른다.
    logger.error('자동출금 수단 폐기 실패', { message: (e as Error).message });
    return { ok: false, message: '해지 처리 중 오류가 발생했습니다. 고객센터로 문의해 주세요.' };
  }
}

// ---------------------------------------------------------------- 한도 설정

const limitSchema = z.object({
  dailyLimit: z.string().trim(),
  monthlyLimit: z.string().trim(),
});

function parseLimit(input: string): bigint | null | 'INVALID' {
  const v = input.replace(/[,\s]/g, '');
  if (v === '') return null; // 미설정 = 전역 정책 사용
  if (!/^\d{1,12}$/.test(v)) return 'INVALID';
  const n = BigInt(v);
  if (n <= 0n) return 'INVALID';
  return n;
}

export async function updateDonorLimits(
  _prev: DonorActionState,
  formData: FormData,
): Promise<DonorActionState> {
  const ctx = await currentDonor();
  if (!ctx) return { ok: false, message: NO_DONOR };

  const parsed = limitSchema.safeParse({
    dailyLimit: String(formData.get('dailyLimit') ?? ''),
    monthlyLimit: String(formData.get('monthlyLimit') ?? ''),
  });
  if (!parsed.success) return { ok: false, message: '입력값을 확인해 주세요.' };

  const daily = parseLimit(parsed.data.dailyLimit);
  const monthly = parseLimit(parsed.data.monthlyLimit);
  if (daily === 'INVALID' || monthly === 'INVALID') {
    return { ok: false, message: '한도는 0보다 큰 숫자로 입력해 주세요.' };
  }

  const policy = await resolvePolicy(null, ctx.donor.id);

  // 후원자는 전역 정책보다 낮은 값만 설정할 수 있다.
  if (daily !== null && daily > policy.donorDailyLimit) {
    return { ok: false, message: '일일 한도는 기본 정책보다 높게 설정할 수 없습니다.' };
  }
  if (monthly !== null && monthly > policy.donorMonthlyLimit) {
    return { ok: false, message: '월간 한도는 기본 정책보다 높게 설정할 수 없습니다.' };
  }
  const effectiveDaily = daily ?? policy.donorDailyLimit;
  const effectiveMonthly = monthly ?? policy.donorMonthlyLimit;
  if (effectiveDaily > effectiveMonthly) {
    /**
     * 무엇을 고쳐야 하는지 알려 준다.
     *
     * 월간만 낮추고 일일을 비워 두면 기본 정책값(높은 값)이 적용돼 이 조건에 걸리는데,
     * 예전 문구는 "일일 한도는 월간 한도보다 클 수 없습니다" 뿐이라 일일을 건드린 적 없는
     * 사용자는 원인을 알 수 없었다.
     */
    if (daily === null) {
      return {
        ok: false,
        message: `일일 한도를 비워 두면 기본 정책(${policy.donorDailyLimit.toString()}원)이 적용되어 월간 한도(${effectiveMonthly.toString()}원)를 넘습니다. 일일 한도도 함께 낮춰 주세요.`,
      };
    }
    if (monthly === null) {
      return {
        ok: false,
        message: `월간 한도를 비워 두면 기본 정책(${policy.donorMonthlyLimit.toString()}원)이 적용됩니다. 일일 한도를 그보다 낮게 설정해 주세요.`,
      };
    }
    return { ok: false, message: '일일 한도는 월간 한도보다 클 수 없습니다.' };
  }

  await prisma.donorProfile.update({
    where: { id: ctx.donor.id },
    data: { dailyLimit: daily, monthlyLimit: monthly },
  });
  revalidatePath('/my/limits');
  return { ok: true, message: '한도가 저장되었습니다.' };
}

// ---------------------------------------------------------------- 방송 닉네임

/**
 * 방송에 표시될 닉네임 변경.
 *
 * 이미 접수된 후원(Donation.displayName)은 그때의 이름을 그대로 둔다.
 * 방송에 이미 나간 이름을 나중에 바꾸면 기록이 실제 송출과 어긋나기 때문이다.
 * 이후 후원부터 새 닉네임이 적용된다.
 */
export async function updateDonorNickname(
  _prev: DonorActionState,
  formData: FormData,
): Promise<DonorActionState> {
  const ctx = await currentDonor();
  if (!ctx) return { ok: false, message: NO_DONOR };

  const raw = String(formData.get('nickname') ?? '');
  const checked = await validateDonorName(raw);
  if (!checked.ok) return { ok: false, message: checked.message ?? '닉네임을 다시 입력해 주세요.' };

  await prisma.donorProfile.update({
    where: { id: ctx.donor.id },
    // 빈 값으로 저장하면 기본 이름(후원자5678)으로 되돌아간다.
    data: { displayName: checked.value.length > 0 ? checked.value : null },
  });
  revalidatePath('/my/account');
  return {
    ok: true,
    message:
      checked.value.length > 0
        ? '닉네임이 저장되었습니다. 다음 후원부터 적용됩니다.'
        : '닉네임을 지웠습니다. 기본 이름으로 표시됩니다.',
  };
}

// ---------------------------------------------------------------- 크리에이터 차단

export async function toggleCreatorBlock(
  _prev: DonorActionState,
  formData: FormData,
): Promise<DonorActionState> {
  const ctx = await currentDonor();
  if (!ctx) return { ok: false, message: NO_DONOR };

  const linkId = String(formData.get('linkId') ?? '').trim();
  const next = String(formData.get('next') ?? '');
  if (!linkId) return { ok: false, message: '대상을 찾을 수 없습니다.' };

  // 소유권 검증: 반드시 로그인 후원자의 링크여야 한다.
  const link = await prisma.donorCreatorLink.findUnique({
    where: { id: linkId },
    select: { id: true, donorId: true, donorBlockedAt: true, creator: { select: { displayName: true } } },
  });
  if (!link || link.donorId !== ctx.donor.id) {
    return { ok: false, message: '대상을 찾을 수 없습니다.' };
  }

  const shouldBlock = next === 'BLOCK';
  await prisma.donorCreatorLink.update({
    where: { id: link.id },
    // 후원자 방향 차단만 건드린다. 크리에이터가 건 차단(blocked_donor)은 그대로 유지된다.
    data: { donorBlockedAt: shouldBlock ? new Date() : null },
  });
  revalidatePath('/my/blocks');
  return {
    ok: true,
    message: shouldBlock
      ? `${link.creator.displayName} 님에 대한 후원이 차단되었습니다.`
      : `${link.creator.displayName} 님에 대한 차단이 해제되었습니다.`,
  };
}

// ---------------------------------------------------------------- 환불 요청

export async function requestDonationRefund(
  _prev: DonorActionState,
  formData: FormData,
): Promise<DonorActionState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: NO_SESSION };
  const ctx = await currentDonor();
  if (!ctx) return { ok: false, message: NO_DONOR };

  const donationId = String(formData.get('donationId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!donationId) return { ok: false, message: '대상 거래를 찾을 수 없습니다.' };
  if (reason.length < 2) return { ok: false, message: '환불 사유를 2자 이상 입력해 주세요.' };
  if (reason.length > 300) return { ok: false, message: '환불 사유는 300자 이내로 입력해 주세요.' };

  // 소유권 검증: 반드시 로그인 후원자의 거래여야 한다.
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: { id: true, donorId: true },
  });
  if (!donation || donation.donorId !== ctx.donor.id) {
    return { ok: false, message: '대상 거래를 찾을 수 없습니다.' };
  }

  try {
    await requestRefund({ donationId: donation.id, reason, requestedBy: user.id });
    revalidatePath('/my');
    return { ok: true, message: '환불 요청이 접수되었습니다. 검토 후 결과를 안내드립니다.' };
  } catch (e) {
    // Prisma·복호화 오류 원문이 그대로 후원자 화면에 렌더되지 않도록 정제한다.
    return { ok: false, message: donorFacingError(e, '환불 요청에 실패했습니다.') };
  }
}

// ---------------------------------------------------------------- 마케팅 수신 동의/철회

/**
 * 마케팅 수신 동의는 선택 동의이므로 마이페이지에서 직접 동의/철회할 수 있다.
 * ConsentRecord 는 이력형(append-only 성격)이므로 새 레코드를 추가하는 방식으로 기록한다.
 */
export async function setMarketingConsent(
  _prev: DonorActionState,
  formData: FormData,
): Promise<DonorActionState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: NO_SESSION };

  const agree = String(formData.get('agree') ?? '') === 'on';

  const terms = await prisma.termsVersion.findFirst({
    where: { type: 'MARKETING', effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
    select: { id: true },
  });
  if (!terms) return { ok: false, message: '마케팅 동의 약관을 찾을 수 없습니다. 고객센터로 문의해 주세요.' };

  const donor = await prisma.donorProfile.findUnique({
    where: { userId: user.id },
    select: { phoneHash: true },
  });

  /**
   * 같은 값이면 기록하지 않는다.
   *
   * 토글을 빠르게 두 번 누르면(hidden 값이 서버 렌더 시점으로 고정되어 있어) 같은 값의
   * 동의 이력이 계속 쌓인다. 이력 목록은 상한 100건이라, 그렇게 쌓인 중복이 정작 확인해야 할
   * 필수 동의 이력을 밀어낸다.
   */
  const latest = await prisma.consentRecord.findFirst({
    where: { userId: user.id, type: 'MARKETING' },
    orderBy: { createdAt: 'desc' },
    select: { agreed: true },
  });
  if (latest && latest.agreed === agree) {
    return {
      ok: true,
      message: agree ? '이미 마케팅 정보 수신에 동의된 상태입니다.' : '이미 마케팅 정보 수신이 철회된 상태입니다.',
    };
  }

  await prisma.consentRecord.create({
    data: {
      id: newId(),
      userId: user.id,
      phoneHash: donor?.phoneHash ?? null,
      termsId: terms.id,
      type: 'MARKETING',
      agreed: agree,
    },
  });

  revalidatePath('/my/consents');
  return {
    ok: true,
    message: agree
      ? '마케팅 정보 수신에 동의했습니다.'
      : '마케팅 정보 수신 동의를 철회했습니다. 처리에 최대 1영업일이 걸릴 수 있습니다.',
  };
}

// ---------------------------------------------------------------- 회원 탈퇴

/**
 * 후원자 회원 탈퇴.
 *
 * 처리 원칙
 *  - 거래·정산 기록은 법정 보존 대상이므로 삭제하지 않는다. 계정과의 연결만 끊는다.
 *  - 자동출금(빌키)은 반드시 먼저 폐기한다. 남겨두면 탈퇴 후에도 출금될 수 있다.
 *  - 계정은 WITHDRAWN 상태로 바꾸고 로그인 수단(이메일·비밀번호)을 무효화한다.
 *  - 진행 중인 환불 요청이 있으면 처리 후 탈퇴하도록 막는다.
 */
export async function withdrawAccount(_prev: DonorActionState, formData: FormData): Promise<DonorActionState> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: NO_SESSION };

  // 후원자 전용 절차다. 크리에이터는 정산·MO 번호 정리가, 관리자는 권한 이관이 선행돼야 하므로
  // 이 경로로 탈퇴하면 프로필과 배정 자원이 고아 상태로 남는다.
  if (user.role !== 'DONOR') {
    return {
      ok: false,
      message:
        user.role === 'CREATOR'
          ? '크리에이터 계정은 정산과 후원 번호 정리가 필요해 이 화면에서 탈퇴할 수 없습니다. 고객센터로 요청해 주세요.'
          : '관리자 계정은 이 화면에서 탈퇴할 수 없습니다. 다른 최고관리자에게 권한 이관 후 처리해 주세요.',
    };
  }

  if (String(formData.get('confirm') ?? '').trim() !== '탈퇴합니다') {
    return { ok: false, message: '확인 문구를 정확히 입력해 주세요. (탈퇴합니다)' };
  }

  const donor = await prisma.donorProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (donor) {
    const openRefund = await prisma.refund.count({
      where: { donation: { donorId: donor.id }, status: { in: ['REQUESTED', 'APPROVED'] } },
    });
    if (openRefund > 0) {
      return {
        ok: false,
        message: `처리 중인 환불 요청이 ${openRefund}건 있습니다. 환불이 완료된 뒤에 탈퇴할 수 있습니다.`,
      };
    }

    // 자동출금 수단 폐기 (탈퇴 후 출금 방지)
    try {
      await revokePaymentMethod(donor.id);
    } catch {
      return { ok: false, message: '결제수단 해지 중 오류가 발생했습니다. 고객센터로 문의해 주세요.' };
    }
  }

  try {
    await prisma.$transaction([
      // 후원자 프로필은 남기고 계정 연결만 끊는다 (거래 이력 보존)
      prisma.donorProfile.updateMany({
        where: { userId: user.id },
        data: { userId: null, onboardingStatus: 'WITHDRAWN' },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          status: 'WITHDRAWN',
          // 같은 이메일로 재가입할 수 있도록 로그인 수단을 비운다
          email: `withdrawn+${user.id}@invalid.local`,
          passwordHash: null,
          name: null,
          phoneHash: null,
          phoneEnc: null,
          phoneMasked: null,
          deletedAt: new Date(),
        },
      }),
      prisma.userSession.deleteMany({ where: { userId: user.id } }),
    ]);
  } catch {
    return { ok: false, message: '탈퇴 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }

  await destroySession();
  redirect('/?withdrawn=1');
}


/**
 * 후원자 화면에 보여도 되는 오류 문구로 정제한다.
 *
 * 서비스가 의도적으로 던진 한국어 안내는 그대로 보여 주고, 그 밖의 내부 오류
 * (Prisma 호출 실패, 복호화 오류 등)는 원문을 감춘다. 원문에는 테이블·컬럼 이름이나
 * 설정 값이 섞여 나온다.
 */
function donorFacingError(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : '';
  if (!message) return fallback;
  const internal =
    /prisma|invocation|ECONN|ETIMEDOUT|Unique constraint|Invalid `|Cannot read|decrypt|Unsupported/i.test(message);
  if (internal) {
    logger.error('후원자 액션 내부 오류', { message });
    return fallback;
  }
  return message;
}
