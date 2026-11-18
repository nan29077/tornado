import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Award, CalendarHeart, ChevronLeft, ExternalLink, Megaphone, Trophy } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { VoteButton } from '@/components/vote/vote-button';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { CheerBoard } from '@/components/vote/cheer-board';
import { categoryLabel } from '@/lib/video-hub';
import { requestNowMs } from '@/lib/vote-period';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getVoteConfig } from '@/server/services/engagement/config';
import { getCreatorRanks } from '@/server/services/vote/ranking';
import { getVoteViewer, voteContextOf } from '@/server/services/vote/view';
import { getFanRanking, listCheers } from '@/server/services/vote/fan';
import { listRewardGrants, REWARD_TYPE_LABEL, GRANT_STATUS_LABEL } from '@/server/services/vote/rewards';
import { listSupports } from '@/server/services/vote/support';
import { ANNIVERSARY_KIND_LABEL, listCreatorAnniversaries } from '@/server/services/vote/anniversary';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const c = await prisma.creatorProfile.findFirst({ where: { code: (await params).code.toUpperCase() }, select: { displayName: true } });
  return { title: c ? `${c.displayName} 팬투표 | 도네이도` : '팬투표 | 도네이도' };
}

/** 크리에이터 팬투표 페이지 (2026-11-18) — 순위 · 팬투표 · 응원 · 이달의 팬 · 서포트 · 보상 · 기념일 */
export default async function CreatorVotePage({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const creator = await prisma.creatorProfile.findFirst({
    where: { code, status: 'APPROVED' },
    select: { id: true, code: true, displayName: true, avatarUrl: true, contentCategory: true, user: { select: { avatarIndex: true } } },
  });
  if (!creator) notFound();
  const user = await getSessionUser().catch(() => null);
  const monthStart = new Date(requestNowMs() - 30 * 86_400_000);
  const [viewer, cfg, ranks, cheers, fans, grants, supports, annis] = await Promise.all([
    getVoteViewer(user?.id),
    getVoteConfig(),
    getCreatorRanks(creator.id),
    listCheers({ creatorId: creator.id, limit: 30, viewerId: user?.id ?? null }),
    getFanRanking({ creatorId: creator.id, since: monthStart, limit: 10 }),
    listRewardGrants({ creatorId: creator.id, publicOnly: true, limit: 10 }),
    listSupports({ status: 'ALL', creatorId: creator.id, limit: 5 }),
    listCreatorAnniversaries(creator.id),
  ]);
  const vote = voteContextOf(viewer);
  const path = `/vote/creator/${creator.code}`;
  const tiles = [
    { l: '실시간', v: ranks.live },
    { l: '주간', v: ranks.week },
    { l: '월간', v: ranks.month },
    { l: '누적', v: ranks.all },
  ];

  return (
    <PublicShell>
      <Link href="/vote" className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        팬투표 랭킹으로
      </Link>
      <VoteSubNav active="ranking" />

      <header className="relative mb-4 overflow-hidden rounded-[28px] bg-ink-900 p-5 text-white shadow-[0_20px_40px_rgba(23,22,26,0.25)]">
        <span className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-brand-400/30 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3.5">
          <ProfileAvatar seed={creator.code} avatarIndex={creator.user.avatarIndex} name={creator.displayName} imageUrl={creator.avatarUrl} className="h-16 w-16 rounded-full ring-2 ring-brand-300" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-extrabold tracking-wide text-brand-200">{creator.contentCategory ? categoryLabel(creator.contentCategory) : 'CREATOR'}</p>
            <h1 className="truncate text-[22px] font-black tracking-[-0.03em]">{creator.displayName}</h1>
            <Link href={`/c/${creator.code}`} className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-bold text-white/70 hover:text-white">
              도네이도 샵 <ExternalLink size={12} aria-hidden />
            </Link>
          </div>
        </div>
        <div className="relative mt-4 grid grid-cols-4 gap-1.5">
          {tiles.map((t) => (
            <div key={t.l} className="rounded-2xl bg-white/10 px-2 py-2.5 text-center">
              <p className="text-[10.5px] font-bold text-white/60">{t.l}</p>
              <p className="text-[18px] font-black tabular-nums text-brand-200">{t.v.rank ? `${t.v.rank}위` : '-'}</p>
              <p className="text-[10.5px] tabular-nums text-white/60">{t.v.votes.toLocaleString('ko-KR')}표</p>
            </div>
          ))}
        </div>
        <div className="relative mt-4">
          <VoteButton {...vote} creator={{ id: creator.id, name: creator.displayName, code: creator.code, avatarUrl: creator.avatarUrl, avatarIndex: creator.user.avatarIndex, category: creator.contentCategory }} size="lg" label="팬투표하기" className="!bg-brand-400 !text-ink-900 hover:!bg-brand-300" />
        </div>
      </header>

      {annis.length > 0 ? (
        <section className="mb-4 flex flex-wrap gap-2">
          {annis.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[12px] font-bold text-ink-700 shadow-card">
              <CalendarHeart size={14} className="text-accent-600" aria-hidden />
              {a.title || ANNIVERSARY_KIND_LABEL[a.kind]} · {a.month}월 {a.day}일
            </span>
          ))}
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <CheerBoard creatorId={creator.id} path={path} cheers={cheers.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() }))} loggedIn={Boolean(user)} maxLength={cfg.cheerMaxLength} enabled={cfg.enabled && cfg.cheerEnabled} />
        <div className="space-y-4">
          <section className="rounded-[22px] bg-white p-4 shadow-card">
            <p className="mb-2 flex items-center gap-1.5 text-[15px] font-black text-ink-900">
              <Trophy size={17} className="text-brand-700" aria-hidden />
              최근 30일 팬 랭킹
            </p>
            {fans.length === 0 ? (
              <p className="py-4 text-center text-[12.5px] text-ink-400">아직 팬투표한 팬이 없어요.</p>
            ) : (
              <ol className="space-y-1.5">
                {fans.map((f) => (
                  <li key={f.userId} className="flex items-center gap-2.5">
                    <span className="w-6 text-center text-[13px] font-black tabular-nums text-ink-500">{f.rank}</span>
                    <ProfileAvatar seed={`fan-${f.userId}`} avatarIndex={f.avatarIndex} name={f.name} className="h-8 w-8" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink-800">
                      {f.name}
                      {f.level ? <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] font-black text-brand-800">Lv.{f.level}</span> : null}
                    </span>
                    <span className="text-[12.5px] font-black tabular-nums text-ink-900">{f.votes.toLocaleString('ko-KR')}표</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {supports.length > 0 ? (
            <section className="rounded-[22px] bg-white p-4 shadow-card">
              <p className="mb-2 flex items-center gap-1.5 text-[15px] font-black text-ink-900">
                <Megaphone size={17} className="text-brand-700" aria-hidden />
                서포트
              </p>
              <ul className="space-y-2">
                {supports.map((s) => (
                  <li key={s.id}>
                    <Link href={`/vote/support/${s.id}`} className="block rounded-xl bg-warm-50 px-3 py-2.5 hover:bg-warm-100">
                      <p className="truncate text-[13px] font-extrabold text-ink-900">{s.title}</p>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                        <span className="block h-full rounded-full bg-brand-400" style={{ width: `${Math.min(100, Math.round((s.raisedTickets / s.goalTickets) * 100))}%` }} />
                      </div>
                      <p className="mt-1 text-[11px] font-bold text-ink-500">{Math.min(100, Math.round((s.raisedTickets / s.goalTickets) * 100))}% · {s.status === 'OPEN' ? '진행 중' : s.status === 'SUCCESS' ? '성공' : '마감'}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {grants.length > 0 ? (
            <section className="rounded-[22px] bg-white p-4 shadow-card">
              <p className="mb-2 flex items-center gap-1.5 text-[15px] font-black text-ink-900">
                <Award size={17} className="text-brand-700" aria-hidden />
                받은 보상
              </p>
              <ul className="space-y-1.5">
                {grants.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="min-w-0 truncate font-bold text-ink-800">
                      {g.sourceLabel}
                      {g.rank ? ` ${g.rank}위` : ''} · {REWARD_TYPE_LABEL[g.rewardType] ?? g.rewardType}
                    </span>
                    <span className="shrink-0 text-[11px] font-bold text-ink-400">{GRANT_STATUS_LABEL[g.status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </PublicShell>
  );
}
