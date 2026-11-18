import Link from 'next/link';
import { ChevronRight, Clock3, Sparkles, Ticket, Trophy } from '@/components/brand/icons';
import { EmptyRanking, Podium, RankList } from '@/components/vote/ranking-board';
import { Countdown } from '@/components/vote/live-bits';
import { VoteHomeTabs } from '@/components/vote/home-tabs';
import { CategoryRankingBoard } from '@/components/vote/category-ranking-board';
import { getRanking, type RankingTab } from '@/server/services/vote/ranking';
import { getVoteViewer, voteContextOf } from '@/server/services/vote/view';
import { ensureDemoData } from '@/server/services/demo-data';

/**
 * 메인 [구독자 전용] — 크리에이터 팬투표 랭킹 섹션 (2026-11-17)
 * 실시간 / 주간 / 월간 / 왕중왕 탭, 1~3위 시상대 + 4~10위 목록, 마감 카운트다운, 내 팬투표권, 충전 바로가기.
 * 팬투표 기능이 꺼져 있거나 랭킹 비공개면 섹션을 숨긴다.
 */
export async function VoteRankingSection({ viewerId }: { viewerId: string | null }) {
  await ensureDemoData();
  const viewer = await getVoteViewer(viewerId).catch(() => null);
  if (!viewer || !viewer.enabled || !viewer.rankingPublic) return null;
  const tabs: Array<{ key: RankingTab; label: string }> = [
    { key: 'live', label: '실시간' },
    { key: 'week', label: '주간' },
    { key: 'month', label: '월간' },
    { key: 'day', label: '일간' },
    { key: 'champion', label: '왕중왕' },
  ];
  const views = await Promise.all(tabs.map((t) => getRanking(t.key, { limit: 10 }).catch(() => null)));
  const vote = voteContextOf(viewer);

  return (
    <section className="mt-8" aria-labelledby="fan-vote">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="fan-vote" className="flex items-center gap-1.5 text-[18px] font-black tracking-[-0.025em] text-ink-900 sm:text-[19px]">
            <Trophy size={19} strokeWidth={1.8} className="text-brand-600" aria-hidden />
            크리에이터 팬투표 랭킹
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-500">내 최애에게 팬투표하고 1위로 만들어 주세요.</p>
        </div>
        <Link href="/vote" prefetch={false} className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-ink-200 bg-white pl-3 pr-2 text-[12.5px] font-bold text-ink-700 hover:border-brand-300 hover:bg-brand-50">
          전체 랭킹
          <ChevronRight size={14} strokeWidth={2} aria-hidden />
        </Link>
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-2xl bg-ink-900 px-3.5 py-2.5 text-white">
        <Ticket size={17} className="shrink-0 text-brand-300" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-[12.5px] font-bold">
          {viewer.loggedIn ? (
            <>내 팬투표권 <b className="tabular-nums text-brand-200">{viewer.balance.toLocaleString('ko-KR')}</b>개</>
          ) : (
            '광고만 봐도 팬투표권을 무료로 받아요'
          )}
        </p>
        <Link href="/vote/charge" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-brand-400 px-3 text-[12px] font-black text-ink-900">
          <Sparkles size={13} aria-hidden />
          무료 충전
        </Link>
      </div>

      <VoteHomeTabs
        tabs={tabs.map((t, i) => {
          const v = views[i];
          const canVote = t.key !== 'day' && (t.key !== 'champion' || v?.round?.status === 'OPEN');
          const ctx = { ...vote, roundId: t.key === 'champion' && v?.round?.status === 'OPEN' ? v.round.id : null };
          return {
            key: t.key,
            label: t.label,
            badge: t.key === 'champion' && v?.round?.status === 'OPEN' ? '진행 중' : null,
            panel: !v || v.rows.length === 0 ? (
              <EmptyRanking
                title={t.key === 'champion' ? '열린 왕중왕전이 없어요' : '아직 팬투표가 없어요'}
                description={t.key === 'champion' ? '왕중왕전이 열리면 여기에서 팬투표할 수 있어요.' : '첫 표를 보내 순위를 만들어 주세요.'}
              />
            ) : (
              <div className="space-y-2.5">
                <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-500">
                  {t.key === 'champion' && v.round ? <b className="text-ink-800">{v.round.title}</b> : null}
                  {v.caption}
                  {v.endsAt ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-bold text-ink-700 shadow-sm">
                      <Clock3 size={11} aria-hidden />
                      <Countdown endsAt={v.endsAt.toISOString()} />
                    </span>
                  ) : null}
                </p>
                <Podium rows={v.rows} vote={canVote ? ctx : null} />
                <RankList rows={v.rows} vote={canVote ? ctx : null} startAt={4} compact />
                <Link href={`/vote?p=${t.key}`} prefetch={false} className="flex h-11 items-center justify-center gap-1 rounded-2xl bg-white text-[13px] font-extrabold text-ink-800 shadow-card hover:bg-warm-50">
                  {t.label} 랭킹 전체 보기
                  <ChevronRight size={14} aria-hidden />
                </Link>
              </div>
            ),
          };
        })}
      />

      {/* 카테고리별 랭킹 (2026-11-18) — 한 표가 전체·카테고리 랭킹에 함께 들어간다 */}
      <CategoryRankingBoard vote={vote} />
    </section>
  );
}
