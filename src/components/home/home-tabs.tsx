'use client';

import Link from 'next/link';
import { Clapperboard, Users } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { HOME_TAB_LABEL, rememberHomeTab, type HomeTab } from '@/lib/home-tab';

/**
 * 메인 배너 바로 아래 탭 — [구독자 전용] / [크리에이터 전용].
 * 고른 탭은 쿠키에 "누가 골랐는지"와 함께 남긴다. 로그인·로그아웃으로 사람이 바뀌면
 * 서버가 그 쿠키를 무시하고 역할 기본값을 보여 준다(src/lib/home-tab.ts).
 */
export function HomeTabs({ active, viewerId }: { active: HomeTab; viewerId: string | null }) {
  const tabs: Array<{ tab: HomeTab; icon: typeof Users }> = [
    // (2026-11-17) 순서 변경: 구독자 전용이 왼쪽
    { tab: 'fan', icon: Users },
    { tab: 'creator', icon: Clapperboard },
  ];
  return (
    <nav
      aria-label="메인 화면 탭"
      className="home-tabs sticky top-[68px] z-30 -mx-4 mt-4 border-b border-[rgba(221,190,143,0.42)] bg-[rgba(255,253,247,0.94)] px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
    >
      <div role="tablist" className="grid grid-cols-2 gap-1.5 rounded-2xl bg-ink-50 p-1">
        {tabs.map(({ tab, icon: Icon }) => {
          const on = tab === active;
          return (
            <Link
              key={tab}
              role="tab"
              aria-selected={on}
              href={`/?tab=${tab}`}
              scroll={false}
              prefetch={false}
              onClick={() => rememberHomeTab(tab, viewerId)}
              className={cx(
                'flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-[14px] font-extrabold transition-colors',
                on ? 'bg-white text-brand-800 shadow-sm ring-1 ring-brand-200' : 'text-ink-500 hover:text-ink-800',
              )}
            >
              <Icon size={17} strokeWidth={1.7} aria-hidden />
              {HOME_TAB_LABEL[tab]}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
