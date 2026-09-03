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

export async function findSocialDonor(profile: Pick<SocialProfile, 'provider' | 'providerUserId'>) {
  const identity = await prisma.socialIdentity.findUnique({ where: { provider_providerUserId: { provider: profile.provider, providerUserId: profile.providerUserId } }, select: { user: { select: { id: true, status: true, role: true } } } });
  if (!identity) return null;
  if (identity.user.status !== 'ACTIVE' || identity.user.role !== 'DONOR') throw new Error('이 계정으로 후원자 로그인을 할 수 없습니다.');
  return identity.user;
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
