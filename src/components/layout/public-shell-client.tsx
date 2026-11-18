'use client';

import { BusinessInfo, type BusinessInfoData } from '@/components/layout/business-info';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell, CircleHelp, CircleUserRound, HeartHandshake, House,
  Clapperboard, Compass, LifeBuoy, MessagesSquare, Trophy, LogIn, LogOut, Menu, UserPlus, X,
} from '@/components/brand/icons';
import { Logo, TornadoMark } from '@/components/brand/logo';
import { PublicMarginMascots } from '@/components/brand/mascot-decorations';
import { CreatorDonateBackdrop } from '@/components/public/creator-donate-backdrop';
import { CLASSIC_MARGIN_IMAGE, DEFAULT_SITE_IMAGE } from '@/lib/site-images';
import { DonationLookupSheet } from '@/components/public/donation-lookup-sheet';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';

/**
 * 공개 영역 레이아웃 (클라이언트).
 * - PC: 중앙 콘텐츠는 앱 폭 유지, 우측 세로 메뉴는 모바일 하단 내비와 동일한 구성
 *       + 하단에 프로필/로그아웃(로그인) 영역
 * - 모바일: 하단 내비게이션
 * - 마이페이지는 로그인 역할에 따라 대시보드(/admin, /studio) 또는 마이페이지(/my)로 이동
 */

export interface ShellViewer {
  id: string;
  name: string | null;
  email: string | null;
  /** 역할별 마이페이지 목적지 (/admin, /studio, /my) */
  myHref: string;
  roleLabel: string;
  /** 프로필 캐릭터(아바타) 이미지. 크리에이터 프로필의 아바타를 그대로 사용한다. */
  avatarUrl: string | null;
  /** 크리에이터는 재시드에도 바뀌지 않는 크리에이터 코드를 사용한다. */
  avatarSeed: string;
  /** 가입 시 무작위로 배정되어 DB에 고정된 0~49 캐릭터 번호 */
  avatarIndex: number;
}

/** 마이페이지 탭 활성 판정에 쓰는 콘솔 경로들 */
const MY_PREFIXES = ['/my', '/studio', '/admin'];

interface NavItem {
  href: string;
  label: string;
  icon: typeof House;
  /** 마이페이지 탭(역할별 이동) */
  my?: boolean;
  /** 페이지 이동 대신 후원확인 바텀시트를 연다 */
  sheet?: boolean;
  /** false 면 모바일 하단 탭바에서 뺀다 (우측 메뉴·PC 레일에는 그대로 둔다) */
  bottom?: boolean;
}

function buildNav(myHref: string, videoHubEnabled: boolean): NavItem[] {
  return [
    { href: '/', label: '홈', icon: House },
    // (2026-11-17) 모바일 하단 탭바: 홈 · 팬투표 · 팬챗 · 후원확인 · 마이페이지.
    // 방송국(문의 버튼 위 떠 있는 버튼으로 이동 가능)과 이용방법은 하단에서 빼고 우측 메뉴·PC 레일에만 둔다.
    { href: '/vote', label: '팬투표', icon: Trophy },
    { href: '/talk', label: '팬챗', icon: MessagesSquare },
    ...(videoHubEnabled ? [{ href: '/videos', label: '방송국', icon: Clapperboard, bottom: false }] : []),
    { href: '/how-it-works', label: '이용방법', icon: Compass, bottom: false },
    { href: '#lookup', label: '후원확인', icon: HeartHandshake, sheet: true },
    // (2026-11-17) 모바일 하단 탭바에서는 뺀다. 우측 메뉴(드로어)·PC 레일에만 보인다.
    { href: '/faq', label: 'FAQ', icon: CircleHelp, bottom: false },
    { href: myHref, label: '마이페이지', icon: CircleUserRound, my: true },
  ];
}

// (2026-11-17) 크리에이터 가입은 메뉴에서 뺐다. 회원가입 화면의 [크리에이터] 탭과 마이페이지 전환 신청으로 들어간다.
const DRAWER_EXTRA = [
  { href: '/notice', label: '공지', icon: Bell },
  { href: '/support', label: '고객센터', icon: LifeBuoy },
];

function isActive(pathname: string, href: string, my?: boolean) {
  if (my) return MY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (href === '/') return pathname === '/';
  if (href === '/videos' && pathname.startsWith('/watch/')) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PublicShellClient({
  children,
  aside,
  home = false,
  leftPane,
  videoHubEnabled = false,
  viewer,
  mockMode = false,
  business,
  marginPreset = DEFAULT_SITE_IMAGE,
  headerExtra,
}: {
  /** 헤더 가운데 영역 (메인 구독자 전용 탭의 시청 현황) */
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  aside?: React.ReactNode;
  home?: boolean;
  /** PC(xl 이상) 왼쪽 여백의 영상 미리보기. */
  leftPane?: React.ReactNode;
  videoHubEnabled?: boolean;
  viewer: ShellViewer | null;
  /** 결제·문자 발송이 모의(mock) 상태일 때만 하단에 안내를 보여 준다. */
  mockMode?: boolean;
  /** 하단 사업자 정보(환경변수 BUSINESS_*) */
  business?: BusinessInfoData;
  marginPreset?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [lookupOpen, setLookupOpen] = React.useState(false);
  const myHref = viewer?.myHref ?? '/my';
  const nav = buildNav(myHref, videoHubEnabled);
  const bottomNav = nav.filter((t) => t.bottom !== false);

  const openLookup = React.useCallback(() => {
    setOpen(false);
    setLookupOpen(true);
  }, []);

  return (
    <div className="public-canvas min-h-dvh pb-20 lg:pb-0">
      <CreatorDonateBackdrop preset={marginPreset} publicPage />
      {marginPreset === DEFAULT_SITE_IMAGE || marginPreset === CLASSIC_MARGIN_IMAGE ? (
        leftPane ? <div className="xl:hidden"><PublicMarginMascots home={home} /></div> : <PublicMarginMascots home={home} />
      ) : null}
      <div className="relative z-[2] mx-auto flex w-full max-w-[var(--public-layout-width)] items-start justify-center">
        {leftPane ? (
          <div className="public-home-video-rail pointer-events-none absolute bottom-0 right-full top-0 hidden xl:block">
            <div className="sticky top-6 flex h-[calc(100dvh-3rem)] items-center">
              <div className="public-home-video-dock pointer-events-auto max-h-full w-full overflow-y-auto overscroll-contain p-1">{leftPane}</div>
            </div>
          </div>
        ) : null}
        <div className="public-app-surface min-h-dvh w-full min-w-0 max-w-[var(--public-app-width)] shadow-[0_0_60px_rgba(74,49,25,0.12)]">
      <header className="public-header sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="grid h-[68px] w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-2 min-[360px]:px-3 sm:px-6">
          <Link href="/" aria-label="도네이도 홈" className="col-start-1 row-start-1 justify-self-start">
            <span className={headerExtra ? 'hidden min-[420px]:inline-flex' : 'inline-flex'}>
              <Logo />
            </span>
            {headerExtra ? <span className="inline-flex min-[420px]:hidden"><Logo compact /></span> : null}
          </Link>

          {headerExtra ? <div className="col-start-2 row-start-1 flex min-w-0 justify-center">{headerExtra}</div> : null}

          {/*
            알림 버튼.
            PC 에서는 햄버거(lg:hidden)가 숨겨지므로 이 버튼만 남아 우측 상단에 위치하고,
            모바일에서는 햄버거 바로 왼쪽에 나란히 놓인다.
            알림은 사용자별 데이터라 로그인한 경우에만 노출한다.
          */}
          <div className="col-start-3 row-start-1 flex items-center justify-self-end gap-1 min-[360px]:gap-1.5 sm:gap-2">
            {viewer ? <NotificationBell /> : null}
            <button
              type="button"
              aria-label="메뉴"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="grid h-10 w-10 place-items-center rounded-full border border-ink-200 bg-white text-ink-700 shadow-sm lg:hidden"
            >
              {open ? <X size={18} strokeWidth={1.6} /> : <Menu size={18} strokeWidth={1.6} />}
            </button>
          </div>
        </div>

        {open ? (
          <div className="border-t border-ink-100 bg-white px-4 py-3 lg:hidden">
            {[...nav, ...DRAWER_EXTRA].map((m) => {
              const DrawerIcon = m.icon;
              const drawerContent = (
                <>
                  <span className="grid h-8 w-8 place-items-center rounded-[10px] border border-brand-100 bg-brand-50 text-brand-700">
                    <DrawerIcon size={16} strokeWidth={1.75} />
                  </span>
                  <span>{m.label}</span>
                </>
              );
              return 'sheet' in m && m.sheet ? (
                <button
                  key={m.href + m.label}
                  type="button"
                  onClick={openLookup}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[14px] font-semibold text-ink-700 hover:bg-ink-50"
                >
                  {drawerContent}
                </button>
              ) : (
                <Link
                  key={m.href + m.label}
                  href={m.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-[14px] font-semibold text-ink-700 hover:bg-ink-50"
                >
                  {drawerContent}
                </Link>
              );
            })}
            {viewer ? (
              <form action="/api/auth/logout" method="post" className="border-t border-ink-100 pt-2">
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-3 text-[15px] font-semibold text-ink-500"
                >
                  <LogOut size={16} strokeWidth={1.7} />
                  로그아웃
                </button>
              </form>
            ) : (
              <div className="border-t border-ink-100 pt-1">
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded-lg px-2 py-3 text-[15px] font-semibold text-brand-700"
                >
                  <LogIn size={16} strokeWidth={1.7} />
                  로그인
                </Link>
                <Link
                  href="/signup"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded-lg px-2 py-3 text-[15px] font-semibold text-ink-700"
                >
                  <UserPlus size={16} strokeWidth={1.7} />
                  회원가입
                </Link>
              </div>
            )}
          </div>
        ) : null}
      </header>

      <main className="public-content px-4 py-5 sm:px-6 sm:py-7">{children}</main>

      <Footer mockMode={mockMode} business={business} />
        </div>

        {/* PC 우측 메뉴: 화면 세로 중앙 근처에 붙는다.
            (2026-11-18) 오른쪽 아래 문의 버튼(바닥에서 24px + 52px)과 겹치지 않게 아래쪽 92px 를 비우고,
            남은 영역(위 16px ~ 아래 92px)의 가운데에 둔다. 화면이 낮으면 메뉴 안에서 스크롤된다. */}
        <aside
          className="sticky top-[calc(50%-38px)] hidden max-h-[calc(100dvh-108px)] w-[96px] shrink-0 -translate-y-1/2 self-start overflow-y-auto pl-2 lg:block"
          aria-label="PC 메뉴"
        >
          <nav className="public-side-nav flex w-full flex-col items-center gap-0.5 rounded-[24px] border px-2 py-3 backdrop-blur-xl">
            <Link
              href="/"
              aria-label="도네이도 홈"
              className="mb-2 grid h-10 w-10 place-items-center rounded-[14px] bg-[linear-gradient(145deg,#ffd257_0%,#f5b81a_58%,#e09b00_100%)] text-ink-900 shadow-[0_6px_14px_rgba(237,166,0,0.32)] ring-1 ring-ink-900/10 transition-transform hover:-translate-y-0.5"
            >
              <TornadoMark size={21} colored={false} />
            </Link>
            {nav.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href, item.my);
              const cls = cx(
                'group flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold transition-all',
                active ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_rgba(237,166,0,0.14)]' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-900',
              );
              const inner = (
                <>
                  <span
                    className={cx(
                      'grid h-8 w-8 place-items-center rounded-[11px] border transition-all group-hover:-translate-y-0.5',
                      active
                        ? 'border-brand-200 bg-brand-100 text-ink-800'
                        : 'border-ink-100 bg-white text-ink-800 group-hover:border-brand-200 group-hover:bg-brand-50',
                    )}
                  >
                    <Icon size={17} strokeWidth={active ? 2 : 1.7} />
                  </span>
                  <span>{item.label}</span>
                </>
              );
              return item.sheet ? (
                <button key={item.href + item.label} type="button" onClick={openLookup} className={cls}>
                  {inner}
                </button>
              ) : (
                <Link
                  key={item.href + item.label}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cls}
                >
                  {inner}
                </Link>
              );
            })}

            <div className="mt-1.5 h-px w-8 bg-ink-100" />

            {viewer ? (
              <>
                <Link
                  href={myHref}
                  className="group mt-1.5 flex w-full flex-col items-center gap-1 rounded-[14px] py-2 text-ink-500 transition-colors hover:bg-ink-50"
                  aria-label="내 프로필"
                >
                  <ProfileAvatar
                    seed={viewer.avatarSeed}
                    avatarIndex={viewer.avatarIndex}
                    name={viewer.name ?? viewer.email}
                    imageUrl={viewer.avatarUrl}
                    className="h-9 w-9"
                  />
                  <span className="w-full truncate text-center text-[9px] font-bold text-ink-700">
                    {viewer.name ?? viewer.email ?? '사용자'}
                  </span>
                  <span className="text-[8px] font-semibold text-ink-300">{viewer.roleLabel}</span>
                </Link>
                <form action="/api/auth/logout" method="post" className="w-full">
                  <button
                    type="submit"
                    className="flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-900"
                  >
                    <LogOut size={17} strokeWidth={1.65} />
                    <span>로그아웃</span>
                  </button>
                </form>
              </>
            ) : (
              <Link
                href="/login"
                className={cx(
                  'mt-1.5 flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold transition-all',
                  isActive(pathname, '/login')
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-400 hover:bg-ink-50 hover:text-ink-900',
                )}
              >
                <LogIn size={18} strokeWidth={1.65} />
                <span>로그인</span>
              </Link>
            )}
            {!viewer ? (
              <Link
                href="/signup"
                className={cx(
                  'flex w-full flex-col items-center gap-0.5 rounded-[14px] py-2 text-[9.5px] font-bold transition-all',
                  isActive(pathname, '/signup')
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-400 hover:bg-ink-50 hover:text-ink-900',
                )}
              >
                <UserPlus size={18} strokeWidth={1.65} />
                <span>회원가입</span>
              </Link>
            ) : null}

            <p className="mt-2 text-[8px] font-extrabold tracking-[0.16em] text-ink-300">DONAIDO</p>
          </nav>
        </aside>
      </div>

      <nav aria-label="하단 메뉴" className="public-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <div className={cx('mx-auto grid max-w-[640px]', bottomNav.length >= 5 ? 'grid-cols-5' : 'grid-cols-4')}>
          {bottomNav.map((t) => {
            const Icon = t.icon;
            const active = isActive(pathname, t.href, t.my);
            const cls = cx(
              'flex min-h-16 flex-col items-center justify-center gap-1 whitespace-nowrap py-2 text-[10px] font-semibold min-[375px]:text-[11px]',
              active ? 'text-brand-800' : 'text-ink-600',
            );
            const inner = (
              <>
                <span
                  className={cx(
                    'grid h-8 w-8 place-items-center rounded-[10px] text-ink-800',
                    active && 'bg-brand-100',
                  )}
                >
                  <Icon size={20} strokeWidth={1.65} />
                </span>
                {t.label}
              </>
            );
            return t.sheet ? (
              <button key={t.href + t.label} type="button" onClick={openLookup} className={cls}>
                {inner}
              </button>
            ) : (
              <Link key={t.href + t.label} href={t.href} aria-current={active ? 'page' : undefined} className={cls}>
                {inner}
              </Link>
            );
          })}
        </div>
      </nav>

      <DonationLookupSheet open={lookupOpen} onClose={() => setLookupOpen(false)} />
    </div>
  );
}

function Footer({ mockMode, business }: { mockMode: boolean; business?: BusinessInfoData }) {
  return (
    <footer className="public-footer mt-10 border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 text-[12px] leading-relaxed text-ink-400">
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-[13px] font-semibold text-ink-700">
          <Link href="/terms">이용약관</Link>
          <Link href="/privacy">개인정보처리방침</Link>
          <Link href="/terms/e-finance">전자금융거래약관</Link>
          <Link href="/support">고객센터</Link>
        </div>
        <p>도네이도(DONAIDO) | 문자 기반 크리에이터 후원 플랫폼</p>
        <p className="mt-1">
          도네이도 후원은 유튜브 공식 슈퍼챗이 아닌 외부 후원 서비스입니다. 방송 채팅에는 크리에이터가 연결한 계정으로
          표시됩니다.
        </p>
        {mockMode ? (
          <p className="mt-1">현재 테스트(모의) 모드로 운영 중이라 실제 결제와 문자 발송은 이루어지지 않습니다.</p>
        ) : null}
        <BusinessInfo info={business} className="mt-2" />
      </div>
    </footer>
  );
}
