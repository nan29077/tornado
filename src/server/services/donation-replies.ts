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

/** 타인의 donorId를 받지 않는다. 세션 계정에 연결된 휴대폰의 MO 내역만 반환한다. */
export async function listMyCreatorMessages(userId: string, creatorId: string, requestedPage = 1) {
  const donor = await prisma.donorProfile.findFirst({ where: { userId, user: { status: 'ACTIVE' } }, select: { id: true } });
  if (!donor) return { connected: false, rows: [], total: 0, page: 1, pages: 1 };
  const where = { donorId: donor.id, creatorId, channel: 'MO' };
  const total = await prisma.donation.count({ where });
  const pages = Math.max(1, Math.ceil(total / 20));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const rows = await prisma.donation.findMany({
    where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20,
    select: { id: true, amount: true, message: true, status: true, receivedAt: true, isTest: true, reply: { select: { body: true, updatedAt: true } } },
  });
  return { connected: true, rows, total, page, pages };
}
