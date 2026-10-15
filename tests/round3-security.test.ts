import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-15 3차 점검 — 보안·권한 수정 회귀 테스트.
 * 항목 번호(SEC-A, SET-H …)는 3차 전체점검 보고서를 따른다.
 */

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) => (mocks.jar.has(key) ? { value: mocks.jar.get(key)! } : undefined),
    set: (key: string, value: string) => void mocks.jar.set(key, value),
    delete: (key: string) => void mocks.jar.delete(key),
  }),
  headers: async () => new Headers(Object.fromEntries(mocks.headers)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, generateToken, phoneHash, maskPhone, tokenHash } from '@/lib/crypto';
import { SESSION_COOKIE } from '@/server/auth';
import { resetDb, seedBasics, type Fixture } from './helpers';
import {
  createAdminInvite,
  acceptAdminInvite,
  loadAdminInvite,
  revokeAdminInvite,
  ADMIN_INVITE_TTL_MS,
} from '@/server/services/admin-invite';
import {
  createAdminInviteAction,
  revokeAdminInviteAction,
  issueTemporaryPasswordAction,
  updateUserStatus,
  setSettlementAccountVerified,
} from '@/app/actions/admin/accounts';
import { acceptAdminInviteAction } from '@/app/actions/admin-invite';
import { FINANCE_PERMISSIONS, assertFinanceAdmin } from '@/app/actions/admin/shared';
import { canWriteFinance, financeDenyReason } from '@/server/admin-guard';
import { findSocialUser, registerSocialDonor, socialLandingPath } from '@/server/services/social-login';
import { withdrawAccount } from '@/app/actions/donor';
import { loadDonationLookupResult } from '@/server/services/donation-lookup';
import { submitSupportRequest } from '@/app/actions/support';
import { signupDonor } from '@/app/actions/auth';
import { requestPasswordReset } from '@/server/services/password-reset';
import { purgeStaleSessions } from '@/server/services/session-cleanup';
import { rejectCrossOrigin } from '@/server/request-guard';
import { PATCH as notificationsPatch } from '@/app/api/notifications/route';
import { POST as overlayLayoutPost } from '@/app/api/studio/overlay/layout/route';
import { POST as gameControlPost } from '@/app/api/studio/games/control/route';
import { initialAdminState } from '@/components/admin/state';

const ORIGIN = 'http://localhost:3025';

async function makeUser(input: {
  role: 'DONOR' | 'CREATOR' | 'ADMIN';
  email?: string | null;
  permission?: 'SUPER_ADMIN' | 'OPERATION' | 'FINANCE' | 'SUPPORT' | 'READ_ONLY';
  status?: 'ACTIVE' | 'SUSPENDED';
}) {
  const user = await prisma.user.create({
    data: {
      id: newId(),
      email: input.email === undefined ? `u-${newId()}@test.local` : input.email,
      name: '테스트',
      role: input.role,
      status: input.status ?? 'ACTIVE',
    },
  });
  if (input.permission) {
    await prisma.adminProfile.create({ data: { id: newId(), userId: user.id, permission: input.permission } });
  }
  return user;
}

/** 실제 세션 행을 만들고 쿠키 jar 에 넣는다 (getSessionUser 가 그대로 동작한다). */
async function loginAs(userId: string) {
  const token = generateToken(32);
  await prisma.userSession.create({
    data: { id: newId(), userId, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  mocks.jar.set(SESSION_COOKIE, token);
}

function fd(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

beforeEach(async () => {
  await resetDb();
  mocks.jar.clear();
  mocks.headers.clear();
  mocks.headers.set('host', 'localhost:3025');
  mocks.headers.set('x-forwarded-for', '203.0.113.7');
});

// ───────────────────── SEC-A 관리자 초대 ─────────────────────

describe('SEC-A 관리자 추가는 초대 → 본인 로그인 수락으로만 이루어진다', () => {
  it('초대 이메일과 다른 계정으로는 수락할 수 없고, 같은 이메일 계정만 1회 승격된다', async () => {
    const sup = await makeUser({ role: 'ADMIN', permission: 'SUPER_ADMIN' });
    const target = await makeUser({ role: 'DONOR', email: 'staff@test.local' });
    const other = await makeUser({ role: 'DONOR', email: 'attacker@test.local' });

    const invite = await createAdminInvite({ invitedById: sup.id, email: 'Staff@Test.local', permission: 'OPERATION' });
    const token = invite.link.split('/admin-invite/')[1]!;
    // 토큰 원문은 DB 에 없다.
    const row = await prisma.adminInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.email).toBe('staff@test.local');

    // 초대 생성만으로는 아무도 승격되지 않는다(예전 즉시 승격 경로 제거).
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('DONOR');

    const wrong = await acceptAdminInvite(token, other.id);
    expect(wrong.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).role).toBe('DONOR');

    const ok = await acceptAdminInvite(token, target.id);
    expect(ok.ok).toBe(true);
    const promoted = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: { adminProfile: true } });
    expect(promoted.role).toBe('ADMIN');
    expect(promoted.adminProfile?.permission).toBe('OPERATION');

    // 1회용
    const again = await acceptAdminInvite(token, target.id);
    expect(again.ok).toBe(false);
    expect((await loadAdminInvite(token)).state).toBe('USED');
  });

  it('만료·회수된 초대는 수락할 수 없다', async () => {
    const sup = await makeUser({ role: 'ADMIN', permission: 'SUPER_ADMIN' });
    const target = await makeUser({ role: 'DONOR', email: 'late@test.local' });

    const expired = await createAdminInvite({ invitedById: sup.id, email: 'late@test.local', permission: 'READ_ONLY' });
    const expiredToken = expired.link.split('/admin-invite/')[1]!;
    const later = new Date(Date.now() + ADMIN_INVITE_TTL_MS + 60_000);
    expect((await loadAdminInvite(expiredToken, later)).state).toBe('EXPIRED');
    expect((await acceptAdminInvite(expiredToken, target.id, later)).ok).toBe(false);

    // 같은 이메일로 다시 초대하면 이전 링크는 자동 회수된다.
    const fresh = await createAdminInvite({ invitedById: sup.id, email: 'late@test.local', permission: 'READ_ONLY' });
    expect(fresh.replaced).toBe(1);
    expect((await loadAdminInvite(expiredToken)).state).toBe('REVOKED');

    expect(await revokeAdminInvite(fresh.id, sup.id)).toBe(true);
    const freshToken = fresh.link.split('/admin-invite/')[1]!;
    expect((await acceptAdminInvite(freshToken, target.id)).ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('DONOR');
  });

  it('크리에이터 계정은 이메일이 같아도 수락할 수 없다', async () => {
    const sup = await makeUser({ role: 'ADMIN', permission: 'SUPER_ADMIN' });
    const creator = await makeUser({ role: 'CREATOR', email: 'maker@test.local' });
    const invite = await createAdminInvite({ invitedById: sup.id, email: 'maker@test.local', permission: 'SUPPORT' });
    const res = await acceptAdminInvite(invite.link.split('/admin-invite/')[1]!, creator.id);
    expect(res.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: creator.id } })).role).toBe('CREATOR');
  });

  it('서버 액션: SUPER_ADMIN 만 초대를 만들 수 있고, 링크는 미발송(mock) 안내와 함께 응답으로만 전달된다', async () => {
    const op = await makeUser({ role: 'ADMIN', permission: 'OPERATION' });
    await loginAs(op.id);
    const denied = await createAdminInviteAction(initialAdminState, fd({ email: 'x@test.local', permission: 'READ_ONLY' }));
    expect(denied.ok).toBe(false);
    expect(await prisma.adminInvite.count()).toBe(0);

    mocks.jar.clear();
    const sup = await makeUser({ role: 'ADMIN', permission: 'SUPER_ADMIN' });
    await loginAs(sup.id);
    const created = await createAdminInviteAction(initialAdminState, fd({ email: 'x@test.local', permission: 'FINANCE' }));
    expect(created.ok).toBe(true);
    expect(created.message).toContain('메일 발송 미연동');
    expect(created.detail?.inviteLink).toContain('/admin-invite/');
    // 감사로그에는 링크·토큰이 남지 않는다.
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ADMIN_INVITE_CREATE' } });
    expect(JSON.stringify(audit)).not.toContain(created.detail!.inviteLink!.split('/admin-invite/')[1]!);

    const inv = await prisma.adminInvite.findFirstOrThrow();
    const revoked = await revokeAdminInviteAction(initialAdminState, fd({ inviteId: inv.id }));
    expect(revoked.ok).toBe(true);
    expect(await prisma.adminAuditLog.count({ where: { action: 'ADMIN_INVITE_REVOKE' } })).toBe(1);
  });

  it('수락 액션: 로그인하지 않으면 거절, 초대 이메일 계정으로 로그인하면 승격되고 감사로그가 남는다', async () => {
    const sup = await makeUser({ role: 'ADMIN', permission: 'SUPER_ADMIN' });
    const target = await makeUser({ role: 'DONOR', email: 'join@test.local' });
    const invite = await createAdminInvite({ invitedById: sup.id, email: 'join@test.local', permission: 'SUPPORT' });
    const token = invite.link.split('/admin-invite/')[1]!;

    const anon = await acceptAdminInviteAction({ ok: false }, fd({ token }));
    expect(anon.ok).toBe(false);

    await loginAs(target.id);
    const ok = await acceptAdminInviteAction({ ok: false }, fd({ token }));
    expect(ok.ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ADMIN');
    expect(await prisma.adminAuditLog.count({ where: { action: 'ADMIN_INVITE_ACCEPT' } })).toBe(1);
  });
});

// ───────────────────── SET-H 돈이 움직이는 작업 ─────────────────────

describe('SET-H 돈이 움직이는 작업은 SUPER_ADMIN·FINANCE 만', () => {
  it('재무 허용목록에서 OPERATION 이 빠졌다 (서버 액션 가드와 화면 가드 모두)', () => {
    expect(FINANCE_PERMISSIONS.has('SUPER_ADMIN')).toBe(true);
    expect(FINANCE_PERMISSIONS.has('FINANCE')).toBe(true);
    expect(FINANCE_PERMISSIONS.has('OPERATION')).toBe(false);
    expect(() => assertFinanceAdmin({ adminPermission: 'OPERATION' } as never)).toThrow();
    expect(() => assertFinanceAdmin({ adminPermission: 'FINANCE' } as never)).not.toThrow();
    expect(canWriteFinance({ adminPermission: 'OPERATION' } as never)).toBe(false);
    expect(financeDenyReason({ adminPermission: 'OPERATION' } as never, '정산 처리')).not.toContain('운영');
  });

  it('OPERATION 계정의 정산 계좌 실명확인은 거절된다', async () => {
    const fx: Fixture = await seedBasics();
    await prisma.settlementAccount.update({ where: { creatorId: fx.creatorId }, data: { verified: false, verifiedAt: null } });
    const acct = await prisma.settlementAccount.findUniqueOrThrow({ where: { creatorId: fx.creatorId } });
    const op = await makeUser({ role: 'ADMIN', permission: 'OPERATION' });
    await loginAs(op.id);
    const res = await setSettlementAccountVerified(
      initialAdminState,
      fd({ creatorId: fx.creatorId, verified: 'true', accountTail4: acct.accountTail4, accountUpdatedAt: acct.updatedAt.toISOString() }),
    );
    expect(res.ok).toBe(false);
    expect((await prisma.settlementAccount.findUniqueOrThrow({ where: { creatorId: fx.creatorId } })).verified).toBe(false);
  });
});

// ───────────────────── SEC-B 크리에이터 계정 조치 ─────────────────────

describe('SEC-B 크리에이터 계정의 임시 비밀번호·상태 변경은 운영 권한 이상', () => {
  it('SUPPORT 는 크리에이터 임시 비밀번호를 발급할 수 없다 (후원자는 가능)', async () => {
    const support = await makeUser({ role: 'ADMIN', permission: 'SUPPORT' });
    const creator = await makeUser({ role: 'CREATOR' });
    const donor = await makeUser({ role: 'DONOR' });
    await loginAs(support.id);

    const denied = await issueTemporaryPasswordAction(initialAdminState, fd({ userId: creator.id }));
    expect(denied.ok).toBe(false);
    expect(denied.detail?.tempPassword).toBeUndefined();

    const allowed = await issueTemporaryPasswordAction(initialAdminState, fd({ userId: donor.id }));
    expect(allowed.ok).toBe(true);
  });

  it('SEC-B2 SUPPORT 는 정지된 크리에이터를 다시 활성화할 수 없다', async () => {
    const support = await makeUser({ role: 'ADMIN', permission: 'SUPPORT' });
    const creator = await makeUser({ role: 'CREATOR', status: 'SUSPENDED' });
    await loginAs(support.id);
    const res = await updateUserStatus(initialAdminState, fd({ userId: creator.id, status: 'ACTIVE' }));
    expect(res.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: creator.id } })).status).toBe('SUSPENDED');

    const op = await makeUser({ role: 'ADMIN', permission: 'OPERATION' });
    mocks.jar.clear();
    await loginAs(op.id);
    const ok = await updateUserStatus(initialAdminState, fd({ userId: creator.id, status: 'ACTIVE' }));
    expect(ok.ok).toBe(true);
  });
});

// ───────────────────── SET-I 계좌 실명확인 경쟁 ─────────────────────

describe('SET-I 실명확인은 관리자가 본 계좌에만 적용된다', () => {
  it('화면에서 본 뒤 계좌가 바뀌었으면 거절하고, 그대로면 인증한다', async () => {
    const fx: Fixture = await seedBasics();
    await prisma.settlementAccount.update({ where: { creatorId: fx.creatorId }, data: { verified: false, verifiedAt: null } });
    const seen = await prisma.settlementAccount.findUniqueOrThrow({ where: { creatorId: fx.creatorId } });

    // 관리자가 화면을 보는 사이 크리에이터가 계좌를 바꿨다.
    await new Promise((r) => setTimeout(r, 5));
    await prisma.settlementAccount.update({
      where: { creatorId: fx.creatorId },
      data: { accountEnc: encrypt('99988877766612'), accountTail4: '6612' },
    });

    const fin = await makeUser({ role: 'ADMIN', permission: 'FINANCE' });
    await loginAs(fin.id);
    const stale = await setSettlementAccountVerified(
      initialAdminState,
      fd({ creatorId: fx.creatorId, verified: 'true', accountTail4: seen.accountTail4, accountUpdatedAt: seen.updatedAt.toISOString() }),
    );
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain('계좌 정보가 바뀌었습니다');
    expect((await prisma.settlementAccount.findUniqueOrThrow({ where: { creatorId: fx.creatorId } })).verified).toBe(false);

    // 끝 4자리만 맞추고 시각을 빼먹어도 거절한다.
    const noTime = await setSettlementAccountVerified(initialAdminState, fd({ creatorId: fx.creatorId, verified: 'true', accountTail4: '6612' }));
    expect(noTime.ok).toBe(false);

    const now = await prisma.settlementAccount.findUniqueOrThrow({ where: { creatorId: fx.creatorId } });
    const ok = await setSettlementAccountVerified(
      initialAdminState,
      fd({ creatorId: fx.creatorId, verified: 'true', accountTail4: now.accountTail4, accountUpdatedAt: now.updatedAt.toISOString() }),
    );
    expect(ok.ok).toBe(true);
    expect((await prisma.settlementAccount.findUniqueOrThrow({ where: { creatorId: fx.creatorId } })).verified).toBe(true);
  });
});

// ───────────────────── SEC-C 소셜 로그인 / 탈퇴 ─────────────────────

describe('SEC-C 소셜 가입 후 크리에이터가 된 계정도 다시 로그인할 수 있다', () => {
  it('CREATOR 역할의 소셜 계정을 찾아 주고 스튜디오로 보낸다. ADMIN 은 거절한다', async () => {
    await seedBasics();
    const user = await registerSocialDonor({ provider: 'kakao', providerUserId: 'k-100', name: '소셜' }, true);
    await prisma.user.update({ where: { id: user.id }, data: { role: 'CREATOR' } });
    const found = await findSocialUser({ provider: 'kakao', providerUserId: 'k-100' });
    expect(found?.id).toBe(user.id);
    expect(socialLandingPath('CREATOR', '/my')).toBe('/studio');
    expect(socialLandingPath('DONOR', '/my')).toBe('/my');
    expect(socialLandingPath('CREATOR', '/c/TOR-ABCD')).toBe('/c/TOR-ABCD');

    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    await expect(findSocialUser({ provider: 'kakao', providerUserId: 'k-100' })).rejects.toThrow();
  });

  it('SEC-C2 탈퇴하면 소셜 연결이 지워지고 같은 카카오 계정으로 다시 가입할 수 있다', async () => {
    await seedBasics();
    const user = await registerSocialDonor({ provider: 'kakao', providerUserId: 'k-200', name: '탈퇴자' }, true);
    await loginAs(user.id);
    await expect(withdrawAccount({ ok: false }, fd({ confirm: '탈퇴합니다' }))).rejects.toThrow('NEXT_REDIRECT');

    expect(await prisma.socialIdentity.count({ where: { userId: user.id } })).toBe(0);
    expect(await findSocialUser({ provider: 'kakao', providerUserId: 'k-200' })).toBeNull();
    const again = await registerSocialDonor({ provider: 'kakao', providerUserId: 'k-200', name: '재가입' }, true);
    expect(again.id).not.toBe(user.id);
  });
});

// ───────────────────── SEC-E 가입 동의 기록 ─────────────────────

describe('SEC-E 이메일 가입도 필수 약관 동의를 기록한다', () => {
  it('signupDonor 는 이용약관·개인정보 동의 레코드를 남긴다', async () => {
    await seedBasics();
    await expect(
      signupDonor(
        { ok: false },
        fd({ email: 'new@test.local', name: '새회원', password: 'password123', passwordConfirm: 'password123', agreeTerms: 'on' }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'new@test.local' } });
    const types = (await prisma.consentRecord.findMany({ where: { userId: user.id } })).map((c) => c.type).sort();
    expect(types).toEqual(['PRIVACY', 'TERMS_SERVICE']);
  });
});

// ───────────────────── SEC-D 재설정 메일 미연동 ─────────────────────

describe('SEC-D 메일 미연동이면 발송했다고 안내하지 않는다', () => {
  it('requestPasswordReset 는 가입 여부와 무관하게 mailDelivered=false 를 돌려준다', async () => {
    const user = await makeUser({ role: 'DONOR', email: 'reset@test.local' });
    expect(user.id).toBeTruthy();
    expect((await requestPasswordReset('reset@test.local', null)).mailDelivered).toBe(false);
    expect((await requestPasswordReset('nobody@test.local', null)).mailDelivered).toBe(false);
  });
});

// ───────────────────── SEC-F 재배정 번호 조회 ─────────────────────

describe('SEC-F 번호 조회는 이전 이용자의 후원 내역을 보여 주지 않는다', () => {
  it('연결이 끊긴 프로필은 끊긴 이후의 후원만 보인다', async () => {
    const fx: Fixture = await seedBasics();
    const phone = '01055556666';
    const unlinkedAt = new Date(Date.now() - 60_000);
    const donor = await prisma.donorProfile.create({
      data: {
        id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone),
        previousUserId: newId(), unlinkedAt, registeredAt: new Date(Date.now() - 86_400_000),
      },
    });
    const mk = (receivedAt: Date, message: string) =>
      prisma.donation.create({
        data: {
          id: newId(), transactionNo: `T${newId()}`, creatorId: fx.creatorId, donorId: donor.id,
          amount: 3000n, displayName: '익명', message, status: 'PAYMENT_SUCCESS', receivedAt,
        },
      });
    await mk(new Date(Date.now() - 86_400_000), '이전 사람 후원');
    await mk(new Date(), '지금 번호 주인 후원');

    const result = await loadDonationLookupResult(phoneHash(phone), maskPhone(phone));
    expect(result.items.map((i) => i.message)).toEqual(['지금 번호 주인 후원']);
    expect(result.totalCount).toBe(1);
    expect(result.registered).toBe(false);
  });

  it('연결 해제 시각이 없는 분리 프로필은 아무것도 보여 주지 않는다', async () => {
    const fx: Fixture = await seedBasics();
    const phone = '01077778888';
    const donor = await prisma.donorProfile.create({
      data: { id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), previousUserId: newId() },
    });
    await prisma.donation.create({
      data: {
        id: newId(), transactionNo: `T${newId()}`, creatorId: fx.creatorId, donorId: donor.id,
        amount: 3000n, displayName: '익명', message: '비공개', status: 'PAYMENT_SUCCESS',
      },
    });
    const result = await loadDonationLookupResult(phoneHash(phone), maskPhone(phone));
    expect(result.items).toHaveLength(0);
  });
});

// ───────────────────── SEC-G 문의 거래번호 ─────────────────────

describe('SEC-G 문의의 거래번호는 존재 여부를 드러내지 않고, 남의 후원에 연결되지 않는다', () => {
  it('있는 번호·없는 번호의 안내가 같고, 비로그인은 연결하지 않는다', async () => {
    const fx: Fixture = await seedBasics();
    const donation = await prisma.donation.create({
      data: {
        id: newId(), transactionNo: 'TX-REAL-1', creatorId: fx.creatorId,
        amount: 3000n, displayName: '익명', message: 'x', status: 'PAYMENT_SUCCESS',
      },
    });
    const content = '거래 관련 문의드립니다. 확인 부탁드립니다.';
    const a = await submitSupportRequest({ ok: false }, fd({ category: 'PAYMENT', content, transactionNo: 'TX-REAL-1' }));
    mocks.jar.clear();
    mocks.headers.set('x-forwarded-for', '203.0.113.8');
    const b = await submitSupportRequest({ ok: false }, fd({ category: 'PAYMENT', content, transactionNo: 'TX-NONE-9' }));
    expect(a.ok && b.ok).toBe(true);
    expect(a.linkNote!.replace('TX-REAL-1', '#')).toBe(b.linkNote!.replace('TX-NONE-9', '#'));

    const linked = await prisma.supportInquiry.count({ where: { donationId: donation.id } });
    expect(linked).toBe(0);
    const stored = await prisma.supportInquiry.findFirstOrThrow({ where: { transactionNo: 'TX-REAL-1' } });
    expect(stored.donationId).toBeNull();
  });
});

// ───────────────────── CSRF ─────────────────────

describe('CSRF 쿠키 인증 상태 변경 라우트는 다른 출처를 거절한다', () => {
  const req = (url: string, method: string, origin?: string) =>
    new Request(`${ORIGIN}${url}`, {
      method,
      headers: { 'content-type': 'application/json', host: 'localhost:3025', ...(origin ? { origin } : {}) },
      body: '{}',
    });

  it('가드 함수: 다른 Origin 403, 같은 Origin 통과, Origin·Referer 없음 403', async () => {
    expect(rejectCrossOrigin(req('/api/notifications', 'PATCH', 'https://evil.example'))?.status).toBe(403);
    expect(rejectCrossOrigin(req('/api/notifications', 'PATCH', ORIGIN))).toBeNull();
    expect(rejectCrossOrigin(req('/api/notifications', 'PATCH'))?.status).toBe(403);
  });

  it('알림 PATCH: 다른 출처는 403 (로그인 상태여도), 같은 출처는 정상 처리', async () => {
    const donor = await makeUser({ role: 'DONOR' });
    await loginAs(donor.id);
    const cross = await notificationsPatch(req('/api/notifications', 'PATCH', 'https://evil.example'));
    expect(cross.status).toBe(403);
    const same = await notificationsPatch(req('/api/notifications', 'PATCH', ORIGIN));
    expect(same.status).not.toBe(403);
  });

  it('오버레이 배치·게임 컨트롤 POST 도 다른 출처는 403', async () => {
    const fx: Fixture = await seedBasics();
    await loginAs(fx.creatorUserId);
    expect((await overlayLayoutPost(req('/api/studio/overlay/layout', 'POST', 'https://evil.example'))).status).toBe(403);
    expect((await gameControlPost(req('/api/studio/games/control', 'POST', 'https://evil.example'))).status).toBe(403);
    // 같은 출처는 가드를 통과한다(본문이 비어 있어 이후 단계에서 다른 응답이 나온다).
    expect((await overlayLayoutPost(req('/api/studio/overlay/layout', 'POST', ORIGIN))).status).not.toBe(403);
  });
});

// ───────────────────── 세션 정리 ─────────────────────

describe('만료·폐기 세션 정리', () => {
  it('30일이 지난 만료·폐기 세션만 지운다', async () => {
    const u = await makeUser({ role: 'DONOR' });
    const old = new Date(Date.now() - 40 * 86_400_000);
    const mk = (data: { expiresAt: Date; revokedAt?: Date }) =>
      prisma.userSession.create({ data: { id: newId(), userId: u.id, tokenHash: tokenHash(generateToken(16)), ...data } });
    await mk({ expiresAt: old });
    await mk({ expiresAt: new Date(Date.now() + 86_400_000), revokedAt: old });
    const live = await mk({ expiresAt: new Date(Date.now() + 86_400_000) });
    const recent = await mk({ expiresAt: new Date(Date.now() - 86_400_000) });

    expect(await purgeStaleSessions()).toBe(2);
    const left = (await prisma.userSession.findMany({ where: { userId: u.id } })).map((s) => s.id).sort();
    expect(left).toEqual([live.id, recent.id].sort());
  });
});
