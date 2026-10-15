'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser, writeAudit } from '@/server/auth';
import { acceptAdminInvite } from '@/server/services/admin-invite';
import { logger } from '@/lib/logger';

/**
 * [SEC-A] 관리자 초대 수락.
 *
 * 관리자 콘솔 밖(일반 로그인 사용자)에서 부르므로 requireAdmin 을 쓰지 않는다.
 * 대신 **현재 세션의 사용자**만 수락 주체가 될 수 있고, 그 계정의 이메일이 초대 이메일과
 * 같아야 한다(서비스에서 검사). 로그인하지 않았으면 아무것도 하지 않는다.
 */
export interface AcceptInviteState {
  ok: boolean;
  message?: string;
}

export async function acceptAdminInviteAction(_prev: AcceptInviteState, fd: FormData): Promise<AcceptInviteState> {
  const token = String(fd.get('token') ?? '').trim();
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: '초대받은 이메일 계정으로 먼저 로그인해 주세요.' };

    const result = await acceptAdminInvite(token, user.id);
    if (!result.ok) return { ok: false, message: result.message };

    // 감사로그 주체는 초대를 만든 최고관리자로 남기고, 실제 수락자는 targetId 로 남긴다.
    await writeAudit({
      adminUserId: result.invitedById,
      action: result.reinstated ? 'ADMIN_INVITE_ACCEPT_REINSTATE' : 'ADMIN_INVITE_ACCEPT',
      targetType: 'User',
      targetId: user.id,
      before: { role: result.beforeRole },
      after: { role: 'ADMIN', permission: result.permission, inviteId: result.inviteId },
    });
    revalidatePath('/admin/admins');
    return { ok: true, message: result.message };
  } catch (e) {
    logger.error('관리자 초대 수락 실패', { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
