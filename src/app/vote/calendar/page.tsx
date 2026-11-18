import type { Metadata } from 'next';
import Link from 'next/link';
import { Cake, ChevronLeft, ChevronRight, PartyPopper, Star } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { VoteSubNav } from '@/components/vote/vote-subnav';
import { cx } from '@/components/ui';
import { toKst } from '@/lib/datetime';
import { ANNIVERSARY_KIND_LABEL, monthAnniversaries } from '@/server/services/vote/anniversary';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '기념일 캘린더 | 도네이도 팬투표' };

/** 크리에이터 기념일 캘린더 (2026-11-18) — 생일 · 데뷔일 */
export default async function VoteCalendarPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const sp = await searchParams;
  const k = toKst(new Date());
  const thisMonth = k.getUTCMonth() + 1;
  const today = k.getUTCDate();
  const m = Math.min(12, Math.max(1, Number(sp.m) || thisMonth));
  const list = await monthAnniversaries(m);
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  const firstWeekday = new Date(Date.UTC(k.getUTCFullYear(), m - 1, 1)).getUTCDay();
  const cells: Array<number | null> = [...Array.from({ length: firstWeekday }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const byDay = new Map<number, typeof list>();
  for (const a of list) byDay.set(a.day, [...(byDay.get(a.day) ?? []), a]);
  const prev = m === 1 ? 12 : m - 1;
  const next = m === 12 ? 1 : m + 1;
  return (
    <PublicShell>
      <PageHeader eyebrow="CALENDAR" title="기념일 캘린더" description="크리에이터의 생일 · 데뷔일을 모았어요. 기념일에는 팬투표로 축하해 주세요." />
      <VoteSubNav active="calendar" />
      <section className="rounded-[22px] bg-white p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <Link href={`/vote/calendar?m=${prev}`} aria-label="이전 달" className="grid h-9 w-9 place-items-center rounded-full hover:bg-warm-100">
            <ChevronLeft size={18} />
          </Link>
          <p className="text-[17px] font-black text-ink-900">{m}월</p>
          <Link href={`/vote/calendar?m=${next}`} aria-label="다음 달" className="grid h-9 w-9 place-items-center rounded-full hover:bg-warm-100">
            <ChevronRight size={18} />
          </Link>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-bold text-ink-400">
          {['일', '월', '화', '수', '목', '금', '토'].map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {cells.map((d, i) =>
            d == null ? (
              <span key={`e${i}`} />
            ) : (
              <div key={d} className={cx('flex min-h-14 flex-col items-center rounded-xl p-1', m === thisMonth && d === today ? 'bg-brand-100 ring-1 ring-brand-300' : 'bg-warm-50')}>
                <span className="text-[11px] font-bold text-ink-500">{d}</span>
                {(byDay.get(d) ?? []).slice(0, 2).map((a) => (
                  <ProfileAvatar key={a.id} seed={a.creator.code} avatarIndex={a.creator.user.avatarIndex} name={a.creator.displayName} imageUrl={a.creator.avatarUrl} className="mt-0.5 h-6 w-6" />
                ))}
                {(byDay.get(d)?.length ?? 0) > 2 ? <span className="text-[9.5px] font-bold text-ink-400">+{(byDay.get(d)?.length ?? 0) - 2}</span> : null}
              </div>
            ),
          )}
        </div>
      </section>
      <section className="mt-4">
        <h2 className="mb-2 text-[15px] font-black text-ink-900">{m}월 기념일 {list.length > 0 ? list.length : ''}</h2>
        {list.length === 0 ? (
          <p className="rounded-[22px] bg-white p-6 text-center text-[13px] text-ink-400 shadow-card">이달에 등록된 기념일이 없어요.</p>
        ) : (
          <ul className="divide-y divide-ink-100 overflow-hidden rounded-[22px] bg-white shadow-card">
            {list.map((a) => (
              <li key={a.id}>
                <Link href={`/vote/creator/${a.creator.code}`} className="flex items-center gap-3 px-4 py-3 hover:bg-warm-50">
                  <span className="w-12 text-center text-[13px] font-black tabular-nums text-ink-700">{a.month}/{a.day}</span>
                  <ProfileAvatar seed={a.creator.code} avatarIndex={a.creator.user.avatarIndex} name={a.creator.displayName} imageUrl={a.creator.avatarUrl} className="h-10 w-10" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-extrabold text-ink-900">{a.creator.displayName}</span>
                    <span className="inline-flex items-center gap-1 text-[12px] font-bold text-accent-600">
                      {a.kind === 'BIRTHDAY' ? <Cake size={12} aria-hidden /> : a.kind === 'DEBUT' ? <Star size={12} aria-hidden /> : <PartyPopper size={12} aria-hidden />}
                      {a.title || ANNIVERSARY_KIND_LABEL[a.kind]}
                    </span>
                  </span>
                  {m === thisMonth && a.day === today ? <span className="rounded-full bg-danger-500 px-2 py-0.5 text-[11px] font-black text-white">오늘</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PublicShell>
  );
}
