import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, Clock3, UsersRound } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { Countdown } from '@/components/vote/live-bits';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { SupportForm } from '@/components/vote/support-form';
import { cx } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getVoteConfig } from '@/server/services/engagement/config';
import { getBalance } from '@/server/services/vote/wallet';
import { getSupportDetail, SUPPORT_STATUS_LABEL } from '@/server/services/vote/support';
import { GRANT_STATUS_LABEL, REWARD_TYPE_LABEL } from '@/server/services/vote/rewards';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const s = await prisma.voteSupport.findUnique({ where: { id: (await params).id }, select: { title: true } });
  return { title: s ? `${s.title} | 도네이도 서포트` : '서포트 | 도네이도' };
}

export default async function SupportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const user = await getSessionUser().catch(() => null);
  const d = await getSupportDetail(id, user?.id);
  if (!d) notFound();
  const { support: s, creator, grant } = d;
  const [cfg, balance] = await Promise.all([getVoteConfig(), user ? getBalance(user.id).then((b) => b.total) : Promise.resolve(0)]);
  const pct = Math.min(100, Math.round((s.raisedTickets / s.goalTickets) * 100));
  const now = new Date();
  const open = s.status === 'OPEN' && s.startsAt <= now && s.endsAt > now;
  const path = `/vote/support/${id}`;
  return (
    <PublicShell>
      <Link href="/vote/support" className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
        <ChevronLeft size={15} aria-hidden />
        서포트 목록
      </Link>
      <VoteSubNav active="support" />
      <article className="overflow-hidden rounded-[26px] bg-white shadow-card">
        {s.bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.bannerUrl} alt="" className="aspect-[16/7] w-full object-cover" />
        ) : null}
        <div className="p-5">
          <div className="flex items-center gap-2.5">
            {creator ? <ProfileAvatar seed={creator.code} avatarIndex={creator.user.avatarIndex} name={creator.displayName} imageUrl={creator.avatarUrl} className="h-11 w-11" /> : null}
            <div className="min-w-0 flex-1">
              {creator ? (
                <Link href={`/vote/creator/${creator.code}`} className="block truncate text-[13px] font-bold text-ink-600 hover:text-brand-800">
                  {creator.displayName}
                </Link>
              ) : null}
              <p className="text-[11.5px] font-extrabold text-brand-800">{REWARD_TYPE_LABEL[s.rewardType] ?? s.rewardType} 서포트</p>
            </div>
            <span className={cx('rounded-full px-2.5 py-1 text-[11.5px] font-black', s.status === 'SUCCESS' ? 'bg-success-50 text-success-600' : s.status === 'OPEN' ? 'bg-danger-500 text-white' : 'bg-ink-100 text-ink-500')}>
              {SUPPORT_STATUS_LABEL[s.status]}
            </span>
          </div>
          <h1 className="mt-3 text-[21px] font-black leading-snug tracking-[-0.03em] text-ink-900">{s.title}</h1>
          {s.description ? <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-600">{s.description}</p> : null}
          <div className="mt-4 h-3.5 overflow-hidden rounded-full bg-ink-100">
            <span className={cx('block h-full rounded-full', s.status === 'SUCCESS' ? 'bg-success-500' : 'bg-brand-400')} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex items-end justify-between">
            <p className="text-[26px] font-black tabular-nums text-ink-900">{pct}%</p>
            <p className="text-right text-[12px] font-bold text-ink-500">
              {s.raisedTickets.toLocaleString('ko-KR')} / {s.goalTickets.toLocaleString('ko-KR')} 팬투표권
              <span className="ml-2 inline-flex items-center gap-0.5">
                <UsersRound size={12} aria-hidden />
                {s.participantCount.toLocaleString('ko-KR')}명
              </span>
            </p>
          </div>
          <p className="mt-1 flex items-center gap-1 text-[12px] text-ink-500">
            <Clock3 size={13} aria-hidden />
            {open ? <Countdown endsAt={s.endsAt.toISOString()} prefix="마감까지" /> : `${formatKst(s.startsAt, false).slice(0, 10)} ~ ${formatKst(s.endsAt, false).slice(0, 10)}`}
          </p>
          {d.myTickets > 0 ? <p className="mt-2 rounded-xl bg-brand-50 px-3 py-2 text-[12.5px] font-bold text-brand-800">내가 모은 팬투표권 {d.myTickets.toLocaleString('ko-KR')}개</p> : null}
          {grant ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-xl bg-success-50 px-3 py-2 text-[12.5px] font-bold text-success-600">
              <CheckCircle2 size={14} aria-hidden />
              광고 집행: {GRANT_STATUS_LABEL[grant.status]}
              {grant.mediaName ? ` · ${grant.mediaName}` : ''}
              <Link href="/vote/rewards" className="ml-auto underline">
                보상 보기
              </Link>
            </p>
          ) : null}
        </div>
      </article>

      {open && cfg.supportEnabled ? (
        <section className="mt-4 rounded-[22px] bg-white p-4 shadow-card">
          <p className="mb-3 text-[15px] font-black text-ink-900">서포트 참여</p>
          <SupportForm supportId={s.id} loggedIn={Boolean(user)} balance={balance} min={cfg.supportMinTickets} left={s.goalTickets - s.raisedTickets} path={path} />
        </section>
      ) : null}

      <section className="mt-4 rounded-[22px] bg-white p-4 shadow-card">
        <p className="mb-2 text-[15px] font-black text-ink-900">서포터 TOP 10</p>
        {d.top.length === 0 ? (
          <p className="py-3 text-center text-[12.5px] text-ink-400">첫 서포터가 되어 주세요.</p>
        ) : (
          <ol className="space-y-1.5">
            {d.top.map((t) => (
              <li key={t.rank} className="flex items-center gap-2.5">
                <span className="w-6 text-center text-[13px] font-black tabular-nums text-ink-500">{t.rank}</span>
                <ProfileAvatar seed={`sup-${t.rank}-${t.name}`} avatarIndex={t.avatarIndex} name={t.name} className="h-8 w-8" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink-800">{t.name}</span>
                <span className="text-[12.5px] font-black tabular-nums text-ink-900">{t.tickets.toLocaleString('ko-KR')}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </PublicShell>
  );
}
