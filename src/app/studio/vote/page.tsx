import Link from 'next/link';
import { ExternalLink } from '@/components/brand/icons';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, EmptyState, StatTile, cx } from '@/components/ui';
import { GuideCard } from '@/components/engage/guide-card';
import { CopyButton } from '@/components/public/copy-button';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { periodLabel, periodRange, type VotePeriodType } from '@/lib/vote-period';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { getPublicBaseUrl } from '@/server/public-base-url';
import { getCreatorEngagement } from '@/server/services/engagement/config';
import { ensureRecentFinalized, getCreatorDailyTrend, getCreatorRanks, getCreatorResultHistory, getTopVoters } from '@/server/services/vote/ranking';

export const dynamic = 'force-dynamic';

const PERIOD_NAME: Record<string, string> = { DAY: '일간', WEEK: '주간', MONTH: '월간', ROUND: '왕중왕전' };

/** 크리에이터 관리자 > 팬 소통 > 투표·랭킹 */
export default async function StudioVotePage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const sp = await searchParams;
  const { creatorId } = await requireCreator();
  await ensureRecentFinalized();
  const range = sp.r === 'week' || sp.r === 'all' ? sp.r : 'month';
  const since = range === 'all' ? null : periodRange(range === 'week' ? 'WEEK' : 'MONTH').start;
  const [creator, ranks, trend, voters, history, eng] = await Promise.all([
    prisma.creatorProfile.findUniqueOrThrow({ where: { id: creatorId }, select: { code: true, displayName: true } }),
    getCreatorRanks(creatorId),
    getCreatorDailyTrend(creatorId, 30),
    getTopVoters(creatorId, since, 20),
    getCreatorResultHistory(creatorId, 20),
    getCreatorEngagement(creatorId),
  ]);
  const max = Math.max(...trend.map((t) => t.votes), 1);
  const shareUrl = `${await getPublicBaseUrl()}/vote?vote=${creator.code}`;
  const roundIds = history.filter((h) => h.periodType === 'ROUND').map((h) => h.periodKey);
  const rounds = roundIds.length ? await prisma.voteRound.findMany({ where: { id: { in: roundIds } }, select: { id: true, title: true } }) : [];
  const rk = (r: number | null) => (r ? `${r}위` : '-');

  return (
    <div>
      <PageHeader title="투표·랭킹" description="팬들이 보내 준 표와 내 순위를 확인하세요." action={<Link href="/vote" target="_blank" className="inline-flex items-center gap-1 text-[13px] font-bold text-brand-800">공개 랭킹 보기 <ExternalLink size={13} aria-hidden /></Link>} />

      <GuideCard
        title="투표 기능 안내"
        items={[
          { head: '팬은 투표권으로 투표해요', body: '구독자는 광고 시청 · 퀴즈로 무료 투표권을 받거나 결제로 충전해 나에게 투표해요. 1표에 쓰이는 투표권 수는 최고관리자가 정해요.' },
          { head: '순위는 실시간 · 일간 · 주간 · 월간', body: '실시간은 오늘 받은 표, 매일 · 매주(월요일) · 매달(1일) 자정에 순위가 확정돼요. 월간 1위는 명예의 전당에 올라요.' },
          { head: '왕중왕전', body: '최고관리자가 월간 상위 크리에이터끼리 겨루는 왕중왕전을 열어요. 후보가 되면 안내가 와요.' },
          { head: '팬에게 투표를 부탁해 보세요', body: <>아래 투표 링크를 방송 · SNS 에 공유하면 팬이 바로 내 투표 창으로 들어와요.</> },
        ]}
        footer={
          <>
            유료 투표권 사용분 중 크리에이터 몫: <b className="text-ink-800">{eng.voteShareRate > 0 ? `${(eng.voteShareRate * 100).toFixed(2).replace(/\.?0+$/, '')}%` : '현재 배분 없음'}</b>
            {eng.voteShareRate > 0 ? ' — 정산 관리의 [투표 수익 배분] 항목으로 적립돼요.' : ' — 최고관리자가 비율을 정하면 정산에 자동으로 적립돼요.'} 부정한 방법으로 모은 표는 무효 처리될 수 있어요.
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="실시간 (오늘)" value={rk(ranks.live.rank)} sub={`${ranks.live.votes.toLocaleString('ko-KR')}표`} tone="brand" />
        <StatTile label="이번 주" value={rk(ranks.week.rank)} sub={`${ranks.week.votes.toLocaleString('ko-KR')}표`} />
        <StatTile label="이번 달" value={rk(ranks.month.rank)} sub={`${ranks.month.votes.toLocaleString('ko-KR')}표`} />
        <StatTile label="누적" value={rk(ranks.all.rank)} sub={`${ranks.all.votes.toLocaleString('ko-KR')}표`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardTitle>최근 30일 받은 표</CardTitle>
          <div className="mt-4 flex h-40 items-end gap-[3px]" role="img" aria-label="최근 30일 일별 받은 표">
            {trend.map((t) => (
              <div key={t.key} className="group relative flex-1">
                <div className="w-full rounded-t-[4px] bg-gradient-to-t from-brand-400 to-accent-400" style={{ height: `${Math.max(2, Math.round((t.votes / max) * 150))}px` }} />
                <span className="pointer-events-none absolute -top-9 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-900 px-1.5 py-1 text-[10.5px] font-bold text-white group-hover:block">
                  {t.key.slice(5)} · {t.votes.toLocaleString('ko-KR')}표{t.rank ? ` · ${t.rank}위` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10.5px] text-ink-400"><span>{trend[0]?.key.slice(5)}</span><span>오늘</span></div>
        </Card>

        <Card>
          <CardTitle>투표 링크 공유</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">팬이 누르면 바로 내 투표 창이 열려요.</p>
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-ink-50 px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-[12px] text-ink-700">{shareUrl}</code>
            <CopyButton value={shareUrl} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>나에게 투표한 팬</CardTitle>
            <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5 text-[12px] font-bold">
              {[{ k: 'week', l: '이번 주' }, { k: 'month', l: '이번 달' }, { k: 'all', l: '전체' }].map((x) => (
                <Link key={x.k} href={`/studio/vote?r=${x.k}`} className={cx('rounded-md px-2 py-1', range === x.k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500')}>{x.l}</Link>
              ))}
            </div>
          </div>
          {voters.length === 0 ? (
            <div className="mt-3"><EmptyState title="아직 받은 표가 없어요" description="투표 링크를 팬들에게 공유해 보세요." /></div>
          ) : (
            <ol className="mt-3 divide-y divide-ink-100">
              {voters.map((v) => (
                <li key={v.userId} className="flex items-center gap-3 py-2">
                  <span className={cx('w-6 text-center text-[13px] font-black', v.rank <= 3 ? 'text-brand-700' : 'text-ink-400')}>{v.rank}</span>
                  <ProfileAvatar seed={v.userId} avatarIndex={v.avatarIndex} name={v.name} className="h-8 w-8" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink-800">{v.name}</span>
                  <span className="text-[13px] font-black tabular-nums text-ink-900">{v.votes.toLocaleString('ko-KR')}표</span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-[11px] text-ink-400">팬 개인정보 보호를 위해 닉네임 일부만 보여요.</p>
        </Card>

        <Card>
          <CardTitle>확정 순위 기록</CardTitle>
          {history.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-500">아직 확정된 순위가 없어요.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-2 text-[13px]">
                  <span className="w-14 shrink-0 rounded-md bg-ink-100 px-1.5 py-0.5 text-center text-[11px] font-bold text-ink-600">{PERIOD_NAME[h.periodType] ?? h.periodType}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-700">{h.periodType === 'ROUND' ? rounds.find((r) => r.id === h.periodKey)?.title ?? '왕중왕전' : periodLabel(h.periodType as VotePeriodType, h.periodKey)}</span>
                  <span className={cx('font-black', h.rank === 1 ? 'text-brand-700' : 'text-ink-800')}>{h.rank}위</span>
                  <span className="w-20 text-right tabular-nums text-ink-500">{Number(h.votes).toLocaleString('ko-KR')}표</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
