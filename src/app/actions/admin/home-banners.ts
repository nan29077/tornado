'use server';

import { revalidatePath } from 'next/cache';
import { HOME_BANNER_DEFAULTS, homeBannerSchema } from '@/lib/home-banners';
import { writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { homeBannerKey } from '@/server/services/home-banners';
import { enumValue, int, run, text, type AdminActionState } from './shared';

export async function saveHomeBanner(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error('최고 관리자만 상단 배너를 변경할 수 있습니다.');

    const tab = enumValue(fd, 'tab', ['creator', 'fan'] as const, '홈 탭');
    const slot = int(fd, 'slot', { min: 1, max: HOME_BANNER_DEFAULTS[tab].length, label: '배너 번호' });
    const key = homeBannerKey(tab, slot);
    const reset = text(fd, 'intent') === 'reset';

    if (reset) {
      await prisma.systemSetting.deleteMany({ where: { key } });
    } else {
      const parsed = homeBannerSchema.safeParse({
        image: text(fd, 'image'),
        eyebrow: text(fd, 'eyebrow'),
        title: text(fd, 'title'),
        description: text(fd, 'description'),
        href: text(fd, 'href'),
        cta: text(fd, 'cta'),
        video: text(fd, 'video'),
        poster: text(fd, 'poster'),
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(issue?.path[0] === 'title' ? '제목 또는 슬로건을 2~90자로 입력해 주세요.' : issue?.message);
      }
      const data = { value: parsed.data, updatedBy: admin.id };
      await prisma.systemSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
    }

    await writeAudit({
      adminUserId: admin.id,
      action: reset ? 'HOME_BANNER_RESET' : 'HOME_BANNER_UPDATE',
      targetType: 'SystemSetting',
      targetId: key,
      after: { tab, slot },
    });
    revalidatePath('/');
    revalidatePath('/admin/banners');
    return reset ? '기본 배너를 복원했습니다.' : '상단 배너를 저장했습니다.';
  });
}
