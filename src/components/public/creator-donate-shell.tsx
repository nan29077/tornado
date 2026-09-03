import Link from 'next/link';
import { Heart, LifeBuoy, Radio, MessageCircleHeart, UserRound, LogIn, Home } from 'lucide-react';
import { getSessionUser } from '@/server/auth';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { Logo } from '@/components/brand/logo';
import { CreatorDonateBackdrop } from './creator-donate-backdrop';

/**
 * 크리에이터 후원 페이지 셸.
 *
 * 같은 계열 서비스인 **나눔플러스 후원 페이지와 같은 화면 구조**를 따른다.
 *  - 바탕은 크림색(warm). 흰 카드를 얹었을 때 카드가 떠 보이게 하는 것이 목적이다.
 *  - PC 에서는 화면 전체를 쓰지 않고 **700px 패널 한 장 + 우측 104px 플로팅 레일**로 앉힌다.
 *    후원 페이지는 방송 화면이나 프로필 링크에서 들어오는 "한 장짜리 페이지"라, 넓게
 *    벌리면 시선이 흩어지고 모바일과 PC 의 인상이 갈린다.
 *  - 모바일에서는 패널 장식을 모두 걷고 한 컬럼으로 흐른다. 하단은 고정 CTA 가 차지한다.
 *
 * 나눔플러스와 다르게 가져간 것
 *  - 배경: 직접 생성한 도네이도 캐릭터·하트·편지 이미지를 양쪽 여백에 배치한다.
 *  - 우측 레일: 로그인한 후원자 프로필과 내 문자후원·마이페이지 중심의 메뉴를 제공한다.
 */

export interface CreatorShellProfile {
  code: string;
  displayName: string;
  channelName: string | null;
  avatarUrl: string | null;
  avatarIndex: number | null;
  description: string | null;
  /** 방송 중이면 라이브 주소. 아니면 null */
  liveUrl: string | null;
}

/**
 * 크리에이터 아바타.
 *
 * 셸 안에서 화살표 함수로 두면 렌더마다 새 컴포넌트 타입이 만들어져 React 가 트리를
 * 통째로 다시 마운트한다(react-hooks/static-components). 모듈 레벨에 둔다.
 */
function ShellAvatar({ creator, size }: { creator: CreatorShellProfile; size: 'sm' | 'lg' }) {
  return (
    <ProfileAvatar
      seed={creator.code}
      avatarIndex={creator.avatarIndex}
      name={creator.displayName}
      imageUrl={creator.avatarUrl}
      className={size === 'lg' ? 'h-16 w-16' : 'h-9 w-9'}
    />
  );
}

export async function CreatorDonateShell({
  creator,
  children,
  bottomBar,
  activeMenu = 'donate',
}: {
  creator: CreatorShellProfile;
  children: React.ReactNode;
  /** 모바일 하단 고정 CTA. 없으면 렌더하지 않는다. */
  bottomBar?: React.ReactNode;
  activeMenu?: 'donate' | 'messages' | 'login';
}) {
  const onAir = Boolean(creator.liveUrl);
  const viewer = await getSessionUser();
  const base = `/c/${creator.code}`;
  const loginPath = `${base}/login`;
  const nav = [
    { key: 'donate', href: base, label: '후원하기', icon: Heart },
    { key: 'messages', href: `${base}/messages`, label: '내 문자후원', icon: MessageCircleHeart },
    { key: 'my', href: viewer ? '/my' : `${loginPath}?next=%2Fmy`, label: '마이페이지', icon: UserRound },
    { key: 'support', href: '/support', label: '문의하기', icon: LifeBuoy },
    { key: 'home', href: '/', label: '도네이도 홈', icon: Home },
  ];

  return (
    <div className="relative min-h-dvh bg-warm-50 lg:bg-warm-200">
      {/*
        PC 전용 배경.
        고정(fixed) 이라 본문이 스크롤해도 배경은 움직이지 않는다. 가장자리를 어둡게 눌러
        가운데 패널이 조명 아래 놓인 것처럼 보이게 한다.
      */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 hidden lg:block"
        style={{
          background:
            'radial-gradient(1200px 700px at 50% -10%, #fffaf0 0%, #f6eedf 45%, #e9dcc4 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 hidden lg:block"
        style={{
          background:
            'radial-gradient(700px 420px at 82% 12%, rgba(251,185,20,0.16) 0%, rgba(251,185,20,0) 70%), radial-gradient(620px 420px at 12% 88%, rgba(23,22,26,0.07) 0%, rgba(23,22,26,0) 70%)',
        }}
      />

      <CreatorDonateBackdrop />

      <div className="relative mx-auto min-h-dvh lg:grid lg:w-fit lg:grid-cols-[700px_104px] lg:items-start lg:gap-4 lg:py-6 xl:gap-5">
        <div className="min-h-dvh bg-warm-50 lg:w-[700px] lg:rounded-[2rem] lg:border lg:border-white/80 lg:shadow-panel">
          {/* 모바일: 크리에이터 정보 / PC: 도네이도 브랜드 */}
          <header className="sticky top-0 z-40 border-b border-warm-300/70 bg-warm-50/95 backdrop-blur lg:static lg:rounded-t-[2rem]">
            <div className="mx-auto flex max-w-[560px] items-center justify-between gap-3 px-4 py-3 lg:max-w-none lg:px-5">
              <span className="flex min-w-0 items-center gap-2.5 lg:hidden">
                <ShellAvatar creator={creator} size="sm" />
                <span className="min-w-0">
                  <span className="block max-w-[13rem] truncate text-[15px] font-extrabold tracking-[-0.02em] text-ink-900">
                    {creator.displayName}
                  </span>
                  {creator.channelName ? (
                    <span className="block max-w-[13rem] truncate text-[11.5px] text-ink-400">
                      {creator.channelName}
                    </span>
                  ) : null}
                </span>
              </span>

              <Link href="/" className="hidden items-center gap-2 lg:flex" aria-label="도네이도 홈으로 이동">
                <Logo compact />
                <span className="text-[13px] font-extrabold tracking-tight text-ink-900">도네이도</span>
                <span className="text-[11.5px] text-ink-400">문자후원</span>
              </Link>

              <div className="flex shrink-0 items-center gap-2">
              <Link href={viewer ? '/my' : loginPath} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-warm-300 bg-white px-3 text-xs font-bold text-ink-800">
                {viewer ? <ProfileAvatar seed={viewer.id} avatarIndex={viewer.avatarIndex} name={viewer.name ?? '후원자'} className="h-6 w-6" /> : <LogIn size={16} strokeWidth={1.7} />}
                {viewer ? '마이페이지' : '로그인'}
              </Link>
              {onAir ? (
                <a
                  href={creator.liveUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#e5342f] px-3 py-1.5 text-[11px] font-black tracking-[0.04em] text-white shadow-[0_6px_16px_rgba(229,52,47,0.35)]"
                >
                  <span aria-hidden className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
                  </span>
                  ON AIR
                </a>
              ) : null}
              </div>
            </div>
            <nav aria-label="후원자 모바일 메뉴" className="grid grid-cols-4 gap-1 px-3 pb-2 lg:hidden">
              {nav.slice(0, 4).map((n) => <Link key={n.key} href={n.href} aria-current={activeMenu === n.key ? 'page' : undefined} className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-bold ${activeMenu === n.key ? 'bg-brand-100 text-brand-900' : 'text-ink-600 hover:bg-warm-100'}`}><n.icon size={16} strokeWidth={1.7} />{n.label}</Link>)}
            </nav>
          </header>

          <main className="mx-auto max-w-[560px] px-4 pb-32 sm:pb-14 lg:max-w-none lg:px-5 lg:pb-12">
            {children}

            {/* 크리에이터 정보 + 서비스 표기 푸터 */}
            <footer className="mt-10 rounded-3xl border border-warm-300/70 bg-white p-6 shadow-card">
              <div className="flex items-center gap-2.5">
                <ShellAvatar creator={creator} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-extrabold text-ink-900">
                    {creator.displayName}
                  </span>
                  {creator.channelName ? (
                    <span className="block truncate text-[11.5px] text-ink-400">{creator.channelName}</span>
                  ) : null}
                </span>
              </div>
              {creator.description ? (
                <p className="mt-3 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-500">
                  {creator.description}
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-warm-300/60 pt-3 text-[12px] font-semibold text-ink-400">
                <Link href="/how-it-works" className="transition-colors hover:text-ink-900">
                  이용방법
                </Link>
                <Link href="/support" className="transition-colors hover:text-ink-900">
                  고객센터
                </Link>
                <Link href="/" className="transition-colors hover:text-ink-900">
                  도네이도 홈
                </Link>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
                이 페이지는 <span className="font-bold text-ink-500">도네이도 문자후원</span>으로 운영됩니다.
                유튜브 공식 슈퍼챗이 아닌 외부 후원 서비스입니다.
              </p>
            </footer>
          </main>
        </div>

        {/* PC 우측 플로팅 레일 */}
        <aside className="sticky top-6 z-30 hidden max-h-[calc(100dvh-3rem)] w-[104px] flex-col items-center overflow-y-auto rounded-[1.75rem] border border-white/90 bg-white/95 px-2.5 py-3.5 shadow-rail backdrop-blur lg:flex">
          <Link href={viewer ? '/my' : loginPath} aria-current={activeMenu === 'login' ? 'page' : undefined} className="flex w-full shrink-0 flex-col items-center rounded-2xl px-1 py-1.5 text-center hover:bg-warm-100">
            <ProfileAvatar seed={viewer?.id ?? 'donaido-guest'} avatarIndex={viewer?.avatarIndex ?? 0} name={viewer?.name ?? '후원자'} className="h-12 w-12" />
            <span className="mt-2 line-clamp-2 w-full text-[11px] font-bold leading-[1.35] break-keep text-ink-700">
              {viewer ? (viewer.name ?? '후원자님') : '후원자 로그인'}
            </span>
          </Link>

          <span aria-hidden className="my-3 h-px w-12 bg-warm-300" />

          <nav className="w-full space-y-1.5" aria-label={`${creator.displayName} 후원 페이지 메뉴`}>
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={activeMenu === n.key ? 'page' : undefined}
                className={`flex min-h-[58px] w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-center text-[11px] font-semibold transition-colors hover:bg-brand-50 hover:text-brand-700 ${activeMenu === n.key ? 'bg-brand-100 text-brand-900' : 'text-ink-600'}`}
              >
                <n.icon className="h-5 w-5" strokeWidth={1.75} />
                <span className="leading-tight">{n.label}</span>
              </Link>
            ))}
          </nav>

          {onAir ? (
            <>
              <span aria-hidden className="my-3 h-px w-12 bg-warm-300" />
              <a
                href={creator.liveUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-[56px] w-full flex-col items-center justify-center gap-1 rounded-2xl bg-[#e5342f] px-1 py-2 text-[11px] font-bold text-white shadow-sm transition hover:brightness-95"
              >
                <Radio className="h-5 w-5" strokeWidth={1.8} />
                라이브
              </a>
            </>
          ) : null}
        </aside>
      </div>

      {bottomBar}
    </div>
  );
}
