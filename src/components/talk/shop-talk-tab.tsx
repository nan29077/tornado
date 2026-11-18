import Link from 'next/link';
import { CalendarClock, ChevronRight, Heart, Lock, MessageCircleHeart, Sparkles } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { formatKst } from '@/lib/datetime';
import { personalize } from '@/lib/contact-mask';
import { prisma } from '@/server/db';
import { isShopPaymentMock, isShopPaymentOff } from '@/server/adapters/shop-payment';
import { PaymentPreparing } from '@/components/shop/payment-preparing';
import { getCreatorEngagement, getTalkConfig } from '@/server/services/engagement/config';
import { fanDisplayName, getSubscriptionStatus } from '@/server/services/talk/talk';
import { sessionAvailability } from '@/server/services/talk/sessions';
import { SubscribeForm } from './talk-forms';

/**
 * 도네이도 샵 [소통] 탭 (2026-11-17) — 버블형 월 구독 소개 · 결제 · 소통방 입장, 1:1 채팅 신청 바로가기.
 */
export async function ShopTalkTab({ creator, viewer }: { creator: { id: string; code: string; displayName: string; avatarUrl: string | null; avatarIndex: number }; viewer: { id: string; name: string | null } | null }) {
  const talk = await getTalkConfig();
  const [room, eng, status, avail] = await Promise.all([
    prisma.talkRoom.findUnique({ where: { creatorId: creator.id } }),
    getCreatorEngagement(creator.id, prisma, { talk }),
    getSubscriptionStatus(viewer?.id, creator.id),
    sessionAvailability(creator.id, talk),
  ]);
  const isOwner = Boolean(viewer && (await prisma.creatorProfile.findFirst({ where: { id: creator.id, userId: viewer.id }, select: { id: true } })));
  const latest = await prisma.talkMessage.findMany({ where: { creatorId: creator.id, kind: 'BROADCAST', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 3 });
  const name = viewer ? await fanDisplayName(viewer.id, viewer.name) : null;
  const loginHref = `/c/${creator.code}/login?next=${encodeURIComponent(`/c/${creator.code}?tab=talk`)}`;

  return (
    <div className="mt-5 space-y-4">
      <section className="relative overflow-hidden rounded-[26px] bg-ink-900 p-5 text-white shadow-[0_18px_36px_rgba(23,22,26,0.22)]">
        <span className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-brand-400/30 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={creator.displayName} imageUrl={creator.avatarUrl} className="h-14 w-14 ring-2 ring-brand-300 rounded-full" />
          <div className="min-w-0">
            <p className="flex items-center gap-1 text-[11px] font-extrabold tracking-wide text-brand-200"><MessageCircleHeart size={13} aria-hidden />{talk.roomMode === 'GROUP' ? 'FAN TALK · 1:N' : 'PRIVATE TALK'}</p>
            <h2 className="truncate text-[19px] font-black tracking-[-0.03em]">{creator.displayName} 님 소통방</h2>
          </div>
        </div>
        <ul className="relative mt-4 grid gap-1.5 text-[12.5px] text-white/80">
          <li className="flex gap-1.5"><Sparkles size={14} className="mt-0.5 shrink-0 text-brand-300" aria-hidden />크리에이터가 보내는 메시지를 내 이름으로 받아요</li>
          <li className="flex gap-1.5"><Heart size={14} className="mt-0.5 shrink-0 text-brand-300" aria-hidden />{talk.roomMode === 'GROUP' ? '크리에이터와 구독자 여러 명이 함께 대화해요' : '내 메시지는 크리에이터에게만 보여요 (다른 팬은 못 봐요)'}</li>
          <li className="flex gap-1.5"><Lock size={14} className="mt-0.5 shrink-0 text-brand-300" aria-hidden />연락처 · 링크는 자동으로 가려져 안전해요</li>
        </ul>
      </section>

      {!room?.open ? (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-white px-5 py-8 text-center">
          <p className="text-[14px] font-extrabold text-ink-700">아직 소통방을 준비 중이에요</p>
          <p className="mt-1 text-[12.5px] text-ink-400">{isOwner ? '스튜디오 > 소통 관리에서 소통방을 열 수 있어요.' : '크리에이터가 소통방을 열면 바로 알려 드릴게요.'}</p>
          {isOwner ? <Link href="/studio/talk" className="mt-3 inline-flex h-10 items-center rounded-xl bg-ink-900 px-4 text-[13px] font-extrabold text-white">소통방 열러 가기</Link> : null}
        </div>
      ) : (
        <section className="rounded-[22px] bg-white p-4 shadow-card sm:p-5">
          {latest.length > 0 ? (
            <div className="mb-4 space-y-2">
              <p className="text-[12px] font-bold text-ink-400">최근 메시지</p>
              {latest.map((m) => (
                <div key={m.id} className="flex items-start gap-2">
                  <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={creator.displayName} imageUrl={creator.avatarUrl} className="h-8 w-8 shrink-0" />
                  <p className={`min-w-0 flex-1 rounded-2xl rounded-tl-md bg-warm-100 px-3 py-2 text-[13px] leading-relaxed text-ink-800 ${status.active ? '' : 'select-none blur-[3px]'}`}>
                    {status.active ? personalize(m.body, name) : personalize(m.body, '팬').slice(0, 40)}
                    <span className="ml-1 text-[10.5px] text-ink-400">{formatKst(m.createdAt, false).slice(5, 16)}</span>
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {status.active ? (
            <>
              <Link href={`/c/${creator.code}/talk`} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white">
                <MessageCircleHeart size={18} aria-hidden />
                소통방 들어가기
              </Link>
              <p className="mt-2 text-center text-[12px] text-ink-500">이용 기간 {status.endsAt ? `${formatKst(status.endsAt, false).slice(0, 10)} 까지` : ''}</p>
{isShopPaymentOff() ? null : (
              <details className="mt-3 rounded-xl bg-warm-50 px-3 py-2">
                <summary className="cursor-pointer text-[12.5px] font-bold text-ink-600">이용 기간 연장하기</summary>
                <div className="mt-3"><SubscribeForm creatorId={creator.id} code={creator.code} price={eng.talkSub.price} periodDays={talk.subPeriodDays} mock={isShopPaymentMock()} renew /></div>
              </details>
              )}
            </>
          ) : isOwner ? (
            <p className="text-center text-[13px] text-ink-500">내 소통방입니다. 메시지는 스튜디오 &gt; 소통 관리에서 보내요.</p>
          ) : !viewer ? (
            <Link href={loginHref} className="flex h-12 items-center justify-center rounded-2xl bg-ink-900 text-[15px] font-black text-white">로그인하고 소통 시작하기</Link>
          ) : isShopPaymentOff() ? (
            <PaymentPreparing title="소통 구독은 준비 중이에요" />
          ) : (
            <>
              <div className="mb-3 flex items-baseline justify-between">
                <p className="text-[14px] font-extrabold text-ink-900">{talk.subPeriodDays}일 이용권</p>
                <p className="text-[20px] font-black tabular-nums text-ink-900">{eng.talkSub.price.toLocaleString('ko-KR')}<span className="text-[13px]">원</span></p>
              </div>
              <SubscribeForm creatorId={creator.id} code={creator.code} price={eng.talkSub.price} periodDays={talk.subPeriodDays} mock={isShopPaymentMock()} />
            </>
          )}
        </section>
      )}

      {avail.available ? (
        <Link href={`/c/${creator.code}/talk/book`} className="flex items-center gap-3 rounded-[22px] bg-gradient-to-r from-brand-100 to-white p-4 shadow-card ring-1 ring-brand-200">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-brand-700 shadow-sm"><CalendarClock size={20} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-black text-ink-900">1:1 채팅 예약</span>
            <span className="block text-[12px] text-ink-500">{room?.sessionMinutes ?? 20}분 · {eng.session.price.toLocaleString('ko-KR')}원 · 원하는 날짜와 시간을 골라 신청해요</span>
          </span>
          <ChevronRight size={18} className="text-ink-400" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
