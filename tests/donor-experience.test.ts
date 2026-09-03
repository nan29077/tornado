import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, seedRegisteredDonor } from './helpers';
import { donationReplySchema, saveDonationReply, listMyCreatorMessages } from '@/server/services/donation-replies';
import { authReturnPath } from '@/lib/auth-return-path';
import { findSocialDonor, registerSocialDonor, validSocialState, socialPendingCookie, readSocialPending } from '@/server/services/social-login';
import { ensureDonorPreviewSeed } from '@/server/services/donor-preview-seed';
import { env } from '@/lib/env';
import { getSocialAdapter } from '@/server/adapters/social';

beforeEach(resetDb);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  const creator = await seedBasics();
  const donor = await seedRegisteredDonor();
  const user = await prisma.user.create({ data: { id: newId(), name: '후원자', role: 'DONOR' } });
  await prisma.donorProfile.update({ where: { id: donor.id }, data: { userId: user.id } });
  const donation = await prisma.donation.create({ data: { id: newId(), transactionNo: newId(), creatorId: creator.creatorId, donorId: donor.id, displayName: '후원자', message: '응원합니다', amount: 3000n, channel: 'MO', isTest: true } });
  return { creator, donor, user, donation };
}

describe('비공개 후원 답글', () => {
  it('소유 크리에이터가 작성·수정하고 본인 후원자가 조회한다', async () => {
    const f = await fixture();
    await saveDonationReply(f.creator.creatorUserId, f.donation.id, '  감사합니다  ');
    await saveDonationReply(f.creator.creatorUserId, f.donation.id, '다음 방송에서 만나요');
    expect(await prisma.donationReply.count()).toBe(1);
    const result = await listMyCreatorMessages(f.user.id, f.creator.creatorId);
    expect(result.rows[0].reply?.body).toBe('다음 방송에서 만나요');
    expect(result.rows[0]).not.toHaveProperty('messageRawEnc');
    expect(result.rows[0]).not.toHaveProperty('donorId');
  });
  it('후원자·다른 크리에이터·정지 계정의 작성과 타인 내역 조회를 차단한다', async () => {
    const f = await fixture();
    const other = await prisma.user.create({ data: { id: newId(), role: 'CREATOR' } });
    await expect(saveDonationReply(f.user.id, f.donation.id, '위조')).rejects.toThrow();
    await expect(saveDonationReply(other.id, f.donation.id, '위조')).rejects.toThrow();
    expect((await listMyCreatorMessages(other.id, f.creator.creatorId)).rows).toHaveLength(0);
    await prisma.user.update({ where: { id: f.creator.creatorUserId }, data: { status: 'SUSPENDED' } });
    await expect(saveDonationReply(f.creator.creatorUserId, f.donation.id, '위조')).rejects.toThrow();
    expect(await prisma.donationReply.count()).toBe(0);
  });
  it('WEB 후원은 문자내역에 혼입하지 않고 페이지를 제한한다', async () => {
    const f = await fixture();
    await prisma.donation.update({ where: { id: f.donation.id }, data: { channel: 'WEB' } });
    expect((await listMyCreatorMessages(f.user.id, f.creator.creatorId, Infinity)).rows).toHaveLength(0);
    expect((await listMyCreatorMessages(f.user.id, f.creator.creatorId, -5)).page).toBe(1);
  });
  it('빈 답글과 1000자 초과를 거절한다', () => {
    expect(donationReplySchema.safeParse('   ').success).toBe(false);
    expect(donationReplySchema.safeParse('가'.repeat(1001)).success).toBe(false);
    expect(donationReplySchema.safeParse('가'.repeat(1000)).success).toBe(true);
  });
});

describe('안전한 후원자 로그인', () => {
  it('내부 후원·마이페이지만 복귀하고 외부·API·역슬래시를 거절한다', () => {
    expect(authReturnPath('/c/TOR-8K2M/messages?page=2')).toBe('/c/TOR-8K2M/messages?page=2');
    for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/api/auth/login', '/admin', '/c/TOR-8K2M/../../api/test', '/my%5cevil', '/my\n']) expect(authReturnPath(value)).toBe('/my');
  });
  it('OAuth state 누락·변조·다른 바이트를 거절하고 임시 인증정보도 보호한다', () => {
    expect(validSocialState('abc', 'abc')).toBe(true);
    expect(validSocialState('abc', 'abd')).toBe(false);
    expect(validSocialState(undefined, 'abc')).toBe(false);
    expect(validSocialState('abc', '가나다')).toBe(false);
    const profile = { provider: 'kakao' as const, providerUserId: '123', name: '후원자' };
    const value = socialPendingCookie(profile, '/c/TOR-8K2M');
    expect(readSocialPending(value)?.providerUserId).toBe('123');
    expect(readSocialPending(value + 'bad')).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
    expect(readSocialPending(value)).toBeNull();
  });
  it('신규 소셜 계정은 DONOR·랜덤 캐릭터, 이메일로 기존 계정을 합치지 않는다', async () => {
    await seedBasics();
    const admin = await prisma.user.create({ data: { id: newId(), email: 'same@example.test', role: 'ADMIN' } });
    const profile = { provider: 'kakao' as const, providerUserId: '12345', email: admin.email!, name: '소셜후원자' };
    await expect(registerSocialDonor(profile, false)).rejects.toThrow();
    const user = await registerSocialDonor(profile, true);
    expect(user.id).not.toBe(admin.id);
    const created = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(created.role).toBe('DONOR');
    expect(created.avatarIndex).toBeGreaterThanOrEqual(0);
    expect(created.avatarIndex).toBeLessThan(50);
    expect(created.email).toBeNull();
    expect(await prisma.consentRecord.count({ where: { userId: user.id } })).toBe(2);
    expect((await registerSocialDonor(profile, true)).id).toBe(user.id);
    expect(await prisma.donorProfile.count({ where: { userId: user.id } })).toBe(0);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    await expect(findSocialDonor(profile)).rejects.toThrow();
  });
  it('테스트 후원자 시드는 멱등적이며 결제·MT·정산을 만들지 않는다', async () => {
    await seedBasics();
    const first = await ensureDonorPreviewSeed();
    const second = await ensureDonorPreviewSeed();
    expect(first.userId).toBe(second.userId);
    expect(await prisma.donation.count({ where: { isTest: true } })).toBe(3);
    expect(await prisma.donationReply.count()).toBe(1);
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.mtOutboundMessage.count()).toBe(0);
    expect(await prisma.settlementLedger.count()).toBe(0);
  });
});

describe('공식 OAuth 응답 어댑터 (네트워크 mock)', () => {
  it.each(['kakao', 'naver'] as const)('%s 코드 교환·식별자 추출 및 실패 처리', async (provider) => {
    const original = { ...env.social[provider] };
    Object.assign(env.social[provider], { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost:3025/callback' });
    try {
      const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'TEST_TOKEN' })).mockResolvedValueOnce(Response.json(provider === 'kakao' ? { id: 123, kakao_account: { profile: { nickname: '테스트' } } } : { resultcode: '00', response: { id: '123', nickname: '테스트' } }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = getSocialAdapter(provider);
      expect(new URL(adapter.getAuthorizeUrl('state')).searchParams.get('state')).toBe('state');
      expect((await adapter.getProfile(await adapter.exchangeCode('code', 'state'))).providerUserId).toBe('123');
      expect(fetchMock.mock.calls[0][1].body.get('client_secret')).toBe('test-secret');
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }));
      await expect(adapter.exchangeCode('bad', 'state')).rejects.toThrow();
    } finally { Object.assign(env.social[provider], original); }
  });
});

