import { prisma } from '@/server/db';
import { newId } from '@/lib/id';

/**
 * [SEC-E] 가입 시 필수 약관 동의 기록.
 *
 * 소셜 가입(registerSocialDonor)만 consent_record 를 남기고, 이메일 가입(signupDonor)과
 * 크리에이터 신청(applyCreator)은 체크박스만 검사한 뒤 **아무 기록도 남기지 않았다.**
 * 분쟁·감독 대응 시 "어느 버전의 약관에 언제 동의했는가"를 증명할 수 없다.
 * 세 경로 모두 같은 규칙(현재 시행 중인 이용약관 + 개인정보 처리방침)으로 남긴다.
 */

type Tx = Pick<typeof prisma, 'termsVersion' | 'consentRecord'>;

export const SIGNUP_REQUIRED_TERMS = ['TERMS_SERVICE', 'PRIVACY'] as const;

export class SignupTermsMissingError extends Error {
  constructor() {
    super('가입 약관을 준비 중입니다. 잠시 후 다시 시도해 주세요.');
  }
}

/** 현재 시행 중인 필수 약관 버전. 하나라도 없으면 가입을 받지 않는다(소셜 가입과 같은 규칙). */
export async function activeSignupTerms(db: Tx = prisma, now = new Date()) {
  const terms = await db.termsVersion.findMany({
    where: { type: { in: [...SIGNUP_REQUIRED_TERMS] }, active: true, effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
    select: { id: true, type: true },
  });
  const picked = SIGNUP_REQUIRED_TERMS.map((type) => terms.find((t) => t.type === type));
  if (picked.some((t) => !t)) throw new SignupTermsMissingError();
  return picked as Array<{ id: string; type: (typeof SIGNUP_REQUIRED_TERMS)[number] }>;
}

export async function recordSignupConsents(
  db: Tx,
  userId: string,
  terms: Array<{ id: string; type: (typeof SIGNUP_REQUIRED_TERMS)[number] }>,
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  await db.consentRecord.createMany({
    data: terms.map((t) => ({
      id: newId(),
      userId,
      termsId: t.id,
      type: t.type,
      agreed: true,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
    })),
  });
}
