import { env, isLocal } from '@/lib/env';
import { cookies, headers } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, tokenHash } from '@/lib/crypto';
import { addDays } from '@/lib/datetime';
import type { UserRole, CreatorStatus } from '@/generated/prisma/enums';
import { clientIpFrom } from '@/server/rate-limit';
import { logger } from '@/lib/logger';

/**
 * 세션 기반 인증.
 * - 세션 토큰 원문은 쿠키에만 존재하고 DB 에는 해시만 저장한다.
 * - `requireAdmin()` 은 role 만 본다. 권한 등급(permission) 검사는 변경 액션 래퍼
 *   (`app/actions/admin/shared.ts` 의 requireWriteAdmin / assertFinanceAdmin)에서 한다.
 */

export const SESSION_COOKIE = 'tornado_session';
const SESSION_DAYS = 14;

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  role: UserRole;
  avatarIndex: number;
  creatorId?: string;
  /** 크리에이터 캐릭터를 DB 재생성 후에도 동일하게 유지하는 고정 코드 */
  creatorCode?: string;
  creatorAvatarUrl?: string | null;
  /** 크리에이터 프로필 상태. APPROVED 가 아니면 스튜디오 기능을 쓸 수 없다. */
  creatorStatus?: CreatorStatus;
  adminPermission?: string;
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string | null) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export async function createSession(userId: string) {
  const token = generateToken(32);
  const h = await headers();
  await prisma.userSession.create({
    data: {
      id: newId(),
      userId,
      tokenHash: tokenHash(token),
      ip: clientIpFrom((name) => h.get(name)),
      userAgent: h.get('user-agent') ?? null,
      expiresAt: addDays(new Date(), SESSION_DAYS),
    },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    /**
     * 프로덕션 빌드를 http(사내망 IP 등)로 접근하는 미리보기에서 세션이 떨어지지 않도록
     * 실제 서비스 주소가 https 일 때만 Secure 속성을 붙인다.
     *
     * 판단 기준은 `NODE_ENV` 가 아니라 **APP_ENV + 서비스 주소**다. CLAUDE.md 는 .env 에
     * NODE_ENV 를 넣지 말라고 하고 있어서, https 로 서비스하는데 NODE_ENV 가 production 이
     * 아니면 세션 쿠키가 Secure 없이 나갈 수 있었다. 웹 후원 쪽 쿠키와도 기준이 달랐다.
     */
    secure: !isLocal && env.baseUrl.startsWith('https'),
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return token;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.userSession.updateMany({
      where: { tokenHash: tokenHash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  jar.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: {
      user: { include: { creatorProfile: true, adminProfile: true } },
    },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  const u = session.user;
  if (u.status !== 'ACTIVE') return null;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarIndex: u.avatarIndex,
    creatorId: u.creatorProfile?.id,
    creatorCode: u.creatorProfile?.code,
    creatorAvatarUrl: u.creatorProfile?.avatarUrl,
    creatorStatus: u.creatorProfile?.status,
    adminPermission: u.adminProfile?.permission,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('로그인이 필요합니다.');
  return user;
}

export async function requireRole(role: UserRole): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== role) throw new Error('접근 권한이 없습니다.');
  return user;
}

/**
 * 크리에이터 전용 화면/액션 가드.
 *
 * 프로필 존재만으로는 부족하다. 심사 대기(PENDING)·반려(REJECTED)·정지(SUSPENDED) 상태에서도
 * 스튜디오에 접근되면 미승인 채널이 후원을 받거나, 정지된 채널이 정산을 신청할 수 있다.
 * 정지 상태는 세션 자체를 무효화해 모든 탭에서 즉시 로그아웃시킨다.
 */
export async function requireCreator(): Promise<SessionUser & { creatorId: string }> {
  const user = await requireUser();
  if (!user.creatorId) throw new Error('크리에이터 권한이 필요합니다.');

  const status = user.creatorStatus;
  if (status !== 'APPROVED') {
    if (status === 'SUSPENDED') {
      await destroySession().catch(() => undefined);
      throw new Error('정지된 채널입니다. 고객센터로 문의해 주세요.');
    }
    if (status === 'REJECTED') throw new Error('채널 심사가 반려되었습니다. 고객센터로 문의해 주세요.');
    throw new Error('채널 승인 후 이용할 수 있습니다. 심사가 완료되면 알려드립니다.');
  }

  return user as SessionUser & { creatorId: string };
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'ADMIN') throw new Error('관리자 권한이 필요합니다.');
  return user;
}

/** 관리자 변경 감사로그 */
export async function writeAudit(input: {
  adminUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}) {
  const h = await headers();
  let adminProfileId: string | null = null;
  if (input.adminUserId) {
    const p = await prisma.adminProfile.findUnique({ where: { userId: input.adminUserId }, select: { id: true } });
    adminProfileId = p?.id ?? null;
    if (!adminProfileId) {
      // 권한 등급 없이 role 만 ADMIN 인 계정. 이 경우 감사로그가 "시스템"으로만 남아 추적이 안 된다.
      // requireWriteAdmin() 이 이런 계정을 막지만, 흔적은 반드시 남긴다.
      logger.error('감사로그: 관리자 프로필이 없는 계정의 변경', {
        adminUserId: input.adminUserId,
        action: input.action,
        targetType: input.targetType,
      });
    }
  }

  /**
   * 감사 기록 실패가 **작업 실패로 보이면 안 된다.**
   *
   * 예전에는 이 함수가 던지는 예외를 액션 래퍼가 잡아 `ok:false` 로 돌려줬다. 그런데 변경은
   * 이미 DB 에 반영된 뒤라, 운영자는 "실패"를 보고 재시도하고 두 번째 시도는
   * "이미 해당 상태입니다"로 거절되어 무슨 일이 일어났는지 알 수 없었다. 그리고 감사로그에는
   * 아무 기록도 남지 않았다. 기록에 실패하면 애플리케이션 로그로라도 남기고 작업은 성공으로 둔다.
   */
  try {
    await prisma.adminAuditLog.create({
      data: {
        id: newId(),
        adminId: adminProfileId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        beforeValue: (input.before ?? null) as object,
        afterValue: (input.after ?? null) as object,
        ip: clientIpFrom((name) => h.get(name)),
        userAgent: h.get('user-agent') ?? null,
      },
    });
  } catch (e) {
    logger.error('감사로그 기록 실패 (작업 자체는 반영됨)', {
      adminUserId: input.adminUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      message: (e as Error).message,
    });
  }
}
