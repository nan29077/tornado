import Link from 'next/link';
import { ChevronRight, LayoutGrid } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { VoteButton } from './vote-button';
import { RankChange, type VoteContext } from './ranking-board';
import { VoteHomeTabs } from './home-tabs';
import { getCategoryLeaders, type CategoryLeaders } from '@/server/services/vote/ranking';

/**
 * 카테고리별 팬투표 랭킹 (2026-11-18).
 *
 * - 한 표가 전체 랭킹과 그 크리에이터의 카테고리 랭킹에 동시에 들어간다. 팬투표하는 사람이 카테고리를 고를 필요가 없다.
 * - 표를 많이 받은 카테고리부터, 카테고리마다 1~3위를 카드로 보여 준다.
 * - 모바일은 카드가 한 줄 가로 넘김, PC 는 3열 그리드.
 */
export async function CategoryRankingBoard({ vote, perCategory = 3, maxCategories = 9 }: { vote: VoteContext | null; perCategory?: number; maxCategories?: number }) {
  const tabs = [
    { key: 'week' as const, label: '주간' },
    { key: 'live' as const, label: '실시간' },
    { key: 'month' as const, label: '월간' },
  ];
  const lists = await Promise.all(tabs.map((t) => getCategoryLeaders(t.key, { perCategory, maxCategories }).catch(() => [] as CategoryLeaders[])));
  if (lists.every((l) => l.length === 0)) return null;
  return (
    <div className="mt-6">
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[16px] font-black tracking-[-0.02em] text-ink-900">
            <LayoutGrid size={17} strokeWidth={1.8} className="text-brand-600" aria-hidden />
            카테고리별 랭킹
          </h3>
          <p className="mt-0.5 text-[12px] text-ink-500">팬투표하면 전체 랭킹과 크리에이터의 카테고리 랭킹에 함께 반영돼요.</p>
        </div>
      </div>
      <VoteHomeTabs
        tabs={tabs.map((t, i) => ({
          key: t.key,
          label: t.label,
          panel:
            lists[i].length === 0 ? (
              <p className="rounded-2xl bg-white px-4 py-6 text-center text-[12.5px] text-ink-500 shadow-card">{t.label} 카테고리 랭킹이 아직 없어요.</p>
            ) : (
              // PC 는 화면 폭이 아니라 이 영역의 폭에 맞춰 열 수를 정한다 (메인 가운데 패널은 화면보다 훨씬 좁다 —
              // 예전에는 화면 폭 기준 3열이라 카드가 200px 로 좁아져 팬투표 버튼이 이름을 가렸다)
              <div className="@container">
                <div className="-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:grid sm:grid-cols-1 sm:gap-3 sm:overflow-visible sm:px-0 sm:@[32rem]:grid-cols-2 sm:@[54rem]:grid-cols-3">
                  {lists[i].map((c) => (
                    <CategoryCard key={c.category} data={c} tab={t.key} vote={t.key === 'live' || t.key === 'week' || t.key === 'month' ? vote : null} />
                  ))}
                </div>
              </div>
            ),
        }))}
      />
    </div>
  );
}

function CategoryCard({ data, tab, vote }: { data: CategoryLeaders; tab: 'live' | 'week' | 'month'; vote: VoteContext | null }) {
  const nf = (n: number) => n.toLocaleString('ko-KR');
  return (
    <section className="@container w-[82%] max-w-[320px] shrink-0 snap-start rounded-[22px] bg-white p-3.5 shadow-card ring-1 ring-ink-100 sm:w-auto sm:max-w-none" aria-label={`${data.label} 카테고리 랭킹`}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[14px] font-black text-ink-900">
          <span className="mr-1.5 inline-block rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-extrabold text-brand-800">{data.label}</span>
        </p>
        <span className="shrink-0 text-[11px] font-bold tabular-nums text-ink-400">{nf(data.creators)}명 · {nf(data.totalVotes)}표</span>
      </header>
      <ol className="space-y-1.5">
        {data.rows.map((r) => (
          <li key={r.creatorId} className={cx('flex min-h-[52px] items-center gap-2 rounded-2xl px-2 py-1.5', r.rank === 1 ? 'bg-[linear-gradient(135deg,#fff3cf,#fffaf0)]' : '')}>
            <span className="w-5 shrink-0 text-center">
              <span className={cx('block text-[14px] font-black tabular-nums', r.rank === 1 ? 'text-brand-700' : 'text-ink-700')}>{r.rank}</span>
              <span className="flex h-3 justify-center"><RankChange rank={r.rank} prevRank={r.prevRank} showNew={false} /></span>
            </span>
            <Link href={`/c/${r.code}`} target="_blank" rel="noopener" prefetch={false} className="shrink-0">
              <ProfileAvatar seed={r.code} avatarIndex={r.avatarIndex} name={r.displayName} imageUrl={r.avatarUrl} className="h-9 w-9" />
            </Link>
            <div className="min-w-0 flex-1">
              <Link href={`/c/${r.code}`} target="_blank" rel="noopener" prefetch={false} className="block truncate text-[13px] font-extrabold text-ink-900 hover:text-brand-800">
                {r.displayName}
              </Link>
              <span className="block truncate text-[11.5px] font-bold tabular-nums text-ink-400">{nf(r.votes)}표</span>
            </div>
            {vote ? <VoteButton {...vote} creator={{ id: r.creatorId, name: r.displayName, code: r.code, avatarUrl: r.avatarUrl, avatarIndex: r.avatarIndex, category: r.category }} size="sm" collapseNarrow className="shadow-none" /> : null}
          </li>
        ))}
      </ol>
      <Link href={`/vote?p=${tab}&cat=${data.category}`} prefetch={false} className="mt-2 flex h-9 items-center justify-center gap-0.5 rounded-xl bg-warm-100 text-[12px] font-extrabold text-ink-700 hover:bg-warm-200">
        {data.label} 전체 순위
        <ChevronRight size={13} aria-hidden />
      </Link>
    </section>
  );
}
