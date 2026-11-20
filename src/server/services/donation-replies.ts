import { z } from 'zod';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';

export const donationReplySchema = z.string().trim().min(1, '답글을 입력해 주세요.').max(1000, '답글은 1,000자까지 입력할 수 있습니다.');

/** 사용자 ID는 인증된 세션에서만 받는다. 크리에이터 소유권은 DB에서 재확인한다. */
export async function saveDonationReply(userId: string, donationId: string, rawBody: string) {
  const body = donationReplySchema.parse(rawBody);
  return prisma.$transaction(async (tx) => {
    const donation = await tx.donation.findFirst({
      where: { id: donationId, donorId: { not: null }, creator: { userId, status: 'APPROVED', user: { status: 'ACTIVE', role: 'CREATOR' } } },
      select: { id: true, creator: { select: { code: true } } },
    });
    if (!donation) throw new Error('답글을 작성할 수 있는 후원 내역이 아닙니다.');
    await tx.donationReply.upsert({ where: { donationId }, create: { id: newId(), donationId, body }, update: { body } });
    return donation.creator.code;
  });
}

/**
 * 답글 알림을 받을 후원자 정보 (8차 점검, 2026-11-20).
 * 예전에는 크리에이터가 답글을 달아도 후원자에게 알림이 가지 않아, 마이페이지를 직접 열어 봐야 알 수 있었다.
 * 후원자 휴대폰이 회원 계정에 연결돼 있을 때만 알림을 보낸다. 같은 답글을 고칠 때마다 알리지 않도록 처음 한 번만.
 */
export async function replyNotifyTarget(donationId: string): Promise<{ userId: string; creatorName: string; creatorCode: string } | null> {
  const d = await prisma.donation.findUnique({
    where: { id: donationId },
    select: { donor: { select: { userId: true, user: { select: { status: true } } } }, creator: { select: { displayName: true, code: true } }, reply: { select: { createdAt: true, updatedAt: true } } },
  });
  if (!d?.donor?.userId || d.donor.user?.status !== 'ACTIVE' || !d.reply) return null;
  // 방금 처음 만든 답글만 (수정은 updatedAt 만 바뀐다)
  if (d.reply.updatedAt.getTime() - d.reply.createdAt.getTime() > 1000) return null;
  return { userId: d.donor.userId, creatorName: d.creator.displayName, creatorCode: d.creator.code };
}

/** 타인의 donorId를 받지 않는다. 세션 계정에 연결된 휴대폰의 MO 내역만 반환한다. */
export async function listMyCreatorMessages(userId: string, creatorId: string, requestedPage = 1) {
  const donor = await prisma.donorProfile.findFirst({ where: { userId, user: { status: 'ACTIVE' } }, select: { id: true } });
  if (!donor) return { connected: false, rows: [], total: 0, page: 1, pages: 1 };
  // (8차 점검) 문자 후원뿐 아니라 간편계좌이체 · 신용카드 · 영상 후원도 함께 보여 준다 (답글은 경로와 관계없이 달 수 있다)
  const where = { donorId: donor.id, creatorId };
  const total = await prisma.donation.count({ where });
  const pages = Math.max(1, Math.ceil(total / 20));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const rows = await prisma.donation.findMany({
    where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20,
    select: { id: true, amount: true, message: true, status: true, receivedAt: true, isTest: true, channel: true, reply: { select: { body: true, updatedAt: true } } },
  });
  return { connected: true, rows, total, page, pages };
}
