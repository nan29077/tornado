/** 도네이도 구독 (팬 귀속과 별개 — 여러 크리에이터를 구독할 수 있다) */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';

export async function setFollow(userId: string, creatorId: string, on: boolean) {
  if (on) {
    const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { status: true } });
    if (!creator || creator.status !== 'APPROVED') throw new Error('구독할 수 없는 크리에이터입니다.');
    await prisma.memberFollow.upsert({
      where: { userId_creatorId: { userId, creatorId } },
      create: { id: newId(), userId, creatorId },
      update: {},
    });
  } else {
    await prisma.memberFollow.deleteMany({ where: { userId, creatorId } });
  }
}

export async function setFollowNotify(userId: string, creatorId: string, notify: boolean) {
  await prisma.memberFollow.updateMany({ where: { userId, creatorId }, data: { notify } });
}

export async function isFollowing(userId: string | null | undefined, creatorId: string): Promise<boolean> {
  if (!userId) return false;
  return Boolean(await prisma.memberFollow.findUnique({ where: { userId_creatorId: { userId, creatorId } }, select: { id: true } }));
}

export async function followerCount(creatorId: string): Promise<number> {
  return prisma.memberFollow.count({ where: { creatorId } });
}
