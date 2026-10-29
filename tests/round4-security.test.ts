import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-29 4차 점검 — 권한·비밀번호·시드 계정 회귀 테스트 (SEC-2, P2-14, P2-15, P2-21, 정책 기본값).
 */

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  // 호출 시점의 쿠키를 고정한다. 동시 요청 테스트에서 각 요청이 자기 세션을 보게 하려는 것이다.
  cookies: async () => {
    const snap = new Map(mocks.jar);
    return {
    get: (key: string) => (snap.has(key) ? { value: snap.get(key)! } : undefined),
    set: (key: string, value: string) => void mocks.jar.set(key, value),
    delete: (key: string) => void mocks.jar.delete(key),
    };
  },
  headers: async () => new Headers(Object.fromEntries(mocks.headers)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// studio 액션이 끌어오는 public-base-url 은 'server-only' 를 import 한다(테스트 환경에는 없는 패키지).
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, tokenHash } from '@/lib/crypto';
import { SESSION_COOKIE, verifyPassword } from '@/server/auth';
import { resetDb, seedBasics, seedRegisteredDonor, type Fixture } from './helpers';
import {
  updateCreatorAmountBounds,
  applyGlobalAmountBounds,
  unlockDonor,
  setDonorBlock,
  updateAdminPermission,
  revokeAdmin,
} from '@/app/actions/admin/accounts';
import { changeCreatorPasswordAction } from '@/app/actions/studio';
import { testLogin } from '@/app/actions/auth';
import { findLegacySeedAdminProblem, assertNoLegacySeedAdmin } from '@/server/boot-checks';
import { initialAdminState } from '@/components/admin/state';

type Permission = 'SUPER_ADMIN' | 'OPERATION' | 'FINANCE' | 'SUPPORT' | 'READ_ONLY';

async function makeAdmin(permission: Permission) {
  const user = await prisma.user.create({
    data: { id: newId(), email: `a-${newId()}@test.local`, name: '관리자', role: 'ADMIN', status: 'ACTIVE' },
  });
  const profile = await prisma.adminProfile.create({ data: { id: newId(), userId: user.id, permission } });
  return { user, profile };
}

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

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  mocks.jar.clear();
  mocks.headers.clear();
  mocks.headers.set('host', 'localhost:3025');
  mocks.headers.set('x-forwarded-for', '127.0.0.1');
});

describe('P2-15 1건 후원금 허용 범위는 최고관리자·재무만, 전역 상한 이내로', () => {
  it('고객지원·운영은 개별 변경을 할 수 없다', async () => {
    for (const p of ['SUPPORT', 'OPERATION'] as const) {
      const { user } = await makeAdmin(p);
      await loginAs(user.id);
      const r = await updateCreatorAmountBounds(initialAdminState, fd({ creatorId: fx.creatorId, minAmount: '1000', maxAmount: '20000' }));
      expect(r.ok, p).toBe(false);
      expect(r.message).toContain('재무 권한');
    }
  });

  it('재무는 변경할 수 있지만 전역 상한(50,000원)을 넘길 수는 없다', async () => {
    const { user } = await makeAdmin('FINANCE');
    await loginAs(user.id);
    const over = await updateCreatorAmountBounds(initialAdminState, fd({ creatorId: fx.creatorId, minAmount: '1000', maxAmount: '50001' }));
    expect(over.ok).toBe(false);
    expect(over.message).toContain('전역 한도 정책');
    const ok = await updateCreatorAmountBounds(initialAdminState, fd({ creatorId: fx.creatorId, minAmount: '1000', maxAmount: '50000' }));
    expect(ok.ok).toBe(true);
    const c = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } });
    expect(c.maxAmount).toBe(50000n);
  });

  it('전체 일괄 적용도 같은 등급(운영 불가, 재무 가능)과 같은 상한을 쓴다', async () => {
    const op = await makeAdmin('OPERATION');
    await loginAs(op.user.id);
    expect((await applyGlobalAmountBounds(initialAdminState, fd({ minAmount: '1000', maxAmount: '30000' }))).ok).toBe(false);

    const fin = await makeAdmin('FINANCE');
    await loginAs(fin.user.id);
    expect((await applyGlobalAmountBounds(initialAdminState, fd({ minAmount: '1000', maxAmount: '90000' }))).ok).toBe(false);
    expect((await applyGlobalAmountBounds(initialAdminState, fd({ minAmount: '1000', maxAmount: '30000' }))).ok).toBe(true);
  });
});

describe('정책 기본값: 후원자 잠금·제한 해제는 운영 권한 이상', () => {
  it('고객지원은 잠금 해제·제한 해제를 못 하고, 제한은 걸 수 있다', async () => {
    const donor = await seedRegisteredDonor();
    await prisma.donorProfile.update({ where: { id: donor.id }, data: { lockedUntil: new Date(Date.now() + 3600_000), failCount: 3 } });
    const support = await makeAdmin('SUPPORT');
    await loginAs(support.user.id);

    expect((await unlockDonor(initialAdminState, fd({ donorId: donor.id }))).ok).toBe(false);
    expect((await setDonorBlock(initialAdminState, fd({ donorId: donor.id, next: 'BLOCK', reason: '도용 의심' }))).ok).toBe(true);
    expect((await setDonorBlock(initialAdminState, fd({ donorId: donor.id, next: 'UNBLOCK' }))).ok).toBe(false);

    const op = await makeAdmin('OPERATION');
    await loginAs(op.user.id);
    expect((await unlockDonor(initialAdminState, fd({ donorId: donor.id }))).ok).toBe(true);
    expect((await setDonorBlock(initialAdminState, fd({ donorId: donor.id, next: 'UNBLOCK' }))).ok).toBe(true);
    const after = await prisma.donorProfile.findUniqueOrThrow({ where: { id: donor.id } });
    expect(after.lockedUntil).toBeNull();
    expect(after.blockedAt).toBeNull();
  });
});

describe('P2-21 마지막 SUPER_ADMIN 보호', () => {
  it('두 최고관리자가 동시에 서로를 회수해도 최소 1명은 남는다', async () => {
    const a = await makeAdmin('SUPER_ADMIN');
    const b = await makeAdmin('SUPER_ADMIN');
    // 세션 쿠키가 하나뿐인 모의 환경이라 각 호출 직전에 쿠키를 바꿔 끼운다.
    const tokenA = generateToken(32);
    const tokenB = generateToken(32);
    for (const [uid, t] of [[a.user.id, tokenA], [b.user.id, tokenB]] as const) {
      await prisma.userSession.create({
        data: { id: newId(), userId: uid, tokenHash: tokenHash(t), expiresAt: new Date(Date.now() + 86_400_000) },
      });
    }
    mocks.jar.set(SESSION_COOKIE, tokenA);
    const p1 = revokeAdmin(initialAdminState, fd({ profileId: b.profile.id }));
    mocks.jar.set(SESSION_COOKIE, tokenB);
    const p2 = updateAdminPermission(initialAdminState, fd({ profileId: a.profile.id, permission: 'READ_ONLY' }));
    const results = await Promise.all([p1, p2]);
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const supers = await prisma.adminProfile.count({ where: { permission: 'SUPER_ADMIN', revokedAt: null } });
    expect(supers).toBeGreaterThanOrEqual(1);
  });

  it('최고관리자가 셋이면 차례로 둘까지는 줄일 수 있다(정상 경로는 막지 않는다)', async () => {
    const a = await makeAdmin('SUPER_ADMIN');
    const b = await makeAdmin('SUPER_ADMIN');
    const c = await makeAdmin('SUPER_ADMIN');
    await loginAs(a.user.id);
    expect((await updateAdminPermission(initialAdminState, fd({ profileId: b.profile.id, permission: 'OPERATION' }))).ok).toBe(true);
    await loginAs(c.user.id);
    expect((await revokeAdmin(initialAdminState, fd({ profileId: a.profile.id }))).ok).toBe(true);
    expect(await prisma.adminProfile.count({ where: { permission: 'SUPER_ADMIN', revokedAt: null } })).toBe(1);
  });
});

describe('SEC-2 비밀번호 변경은 입력 원문을 쓴다(trim 하지 않음)', () => {
  it('앞뒤 공백이 있는 현재 비밀번호를 확인하고, 새 비밀번호도 공백 포함 원문으로 저장한다', async () => {
    await prisma.user.update({
      where: { id: fx.creatorUserId },
      data: { passwordHash: await bcrypt.hash(' old-pass-123 ', 10) },
    });
    await loginAs(fx.creatorUserId);
    const r = await changeCreatorPasswordAction(
      { ok: false, message: '' } as never,
      fd({ currentPassword: ' old-pass-123 ', newPassword: '  new-pass-456', newPasswordConfirm: '  new-pass-456' }),
    );
    expect(r.ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: fx.creatorUserId } });
    expect(await verifyPassword('  new-pass-456', u.passwordHash)).toBe(true);
    expect(await verifyPassword('new-pass-456', u.passwordHash)).toBe(false);
  });
});

describe('SEC-1 테스트 로그인은 터널 요청에서 거절된다', () => {
  it('cloudflared 헤더가 붙은 요청은 세션을 만들지 않는다', async () => {
    await prisma.user.create({ data: { id: newId(), email: 'admin@tornado.kr', name: '관리자', role: 'ADMIN' } });
    mocks.headers.set('x-forwarded-for', '203.0.113.7');
    mocks.headers.set('cf-connecting-ip', '203.0.113.7');
    const r = await testLogin({}, fd({ account: 'admin' }));
    expect(r.message).toContain('직접 접속');
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });
});

describe('P2-14 공개된 기본 비밀번호의 시드 관리자 점검', () => {
  it('admin@tornado.kr 가 tornado1234! 로 로그인되면 prod 기동을 막는다', async () => {
    await prisma.user.create({
      data: {
        id: newId(), email: 'admin@tornado.kr', name: '관리자', role: 'ADMIN',
        passwordHash: await bcrypt.hash('tornado1234!', 4),
      },
    });
    expect(await findLegacySeedAdminProblem()).toContain('admin@tornado.kr');
    await expect(assertNoLegacySeedAdmin('prod')).rejects.toThrow(/운영 기동 중단/);
    await expect(assertNoLegacySeedAdmin('local')).resolves.toBeUndefined();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(assertNoLegacySeedAdmin('staging')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('비밀번호를 바꾼 계정은 문제로 보지 않는다', async () => {
    await prisma.user.create({
      data: {
        id: newId(), email: 'admin@tornado.kr', name: '관리자', role: 'ADMIN',
        passwordHash: await bcrypt.hash('a-much-longer-random-secret', 4),
      },
    });
    expect(await findLegacySeedAdminProblem()).toBeNull();
    await expect(assertNoLegacySeedAdmin('prod')).resolves.toBeUndefined();
  });
});
