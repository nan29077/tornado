import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { generateToken, tokenHash } from '@/lib/crypto';
import type { AdminPermission } from '@/generated/prisma/enums';

/**
 * [SEC-A] 관리자 초대.
 *
 * 왜 바꿨는가
 * -----------
 * 예전 `createAdminByEmail` 은 최고관리자가 이메일을 입력하는 순간 그 이메일로 가입된 계정을
 * **즉시** 관리자로 승격했다. 이메일 소유 확인이 없는 회원가입 구조에서는, 공격자가 초대될 사람의
 * 이메일(또는 오타가 난 비슷한 이메일)로 먼저 가입해 두기만 하면 그대로 관리자 콘솔을 얻는다.
 *
 * 지금 흐름 (운영 결정 사항)
 *  1) 최고관리자가 이메일 + 권한으로 초대를 만든다 → 1회용 토큰 링크(72시간) 발급
 *  2) 이메일 발송은 연동 전이다. 링크를 화면에 보여 주고 **직접 전달**한다(mock 명시)
 *  3) 초대받은 사람이 **그 이메일 계정으로 로그인한 상태에서** 링크를 열어 수락해야 승격된다
 *  4) 회수·만료·이미 사용된 초대는 수락할 수 없다. 생성·수락·회수는 감사로그에 남긴다
 *
 * 토큰 원문은 DB 에 남기지 않는다(tokenHash 만 저장 — 세션·비밀번호 재설정과 같은 규칙).
 */

export const ADMIN_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export const ADMIN_INVITE_PERMISSIONS = ['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const;

export function adminInviteLink(token: string): string {
  return `${env.baseUrl}/admin-invite/${token}`;
}

export function normalizeInviteEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface CreatedAdminInvite {
  id: string;
  email: string;
  permission: AdminPermission;
  expiresAt: Date;
  /** 원문 토큰이 담긴 링크. 이 응답에서만 볼 수 있다. */
  link: string;
  /** 같은 이메일로 살아 있던 이전 초대를 회수한 수 */
  replaced: number;
}

/**
 * 초대 생성. 같은 이메일로 살아 있는 이전 초대는 회수한다(링크가 여러 장 살아 있지 않게).
 * 권한 검사(SUPER_ADMIN)는 호출하는 서버 액션이 한다.
 */
export async function createAdminInvite(input: {
  invitedById: string;
  email: string;
  permission: AdminPermission;
  now?: Date;
}): Promise<CreatedAdminInvite> {
  const email = normalizeInviteEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('이메일 형식을 확인해 주세요.');
  if (!ADMIN_INVITE_PERMISSIONS.includes(input.permission)) throw new Error('권한 값이 올바르지 않습니다.');

  // 이미 활성 관리자인 이메일이면 초대할 이유가 없다(권한 변경은 목록에서 한다).
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { role: true, adminProfile: { select: { revokedAt: true } } },
  });
  if (existing?.role === 'ADMIN' && existing.adminProfile && !existing.adminProfile.revokedAt) {
    throw new Error('이미 관리자로 등록된 계정입니다. 권한 변경은 관리자 목록에서 해 주세요.');
  }

  const now = input.now ?? new Date();
  const token = generateToken(32);
  const id = newId();
  const expiresAt = new Date(now.getTime() + ADMIN_INVITE_TTL_MS);

  const [replaced] = await prisma.$transaction([
    prisma.adminInvite.updateMany({
      where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, revokedById: input.invitedById },
    }),
    prisma.adminInvite.create({
      data: {
        id,
        email,
        permission: input.permission,
        tokenHash: tokenHash(token),
        invitedById: input.invitedById,
        expiresAt,
      },
    }),
  ]);

  return { id, email, permission: input.permission, expiresAt, link: adminInviteLink(token), replaced: replaced.count };
}

export type AdminInviteState = 'VALID' | 'NOT_FOUND' | 'EXPIRED' | 'USED' | 'REVOKED';

export interface LoadedAdminInvite {
  state: AdminInviteState;
  id?: string;
  email?: string;
  emailMasked?: string;
  permission?: AdminPermission;
  expiresAt?: Date;
}

export function maskInviteEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain || !name) return '***';
  const head = name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

/** 초대 상태 확인(승격하지 않는다). 수락 화면 진입 시 사용한다. */
export async function loadAdminInvite(token: string, now = new Date()): Promise<LoadedAdminInvite> {
  if (!token) return { state: 'NOT_FOUND' };
  const row = await prisma.adminInvite.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: { id: true, email: true, permission: true, expiresAt: true, acceptedAt: true, revokedAt: true },
  });
  if (!row) return { state: 'NOT_FOUND' };
  const base = {
    id: row.id,
    email: row.email,
    emailMasked: maskInviteEmail(row.email),
    permission: row.permission,
    expiresAt: row.expiresAt,
  };
  if (row.acceptedAt) return { state: 'USED', ...base };
  if (row.revokedAt) return { state: 'REVOKED', ...base };
  if (row.expiresAt.getTime() <= now.getTime()) return { state: 'EXPIRED', ...base };
  return { state: 'VALID', ...base };
}

export interface AcceptAdminInviteResult {
  ok: boolean;
  message: string;
  inviteId?: string;
  invitedById?: string;
  permission?: AdminPermission;
  reinstated?: boolean;
  beforeRole?: string;
}

const STATE_MESSAGE: Record<Exclude<AdminInviteState, 'VALID'>, string> = {
  NOT_FOUND: '유효하지 않은 초대 링크입니다. 초대한 최고관리자에게 다시 요청해 주세요.',
  EXPIRED: '초대 링크가 만료되었습니다. 초대한 최고관리자에게 다시 요청해 주세요.',
  USED: '이미 사용된 초대 링크입니다.',
  REVOKED: '회수된 초대 링크입니다. 초대한 최고관리자에게 문의해 주세요.',
};

/**
 * 초대 수락 → 관리자 승격.
 *
 * `userId` 는 **현재 로그인한 세션의 사용자**여야 한다(서버 액션이 세션에서 꺼내 넘긴다).
 * 조건
 *  - 계정이 활성 상태이고 삭제되지 않았다
 *  - 크리에이터 계정이 아니다(관리자 겸직 금지 — 기존 규칙 유지)
 *  - 계정 이메일이 초대 이메일과 정확히 같다(소문자 비교)
 *  - 초대가 VALID 이고, 선점(updateMany acceptedAt=null) 에 성공한 요청만 승격한다(1회용)
 */
export async function acceptAdminInvite(token: string, userId: string, now = new Date()): Promise<AcceptAdminInviteResult> {
  const loaded = await loadAdminInvite(token, now);
  if (loaded.state !== 'VALID' || !loaded.id || !loaded.email || !loaded.permission) {
    return { ok: false, message: STATE_MESSAGE[loaded.state as Exclude<AdminInviteState, 'VALID'>] };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, role: true, status: true, deletedAt: true,
      adminProfile: { select: { id: true, revokedAt: true } },
    },
  });
  if (!user || user.deletedAt || user.status !== 'ACTIVE') {
    return { ok: false, message: '활성 상태의 계정으로 로그인한 뒤 수락해 주세요.' };
  }
  if (!user.email || normalizeInviteEmail(user.email) !== loaded.email) {
    // 어떤 이메일로 초대됐는지는 마스킹해서만 알려 준다.
    return {
      ok: false,
      message: `초대받은 이메일(${loaded.emailMasked}) 계정으로 로그인한 뒤 다시 열어 주세요.`,
    };
  }
  if (user.role === 'CREATOR') {
    return { ok: false, message: '크리에이터 계정은 관리자를 겸할 수 없습니다. 별도 계정으로 초대를 받아 주세요.' };
  }
  if (user.role === 'ADMIN' && user.adminProfile && !user.adminProfile.revokedAt) {
    return { ok: false, message: '이미 관리자로 등록된 계정입니다.' };
  }

  const inviteId = loaded.id;
  const permission = loaded.permission;
  const reinstated = Boolean(user.adminProfile);

  const result = await prisma.$transaction(async (tx) => {
    // 1회용 선점: 동시에 두 번 눌러도 한 번만 승격된다.
    const claimed = await tx.adminInvite.updateMany({
      where: { id: inviteId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now, acceptedUserId: user.id },
    });
    if (claimed.count !== 1) return null;
    const invite = await tx.adminInvite.findUniqueOrThrow({ where: { id: inviteId }, select: { invitedById: true } });
    await tx.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    if (user.adminProfile) {
      // 자격을 회수했던 계정은 프로필 행이 남아 있다(감사로그 보존). 새로 만들지 않고 되살린다.
      await tx.adminProfile.update({ where: { id: user.adminProfile.id }, data: { permission, revokedAt: null } });
    } else {
      await tx.adminProfile.create({ data: { id: newId(), userId: user.id, permission } });
    }
    return invite.invitedById;
  });

  if (!result) return { ok: false, message: STATE_MESSAGE.USED };
  return {
    ok: true,
    message: '관리자 초대를 수락했습니다. 관리자 콘솔을 이용할 수 있습니다.',
    inviteId,
    invitedById: result,
    permission,
    reinstated,
    beforeRole: user.role,
  };
}

/** 초대 회수. 이미 수락·회수된 초대는 바꾸지 않는다. */
export async function revokeAdminInvite(inviteId: string, revokedById: string, now = new Date()): Promise<boolean> {
  const r = await prisma.adminInvite.updateMany({
    where: { id: inviteId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now, revokedById },
  });
  return r.count === 1;
}
