import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, Gift, PartyPopper, Trophy, UsersRound } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { EmptyRanking } from '@/components/vote/ranking-board';
import { Countdown } from '@/components/vote/live-bits';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { formatKst } from '@/lib/datetime';
import { listEventRounds, ROUND_KIND_LABEL } from '@/server/services/vote/rounds';
import { ensureDemoData } from '@/server/services/demo-data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '이벤트 팬투표 | 도네이도' };

/** 팬투표 이벤트 (2026-11-18) — 주제별 · 시즌 이벤트와 왕중왕전. 진행 · 예정 · 종료(결과 리포트) */
export default async function VoteEventsPage() {
  await ensureDemoData();
  const { live, upcoming, ended } = await listEventRounds();
  return (
    <PublicShell>
      <PageHeader eyebrow="EVENT" title="이벤트 팬투표" description="주제별 · 시즌 이벤트와 왕중왕전. 1위에게는 신문 광고 같은 보상이 주어져요." />
      <VoteSubNav active="events" />
      {live.length + upcoming.length + ended.length === 0 ? <EmptyRanking title="아직 열린 이벤트가 없어요" description="새 이벤트가 열리면 여기에 보여요." /> : null}
      {live.length > 0 ? (
        <>
          <h2 className="mb-2 flex items-center gap-1.5 text-[16px] font-black text-ink-900">
            <PartyPopper size={17} className="text-danger-600" aria-hidden />
            진행 중
          </h2>
          <div className="mb-6 grid gap-3 sm:grid-cols-2">
            {live.map((r) => (
              <Card key={r.id} r={r} state="live" />
            ))}
          </div>
        </>
      ) : null}
      {upcoming.length > 0 ? (
        <>
          <h2 className="mb-2 text-[16px] font-black text-ink-900">곧 시작</h2>
          <div className="mb-6 grid gap-3 sm:grid-cols-2">
            {upcoming.map((r) => (
              <Card key={r.id} r={r} state="upcoming" />
            ))}
          </div>
        </>
      ) : null}
      {ended.length > 0 ? (
        <>
          <h2 className="mb-2 text-[16px] font-black text-ink-900">지난 이벤트 · 결과</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {ended.map((r) => (
              <Card key={r.id} r={r} state="ended" />
            ))}
          </div>
        </>
      ) : null}
    </PublicShell>
  );
}

type EventRound = Awaited<ReturnType<typeof listEventRounds>>['live'][number];

function Card({ r, state }: { r: EventRound; state: 'live' | 'upcoming' | 'ended' }) {
  return (
    <Link href={`/vote/events/${r.id}`} className="block overflow-hidden rounded-[22px] bg-white shadow-card transition-transform hover:-translate-y-0.5">
      {r.bannerUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.bannerUrl} alt="" className="aspect-[16/7] w-full object-cover" />
      ) : (
        <div className="grid aspect-[16/7] place-items-center bg-[linear-gradient(135deg,#ffd257_0%,#ffb648_55%,#ff9f1c_100%)]">
          <Trophy size={34} className="text-ink-900/70" aria-hidden />
        </div>
      )}
      <div className="p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-extrabold text-brand-800">
          <span className="rounded bg-brand-100 px-1.5 py-px">{ROUND_KIND_LABEL[r.kind] ?? r.kind}</span>
          {state === 'live' ? <span className="rounded bg-danger-500 px-1.5 py-px text-white">진행 중</span> : state === 'upcoming' ? <span className="rounded bg-ink-900 px-1.5 py-px text-white">예정</span> : <span className="rounded bg-ink-100 px-1.5 py-px text-ink-500">종료</span>}
        </p>
        <p className="mt-1.5 line-clamp-2 text-[15.5px] font-black tracking-[-0.02em] text-ink-900">{r.title}</p>
        {r.rewardText ? (
          <p className="mt-1 flex items-center gap-1 text-[12px] font-bold text-accent-600">
            <Gift size={13} aria-hidden />
            {r.rewardText}
          </p>
        ) : null}
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-500">
          <span className="inline-flex items-center gap-1">
            <UsersRound size={12} aria-hidden />후보 {r.candidates.length}명
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarClock size={12} aria-hidden />
            {state === 'live' ? <Countdown endsAt={r.endsAt.toISOString()} prefix="종료까지" /> : state === 'upcoming' ? `${formatKst(r.startsAt, false).slice(5, 16)} 시작` : `${formatKst(r.endsAt, false).slice(0, 10)} 종료`}
          </span>
        </p>
      </div>
    </Link>
  );
}
