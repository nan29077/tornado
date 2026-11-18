import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart3, ChevronLeft, Clock3, Gift, Trophy } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { EmptyRanking, Podium, RankList } from '@/components/vote/ranking-board';
import { AutoRefresh, Countdown } from '@/components/vote/live-bits';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { CheerBoard } from '@/components/vote/cheer-board';
import { formatKst } from '@/lib/datetime';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getVoteConfig } from '@/server/services/engagement/config';
import { roundRanking } from '@/server/services/vote/ranking';
import { closeEndedRounds, roundReport, ROUND_KIND_LABEL } from '@/server/services/vote/rounds';
import { getVoteViewer, voteContextOf } from '@/server/services/vote/view';
import { listCheers } from '@/server/services/vote/fan';
import { listRewardGrants, REWARD_TYPE_LABEL, GRANT_STATUS_LABEL } from '@/server/services/vote/rewards';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const r = await prisma.voteRound.findUnique({ where: { id: (await params).id }, select: { title: true } });
  return { title: r ? `${r.title} | 도네이도 팬투표` : '이벤트 | 도네이도 팬투표' };
}

/** 이벤트 팬투표 상세 (2026-11-18) — 후보 순위 · 팬투표 · 응원 · 결과 리포트 · 보상 */
export default async function VoteEventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ c?: string }> }) {
  const id = (await params).id;
  const sp = await searchParams;
  await closeEndedRounds().catch(() => 0);
  const report = await roundReport(id);
  if (!report || report.round.status === 'DRAFT') notFound();
  const { round } = report;
  const now = new Date();
  const live = round.status === 'OPEN' && round.startsAt <= now && round.endsAt > now;
  const upcoming = round.status === 'OPEN' && round.startsAt > now;
  const user = await getSessionUser().catch(() => null);
  const [rows, viewer, cfg, grants] = await Promise.all([roundRanking(id, { limit: 100 }), getVoteViewer(user?.id), getVoteConfig(), listRewardGrants({ publicOnly: true, limit: 50 })]);
  const voteCtx = live ? { ...voteContextOf(viewer), roundId: id } : null;
  const cheerTarget = rows.find((r) => r.code === (sp.c ?? '').toUpperCase()) ?? rows[0] ?? null;
  const cheers = await listCheers({ roundId: id, limit: 30, viewerId: user?.id ?? null });
  const myGrants = grants.filter((g) => g.sourceType === 'ROUND' && g.sourceKey === id);
  const path = `/vote/events/${id}`;

  return (
    <PublicShell>
      {live ? <AutoRefresh seconds={20} /> : null}
      <Link href="/vote/events" className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        이벤트 목록
      </Link>
      <VoteSubNav active="events" />

      <header className="mb-4 overflow-hidden rounded-[28px] bg-ink-900 text-white shadow-[0_20px_40px_rgba(23,22,26,0.25)]">
        {round.bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={round.bannerUrl} alt="" className="aspect-[16/6] w-full object-cover" />
        ) : null}
        <div className="p-5">
          <p className="flex items-center gap-1.5 text-[11px] font-extrabold text-brand-200">
            <Trophy size={13} aria-hidden />
            {ROUND_KIND_LABEL[round.kind] ?? round.kind}
            {live ? <span className="rounded bg-danger-500 px-1.5 py-px text-white">진행 중</span> : upcoming ? <span className="rounded bg-white/15 px-1.5 py-px">예정</span> : <span className="rounded bg-white/15 px-1.5 py-px">종료</span>}
          </p>
          <h1 className="mt-1.5 text-[22px] font-black leading-snug tracking-[-0.03em]">{round.title}</h1>
          {round.description ? <p className="mt-1.5 text-[13px] text-white/70">{round.description}</p> : null}
          {round.rewardText ? (
            <p className="mt-3 flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-[13px] font-extrabold text-brand-200">
              <Gift size={15} aria-hidden />
              {round.rewardText}
            </p>
          ) : null}
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-white/70">
            <span className="inline-flex items-center gap-1">
              <Clock3 size={13} aria-hidden />
              {live ? <Countdown endsAt={round.endsAt.toISOString()} prefix="종료까지" /> : upcoming ? `${formatKst(round.startsAt, false).slice(0, 16)} 시작` : `${formatKst(round.endsAt, false).slice(0, 16)} 종료`}
            </span>
            {round.dailyMaxVotes > 0 ? <span>1인 하루 최대 {round.dailyMaxVotes.toLocaleString('ko-KR')}표</span> : null}
          </p>
        </div>
      </header>

      {!live && !upcoming ? (
        <section className="mb-4 rounded-[22px] bg-white p-4 shadow-card">
          <p className="mb-3 flex items-center gap-1.5 text-[15px] font-black text-ink-900">
            <BarChart3 size={17} className="text-brand-700" aria-hidden />
            결과 리포트
          </p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl bg-warm-50 p-3">
              <p className="text-[11px] font-bold text-ink-400">총 팬투표</p>
              <p className="text-[17px] font-black tabular-nums text-ink-900">{report.totalVotes.toLocaleString('ko-KR')}</p>
            </div>
            <div className="rounded-2xl bg-warm-50 p-3">
              <p className="text-[11px] font-bold text-ink-400">참여 팬</p>
              <p className="text-[17px] font-black tabular-nums text-ink-900">{report.voters.toLocaleString('ko-KR')}명</p>
            </div>
            <div className="rounded-2xl bg-warm-50 p-3">
              <p className="text-[11px] font-bold text-ink-400">후보</p>
              <p className="text-[17px] font-black tabular-nums text-ink-900">{rows.length}명</p>
            </div>
          </div>
          {rows.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {rows.slice(0, 5).map((r) => {
                const total = rows.reduce((s, x) => s + x.votes, 0) || 1;
                const pct = Math.round((r.votes / total) * 1000) / 10;
                return (
                  <li key={r.creatorId}>
                    <div className="flex items-center justify-between text-[12.5px] font-bold">
                      <span className="truncate text-ink-800">
                        {r.rank}위 {r.displayName}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink-500">
                        {r.votes.toLocaleString('ko-KR')}표 · {pct}%
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100">
                      <span className="block h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {round.resultNote ? <p className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-[12.5px] text-ink-700">{round.resultNote}</p> : null}
          {myGrants.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {myGrants.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-2 rounded-xl bg-warning-50 px-3 py-2 text-[12.5px] font-bold">
                  <span className="truncate text-ink-800">
                    {g.rank}위 {g.creator?.displayName} · {REWARD_TYPE_LABEL[g.rewardType] ?? g.rewardType}
                  </span>
                  <Link href="/vote/rewards" className="shrink-0 text-accent-600">
                    {GRANT_STATUS_LABEL[g.status]}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {rows.length === 0 ? (
        <EmptyRanking title="후보가 없어요" description="관리자가 후보를 정하면 보여요." />
      ) : (
        <div className="space-y-3">
          <Podium rows={rows} vote={voteCtx} hideChange />
          <RankList rows={rows} vote={voteCtx} startAt={4} hideChange />
        </div>
      )}

      {cheerTarget ? (
        <div className="mt-5">
          {rows.length > 1 ? (
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
              {rows.slice(0, 20).map((r) => (
                <Link key={r.creatorId} href={`${path}?c=${r.code}#cheer`} scroll={false} className={`inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[12px] font-bold ${r.creatorId === cheerTarget.creatorId ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-100 bg-white text-ink-600'}`}>
                  {r.displayName}
                </Link>
              ))}
            </div>
          ) : null}
          <CheerBoard
            creatorId={cheerTarget.creatorId}
            roundId={id}
            path={path}
            title={`${cheerTarget.displayName} 님 응원하기`}
            cheers={cheers.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() }))}
            loggedIn={Boolean(user)}
            maxLength={cfg.cheerMaxLength}
            enabled={cfg.enabled && cfg.cheerEnabled && live}
          />
        </div>
      ) : null}
    </PublicShell>
  );
}
