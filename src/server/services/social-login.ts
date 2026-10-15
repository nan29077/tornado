import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, decrypt, hmac } from '@/lib/crypto';
import { authReturnPath } from '@/lib/auth-return-path';
import type { SocialProfile } from '@/server/adapters/social';

export const SOCIAL_PENDING_COOKIE = 'donaido_social_signup';
const pendingSchema = z.object({ provider: z.enum(['kakao', 'naver']), providerUserId: z.string().min(1).max(200), name: z.string().max(40), next: z.string(), expires: z.number() });

export function validSocialState(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual || expected.length > 200 || expected.length !== actual.length) return false;
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function socialPendingCookie(profile: SocialProfile, next: string) {
  const cipher = encrypt(JSON.stringify({ provider: profile.provider, providerUserId: profile.providerUserId, name: (profile.name || '후원자').slice(0, 40), next: authReturnPath(next), expires: Date.now() + 600_000 }));
  return `${cipher}.${hmac('social-signup:' + cipher)}`;
}

export function readSocialPending(raw: string | undefined) {
  try {
    if (!raw || raw.length > 4000) return null;
    const [cipher, signature, extra] = raw.split('.');
    if (extra !== undefined || !validSocialState(hmac('social-signup:' + cipher), signature ?? null)) return null;
    const data = pendingSchema.parse(JSON.parse(decrypt(cipher)));
    return data.expires > Date.now() && data.expires <= Date.now() + 600_000 ? { ...data, next: authReturnPath(data.next) } : null;
  } catch { return null; }
}

/**
 * 소셜 로그인 대상 계정 조회.
 *
 * [SEC-C] 예전에는 role 이 DONOR 가 아니면 예외를 던졌다. 그런데 소셜로 가입한 사용자가
 * 로그인 상태에서 크리에이터를 신청하면 role 이 CREATOR 로 바뀌므로(creator-apply), 그 뒤로는
 * **다시는 로그인할 수 없었다**(소셜 계정에는 비밀번호도 이메일도 없다).
 * 크리에이터도 소셜 로그인을 허용한다.
 *
 * ADMIN 은 계속 막는다. 관리자 자격은 이메일 초대 수락(이메일 일치)으로만 얻을 수 있고 소셜 계정에는
 * 이메일이 없으므로 정상 경로로는 생기지 않는다. 그래도 생겼다면 외부 공급자 계정 하나로
 * 관리자 콘솔에 들어오는 길이 되므로 허용하지 않는다.
 */
export const SOCIAL_LOGIN_ROLES: ReadonlySet<string> = new Set(['DONOR', 'CREATOR']);

export async function findSocialUser(profile: Pick<SocialProfile, 'provider' | 'providerUserId'>) {
  const identity = await prisma.socialIdentity.findUnique({ where: { provider_providerUserId: { provider: profile.provider, providerUserId: profile.providerUserId } }, select: { user: { select: { id: true, status: true, role: true } } } });
  if (!identity) return null;
  if (identity.user.status !== 'ACTIVE' || !SOCIAL_LOGIN_ROLES.has(identity.user.role)) throw new Error('이 계정으로 소셜 로그인을 할 수 없습니다.');
  return identity.user;
}

/** 이전 이름. 호환을 위해 남긴다(이제 크리에이터도 반환한다). */
export const findSocialDonor = findSocialUser;

/**
 * [SEC-C] 소셜 로그인 후 이동할 곳.
 * 크리에이터는 후원자용 마이페이지(/my)가 아니라 스튜디오로 보낸다.
 * 후원 페이지(/c/...)로 들어온 로그인이면 그 화면으로 돌려보낸다(크리에이터도 다른 채널을 볼 수 있다).
 */
export function socialLandingPath(role: string, next: string): string {
  if (role === 'CREATOR' && (next === '/my' || next.startsWith('/my/') || next.startsWith('/my?'))) return '/studio';
  return next;
}

/** 이메일 자동 병합 및 휴대폰 자동 연결을 하지 않는다. 신규 계정은 반드시 DONOR다. */
export async function registerSocialDonor(profile: SocialProfile, agreed: boolean) {
  if (!agreed) throw new Error('필수 약관에 동의해 주세요.');
  const existing = await findSocialDonor(profile);
  if (existing) return existing;
  return prisma.$transaction(async (tx) => {
    const terms = await tx.termsVersion.findMany({ where: { type: { in: ['TERMS_SERVICE', 'PRIVACY'] }, active: true, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } });
    const service = terms.find((t) => t.type === 'TERMS_SERVICE');
    const privacy = terms.find((t) => t.type === 'PRIVACY');
    if (!service || !privacy) throw new Error('가입 약관을 준비 중입니다.');
    const user = await tx.user.create({ data: { id: newId(), name: (profile.name || '후원자').slice(0, 40), role: 'DONOR' }, select: { id: true } });
    await tx.socialIdentity.create({ data: { id: newId(), userId: user.id, provider: profile.provider, providerUserId: profile.providerUserId } });
    await tx.consentRecord.createMany({ data: [service, privacy].map((t) => ({ id: newId(), userId: user.id, termsId: t.id, type: t.type, agreed: true })) });
    return user;
  });
}
