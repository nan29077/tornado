import { cache } from 'react';
import { notFound } from 'next/navigation';
import { normalizeCreatorCode } from '@/lib/id';
import { prisma } from '@/server/db';

export const loadCreatorDonateProfile = cache(async (rawCode: string) => {
  const code = normalizeCreatorCode(rawCode);
  if (!/^TOR-[A-Z0-9]{2,10}$/.test(code)) notFound();
  const creator = await prisma.creatorProfile.findFirst({
    where: { code, status: 'APPROVED', user: { status: 'ACTIVE' } },
    select: { id: true, code: true, displayName: true, channelName: true, avatarUrl: true, description: true, liveOn: true, liveUrl: true, user: { select: { avatarIndex: true } } },
  });
  if (!creator) notFound();
  return { ...creator, avatarIndex: creator.user.avatarIndex, liveUrl: creator.liveOn ? creator.liveUrl : null };
});
