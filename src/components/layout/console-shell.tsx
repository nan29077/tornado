'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity, BadgeCheck, BookOpenText, CalendarDays, ClipboardList, CreditCard, FlaskConical,
  FilePen, Flag, Gauge, HeartHandshake, Home, Images, KeyRound, LayoutDashboard, LogOut,
  Menu, MessageCircleQuestion, MessageSquareText, PanelsTopLeft, Percent, PhoneCall,
  ScrollText, Send, ServerCog, ShieldAlert, ShieldBan,
  SlidersHorizontal, Undo2, UserCog, CircleUserRound, UserRoundCog,
  UsersRound, Video, Volume2, WalletCards, X,
} from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { ConsoleCornerMascot, MascotAccent } from '@/components/brand/mascot-decorations';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';

/**
 * 크리에이터 관리자 / 통합 관리자 공통 콘솔 레이아웃.
 * 좌측 LNB(그룹형) + 상단 바. 모바일에서는 드로어로 전환한다.
 *
 * 좌측 메뉴 맨 아래에는 프로필·메인으로·로그아웃을 고정한다.
 * 메뉴가 길어져도 항상 같은 자리에 있어야 하므로 메뉴 영역만 스크롤시킨다.
 */

export interface NavGroup {
  title: string;
  items: Array<{ href: string; label: string; icon?: ConsoleIconName }>;
}

export type ConsoleIconName =
  | 'activity' | 'admins' | 'audit' | 'banners' | 'codes' | 'contents' | 'creators'
  | 'dashboard' | 'donations' | 'donors' | 'fees' | 'holidays' | 'inquiries' | 'messages'
  | 'moderation' | 'numbers' | 'overlay' | 'payments' | 'policies' | 'profile'
  | 'refunds' | 'reports' | 'risk' | 'settlement' | 'simulator'
  | 'system' | 'templates' | 'terms' | 'tts' | 'users' | 'youtube' | 'settings' | 'send';

const CONSOLE_ICONS = {
  activity: Activity,
  admins: UserCog,
  audit: ClipboardList,
  banners: Images,
  codes: KeyRound,
  contents: BookOpenText,
  creators: BadgeCheck,
  dashboard: LayoutDashboard,
  donations: HeartHandshake,
  donors: CircleUserRound,
  fees: Percent,
  holidays: CalendarDays,
  inquiries: MessageCircleQuestion,
  messages: MessageSquareText,
  moderation: ShieldBan,
  numbers: PhoneCall,
  overlay: PanelsTopLeft,
  payments: CreditCard,
  policies: Gauge,
  profile: UserRoundCog,
  refunds: Undo2,
  reports: Flag,
  risk: ShieldAlert,
  settlement: WalletCards,
  simulator: FlaskConical,
  system: ServerCog,
  templates: FilePen,
  terms: ScrollText,
  tts: Volume2,
  users: UsersRound,
  youtube: Video,
  settings: SlidersHorizontal,
  send: Send,
} satisfies Record<ConsoleIconName, typeof Home>;

export function ConsoleShell({
  title,
  groups,
  user,
  children,
}: {
  title: string;
  groups: NavGroup[];
  user?: { id: string; name: string; role: string; avatarUrl?: string | null; avatarSeed?: string; avatarIndex?: number | null };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // 현재 경로와 가장 길게 일치하는 메뉴 1개만 활성 표시한다.
  // (대시보드(/admin, /studio)나 상위 메뉴(/studio/settlement)가
  //  하위 경로에서 동시에 활성되는 문제 방지)
  const bestMatch = React.useMemo(() => {
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    return (
      hrefs
        .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
        .sort((a, b) => b.length - a.length)[0] ?? null
    );
  }, [groups, pathname]);

  return (
    <div className="console-canvas relative min-h-dvh">
      <ConsoleCornerMascot />
      <header className="console-header sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="flex h-16 items-center gap-3 px-4 lg:px-6">
          <button
            type="button"
            aria-label="메뉴"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-ink-200 text-ink-700 lg:hidden"
          >
            {open ? <X size={18} strokeWidth={1.6} /> : <Menu size={18} strokeWidth={1.6} />}
          </button>
          <Link href="/" className="hidden sm:block">
            <Logo compact />
          </Link>
          <span className="min-w-0 flex-1 truncate text-[15px] font-black tracking-[-0.025em] text-ink-900">{title}</span>
          {user ? <NotificationBell /> : null}
        </div>
      </header>

      <div className="relative z-[1] flex items-start">
        {open ? (
          <button
            type="button"
            aria-label="메뉴 닫기"
            onClick={() => setOpen(false)}
            className="fixed inset-0 top-16 z-20 bg-ink-900/25 backdrop-blur-[2px] lg:hidden"
          />
        ) : null}

        <aside
          className={cx(
            'console-sidebar fixed bottom-0 left-0 top-16 z-30 w-[260px] flex-col border-r shadow-2xl',
            'lg:sticky lg:top-16 lg:ml-4 lg:mt-4 lg:h-[calc(100dvh-5rem)] lg:w-[244px] lg:rounded-[24px] lg:border lg:shadow-[0_14px_40px_rgba(23,22,26,0.08)]',
            open ? 'flex' : 'hidden lg:flex',
          )}
        >
          {/* 메뉴 (이 영역만 스크롤) */}
          <nav className="console-navigation min-h-0 flex-1 overflow-y-auto px-3 py-5">
            {groups.map((g) => (
              <div key={g.title} className="mb-5 last:mb-0">
                <p className="mb-2 px-3 text-[10px] font-extrabold tracking-[0.12em] text-ink-300">{g.title}</p>
                {g.items.map((item) => {
                  const active = item.href === bestMatch;
                  const ItemIcon = CONSOLE_ICONS[item.icon ?? 'settings'];
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={cx(
                        'group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-semibold transition-all',
                        active
                          ? 'bg-brand-100 font-extrabold text-brand-800 shadow-sm'
                          : 'text-ink-500 hover:bg-ink-50 hover:text-ink-900',
                      )}
                    >
                      <span
                        className={cx(
                          'grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border transition-all',
                          active
                            ? 'border-brand-300/70 bg-brand-400 text-ink-900 shadow-[0_4px_10px_rgba(237,166,0,0.2)]'
                            : 'border-ink-100 bg-white text-ink-400 group-hover:border-brand-200 group-hover:bg-brand-50 group-hover:text-brand-700',
                        )}
                      >
                        <ItemIcon size={16} strokeWidth={active ? 2 : 1.7} />
                      </span>
                      <span className="min-w-0 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* 하단 고정: 프로필 · 메인으로 · 로그아웃 */}
          <div className="console-account shrink-0 border-t px-3 py-3 lg:rounded-b-[24px]">
            {user ? (
              <div className="console-profile mb-2 flex items-center gap-2.5 rounded-xl px-3 py-2.5">
                <ProfileAvatar
                  seed={user.avatarSeed ?? user.id}
                  avatarIndex={user.avatarIndex}
                  name={user.name}
                  imageUrl={user.avatarUrl}
                  className="h-10 w-10"
                />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-bold text-ink-900">{user.name}</span>
                  <span className="block text-[11px] font-semibold text-ink-400">{user.role}</span>
                </span>
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Link
                href="/"
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white text-[12.5px] font-bold text-ink-700 transition-colors hover:bg-ink-50"
              >
                <Home size={15} strokeWidth={1.7} />
                메인으로
              </Link>
              <form action="/api/auth/logout" method="post" className="flex-1">
                <button
                  type="submit"
                  className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white text-[12.5px] font-bold text-ink-700 transition-colors hover:bg-ink-50"
                >
                  <LogOut size={15} strokeWidth={1.7} />
                  로그아웃
                </button>
              </form>
            </div>
          </div>
        </aside>

        {/*
          overflow-x 는 hidden 이 아니라 clip 을 쓴다.
          hidden 은 이 요소를 스크롤 상자로 만들어 버려서, 안쪽의 position: sticky 가
          페이지가 아니라 이 상자를 기준으로 붙는다(= 스크롤해도 따라오지 않는다).
          clip 은 스크롤 상자를 만들지 않으므로 가로 넘침만 자르고 sticky 는 그대로 동작한다.
        */}
        <main className="console-content min-w-0 max-w-full flex-1 overflow-x-clip px-3 py-4 sm:px-4 sm:py-5 lg:px-7 lg:py-7">
          <div className="mx-auto w-full max-w-[1480px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="console-page-header relative mb-5 flex min-h-[66px] flex-col items-stretch justify-between gap-3 overflow-hidden rounded-[20px] border px-4 py-3.5 backdrop-blur-sm sm:flex-row sm:flex-wrap sm:items-end sm:px-5">
      <div className="relative min-w-0 flex-1 lg:pr-20">
        <h1 className="break-keep text-[21px] font-black tracking-[-0.035em] text-ink-900 sm:text-[22px]">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-500">{description}</p>
        ) : null}
        <MascotAccent seed={title} className="console-page-mascot absolute -bottom-3 right-0 h-[70px] w-[70px] opacity-80" />
      </div>
      {action ? <div className="w-full sm:w-auto [&>*]:w-full sm:[&>*]:w-auto">{action}</div> : null}
    </div>
  );
}
