import type { Metadata } from 'next';
import Link from 'next/link';
import { Award, Clock3, Search, Sparkles, Ticket, Trophy } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { EmptyRanking, Podium, RankList } from '@/components/vote/ranking-board';
import { VoteButton } from '@/components/vote/vote-button';
import { AutoRefresh, Countdown } from '@/components/vote/live-bits';
import { ChipScroller } from '@/components/vote/chip-scroller';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getCategoryLeaders, getRanking, RANKING_TABS, resolveRankingTab } from '@/server/services/vote/ranking';
import { categoryLabel, CONTENT_CATEGORY_SLUGS } from '@/lib/video-hub';
import { openRounds } from '@/server/services/vote/rounds';
import { getVoteViewer, voteContextOf } from '@/server/services/vote/view';
import { ensureDemoData } from '@/server/services/demo-data';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { todayAnniversaries } from '@/server/services/vote/anniversary';
import { currentBannerWinners } from '@/server/services/vote/rewards';
import { Cake, Megaphone } from '@/components/brand/icons';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '크리에이터 팬투표 랭킹 | 도네이도',
  description: '좋아하는 크리에이터에게 팬투표하세요. 실시간 · 일간 · 주간 · 월간 · 왕중왕 랭킹.',
};

type SP = Promise<{ p?: string; q?: string; vote?: string; cat?: string }>;

export default async function VotePage({ searchParams }: { searchParams: SP }) {
  await ensureDemoData();
  const sp = await searchParams;
  const tab = resolveRankingTab(sp.p);
  const q = (sp.q ?? '').trim().slice(0, 40);
  const user = await getSessionUser().catch(() => null);
  const viewer = await getVoteViewer(user?.id);
  // 카테고리별 랭킹: 한 표가 전체 랭킹과 그 크리에이터의 카테고리 랭킹에 함께 들어간다 (왕중왕전은 회차 후보끼리라 제외)
  const cat = tab !== 'champion' && (CONTENT_CATEGORY_SLUGS as string[]).includes(sp.cat ?? '') ? (sp.cat as string) : null;
  const chipTab = tab === 'month' ? 'month' : tab === 'live' ? 'live' : 'week';
  const [view, rounds, catLeaders, birthdays, winners] = await Promise.all([
    getRanking(tab, { limit: 100, q, category: cat }),
    openRounds(),
    tab === 'champion' ? Promise.resolve([]) : getCategoryLeaders(chipTab, { perCategory: 1 }).catch(() => []),
    todayAnniversaries().catch(() => []),
    currentBannerWinners().catch(() => []),
  ]);
  const catChips = catLeaders.map((l) => ({ slug: l.category, label: l.label, votes: l.totalVotes }));
  if (cat && !catChips.some((c) => c.slug === cat)) catChips.unshift({ slug: cat, label: categoryLabel(cat), votes: 0 });
  const vote = voteContextOf(viewer);
  const voteCtx = { ...vote, roundId: tab === 'champion' && view.round?.status === 'OPEN' ? view.round.id : null };
  const canVote = tab !== 'day' && (tab !== 'champion' || view.round?.status === 'OPEN');

  // /vote?vote=코드 → 그 크리에이터 팬투표 창을 바로 연다
  const target = sp.vote
    ? await prisma.creatorProfile.findFirst({
        where: { code: sp.vote.toUpperCase(), status: 'APPROVED' },
        select: { id: true, code: true, displayName: true, avatarUrl: true, contentCategory: true, user: { select: { avatarIndex: true } } },
      })
    : null;

  const href = (p: string, extra: Record<string, string> = {}, keepCat = true) => {
    const u = new URLSearchParams({ p, ...(q ? { q } : {}), ...(keepCat && cat && p !== 'champion' ? { cat } : {}), ...extra });
    return `/vote?${u.toString()}`;
  };
  const catHref = (slug: string | null) => {
    const u = new URLSearchParams({ p: tab, ...(q ? { q } : {}), ...(slug ? { cat: slug } : {}) });
    return `/vote?${u.toString()}`;
  };

  return (
    <PublicShell>
      {tab === 'live' ? <AutoRefresh seconds={15} /> : null}

      {/* 머리 */}
      <header className="relative mb-4 overflow-hidden rounded-[28px] bg-ink-900 px-5 pb-5 pt-6 text-white shadow-[0_20px_40px_rgba(23,22,26,0.25)] sm:px-7">
        <span className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-brand-400/30 blur-3xl" aria-hidden />
        <span className="pointer-events-none absolute -bottom-16 left-10 h-40 w-40 rounded-full bg-warning-500/25 blur-3xl" aria-hidden />
        <div className="relative">
          <p className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-extrabold tracking-wide text-brand-200">
            <Trophy size={13} aria-hidden /> CREATOR VOTE
          </p>
          <h1 className="mt-2 text-[26px] font-black leading-tight tracking-[-0.04em] sm:text-[30px]">내 최애 크리에이터를 1위로</h1>
          <p className="mt-1.5 text-[13px] text-white/70">광고 보고 받은 팬투표권으로도 팬투표할 수 있어요. 매일 · 매주 · 매달 순위가 확정돼요.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {viewer.loggedIn ? (
              <span className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white/10 px-3.5 text-[13px] font-bold">
                <Ticket size={16} className="text-brand-300" aria-hidden />내 팬투표권 <b className="tabular-nums text-white">{viewer.balance.toLocaleString('ko-KR')}</b>개
              </span>
            ) : null}
            <Link href="/vote/charge" className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-400 px-4 text-[13px] font-black text-ink-900 hover:bg-brand-300">
              <Sparkles size={15} aria-hidden />팬투표권 충전소
            </Link>
            <Link href="/vote/events" className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-white/20 px-3.5 text-[13px] font-bold text-white/90 hover:bg-white/10">
              <Award size={15} aria-hidden />이벤트 · 보상
            </Link>
          </div>
        </div>
      </header>

      <VoteSubNav active="ranking" />

      {winners.length > 0 ? (
        <section className="mb-4 space-y-2">
          {winners.map((w) => (
            <Link key={w.id} href={w.creator ? `/vote/creator/${w.creator.code}` : '/vote/rewards'} className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-ink-900 to-ink-800 px-4 py-3 text-white shadow-card">
              {w.creator ? <ProfileAvatar seed={w.creator.code} avatarIndex={w.creator.user.avatarIndex} name={w.creator.displayName} imageUrl={w.creator.avatarUrl} className="h-11 w-11 rounded-full ring-2 ring-brand-300" /> : null}
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-extrabold text-brand-200">축하합니다 · {w.sourceLabel}{w.rank ? ` ${w.rank}위` : ''}</span>
                <span className="block truncate text-[15px] font-black">{w.creator?.displayName ?? ''} {w.title}</span>
              </span>
              <Megaphone size={18} className="text-brand-300" aria-hidden />
            </Link>
          ))}
        </section>
      ) : null}

      {birthdays.length > 0 ? (
        <section className="mb-4 rounded-2xl bg-warning-50 p-3.5 ring-1 ring-brand-200">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-black text-accent-600">
            <Cake size={15} aria-hidden />
            오늘은 이런 날이에요
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
            {birthdays.map((b) => (
              <Link key={b.id} href={`/vote/creator/${b.creator.code}`} className="flex shrink-0 items-center gap-2 rounded-full bg-white py-1 pl-1 pr-3 shadow-sm">
                <ProfileAvatar seed={b.creator.code} avatarIndex={b.creator.user.avatarIndex} name={b.creator.displayName} imageUrl={b.creator.avatarUrl} className="h-8 w-8" />
                <span className="text-[12.5px] font-extrabold text-ink-900">{b.creator.displayName}</span>
                <span className="text-[11.5px] font-bold text-accent-600">{b.title}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {target ? (
        <section className="mb-4 flex items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50 p-3.5">
          <ProfileAvatar seed={target.code} avatarIndex={target.user.avatarIndex} name={target.displayName} imageUrl={target.avatarUrl} className="h-11 w-11" />
          <p className="min-w-0 flex-1 truncate text-[14px] font-extrabold text-ink-900">{target.displayName} 님에게 팬투표</p>
          <VoteButton {...vote} autoOpen creator={{ id: target.id, name: target.displayName, code: target.code, avatarUrl: target.avatarUrl, avatarIndex: target.user.avatarIndex, category: target.contentCategory }} size="md" label="팬투표하기" />
        </section>
      ) : null}

      {rounds.length > 0 && tab !== 'champion' ? (
        <Link href={rounds[0].kind === 'EVENT' ? `/vote/events/${rounds[0].id}` : href('champion')} className="mb-4 flex items-center gap-3 rounded-2xl bg-gradient-to-r from-brand-300 to-accent-400 px-4 py-3 text-ink-900 shadow-card">
          <Trophy size={20} strokeWidth={1.8} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-black">{rounds[0].title} 진행 중</span>
            <span className="text-[12px] font-bold text-ink-800/80"><Countdown endsAt={rounds[0].endsAt.toISOString()} prefix="종료까지" /></span>
          </span>
          <span className="text-[12.5px] font-extrabold">팬투표하러 가기</span>
        </Link>
      ) : null}

      {/* 탭 */}
      <nav aria-label="랭킹 기간" className="sticky top-[64px] z-20 -mx-4 mb-3 bg-warm-50/95 px-4 py-2 backdrop-blur lg:static lg:mx-0 lg:px-0">
        <div className="grid grid-cols-5 gap-1 rounded-2xl bg-white p-1 shadow-card">
          {RANKING_TABS.map((t) => (
            <Link
              key={t.key}
              href={href(t.key)}
              scroll={false}
              aria-current={tab === t.key ? 'page' : undefined}
              className={cx('grid h-10 place-items-center rounded-xl text-[13px] font-extrabold transition-colors', tab === t.key ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100')}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </nav>

      {tab !== 'champion' && catChips.length > 0 ? (
        <nav aria-label="카테고리별 랭킹" className="mb-3">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="shrink-0 text-[13.5px] font-black tracking-[-0.02em] text-ink-900">카테고리</p>
            <p className="min-w-0 truncate text-[11px] font-medium text-ink-400">한 표가 전체 · 카테고리 랭킹에 함께 들어가요</p>
          </div>
          {/* 모바일은 한 줄 가로 넘김(양끝 흐림), PC 는 줄바꿈 (2026-11-18 정리) */}
          <ChipScroller
            activeKey={cat ?? 'all'}
            className="relative -mx-4 flex snap-x gap-1.5 overflow-x-auto scroll-px-4 px-4 pt-1 pb-2.5 [mask-image:linear-gradient(to_right,transparent,#000_14px,#000_calc(100%-32px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none]"
          >
            <Link href={catHref(null)} scroll={false} aria-current={!cat ? 'page' : undefined} className={catChipClass(!cat)}>
              전체
            </Link>
            {catChips.map((c) => (
              <Link key={c.slug} href={catHref(c.slug)} scroll={false} aria-current={cat === c.slug ? 'page' : undefined} className={catChipClass(cat === c.slug)}>
                {c.label}
                {c.votes > 0 ? (
                  <span className={cx('rounded-full px-1.5 py-px text-[10.5px] font-bold tabular-nums', cat === c.slug ? 'bg-white/15 text-white/80' : 'bg-warm-100 text-ink-400')}>{compactVotes(c.votes)}</span>
                ) : null}
              </Link>
            ))}
          </ChipScroller>
        </nav>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[19px] font-black tracking-[-0.03em] text-ink-900">{view.title}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-500">
            {view.caption}
            {view.endsAt ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-900 px-2 py-0.5 text-[11px] font-bold text-white">
                <Clock3 size={11} aria-hidden />
                <Countdown endsAt={view.endsAt.toISOString()} />
              </span>
            ) : null}
          </p>
        </div>
        <form action="/vote" className="flex h-10 w-full items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 sm:w-[220px]">
          <input type="hidden" name="p" value={tab} />
          {cat ? <input type="hidden" name="cat" value={cat} /> : null}
          <Search size={15} className="text-ink-400" aria-hidden />
          <input name="q" defaultValue={q} placeholder="크리에이터 찾기" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        </form>
      </div>

      {view.round?.description ? <p className="mb-3 rounded-xl bg-white px-4 py-3 text-[13px] text-ink-600 shadow-card">{view.round.description}</p> : null}

      {!viewer.rankingPublic ? (
        <EmptyRanking title="랭킹 공개가 잠시 중지되었어요" description="팬투표는 그대로 반영되고 있어요." />
      ) : view.rows.length === 0 ? (
        <EmptyRanking
          title={tab === 'champion' ? '열린 왕중왕전이 없어요' : q ? '검색 결과가 없어요' : cat ? `${categoryLabel(cat)} 카테고리에 아직 팬투표가 없어요` : '아직 팬투표가 없어요'}
          description={tab === 'day' ? '어제 받은 표가 없어요. 실시간 탭에서 오늘 팬투표해 주세요.' : '첫 표를 보내 순위를 만들어 주세요.'}
        />
      ) : (
        <div className="space-y-3">
          {!q ? <Podium rows={view.rows} vote={canVote ? voteCtx : null} /> : null}
          <RankList rows={view.rows} vote={canVote ? voteCtx : null} startAt={q ? 1 : 4} />
          {view.total > view.rows.length ? <p className="text-center text-[12px] text-ink-400">상위 {view.rows.length}명까지 보여 드려요 (전체 {view.total.toLocaleString('ko-KR')}명)</p> : null}
        </div>
      )}

      <section className="mt-6 rounded-2xl bg-white p-4 text-[12.5px] leading-relaxed text-ink-500 shadow-card">
        <p className="mb-1 font-extrabold text-ink-800">팬투표 안내</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>실시간 랭킹은 오늘(00:00 기준) 받은 표예요. 일간은 매일 자정, 주간은 매주 월요일 자정, 월간은 매월 1일 자정에 확정돼요.</li>
          <li>동점이면 먼저 그 표 수에 도달한 크리에이터가 위예요.</li>
          <li>한 번 팬투표하면 전체 랭킹과 그 크리에이터의 카테고리 랭킹에 함께 반영돼요. 카테고리를 따로 고를 필요가 없어요.</li>
          <li>팬투표권은 팬투표 전용이며 현금으로 바꾸거나 선물할 수 없어요. 부정한 방법으로 얻은 표는 무효 처리될 수 있어요.</li>
        </ul>
      </section>
    </PublicShell>
  );
}

/** 카테고리 칩 모양 (2026-11-18) — 고른 칩은 진한 바탕, 나머지는 흰 바탕에 옅은 테두리 */
function catChipClass(on: boolean) {
  return cx(
    'inline-flex h-8 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-bold transition-colors',
    on
      ? 'border-ink-900 bg-ink-900 text-white shadow-[0_4px_12px_-4px_rgba(23,22,26,0.45)]'
      : 'border-ink-100 bg-white text-ink-600 shadow-[0_1px_2px_rgba(92,61,28,0.06)] hover:border-ink-200 hover:text-ink-900',
  );
}

/** 표 수 짧게: 950 · 5.4천 · 1.2만 */
function compactVotes(n: number) {
  if (n >= 10_000) return `${Math.floor(n / 1000) / 10}만`;
  if (n >= 1_000) return `${Math.floor(n / 100) / 10}천`;
  return n.toLocaleString('ko-KR');
}
