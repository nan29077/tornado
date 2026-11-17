import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { FanChat } from '@/components/talk/fan-chat';
import { formatKst } from '@/lib/datetime';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { getTalkConfig } from '@/server/services/engagement/config';
import { getFanThread, getSubscriptionStatus, markFanRead } from '@/server/services/talk/talk';

export const dynamic = 'force-dynamic';
export const metadata = { title: '소통방 | 도네이도', robots: { index: false, follow: false } };

/** 구독자 소통방 (버블형). 구독 중이 아니면 샵 [소통] 탭으로 돌려보낸다 */
export default async function CreatorTalkRoomPage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const path = `/c/${creator.code}/talk`;
  const user = await getSessionUser();
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(path)}`);
  const talk = await getTalkConfig();
  if (!talk.enabled) redirect(`/c/${creator.code}`);
  const status = await getSubscriptionStatus(user.id, creator.id);
  if (!status.active) redirect(`/c/${creator.code}?tab=talk`);
  const [thread, room] = await Promise.all([getFanThread(user, creator.id), prisma.talkRoom.findUnique({ where: { creatorId: creator.id } })]);
  await markFanRead(user.id, creator.id).catch(() => undefined);

  return (
    <CreatorDonateShell creator={creator} activeMenu="donate">
      <div className="py-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <Link href={`/c/${creator.code}?tab=talk`} className="inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
            <ChevronLeft size={15} aria-hidden />
            샵으로
          </Link>
          <span className="text-[11.5px] text-ink-400">이용 기간 {status.endsAt ? formatKst(status.endsAt, false).slice(0, 10) : ''} 까지</span>
        </div>
        <h1 className="mb-3 text-[20px] font-black tracking-[-0.03em] text-ink-900">{creator.displayName} 소통방</h1>
        <FanChat
          creatorId={creator.id}
          creator={{ name: creator.displayName, code: creator.code, avatarUrl: creator.avatarUrl, avatarIndex: creator.avatarIndex ?? 0 }}
          initial={thread.messages}
          maxLength={talk.fanReplyMaxLength}
          welcome={room?.welcomeMessage ?? null}
          groupMode={talk.roomMode === 'GROUP'}
        />
        <p className="mt-2 text-center text-[11.5px] text-ink-400">하루 {talk.fanReplyDailyLimit > 0 ? `${talk.fanReplyDailyLimit}번까지` : '제한 없이'} 메시지를 보낼 수 있어요.</p>
      </div>
    </CreatorDonateShell>
  );
}
