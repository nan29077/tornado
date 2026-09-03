'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';

/**
 * 후원 페이지 알림 읽음 처리.
 *
 * 알림은 후원자 개인의 것이므로 **로그인한 본인 것만** 건드린다.
 * where 에 userId 를 반드시 함께 넣는다(id 만으로 지우면 남의 알림을 읽음 처리할 수 있다).
 */
export async function markCreatorPageNotificationsRead(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  const id = String(formData.get('id') ?? '').trim();
  const backTo = String(formData.get('backTo') ?? '').trim();

  if (id) {
    await prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
  } else {
    await prisma.notification.updateMany({
      where: { userId: user.id, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
  }

  // 헤더·레일의 안 읽음 배지가 바로 줄어들어야 한다.
  if (/^\/c\/TOR-[A-Z0-9]{2,10}(\/[a-z-]+)?$/.test(backTo)) revalidatePath(backTo);
}
