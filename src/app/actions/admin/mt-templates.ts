'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import {
  MT_TEMPLATE_META,
  SECURE_LINK_TEMPLATES,
  clearMtTemplateOverrideCache,
  validateMtTemplateBody,
  type MtTemplateCode,
} from '@/server/services/mt-templates';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, requiredId } from './shared';

/**
 * MT 문자 본문(mt_message_template) 관리 액션.
 *
 * 여기서 저장한 문구가 실제로 후원자 휴대폰에 찍힌다. 발신 주체 표기·결제 미완료 고지 같은
 * 법적 고지 문구가 사라지면 안 되므로 저장 전에 validateMtTemplateBody() 로 한 번 거른다.
 *
 * 보안링크가 들어가는 문자(최초 등록 안내 · 후원 확인 · PIN 입력)는 **최고관리자만** 고칠 수 있다.
 * 안내 문장은 바꿀 수 있지만 `{보안링크}` 치환자는 뺄 수 없다(validateMtTemplateBody 에서 강제).
 * 이 문자들은 결제 흐름 자체를 좌우하므로 운영 권한에도 열지 않는다.
 */

function assertMtTemplateAdmin(permission: string, code?: MtTemplateCode): void {
  if (code && SECURE_LINK_TEMPLATES.has(code)) {
    if (permission !== 'SUPER_ADMIN') {
      throw new Error(
        `"${MT_TEMPLATE_META[code].label}" 문자는 결제 흐름에 직접 관여하므로 최고관리자만 수정할 수 있습니다.`,
      );
    }
    return;
  }
  if (permission !== 'SUPER_ADMIN' && permission !== 'OPERATION') {
    throw new Error('문자 본문 수정은 최고관리자 또는 운영 권한에서만 할 수 있습니다.');
  }
}

function parseCode(fd: FormData): MtTemplateCode {
  const code = requiredId(fd, 'code', '문자 템플릿') as MtTemplateCode;
  if (!MT_TEMPLATE_META[code]) throw new Error('알 수 없는 문자 템플릿 코드입니다.');
  return code;
}

/** 커스텀 본문 저장 (없으면 생성, 있으면 갱신). */
export async function saveMtTemplateAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const code = parseCode(fd);
    assertMtTemplateAdmin(admin.adminPermission ?? '', code);

    const body = text(fd, 'body');
    const problem = validateMtTemplateBody(code, body);
    if (problem) throw new Error(problem);

    const before = await prisma.mtMessageTemplate.findUnique({ where: { code }, select: { id: true, body: true } });
    await prisma.mtMessageTemplate.upsert({
      where: { code },
      create: { id: newId(), code, body, updatedBy: admin.id },
      update: { body, updatedBy: admin.id },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: before ? 'MT_TEMPLATE_UPDATE' : 'MT_TEMPLATE_CREATE',
      targetType: 'MtMessageTemplate',
      targetId: code,
      before: before ? { body: before.body } : undefined,
      after: { body },
    });

    // 발송 경로가 30초 캐시를 쓰므로, 저장 직후 바로 반영되도록 비운다.
    clearMtTemplateOverrideCache();
    revalidatePath('/admin/mt-templates');
    return `"${MT_TEMPLATE_META[code].label}" 문자 본문을 저장했습니다. 다음 발송부터 적용됩니다.`;
  });
}

/** 커스텀 본문 삭제 → 코드 기본 문구로 되돌린다. */
export async function resetMtTemplateAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const code = parseCode(fd);
    assertMtTemplateAdmin(admin.adminPermission ?? '', code);

    const before = await prisma.mtMessageTemplate.findUnique({ where: { code }, select: { body: true } });
    if (!before) throw new Error('저장된 커스텀 본문이 없습니다. 이미 기본 문구를 사용 중입니다.');

    await prisma.mtMessageTemplate.delete({ where: { code } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MT_TEMPLATE_RESET',
      targetType: 'MtMessageTemplate',
      targetId: code,
      before: { body: before.body },
    });

    clearMtTemplateOverrideCache();
    revalidatePath('/admin/mt-templates');
    return `"${MT_TEMPLATE_META[code].label}" 문자를 기본 문구로 되돌렸습니다.`;
  });
}
