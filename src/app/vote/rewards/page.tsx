import type { Metadata } from 'next';
import Link from 'next/link';
import { Award, CheckCircle2, Clock3, Newspaper } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { EmptyRanking } from '@/components/vote/ranking-board';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { cx } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { GRANT_STATUS_LABEL, listRewardGrants, listRewardPolicies, REWARD_TYPE_LABEL } from '@/server/services/vote/rewards';
import { ensureRecentFinalized } from '@/server/services/vote/ranking';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '팬투표 보상 | 도네이도' };

const PERIOD_LABEL: Record<string, string> = { DAY: '일간', WEEK: '주간', MONTH: '월간' };

/** 팬투표 보상 (2026-11-18) — 보상 안내(정책) · 집행 현황 · 인증 사진 */
export default async function VoteRewardsPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const sp = await searchParams;
  await ensureRecentFinalized().catch(() => undefined);
  const status = sp.s === 'done' ? 'PUBLISHED' : sp.s === 'wait' ? null : null;
  const [policies, grants] = await Promise.all([listRewardPolicies(true), listRewardGrants({ publicOnly: true, status, limit: 60 })]);
  const list = sp.s === 'wait' ? grants.filter((g) => g.status !== 'PUBLISHED') : grants;
  return (
    <PublicShell>
      <PageHeader eyebrow="REWARD" title="팬투표 보상" description="순위가 확정되면 1위 크리에이터에게 신문 광고 · 전광판 · 메인 배너 같은 보상이 주어져요. 집행되면 인증 사진을 올려 드려요." />
      <VoteSubNav active="rewards" />

      <section className="mb-5 rounded-[22px] bg-white p-4 shadow-card">
        <p className="mb-2 flex items-center gap-1.5 text-[15px] font-black text-ink-900">
          <Newspaper size={17} className="text-brand-700" aria-hidden />
          보상 안내
        </p>
        {policies.length === 0 ? (
          <p className="py-3 text-center text-[12.5px] text-ink-400">보상 안내를 준비하고 있어요.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {policies.map((p) => (
              <li key={p.id} className="rounded-2xl bg-warm-50 px-3.5 py-3">
                <p className="text-[11.5px] font-extrabold text-brand-800">
                  {p.scope === 'PERIOD' ? `${PERIOD_LABEL[p.periodType ?? ''] ?? ''} 랭킹` : '이벤트 팬투표'} {p.rankFrom === p.rankTo ? `${p.rankFrom}위` : `${p.rankFrom}~${p.rankTo}위`}
                </p>
                <p className="mt-0.5 text-[14px] font-black text-ink-900">
                  {p.title} <span className="text-[11.5px] font-bold text-ink-400">· {REWARD_TYPE_LABEL[p.rewardType] ?? p.rewardType}</span>
                </p>
                {p.description ? <p className="mt-0.5 text-[12px] text-ink-500">{p.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[16px] font-black text-ink-900">
          <Award size={17} className="text-brand-700" aria-hidden />
          보상 현황
        </h2>
        <div className="flex gap-1 rounded-xl bg-white p-0.5 text-[12px] font-bold shadow-card">
          {[
            { k: '', l: '전체' },
            { k: 'wait', l: '준비 중' },
            { k: 'done', l: '집행 완료' },
          ].map((t) => (
            <Link key={t.k} href={t.k ? `/vote/rewards?s=${t.k}` : '/vote/rewards'} className={cx('rounded-lg px-2.5 py-1', (sp.s ?? '') === t.k ? 'bg-ink-900 text-white' : 'text-ink-500')}>
              {t.l}
            </Link>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyRanking title="아직 보상 기록이 없어요" description="순위가 확정되면 보상이 여기에 기록돼요." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((g) => (
            <article key={g.id} className="overflow-hidden rounded-[22px] bg-white shadow-card">
              {g.proofImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={g.proofImageUrl} alt={`${g.title} 인증 사진`} className="aspect-[4/3] w-full object-cover" />
              ) : null}
              <div className="p-4">
                <div className="flex items-center gap-2.5">
                  {g.creator ? <ProfileAvatar seed={g.creator.code} avatarIndex={g.creator.user.avatarIndex} name={g.creator.displayName} imageUrl={g.creator.avatarUrl} className="h-10 w-10" /> : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-black text-ink-900">{g.creator?.displayName ?? '크리에이터'}</p>
                    <p className="truncate text-[11.5px] font-bold text-ink-500">
                      {g.sourceLabel}
                      {g.rank ? ` ${g.rank}위` : ''}
                    </p>
                  </div>
                  <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-black', g.status === 'PUBLISHED' ? 'bg-success-50 text-success-600' : 'bg-brand-50 text-brand-800')}>
                    {g.status === 'PUBLISHED' ? <CheckCircle2 size={12} aria-hidden /> : <Clock3 size={12} aria-hidden />}
                    {GRANT_STATUS_LABEL[g.status]}
                  </span>
                </div>
                <p className="mt-2.5 text-[13.5px] font-extrabold text-ink-900">
                  {g.title} <span className="text-[11.5px] font-bold text-ink-400">· {REWARD_TYPE_LABEL[g.rewardType] ?? g.rewardType}</span>
                </p>
                <p className="mt-0.5 text-[12px] text-ink-500">
                  {g.mediaName ? `${g.mediaName} · ` : ''}
                  {g.publishedAt ? `${formatKst(g.publishedAt, false).slice(0, 10)} 집행` : g.scheduledAt ? `${formatKst(g.scheduledAt, false).slice(0, 10)} 집행 예정` : '집행 일정 준비 중'}
                </p>
                {g.note ? <p className="mt-1.5 text-[12px] text-ink-600">{g.note}</p> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </PublicShell>
  );
}
