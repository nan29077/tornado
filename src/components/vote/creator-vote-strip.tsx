import Link from 'next/link';
import { Trophy } from '@/components/brand/icons';
import { getCreatorRanks } from '@/server/services/vote/ranking';
import { getVoteViewer, voteContextOf } from '@/server/services/vote/view';
import { VoteButton } from './vote-button';

/**
 * 도네이도 샵 상단 — 이 크리에이터의 투표 순위 + [투표하기] (2026-11-17)
 * 투표 기능이 꺼져 있거나 랭킹 비공개면 아무것도 그리지 않는다.
 */
export async function CreatorVoteStrip({ creatorId, code, name, avatarUrl, avatarIndex, viewerId }: { creatorId: string; code: string; name: string; avatarUrl: string | null; avatarIndex: number; viewerId: string | null }) {
  const viewer = await getVoteViewer(viewerId).catch(() => null);
  if (!viewer || !viewer.enabled || !viewer.rankingPublic) return null;
  const ranks = await getCreatorRanks(creatorId).catch(() => null);
  if (!ranks) return null;
  const chip = (label: string, r: { rank: number | null; votes: number }) => (
    <span className="flex flex-col items-center px-2">
      <span className="text-[10.5px] font-bold text-ink-400">{label}</span>
      <span className="text-[15px] font-black tabular-nums text-ink-900">{r.rank ? `${r.rank}위` : '-'}</span>
    </span>
  );
  return (
    <section className="mt-4 flex items-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#fff3cf,#ffffff)] px-3 py-2.5 shadow-card ring-1 ring-brand-200" aria-label="투표 순위">
      <Link href={`/vote?q=${encodeURIComponent(name)}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-brand-700 shadow-sm" aria-label="투표 랭킹 보기">
        <Trophy size={19} strokeWidth={1.8} aria-hidden />
      </Link>
      <div className="flex min-w-0 flex-1 items-center divide-x divide-brand-100">
        {chip('실시간', ranks.live)}
        {chip('주간', ranks.week)}
        {chip('월간', ranks.month)}
        <span className="hidden flex-col items-center px-2 min-[400px]:flex">
          <span className="text-[10.5px] font-bold text-ink-400">누적</span>
          <span className="text-[13px] font-black tabular-nums text-ink-700">{ranks.all.votes.toLocaleString('ko-KR')}표</span>
        </span>
      </div>
      <VoteButton {...voteContextOf(viewer)} creator={{ id: creatorId, name, code, avatarUrl, avatarIndex }} size="md" label="투표" />
    </section>
  );
}
