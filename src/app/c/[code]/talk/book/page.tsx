import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CalendarClock, ChevronLeft } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { SlotPicker } from '@/components/talk/talk-forms';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { isShopPaymentMock } from '@/server/adapters/shop-payment';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { getCreatorEngagement, getTalkConfig } from '@/server/services/engagement/config';
import { getSlots, sessionAvailability } from '@/server/services/talk/sessions';

export const dynamic = 'force-dynamic';
export const metadata = { title: '1:1 채팅 예약 | 도네이도', robots: { index: false, follow: false } };

/** 1:1 채팅 일정표 · 신청. 전역 스위치가 꺼져 있거나 크리에이터가 받지 않으면 샵으로 돌려보낸다 */
export default async function TalkBookPage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const path = `/c/${creator.code}/talk/book`;
  const talk = await getTalkConfig();
  const avail = await sessionAvailability(creator.id, talk);
  if (!avail.available) redirect(`/c/${creator.code}?tab=talk`);
  const user = await getSessionUser();
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(path)}`);
  const [{ slots, minutes }, eng, mine] = await Promise.all([
    getSlots(creator.id),
    getCreatorEngagement(creator.id, prisma, { talk }),
    prisma.talkSession.findMany({ where: { creatorId: creator.id, userId: user.id, status: { in: ['REQUESTED', 'ACCEPTED'] } }, orderBy: { startsAt: 'asc' }, select: { id: true } }),
  ]);
  const refundNote = `크리에이터가 수락하면 확정돼요. 승인 전 취소 · 거절 · 기한 만료는 전액 환불, 확정 후에는 시작 ${talk.sessionFullRefundHours}시간 전까지 전액 · 그 이후 ${Math.round(talk.sessionLateRefundRate * 100)}% 환불, 시작 후에는 취소할 수 없어요. 크리에이터가 ${talk.sessionNoShowMinutes}분 안에 들어오지 않으면 전액 환불돼요.`;

  return (
    <CreatorDonateShell creator={creator} activeMenu="donate">
      <div className="py-5">
        <Link href={`/c/${creator.code}?tab=talk`} className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
          <ChevronLeft size={15} aria-hidden />
          샵으로
        </Link>
        <header className="mb-4 flex items-center gap-3 rounded-[22px] bg-white p-4 shadow-card">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-100 text-brand-700"><CalendarClock size={22} aria-hidden /></span>
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-black tracking-[-0.03em] text-ink-900">{creator.displayName} 1:1 채팅 예약</h1>
            <p className="text-[12.5px] text-ink-500">1회 {minutes}분 · {eng.session.price.toLocaleString('ko-KR')}원</p>
          </div>
        </header>
        {mine.length > 0 ? (
          <Link href="/my/talk" className="mb-4 block rounded-xl bg-brand-50 px-4 py-3 text-[12.5px] font-bold text-brand-800">이 크리에이터에게 신청한 예약이 {mine.length}건 있어요 · 마이페이지에서 보기</Link>
        ) : null}
        <SlotPicker creatorId={creator.id} slots={slots.map((s) => ({ startsAt: s.startsAt, date: s.date, time: s.time, available: s.available }))} price={eng.session.price} minutes={minutes} mock={isShopPaymentMock()} refundNote={refundNote} />
      </div>
    </CreatorDonateShell>
  );
}
