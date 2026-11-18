import Link from 'next/link';
import { Award, CalendarHeart, Crown, Megaphone, PartyPopper, Trophy, UsersRound } from '@/components/brand/icons';
import { cx } from '@/components/ui';

/** 팬투표 하위 메뉴 (2026-11-18) — 랭킹 · 이벤트 · 서포트 · 보상 · 팬 랭킹 · 캘린더 · 명예의 전당 */
const ITEMS = [
  { href: '/vote', key: 'ranking', label: '랭킹', Icon: Trophy },
  { href: '/vote/events', key: 'events', label: '이벤트', Icon: PartyPopper },
  { href: '/vote/support', key: 'support', label: '서포트', Icon: Megaphone },
  { href: '/vote/rewards', key: 'rewards', label: '보상', Icon: Award },
  { href: '/vote/fans', key: 'fans', label: '팬 랭킹', Icon: UsersRound },
  { href: '/vote/calendar', key: 'calendar', label: '캘린더', Icon: CalendarHeart },
  { href: '/vote/hall-of-fame', key: 'hall', label: '명예의 전당', Icon: Crown },
] as const;

export type VoteSubNavKey = (typeof ITEMS)[number]['key'];

export function VoteSubNav({ active }: { active: VoteSubNavKey }) {
  return (
    <nav aria-label="팬투표 메뉴" className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:px-0">
      <div className="flex w-max gap-1.5 lg:w-auto lg:flex-wrap">
        {ITEMS.map((it) => (
          <Link
            key={it.key}
            href={it.href}
            aria-current={active === it.key ? 'page' : undefined}
            className={cx(
              'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-extrabold transition-colors',
              active === it.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-100 bg-white text-ink-600 hover:border-brand-200 hover:text-ink-900',
            )}
          >
            <it.Icon size={14} aria-hidden />
            {it.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
