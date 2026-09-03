import Link from 'next/link';
import { Heart, LifeBuoy, Radio, MessageCircleHeart, Bell, LogIn, LogOut, BookOpen } from 'lucide-react';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { Logo } from '@/components/brand/logo';
import { CreatorDonateBackdrop } from './creator-donate-backdrop';
import { attributeFanByCreatorCode } from '@/server/services/creator-fans';
import { SOCIAL_PROVIDERS, socialProviderStatus, SOCIAL_LABEL } from '@/server/adapters/social';

/**
 * 크리에이터 후원 페이지 셸.
 *
 * 같은 계열 서비스인 **나눔플러스 후원 페이지와 같은 화면 구조**를 따른다.
 *  - 바탕은 크림색(warm). 흰 카드를 얹었을 때 카드가 떠 보이게 하는 것이 목적이다.
 *  - PC 에서는 화면 전체를 쓰지 않고 **700px 패널 한 장 + 우측 104px 플로팅 레일**로 앉힌다.
 *  - 모바일에서는 패널 장식을 모두 걷고 한 컬럼으로 흐른다. 하단은 고정 CTA 가 차지한다.
 *
 * 이 화면의 절대 규칙 — **밖으로 나가는 길을 두지 않는다.**
 * 후원 페이지는 방송 화면이나 크리에이터 프로필 링크로 들어오는 독립된 한 장이다.
 * 여기서 도네이도 메인이나 공용 마이페이지로 튕겨 나가면 후원자는 자기가 응원하려던
 * 크리에이터를 잃어버리고, 돌아오는 길도 없다. 그래서 메뉴·푸터·로그인·로그아웃까지
 * 전부 `/c/{코드}` 아래 경로로만 구성한다. 새 메뉴를 붙일 때도 이 규칙을 지켜야 한다.
 * (도네이도 브랜드 표기는 남기되 **링크로 걸지 않는다**)
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

export type CreatorShellMenu =
  | 'donate'
  | 'messages'
  | 'notifications'
  | 'support'
  | 'how-it-works'
  | 'login';

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

/** 카카오 말풍선 마크 */
function KakaoMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <path
        d="M12 4c-4.42 0-8 2.79-8 6.24 0 2.2 1.47 4.13 3.68 5.24l-.86 3.16a.35.35 0 0 0 .53.39l3.72-2.45c.3.03.62.05.93.05 4.42 0 8-2.79 8-6.39C20 6.79 16.42 4 12 4Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 네이버 N 마크 */
function NaverMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <path d="M5 4h5.1l3.9 6.1V4H19v16h-5.1L10 13.9V20H5V4Z" fill="currentColor" />
    </svg>
  );
}

const SOCIAL_STYLE: Record<string, string> = {
  kakao: 'bg-[#FEE500] text-[#191600]',
  naver: 'bg-[#03C75A] text-white',
};

/**
 * 로그아웃 폼.
 *
 * 로그아웃 후 **이 후원 페이지로 되돌아온다**(next). 도네이도 메인으로 튕기면 후원자는
 * 보던 크리에이터를 잃는다. 서버 쪽(/api/auth/logout)이 next 를 내부 경로로만 제한한다.
 *
 * 셸 안에서 화살표 함수로 두면 렌더마다 새 컴포넌트 타입이 만들어진다
 * (react-hooks/static-components). 모듈 레벨에 둔다.
 */
function LogoutForm({
  next,
  className,
  children,
}: {
  next: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <form action="/api/auth/logout" method="post" className="w-full">
      <input type="hidden" name="next" value={next} />
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}

/**
 * 읽지 않은 알림 수.
 * 조회 실패가 후원 페이지 자체를 막지 않도록 전부 흡수한다(0 으로 본다).
 */
async function unreadNotificationCount(userId: string): Promise<number> {
  try {
    return await prisma.notification.count({
      where: { userId, channel: 'IN_APP', readAt: null },
    });
  } catch {
    return 0;
  }
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
  activeMenu?: CreatorShellMenu;
}) {
  const onAir = Boolean(creator.liveUrl);
  const viewer = await getSessionUser();
  const base = `/c/${creator.code}`;

  /**
   * 팬 귀속.
   *
   * "이 크리에이터의 후원 페이지로 로그인한 후원자는 그 크리에이터에게 귀속된다"는 규칙을
   * 여기 한 곳에서 처리한다. 로그인 경로가 카카오·네이버·이메일·테스트로 갈라져 있어
   * 경로마다 붙이면 반드시 하나를 빠뜨린다. 셸은 후원 페이지 전 화면이 지나가는 길목이다.
   * 이미 귀속된 계정은 첫 UPDATE 에서 0건으로 끝나므로 추가 비용이 거의 없다.
   */
  if (viewer) await attributeFanByCreatorCode(viewer.id, creator.code);
  const loginPath = `${base}/login`;
  const unread = viewer ? await unreadNotificationCount(viewer.id) : 0;

  /** 메뉴는 전부 후원 페이지 안쪽 경로다. 밖으로 나가는 항목을 여기에 넣지 않는다. */
  const nav: { key: CreatorShellMenu; href: string; label: string; icon: typeof Heart }[] = [
    { key: 'donate', href: base, label: '후원하기', icon: Heart },
    { key: 'messages', href: `${base}/messages`, label: '내 문자후원', icon: MessageCircleHeart },
    { key: 'notifications', href: `${base}/notifications`, label: '알림', icon: Bell },
    { key: 'support', href: `${base}/support`, label: '문의하기', icon: LifeBuoy },
  ];

  const socials = SOCIAL_PROVIDERS.map((p) => ({
    provider: p,
    label: SOCIAL_LABEL[p],
    ready: socialProviderStatus(p).ready,
  }));

  return (
    <div className="relative min-h-dvh bg-warm-50 lg:bg-warm-200">
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
          <header className="sticky top-0 z-40 border-b border-warm-300/70 bg-warm-50/95 backdrop-blur lg:static lg:rounded-t-[2rem]">
            <div className="mx-auto flex max-w-[560px] items-center justify-between gap-3 px-4 py-3 lg:max-w-none lg:px-5">
              {/* 모바일: 크리에이터 / PC: 도네이도 표기 (둘 다 링크가 아니다) */}
              <Link href={base} className="flex min-w-0 items-center gap-2.5 lg:hidden">
                <ShellAvatar creator={creator} size="sm" />
                <span className="min-w-0">
                  <span className="block max-w-[11rem] truncate text-[15px] font-extrabold tracking-[-0.02em] text-ink-900">
                    {creator.displayName}
                  </span>
                  {creator.channelName ? (
                    <span className="block max-w-[11rem] truncate text-[11.5px] text-ink-400">
                      {creator.channelName}
                    </span>
                  ) : null}
                </span>
              </Link>

              {/*
                도네이도 브랜드 표기. **링크가 아니다.**
                예전에는 홈으로 가는 링크였는데, 후원자가 무심코 누르면 크리에이터를 잃고
                메인으로 나가 버렸다. 표기는 남기되 이동은 시키지 않는다.
              */}
              <span className="hidden items-center gap-2 lg:flex">
                <Logo compact />
                <span className="text-[13px] font-extrabold tracking-tight text-ink-900">도네이도</span>
                <span className="text-[11.5px] text-ink-400">문자후원</span>
              </span>

              <div className="flex shrink-0 items-center gap-2">
                {/* 우측 상단: 알림 (마이페이지 자리를 대신한다) */}
                <Link
                  href={viewer ? `${base}/notifications` : `${loginPath}?next=${encodeURIComponent(`${base}/notifications`)}`}
                  aria-label={viewer && unread > 0 ? `알림 ${unread}건 안 읽음` : '알림'}
                  aria-current={activeMenu === 'notifications' ? 'page' : undefined}
                  className="relative inline-flex min-h-10 items-center gap-1.5 rounded-full border border-warm-300 bg-white px-3 text-xs font-bold text-ink-800 transition-colors hover:bg-warm-100"
                >
                  <Bell size={16} strokeWidth={1.8} />
                  알림
                  {viewer && unread > 0 ? (
                    <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[#e5342f] px-1 text-[10px] font-black text-white tabular-nums">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
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

            <nav aria-label="후원 페이지 메뉴" className="grid grid-cols-4 gap-1 px-3 pb-2 lg:hidden">
              {nav.map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  aria-current={activeMenu === n.key ? 'page' : undefined}
                  className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-bold ${activeMenu === n.key ? 'bg-brand-100 text-brand-900' : 'text-ink-600 hover:bg-warm-100'}`}
                >
                  <n.icon size={16} strokeWidth={1.7} />
                  {n.label}
                </Link>
              ))}
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

              {/* 푸터 링크도 전부 후원 페이지 안쪽이다. */}
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-warm-300/60 pt-3 text-[12px] font-semibold text-ink-400">
                <Link href={`${base}/how-it-works`} className="transition-colors hover:text-ink-900">
                  이용방법
                </Link>
                <Link href={`${base}/support`} className="transition-colors hover:text-ink-900">
                  문의하기
                </Link>
                {viewer ? (
                  <LogoutForm next={base} className="text-[12px] font-semibold text-ink-400 transition-colors hover:text-ink-900">
                    로그아웃
                  </LogoutForm>
                ) : (
                  <Link href={loginPath} className="transition-colors hover:text-ink-900">
                    로그인
                  </Link>
                )}
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
          <span className="flex w-full shrink-0 flex-col items-center rounded-2xl px-1 py-1.5 text-center">
            <ProfileAvatar
              seed={viewer?.id ?? 'donaido-guest'}
              avatarIndex={viewer?.avatarIndex ?? 0}
              name={viewer?.name ?? '후원자'}
              className="h-12 w-12"
            />
            <span className="mt-2 line-clamp-2 w-full text-[11px] font-bold leading-[1.35] break-keep text-ink-700">
              {viewer ? (viewer.name ?? '후원자님') : '로그인 전'}
            </span>
          </span>

          <span aria-hidden className="my-3 h-px w-12 bg-warm-300" />

          <nav className="w-full space-y-1.5" aria-label={`${creator.displayName} 후원 페이지 메뉴`}>
            {nav.map((n) => (
              <Link
                key={n.key}
                href={n.href}
                aria-current={activeMenu === n.key ? 'page' : undefined}
                className={`relative flex min-h-[58px] w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-center text-[11px] font-semibold transition-colors hover:bg-brand-50 hover:text-brand-700 ${activeMenu === n.key ? 'bg-brand-100 text-brand-900' : 'text-ink-600'}`}
              >
                <n.icon className="h-5 w-5" strokeWidth={1.75} />
                <span className="leading-tight">{n.label}</span>
                {n.key === 'notifications' && viewer && unread > 0 ? (
                  <span className="absolute top-1.5 right-2 grid h-4 min-w-4 place-items-center rounded-full bg-[#e5342f] px-1 text-[9px] font-black text-white tabular-nums">
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </Link>
            ))}
            <Link
              href={`${base}/how-it-works`}
              aria-current={activeMenu === 'how-it-works' ? 'page' : undefined}
              className={`flex min-h-[58px] w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-center text-[11px] font-semibold transition-colors hover:bg-brand-50 hover:text-brand-700 ${activeMenu === 'how-it-works' ? 'bg-brand-100 text-brand-900' : 'text-ink-600'}`}
            >
              <BookOpen className="h-5 w-5" strokeWidth={1.75} />
              <span className="leading-tight">이용방법</span>
            </Link>
          </nav>

          <span aria-hidden className="my-3 h-px w-12 bg-warm-300" />

          {/* 로그인 / 로그아웃 */}
          {viewer ? (
            <LogoutForm next={base} className="flex min-h-[52px] w-full flex-col items-center justify-center gap-1 rounded-2xl border border-warm-300 bg-white px-1 py-2 text-[11px] font-bold text-ink-600 transition-colors hover:bg-warm-100">
              <LogOut className="h-5 w-5" strokeWidth={1.75} />
              로그아웃
            </LogoutForm>
          ) : (
            <div className="w-full space-y-1.5">
              <Link
                href={loginPath}
                aria-current={activeMenu === 'login' ? 'page' : undefined}
                className="flex min-h-[52px] w-full flex-col items-center justify-center gap-1 rounded-2xl bg-brand-400 px-1 py-2 text-[11px] font-black text-ink-900 shadow-sm transition hover:bg-brand-500"
              >
                <LogIn className="h-5 w-5" strokeWidth={1.8} />
                로그인
              </Link>

              {/* 카카오·네이버 간편 로그인 — 레일에서 한 번에 */}
              <div className="flex justify-center gap-1.5">
                {socials.map((s) => (
                  <a
                    key={s.provider}
                    href={`/api/auth/social/${s.provider}?mode=login&next=${encodeURIComponent(base)}`}
                    aria-label={`${s.label}로 로그인${s.ready ? '' : ' (준비 중)'}`}
                    title={`${s.label}로 로그인${s.ready ? '' : ' (연동 준비 중)'}`}
                    className={`grid h-9 w-9 place-items-center rounded-full transition-[filter] hover:brightness-95 ${SOCIAL_STYLE[s.provider] ?? 'bg-ink-100 text-ink-700'} ${s.ready ? '' : 'opacity-50'}`}
                  >
                    {s.provider === 'kakao' ? <KakaoMark /> : <NaverMark />}
                  </a>
                ))}
              </div>
            </div>
          )}

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
