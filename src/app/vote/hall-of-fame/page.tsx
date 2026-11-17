import type { Metadata } from 'next';
import Link from 'next/link';
import { Award, ChevronLeft, Crown } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { EmptyRanking } from '@/components/vote/ranking-board';
import { periodLabel } from '@/lib/vote-period';
import { ensureRecentFinalized, getCategoryChampions, getHallOfFame } from '@/server/services/vote/ranking';
import { ensureDemoData } from '@/server/services/demo-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '명예의 전당 | 도네이도 투표' };

export default async function HallOfFamePage() {
  await ensureDemoData();
  await ensureRecentFinalized();
  const [{ months, champions }, catChamps] = await Promise.all([getHallOfFame(), getCategoryChampions(3)]);
  return (
    <PublicShell>
      <Link href="/vote" className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        투표 랭킹으로
      </Link>
      <PageHeader eyebrow="HALL OF FAME" title="명예의 전당" description="매달 1위 · 카테고리별 1위 · 왕중왕전 우승 크리에이터를 기록해요." />

      <h2 className="mb-2 flex items-center gap-1.5 text-[16px] font-black text-ink-900"><Crown size={18} className="text-brand-600" aria-hidden />왕중왕</h2>
      {champions.length === 0 ? (
        <EmptyRanking title="아직 왕중왕이 없어요" description="왕중왕전이 끝나면 여기에 기록돼요." />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {champions.map(({ round, winner }) => (
            <Link key={round.id} href={`/c/${winner!.creator.code}`} target="_blank" rel="noopener" className="flex flex-col items-center rounded-2xl bg-gradient-to-b from-brand-100 to-white p-4 text-center shadow-card ring-1 ring-brand-200">
              <ProfileAvatar seed={winner!.creator.code} avatarIndex={winner!.creator.user.avatarIndex} name={winner!.creator.displayName} imageUrl={winner!.creator.avatarUrl} className="h-16 w-16 ring-4 ring-brand-300 rounded-full" />
              <p className="mt-2 w-full truncate text-[14px] font-black text-ink-900">{winner!.creator.displayName}</p>
              <p className="mt-0.5 w-full truncate text-[11.5px] font-bold text-brand-800">{round.title}</p>
              <p className="text-[11px] tabular-nums text-ink-400">{Number(winner!.votes).toLocaleString('ko-KR')}표</p>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-7 flex items-center gap-1.5 text-[16px] font-black text-ink-900"><Award size={18} className="text-brand-600" aria-hidden />월간 1위</h2>
      {months.length === 0 ? (
        <EmptyRanking title="아직 기록이 없어요" description="이번 달이 끝나면 첫 월간 1위가 기록돼요." />
      ) : (
        <ol className="divide-y divide-ink-100 overflow-hidden rounded-2xl bg-white shadow-card">
          {months.map((m) => (
            <li key={m.id}>
              <Link href={`/c/${m.creator.code}`} target="_blank" rel="noopener" className="flex items-center gap-3 px-4 py-3 hover:bg-warm-50">
                <span className="w-24 shrink-0 text-[12.5px] font-extrabold text-ink-500">{periodLabel('MONTH', m.periodKey)}</span>
                <ProfileAvatar seed={m.creator.code} avatarIndex={m.creator.user.avatarIndex} name={m.creator.displayName} imageUrl={m.creator.avatarUrl} className="h-10 w-10" />
                <span className="min-w-0 flex-1 truncate text-[14px] font-extrabold text-ink-900">{m.creator.displayName}</span>
                <span className="text-[12.5px] font-bold tabular-nums text-brand-800">{Number(m.votes).toLocaleString('ko-KR')}표</span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {catChamps.some((m) => m.winners.length > 0) ? (
        <>
          <h2 className="mb-2 mt-7 flex items-center gap-1.5 text-[16px] font-black text-ink-900"><Award size={18} className="text-brand-600" aria-hidden />카테고리별 월간 1위</h2>
          <div className="space-y-4">
            {catChamps.filter((m) => m.winners.length > 0).map((m) => (
              <section key={m.periodKey}>
                <p className="mb-1.5 text-[12.5px] font-extrabold text-ink-500">{periodLabel('MONTH', m.periodKey)}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {m.winners.map((w) => (
                    <Link key={w.category} href={`/c/${w.code}`} target="_blank" rel="noopener" className="flex items-center gap-2.5 rounded-2xl bg-white p-3 shadow-card hover:bg-warm-50">
                      <ProfileAvatar seed={w.code} avatarIndex={w.avatarIndex} name={w.displayName} imageUrl={w.avatarUrl} className="h-10 w-10" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-extrabold text-brand-800">{w.label}</span>
                        <span className="block truncate text-[13px] font-extrabold text-ink-900">{w.displayName}</span>
                        <span className="block text-[11px] tabular-nums text-ink-400">{w.votes.toLocaleString('ko-KR')}표</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : null}
    </PublicShell>
  );
}
