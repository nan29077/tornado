import type { Metadata } from 'next';
import Link from 'next/link';
import { Megaphone, UsersRound } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { EmptyRanking } from '@/components/vote/ranking-board';
import { Countdown } from '@/components/vote/live-bits';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { cx } from '@/components/ui';
import { listSupports, SUPPORT_STATUS_LABEL } from '@/server/services/vote/support';
import { REWARD_TYPE_LABEL } from '@/server/services/vote/rewards';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '서포트 | 도네이도 팬투표' };

/** 서포트 목록 (2026-11-18) — 팬들이 팬투표권을 모아 크리에이터 광고를 연다 */
export default async function SupportListPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const sp = await searchParams;
  const tab = sp.s === 'done' ? 'DONE' : 'OPEN';
  const list = await listSupports({ status: tab, limit: 40 });
  return (
    <PublicShell>
      <PageHeader eyebrow="SUPPORT" title="서포트" description="팬들이 팬투표권을 모아 신문 · 전광판 · 지하철 광고를 열어요. 목표를 채우면 광고가 집행되고, 못 채우면 팬투표권을 돌려드려요." />
      <VoteSubNav active="support" />
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-white p-1 shadow-card">
        {[
          { k: 'OPEN', l: '진행 중', href: '/vote/support' },
          { k: 'DONE', l: '마감', href: '/vote/support?s=done' },
        ].map((t) => (
          <Link key={t.k} href={t.href} aria-current={tab === t.k ? 'page' : undefined} className={cx('grid h-10 place-items-center rounded-xl text-[13px] font-extrabold', tab === t.k ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100')}>
            {t.l}
          </Link>
        ))}
      </div>
      {list.length === 0 ? (
        <EmptyRanking title={tab === 'OPEN' ? '진행 중인 서포트가 없어요' : '마감된 서포트가 없어요'} description="새 서포트가 열리면 여기에 보여요." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((s) => {
            const pct = Math.min(100, Math.round((s.raisedTickets / s.goalTickets) * 100));
            return (
              <Link key={s.id} href={`/vote/support/${s.id}`} className="block overflow-hidden rounded-[22px] bg-white shadow-card transition-transform hover:-translate-y-0.5">
                {s.bannerUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.bannerUrl} alt="" className="aspect-[16/7] w-full object-cover" />
                ) : null}
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    {s.creator ? <ProfileAvatar seed={s.creator.code} avatarIndex={s.creator.user.avatarIndex} name={s.creator.displayName} imageUrl={s.creator.avatarUrl} className="h-8 w-8" /> : null}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-ink-600">{s.creator?.displayName}</span>
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-black text-brand-800">{REWARD_TYPE_LABEL[s.rewardType] ?? s.rewardType}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[15px] font-black text-ink-900">{s.title}</p>
                  <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-ink-100">
                    <span className={cx('block h-full rounded-full', s.status === 'SUCCESS' ? 'bg-success-500' : 'bg-brand-400')} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1.5 flex items-center justify-between text-[11.5px] font-bold text-ink-500">
                    <span className="tabular-nums">
                      <b className="text-ink-900">{pct}%</b> · {s.raisedTickets.toLocaleString('ko-KR')}/{s.goalTickets.toLocaleString('ko-KR')}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <UsersRound size={12} aria-hidden />
                      {s.participantCount.toLocaleString('ko-KR')}명
                    </span>
                  </p>
                  <p className="mt-1 text-[11.5px] text-ink-400">{s.status === 'OPEN' ? <Countdown endsAt={s.endsAt.toISOString()} prefix="마감까지" /> : SUPPORT_STATUS_LABEL[s.status]}</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-ink-400">
        <Megaphone size={13} aria-hidden />
        서포트는 운영팀이 열어요. 광고 매체 계약 · 집행은 운영팀이 진행하고 인증 사진을 [보상]에 올려요.
      </p>
    </PublicShell>
  );
}
