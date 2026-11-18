import Link from 'next/link';
import { Gift, ShoppingBag, Ticket, Trophy } from '@/components/brand/icons';
import { Badge, Card, CardTitle, EmptyState, cx } from '@/components/ui';
import { MiniAction } from '@/components/engage/mini-action';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { refundTicketOrderAction } from '@/app/actions/vote';
import { formatKst } from '@/lib/datetime';
import { requireUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getVoteConfig } from '@/server/services/engagement/config';
import { BUCKET_LABEL, LEDGER_TYPE_LABEL, getBalance, type TicketBucket } from '@/server/services/vote/wallet';
import { PAY_METHOD_LABEL, checkTicketRefund, type PayMethod } from '@/server/services/vote/purchase';
import { getFanCard } from '@/server/services/vote/fan';
import { FanCard } from '@/components/vote/fan-card';

export const dynamic = 'force-dynamic';

/** 마이페이지 > 팬투표 (남은 팬투표권 · 충전 · 획득 · 사용 내역 · 환불) */
export default async function MyVotesPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const view = sp.v === 'orders' || sp.v === 'casts' ? sp.v : 'history';
  const [cfg, balance, ledger, orders, casts, topCreators] = await Promise.all([
    getVoteConfig(),
    getBalance(user.id),
    prisma.voteTicketLedger.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 60 }),
    prisma.voteTicketOrder.findMany({ where: { userId: user.id, status: { in: ['PAID', 'REFUNDED'] } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.voteCast.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { creator: { select: { code: true, displayName: true } } },
    }),
    prisma.voteCast.groupBy({ by: ['creatorId'], where: { userId: user.id, voidedAt: null }, _sum: { votes: true }, orderBy: { _sum: { votes: 'desc' } }, take: 5 }),
  ]);
  const topInfo = await prisma.creatorProfile.findMany({
    where: { id: { in: topCreators.map((t) => t.creatorId) } },
    select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } },
  });
  const fanCard = await getFanCard(user.id);
  const refundable = new Map<string, boolean>();
  for (const o of orders.filter((x) => x.status === 'PAID')) refundable.set(o.id, (await checkTicketRefund(o.id)).refundable);

  return (
    <div className="space-y-4">
      <FanCard
        card={{
          level: { level: fanCard.level.level, name: fanCard.level.name, xpTotal: fanCard.level.xpTotal, progress: fanCard.level.progress, next: fanCard.level.next },
          featuredBadge: fanCard.featuredBadge,
          badges: fanCard.badges.map((b) => ({ key: b.key, title: b.title, desc: b.desc, earned: Boolean(b.earnedAt) })),
          stats: fanCard.stats,
        }}
      />
      <Card className="relative overflow-hidden border border-brand-100 bg-[linear-gradient(135deg,#fff9e8,#fff)]">
        <div className="flex items-center gap-2">
          <Ticket size={18} className="text-brand-700" aria-hidden />
          <CardTitle>내 팬투표권</CardTitle>
        </div>
        <p className="mt-2 text-[30px] font-black tabular-nums tracking-[-0.04em] text-ink-900">
          {balance.total.toLocaleString('ko-KR')}<span className="ml-1 text-[15px]">개</span>
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          {(['free', 'paid', 'bonus'] as const).map((k) => (
            <div key={k} className="rounded-xl bg-white px-2 py-2 shadow-sm">
              <p className="text-[11px] font-bold text-ink-400">{k === 'free' ? '무료' : k === 'paid' ? '유료' : '보너스'}</p>
              <p className="text-[15px] font-black tabular-nums text-ink-800">{balance[k].toLocaleString('ko-KR')}</p>
            </div>
          ))}
        </div>
        {balance.expiringSoon > 0 ? <p className="mt-2 text-[12px] font-bold text-danger-600">7일 안에 만료되는 팬투표권 {balance.expiringSoon.toLocaleString('ko-KR')}개</p> : null}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Link href="/vote/charge?t=free" className="flex h-10 items-center justify-center gap-1 rounded-xl bg-brand-400 text-[12.5px] font-black text-ink-900"><Gift size={14} aria-hidden />무료로 받기</Link>
          <Link href="/vote/charge?t=buy" className="flex h-10 items-center justify-center gap-1 rounded-xl bg-ink-900 text-[12.5px] font-black text-white"><ShoppingBag size={14} aria-hidden />충전하기</Link>
          <Link href="/vote" className="flex h-10 items-center justify-center gap-1 rounded-xl border border-ink-200 bg-white text-[12.5px] font-black text-ink-800"><Trophy size={14} aria-hidden />팬투표하기</Link>
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-400">
          무료 {cfg.freeExpiryDays > 0 ? `${cfg.freeExpiryDays}일` : '기한 없음'} · 보너스 {cfg.bonusExpiryDays > 0 ? `${cfg.bonusExpiryDays}일` : '기한 없음'} · 유료 {cfg.paidExpiryDays > 0 ? `${cfg.paidExpiryDays}일` : '기한 없음'} 동안 쓸 수 있어요. 팬투표할 때는 {cfg.spendOrder === 'FREE_FIRST' ? '무료 → 보너스 → 유료' : '유료 → 보너스 → 무료'} 순서로, 같은 종류는 만료가 가까운 것부터 쓰여요.
        </p>
      </Card>

      {topCreators.length > 0 ? (
        <Card>
          <CardTitle>내가 응원한 크리에이터</CardTitle>
          <ul className="mt-2 flex gap-3 overflow-x-auto pb-1">
            {topCreators.map((t) => {
              const c = topInfo.find((x) => x.id === t.creatorId);
              if (!c) return null;
              return (
                <li key={t.creatorId} className="w-[76px] shrink-0 text-center">
                  <Link href={`/vote?vote=${c.code}`}>
                    <ProfileAvatar seed={c.code} avatarIndex={c.user.avatarIndex} name={c.displayName} imageUrl={c.avatarUrl} className="mx-auto h-12 w-12" />
                    <p className="mt-1 truncate text-[12px] font-bold text-ink-800">{c.displayName}</p>
                    <p className="text-[11px] tabular-nums text-brand-800">{(t._sum.votes ?? 0).toLocaleString('ko-KR')}표</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <nav className="flex gap-1 rounded-2xl bg-ink-100 p-1">
        {[
          { k: 'history', l: '팬투표권 내역' },
          { k: 'casts', l: '팬투표 내역' },
          { k: 'orders', l: '충전 · 환불' },
        ].map((t) => (
          <Link key={t.k} href={`/my/votes?v=${t.k}`} aria-current={view === t.k ? 'page' : undefined} className={cx('flex h-9 flex-1 items-center justify-center rounded-xl text-[12.5px] font-bold', view === t.k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500')}>
            {t.l}
          </Link>
        ))}
      </nav>

      {view === 'history' ? (
        ledger.length === 0 ? <EmptyState title="아직 팬투표권 내역이 없어요" description="광고를 보거나 충전하면 여기에 기록돼요." /> : (
          <Card padded={false} className="divide-y divide-ink-100">
            {ledger.map((l) => (
              <div key={l.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-ink-800">{LEDGER_TYPE_LABEL[l.type] ?? l.type} <Badge tone={l.bucket === 'PAID' ? 'brand' : 'neutral'}>{BUCKET_LABEL[l.bucket as TicketBucket] ?? l.bucket}</Badge></p>
                  <p className="truncate text-[11.5px] text-ink-400">{formatKst(l.createdAt, false)}{l.memo ? ` · ${l.memo}` : ''}</p>
                </div>
                <span className={cx('text-[14px] font-black tabular-nums', l.delta > 0 ? 'text-success-600' : 'text-ink-700')}>{l.delta > 0 ? '+' : ''}{l.delta.toLocaleString('ko-KR')}</span>
              </div>
            ))}
          </Card>
        )
      ) : null}

      {view === 'casts' ? (
        casts.length === 0 ? <EmptyState title="아직 팬투표하지 않았어요" action={<Link href="/vote" className="text-[13px] font-bold text-brand-800">팬투표하러 가기</Link>} /> : (
          <Card padded={false} className="divide-y divide-ink-100">
            {casts.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-bold text-ink-800">{c.creator.displayName} {c.roundId ? <Badge tone="brand">왕중왕전</Badge> : null} {c.voidedAt ? <Badge tone="danger">무효</Badge> : null}</p>
                  <p className="text-[11.5px] text-ink-400">{formatKst(c.createdAt, false)} · 팬투표권 {c.tickets.toLocaleString('ko-KR')}개 사용</p>
                </div>
                <span className="text-[14px] font-black tabular-nums text-ink-800">{c.votes.toLocaleString('ko-KR')}표</span>
              </div>
            ))}
          </Card>
        )
      ) : null}

      {view === 'orders' ? (
        orders.length === 0 ? <EmptyState title="충전 내역이 없어요" /> : (
          <Card padded={false} className="divide-y divide-ink-100">
            {orders.map((o) => (
              <div key={o.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-bold text-ink-800">{o.productName} {o.status === 'REFUNDED' ? <Badge>환불</Badge> : null}</p>
                    <p className="text-[11.5px] text-ink-400">{formatKst(o.paidAt ?? o.createdAt, false)} · {PAY_METHOD_LABEL[o.method as PayMethod] ?? o.method} · {o.orderNo}</p>
                  </div>
                  <span className="text-[14px] font-black tabular-nums text-ink-800">{Number(o.price).toLocaleString('ko-KR')}원</span>
                </div>
                {o.status === 'PAID' ? (
                  refundable.get(o.id) ? (
                    <MiniAction action={refundTicketOrderAction} fields={{ orderId: o.id }} label="환불 요청" variant="light" className="mt-2" confirm="이 결제로 받은 팬투표권(보너스 포함)이 회수되고 결제가 취소됩니다. 환불할까요?" />
                  ) : (
                    <p className="mt-1.5 text-[11.5px] text-ink-400">사용했거나 환불 기간({cfg.refundDays}일)이 지나 환불할 수 없어요.</p>
                  )
                ) : null}
              </div>
            ))}
          </Card>
        )
      ) : null}
    </div>
  );
}
