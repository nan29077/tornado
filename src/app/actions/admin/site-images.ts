'use server';

import { revalidatePath } from 'next/cache';
import { writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { isSiteImageSelection } from '@/lib/site-images';
import { SITE_IMAGE_KEYS } from '@/server/services/site-images';
import { enumValue, run, text, type AdminActionState } from './shared';

export async function saveSiteImage(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error('최고 관리자만 사이트 이미지를 변경할 수 있습니다.');

    const kind = enumValue(fd, 'kind', ['margin', 'banner'] as const, '이미지 종류');
    const value = text(fd, 'preset');
    if (!isSiteImageSelection(kind, value)) throw new Error('목록에서 적용할 이미지를 선택해 주세요.');

    const key = SITE_IMAGE_KEYS[kind];
    const data = { value, updatedBy: admin.id };
    await prisma.systemSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
    await writeAudit({
      adminUserId: admin.id,
      action: 'SITE_IMAGE_UPDATE',
      targetType: 'SystemSetting',
      targetId: key,
      after: { preset: value },
    });

    revalidatePath('/', 'layout');
    return kind === 'margin' ? '여백 이미지를 적용했습니다.' : '배너 이미지를 적용했습니다.';
  });
}
