import type { Metadata } from 'next';
import Link from 'next/link';
import { Crown, Medal } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { EmptyRanking } from '@/components/vote/ranking-board';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { cx } from '@/components/ui';
import { periodRange } from '@/lib/vote-period';
import { getSessionUser } from '@/server/auth';
import { FAN_LEVELS, getFanRanking } from '@/server/services/vote/fan';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '팬 랭킹 | 도네이도 팬투표' };

/** 팬 랭킹 (2026-11-18) — 가장 많이 팬투표한 팬 · 팬 레벨 */
export default async function FanRankingPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const sp = await searchParams;
  const p = sp.p === 'month' ? 'month' : sp.p === 'all' ? 'all' : 'week';
  const since = p === 'all' ? null : periodRange(p === 'month' ? 'MONTH' : 'WEEK').start;
  const [rows, user] = await Promise.all([getFanRanking({ since, limit: 30 }), getSessionUser().catch(() => null)]);
  return (
    <PublicShell>
      <PageHeader eyebrow="FAN RANKING" title="팬 랭킹" description="가장 열심히 팬투표한 팬들이에요. 팬투표 · 출석 · 미션 · 응원으로 팬 레벨이 올라가요." />
      <VoteSubNav active="fans" />
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-2xl bg-white p-1 shadow-card">
        {[
          { k: 'week', l: '이번 주' },
          { k: 'month', l: '이번 달' },
          { k: 'all', l: '누적' },
        ].map((t) => (
          <Link key={t.k} href={`/vote/fans?p=${t.k}`} aria-current={p === t.k ? 'page' : undefined} className={cx('grid h-10 place-items-center rounded-xl text-[13px] font-extrabold', p === t.k ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100')}>
            {t.l}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyRanking title="아직 팬투표한 팬이 없어요" description="첫 팬투표로 1위 팬이 되어 보세요." />
      ) : (
        <ol className="divide-y divide-ink-100 overflow-hidden rounded-[22px] bg-white shadow-card">
          {rows.map((r) => (
            <li key={r.userId} className={cx('flex items-center gap-3 px-4 py-3', user?.id === r.userId && 'bg-brand-50')}>
              <span className="grid w-7 place-items-center">
                {r.rank <= 3 ? <Crown size={18} className={r.rank === 1 ? 'text-brand-600' : r.rank === 2 ? 'text-[#9aa0ae]' : 'text-[#c88a52]'} aria-label={`${r.rank}위`} /> : <span className="text-[14px] font-black tabular-nums text-ink-500">{r.rank}</span>}
              </span>
              <ProfileAvatar seed={`fan-${r.userId}`} avatarIndex={r.avatarIndex} name={r.name} className="h-10 w-10" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-extrabold text-ink-900">{r.name}</span>
                  {r.level ? <span className="rounded bg-ink-900 px-1.5 text-[10px] font-black leading-[17px] text-brand-200">Lv.{r.level}</span> : null}
                  {user?.id === r.userId ? <span className="text-[11px] font-bold text-brand-800">나</span> : null}
                </span>
                {r.badge ? (
                  <span className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-bold text-accent-600">
                    <Medal size={11} aria-hidden />
                    {r.badge}
                  </span>
                ) : null}
              </span>
              <span className="text-[14px] font-black tabular-nums text-ink-900">{r.votes.toLocaleString('ko-KR')}표</span>
            </li>
          ))}
        </ol>
      )}
      <section className="mt-5 rounded-[22px] bg-white p-4 shadow-card">
        <p className="mb-2 text-[14px] font-black text-ink-900">팬 레벨</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {FAN_LEVELS.map((l) => (
            <div key={l.level} className="rounded-xl bg-warm-50 px-2.5 py-2 text-center">
              <p className="text-[11px] font-black text-brand-800">Lv.{l.level}</p>
              <p className="text-[12px] font-extrabold text-ink-900">{l.name}</p>
              <p className="text-[10.5px] tabular-nums text-ink-400">{l.xp.toLocaleString('ko-KR')} XP</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-400">경험치: 팬투표 1표 1 · 출석 1일 10 · 미션 1개 5 · 응원 1개 3 · 서포트 팬투표권 1개 1 · 친구 초대 1명 50</p>
      </section>
    </PublicShell>
  );
}
