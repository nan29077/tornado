import Link from 'next/link';
import { cx } from '@/components/ui';

/** 최고관리자 > 유튜브 연동 화면 탭 (2026-11-18) */
const TABS = [
  { key: 'connections', href: '/admin/youtube', label: '채널 연동·채팅 송출' },
  { key: 'api', href: '/admin/youtube/api', label: 'API 키 관리' },
  { key: 'videos', href: '/admin/youtube/videos', label: '영상 수집' },
] as const;

export type YouTubeAdminTab = (typeof TABS)[number]['key'];

export function YouTubeAdminTabs({ active }: { active: YouTubeAdminTab }) {
  return (
    <nav aria-label="유튜브 연동 메뉴" className="mb-4 flex gap-1 overflow-x-auto rounded-2xl bg-ink-100/70 p-1 [scrollbar-width:none]">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={cx(
            'flex h-10 shrink-0 items-center rounded-xl px-4 text-[13px] font-bold transition-colors',
            active === t.key ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
