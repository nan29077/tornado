import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, ChevronRight, MessageCircleHeart, MessagesSquare, UsersRound } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { Badge, cx } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { requestNowMs } from '@/lib/vote-period';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getTalkConfig } from '@/server/services/engagement/config';
import { listMyTalkRooms } from '@/server/services/talk/talk';
import { SESSION_STATUS_LABEL, formatKstShort, sweepSessions } from '@/server/services/talk/sessions';
import { ensureDemoData } from '@/server/services/demo-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '소통 | 도네이도', robots: { index: false, follow: false } };

function timeAgo(d: Date | null, now: number): string {
  if (!d) return '';
  const m = Math.floor((now - d.getTime()) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/**
 * 하단 메뉴 [소통] (2026-11-17)
 *  - 크리에이터 소통방: 크리에이터별 1:N 채팅(크리에이터 + 구독자 여러 명) 목록
 *  - 1:1 채팅: 예약한 1:1 채팅 목록 (최고관리자가 1:1 을 켰을 때만 보인다)
 *  - 아래에는 소통방을 연 크리에이터를 추천한다.
 */
export default async function TalkHubPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await ensureDemoData();
  const sp = await searchParams;
  const user = await getSessionUser().catch(() => null);
  const talk = await getTalkConfig();
  const sessionOn = talk.enabled && talk.sessionEnabled;
  const tab = sp.t === 'one' && sessionOn ? 'one' : 'rooms';
  const now = requestNowMs();

  if (user && sessionOn) await sweepSessions(new Date(), { userId: user.id }).catch(() => undefined);
  const [rooms, sessions, openRooms] = await Promise.all([
    user && talk.enabled ? listMyTalkRooms(user.id) : Promise.resolve([]),
    user && sessionOn
      ? prisma.talkSession.findMany({
          where: { userId: user.id },
          orderBy: { startsAt: 'desc' },
          take: 40,
          include: { creator: { select: { code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } } } },
        })
      : Promise.resolve([]),
    talk.enabled
      ? prisma.talkRoom.findMany({
          where: { open: true, creator: { status: 'APPROVED' } },
          orderBy: { updatedAt: 'desc' },
          take: 12,
          include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } }, _count: { select: { talkSubscriptions: true } } } } },
        })
      : Promise.resolve([]),
  ]);
  const unreadTotal = rooms.reduce((s, r) => s + r.unread, 0);
  const upcoming = sessions.filter((s) => s.status === 'REQUESTED' || s.status === 'ACCEPTED');
  const past = sessions.filter((s) => s.status !== 'REQUESTED' && s.status !== 'ACCEPTED');
  const joined = new Set(rooms.map((r) => r.creator.id));

  return (
    <PublicShell>
      <header className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-black tracking-[-0.04em] text-ink-900">소통</h1>
          <p className="mt-0.5 text-[13px] text-ink-500">크리에이터와 팬이 함께하는 소통방{sessionOn ? '과 1:1 채팅' : ''}을 한곳에서.</p>
        </div>
        {user ? null : (
          <Link href="/login?next=%2Ftalk" className="inline-flex h-9 items-center rounded-xl bg-ink-900 px-3.5 text-[12.5px] font-extrabold text-white">로그인</Link>
        )}
      </header>

      {!talk.enabled ? (
        <p className="rounded-2xl bg-white p-8 text-center text-[13.5px] font-bold text-ink-500 shadow-card">지금은 소통 기능을 쉬고 있어요.</p>
      ) : (
        <>
          <nav aria-label="소통 종류" className={cx('mb-4 grid gap-1 rounded-2xl bg-white p-1 shadow-card', sessionOn ? 'grid-cols-2' : 'grid-cols-1')}>
            <Link href="/talk" aria-current={tab === 'rooms' ? 'page' : undefined} className={cx('relative flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-extrabold', tab === 'rooms' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100')}>
              <UsersRound size={16} aria-hidden />
              크리에이터 소통방
              {unreadTotal > 0 ? <span className="rounded-full bg-danger-500 px-1.5 text-[10.5px] font-black leading-[18px] text-white">{unreadTotal > 99 ? '99+' : unreadTotal}</span> : null}
            </Link>
            {sessionOn ? (
              <Link href="/talk?t=one" aria-current={tab === 'one' ? 'page' : undefined} className={cx('flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-extrabold', tab === 'one' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100')}>
                <CalendarClock size={16} aria-hidden />
                1:1 채팅
                {upcoming.length > 0 ? <span className="rounded-full bg-brand-400 px-1.5 text-[10.5px] font-black leading-[18px] text-ink-900">{upcoming.length}</span> : null}
              </Link>
            ) : null}
          </nav>

          {tab === 'rooms' ? (
            <section>
              {!user ? (
                <div className="rounded-[22px] bg-white p-6 text-center shadow-card">
                  <MessagesSquare size={28} className="mx-auto text-brand-600" aria-hidden />
                  <p className="mt-2 text-[15px] font-black text-ink-900">로그인하고 크리에이터와 대화해 보세요</p>
                  <p className="mt-1 text-[12.5px] text-ink-500">구독한 크리에이터의 소통방이 여기에 모여요.</p>
                  <Link href="/login?next=%2Ftalk" className="mt-4 inline-flex h-11 items-center rounded-xl bg-ink-900 px-6 text-[13.5px] font-extrabold text-white">로그인</Link>
                </div>
              ) : rooms.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-ink-200 bg-white px-5 py-8 text-center">
                  <p className="text-[14px] font-extrabold text-ink-700">참여 중인 소통방이 없어요</p>
                  <p className="mt-1 text-[12.5px] text-ink-400">아래에서 크리에이터 소통방에 들어가 보세요.</p>
                </div>
              ) : (
                <ul className="divide-y divide-ink-100 overflow-hidden rounded-[22px] bg-white shadow-card">
                  {rooms.map((r) => (
                    <li key={r.creator.id}>
                      <Link href={r.active ? `/c/${r.creator.code}/talk` : `/c/${r.creator.code}?tab=talk`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-warm-50">
                        <span className="relative shrink-0">
                          <ProfileAvatar seed={r.creator.code} avatarIndex={r.creator.user.avatarIndex} name={r.creator.displayName} imageUrl={r.creator.avatarUrl} className="h-[52px] w-[52px]" />
                          <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-white ring-2 ring-white"><UsersRound size={11} aria-hidden /></span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[14.5px] font-extrabold text-ink-900">{r.creator.displayName}</span>
                            {!r.active ? <Badge>기간 만료</Badge> : null}
                          </span>
                          <span className="mt-0.5 block truncate text-[12.5px] text-ink-500">{r.lastBody ?? '아직 메시지가 없어요'}</span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-[11px] text-ink-400">{timeAgo(r.lastAt, now)}</span>
                          {r.unread > 0 ? <span className="min-w-5 rounded-full bg-danger-500 px-1.5 text-center text-[10.5px] font-black leading-5 text-white">{r.unread > 99 ? '99+' : r.unread}</span> : <ChevronRight size={15} className="text-ink-300" aria-hidden />}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {openRooms.filter((o) => !joined.has(o.creator.id)).length > 0 ? (
                <div className="mt-6">
                  <h2 className="mb-2 text-[15px] font-black text-ink-900">소통방이 열린 크리에이터</h2>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {openRooms.filter((o) => !joined.has(o.creator.id)).map((o) => (
                      <Link key={o.id} href={`/c/${o.creator.code}?tab=talk`} className="flex flex-col items-center rounded-2xl bg-white p-3.5 text-center shadow-card hover:-translate-y-0.5 transition-transform">
                        <ProfileAvatar seed={o.creator.code} avatarIndex={o.creator.user.avatarIndex} name={o.creator.displayName} imageUrl={o.creator.avatarUrl} className="h-14 w-14" />
                        <span className="mt-2 w-full truncate text-[13.5px] font-extrabold text-ink-900">{o.creator.displayName}</span>
                        <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-400">{o.welcomeMessage ?? '소통방 열림'}</span>
                        <span className="mt-2 inline-flex h-8 items-center gap-1 rounded-full bg-ink-900 px-3 text-[11.5px] font-extrabold text-white"><MessageCircleHeart size={12} aria-hidden />들어가기</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="space-y-4">
              {!user ? (
                <Link href="/login?next=%2Ftalk%3Ft%3Done" className="block rounded-[22px] bg-white p-6 text-center text-[14px] font-extrabold text-ink-800 shadow-card">로그인하고 1:1 채팅 예약 보기</Link>
              ) : sessions.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-ink-200 bg-white px-5 py-8 text-center">
                  <CalendarClock size={26} className="mx-auto text-ink-300" aria-hidden />
                  <p className="mt-2 text-[14px] font-extrabold text-ink-700">예약한 1:1 채팅이 없어요</p>
                  <p className="mt-1 text-[12.5px] text-ink-400">크리에이터 샵 [소통] 탭에서 날짜와 시간을 골라 신청할 수 있어요.</p>
                </div>
              ) : (
                <>
                  {[{ title: '다가오는 예약', list: upcoming }, { title: '지난 1:1 채팅', list: past }].map((g) =>
                    g.list.length === 0 ? null : (
                      <div key={g.title}>
                        <h2 className="mb-2 text-[14px] font-black text-ink-800">{g.title}</h2>
                        <ul className="divide-y divide-ink-100 overflow-hidden rounded-[22px] bg-white shadow-card">
                          {g.list.map((s) => {
                            const st = SESSION_STATUS_LABEL[s.status] ?? { text: s.status, tone: 'neutral' as const };
                            const live = s.status === 'ACCEPTED' && s.startsAt.getTime() <= now && s.endsAt.getTime() > now;
                            return (
                              <li key={s.id}>
                                <Link href={`/my/talk/sessions/${s.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-warm-50">
                                  <ProfileAvatar seed={s.creator.code} avatarIndex={s.creator.user.avatarIndex} name={s.creator.displayName} imageUrl={s.creator.avatarUrl} className="h-12 w-12" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[14px] font-extrabold text-ink-900">{s.creator.displayName}</span>
                                    <span className="block text-[12px] text-ink-500">{formatKstShort(s.startsAt)} · {s.minutes}분</span>
                                  </span>
                                  {live ? <span className="rounded-full bg-danger-500 px-2 py-0.5 text-[11px] font-black text-white">지금 입장</span> : <Badge tone={st.tone}>{st.text}</Badge>}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ),
                  )}
                </>
              )}
              <p className="text-center text-[11.5px] text-ink-400">1:1 채팅은 크리에이터가 수락하면 예약 시간에 열려요 · {formatKst(new Date(), false).slice(0, 10)} 기준</p>
            </section>
          )}
        </>
      )}
    </PublicShell>
  );
}
