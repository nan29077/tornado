import type { Metadata } from 'next';
import Link from 'next/link';
import {
  MessageSquare, CreditCard, ShieldCheck, CircleAlert,
  Gauge, Flag, Phone, BellRing, Smartphone, Users, CalendarDays, HandCoins,
  Video, Camera, Music2, ThumbsUp,
} from 'lucide-react';
import { CreatorCodeForm } from '@/components/creator-code-form';
import { CopyButton } from '@/components/public/copy-button';
import { WebDonationPanel } from '@/components/public/web-donation-panel';
import { WebDonationPinPanel } from '@/components/public/web-donation-pin-panel';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { defaultBannerFor } from '@/lib/banners';
import { maskDisplayName } from '@/components/public/mask';
import { Logo } from '@/components/brand/logo';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { LinkButton } from '@/components/ui';
import { normalizeCreatorCode } from '@/lib/id';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstStartOfMonth } from '@/lib/datetime';
import { formatMoNumber } from '@/server/emma/number';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { broadcastDonorName, defaultDonorName } from '@/lib/donor-name';
import { resolvePolicy } from '@/server/services/limits';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { resolveWebDonationChannel } from '@/server/services/web-donation';
import { readSnsLinks, type SnsPlatform } from '@/lib/sns-platforms';

export const dynamic = 'force-dynamic';

/**
 * 크리에이터 전용 후원 페이지.
 *
 * 화면 구조는 같은 계열 서비스인 **나눔플러스 후원 페이지**와 같은 결로 맞춘다.
 *  - 크림색 바탕 위에 흰 카드를 얹고, 모서리는 크게(2rem) 깎는다.
 *  - 상단은 라운드 히어로 배너, 그 아래로 **겹쳐 올라오는 프로필 카드**가 후원 행동을 받는다.
 *  - PC 는 화면을 넓게 벌리지 않고 700px 패널 + 우측 플로팅 레일로 앉힌다(CreatorDonateShell).
 *
 * 다만 페이지의 성격은 그대로다. 방송·프로필에 붙는 "크리에이터 자신의 링크"로 보여야 하므로
 * 도네이도 브랜드는 PC 헤더와 하단 풋터에 서비스 표기로만 남기고, 화면의 주인은 크리에이터다.
 * 모바일에서는 하단 고정 CTA(문자 보내기)가 탭바를 대신한다.
 */

type Params = { params: Promise<{ code: string }> };

/** SNS 링크 버튼 아이콘. lucide 에는 브랜드 로고가 없어 성격이 가까운 일반 아이콘을 쓰고, 구분은 색으로 한다. */
const SNS_ICONS: Record<SnsPlatform, typeof Video> = {
  YOUTUBE: Video,
  INSTAGRAM: Camera,
  TIKTOK: Music2,
  FACEBOOK: ThumbsUp,
};

/** 결제가 끝나 공개해도 되는 후원 상태. 통계와 최근 후원 목록이 같은 기준을 쓴다. */
const PAID_STATUSES = ['BROADCASTED', 'SETTLEMENT_PENDING', 'PARTIAL_DELIVERY_FAILED', 'SETTLED'] as const;

/**
 * MO 후원번호 표시용 서식은 공용 함수(@/server/emma/number)를 쓴다.
 *
 * 예전에는 이 파일에 따로 두었는데, 번호 체계가 `1688-□□□□-XXXX` (12자리)로 바뀌면서
 * 이 화면만 서식이 적용되지 않아 후원자에게 168812345678 로 그대로 보였다.
 * 표시 규칙이 두 군데에 있으면 반드시 한쪽이 뒤처진다.
 * sms: 링크와 복사 값은 지금까지처럼 원본(숫자만)을 그대로 쓴다.
 */

/**
 * 로그인한 방문자의 후원자 프로필. 없으면 null.
 * 세션·프로필 조회 실패가 후원 페이지 자체를 막지 않도록 전부 흡수한다.
 */
async function currentViewerDonor() {
  try {
    const user = await getSessionUser();
    if (!user) return null;
    return await prisma.donorProfile.findUnique({
      where: { userId: user.id },
      select: { displayName: true, phoneMasked: true },
    });
  } catch {
    return null;
  }
}

async function findCreator(rawCode: string) {
  const code = normalizeCreatorCode(rawCode);
  if (!/^TOR-[A-Z0-9]{2,10}$/.test(code)) return null;
  return prisma.creatorProfile.findFirst({
    where: {
      code,
      status: 'APPROVED',
      // 계정 자체가 정지·탈퇴된 크리에이터의 후원샵은 닫아야 한다.
      // creatorProfile.status 만 보면 User 를 SUSPENDED 로 제재해도 샵이 계속 열려
      // 후원을 받고 정지 계정에 돈이 계속 쌓인다.
      user: { status: 'ACTIVE' },
    },
    // PostgreSQL 은 행 순서를 보장하지 않아, 번호가 2개 이상 배정된 크리에이터는
    // 새로고침마다 다른 번호가 표시될 수 있다. 다른 화면과 동일하게 assignedAt 내림차순으로 고정한다.
    include: {
      user: { select: { avatarIndex: true } },
      moRoutes: { where: { status: 'ASSIGNED' }, orderBy: { assignedAt: 'desc' } },
    },
  });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { code } = await params;
  const creator = await findCreator(code);
  if (!creator) {
    return { title: '크리에이터를 찾을 수 없습니다 | 도네이도', robots: { index: false, follow: false } };
  }
  return {
    title: `${creator.displayName} 문자후원`,
    description: `${creator.displayName} 님에게 문자 한 통으로 응원을 보내세요. 문자 1건당 ${formatWon(creator.donationAmount)}.`,
    robots: { index: false, follow: false },
  };
}

export default async function CreatorDonationPage({ params }: Params) {
  const { code } = await params;
  const creator = await findCreator(code);

  if (!creator) return <NotFoundView />;

  const monthFrom = kstStartOfMonth();
  const [policy, donations, totalCount, monthCount, supporterCount] = await Promise.all([
    resolvePolicy(creator.id),
    prisma.donation.findMany({
      where: { creatorId: creator.id, status: { in: [...PAID_STATUSES] } },
      orderBy: { paidAt: 'desc' },
      take: 10,
      select: { id: true, displayName: true, amount: true, message: true, paidAt: true, anonymous: true },
    }),
    /**
     * 통계 3칸은 **금액이 아니라 건수·인원**이다.
     * 이 페이지는 누구나 볼 수 있어서, 누적 모금액을 띄우면 크리에이터의 수입이 그대로 공개된다.
     * (나눔플러스는 기관 페이지라 모금액 공개가 자연스럽지만 여기서는 성격이 다르다)
     * 금액을 노출하기로 정하면 여기 세 줄만 aggregate 로 바꾸면 된다.
     */
    prisma.donation.count({ where: { creatorId: creator.id, status: { in: [...PAID_STATUSES] } } }),
    prisma.donation.count({
      where: { creatorId: creator.id, status: { in: [...PAID_STATUSES] }, paidAt: { gte: monthFrom } },
    }),
    prisma.donorCreatorLink.count({ where: { creatorId: creator.id, totalCount: { gt: 0 } } }),
  ]);

  // 허용 범위 = 플랫폼 정책 ∩ 크리에이터 설정 (결제 시 checkLimits 가 같은 교집합으로 판정한다).
  // 정책 범위만 보여 주면 본인인증까지 마친 뒤 금액 범위 오류로 거절된다.
  const effMin = creator.minAmount > policy.minAmount ? creator.minAmount : policy.minAmount;
  const effMax = creator.maxAmount < policy.maxAmount ? creator.maxAmount : policy.maxAmount;

  // 로그인한 후원자라면 방송에 어떤 이름으로 표시되는지 알려준다.
  // 비로그인 방문자에게는 아무것도 보여주지 않는다(안내할 대상이 없다).
  const viewerDonor = await currentViewerDonor();

  const route = creator.moRoutes[0] ?? null;
  const bannerUrl = creator.bannerUrl ?? defaultBannerFor(creator.id);

  /**
   * SNS 링크와 라이브 상태.
   *
   * 링크는 방송 여부와 무관하게 버튼으로 노출하고, 크리에이터가 스튜디오에서 "방송중" 스위치를
   * 켠 플랫폼만 ON AIR 배지가 붙는다. 동시송출을 하면 배지도 여러 개 붙는다.
   * (파생 컬럼 liveOn/liveUrl 대신 원본인 플랫폼별 값을 직접 읽는다 — 배지마다 갈 곳이 다르다)
   */
  const snsLinks = readSnsLinks(creator);
  const liveLinks = snsLinks.filter((l) => l.live);
  const onAir = liveLinks.length > 0;
  const primaryLive = liveLinks[0] ?? null;

  // 결제 연동이 mock 이면 후원 화면에 반드시 표시한다 (가짜 성공 처리 금지 원칙)
  let paymentMock = true;
  try {
    paymentMock = getPaymentAdapter().info().mode === 'mock';
  } catch {
    paymentMock = true;
  }
  // 크리에이터마다 전용 수신번호(대표번호 + 서브번호 4자리)가 부여되므로
  // keyword 없이 번호만으로 라우팅한다. (과거 대표번호 공유 방식의 keyword 선입력 로직 제거)
  const smsHref = route ? `sms:${route.phoneNumber}` : null;
  const moNumberLabel = route ? formatMoNumber(route.phoneNumber) : null;

  return (
    <CreatorDonateShell
      creator={{
        code: creator.code,
        displayName: creator.displayName,
        channelName: creator.channelName,
        avatarUrl: creator.avatarUrl,
        avatarIndex: creator.user.avatarIndex,
        description: creator.description,
        liveUrl: primaryLive?.url ?? null,
      }}
      bottomBar={
        smsHref && route ? (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-warm-300/70 bg-white/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur-xl sm:hidden">
            <div className="mx-auto flex max-w-[560px] items-center gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-ink-400">문자 1통당</p>
                <p className="text-[16px] font-extrabold tracking-tight text-ink-900">
                  {formatWon(creator.donationAmount)}
                </p>
              </div>
              <a
                href={smsHref}
                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] transition-colors hover:bg-brand-500 active:bg-brand-600"
              >
                <MessageSquare size={17} strokeWidth={1.7} />
                문자후원하기
              </a>
            </div>
          </div>
        ) : null
      }
    >
      {/* ── 히어로 배너 ─────────────────────────────────────────────── */}
      <section className="relative mt-4 min-h-[250px] overflow-hidden rounded-[1.5rem] shadow-card sm:mt-5 sm:min-h-[320px] sm:rounded-[2rem]">
        {/* 크리에이터 배너 (미설정 시 기본 배너 5종 중 크리에이터별 고정 적용) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={bannerUrl} alt="" width={1774} height={887} fetchPriority="high" className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center" />
        {/*
          대각선 그러데이션. 나눔플러스는 기관 테마색을 깔지만, 도네이도 브랜드는 노랑이라
          흰 글자를 얹으면 대비가 무너진다. 먹색을 주로 쓰고 끝자락에만 브랜드 색을 섞는다.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(110deg, rgba(23,22,26,0.90) 0%, rgba(23,22,26,0.66) 46%, rgba(160,106,0,0.30) 80%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-ink-900/45 to-transparent"
        />

        <div className="relative z-10 flex min-h-[250px] flex-col justify-end px-5 pt-12 pb-16 text-white sm:min-h-[320px] sm:px-9 sm:pb-20">
          {/*
            ON AIR 표시는 **프로필 카드의 아바타 아래**에만 둔다.
            예전에는 히어로에도 같은 배지를 띄웠는데, 아바타 옆 배지와 나란히 보여
            같은 것이 두 번 붙은 것처럼 읽혔다. 스크롤 중에도 보이는 상단 헤더 배지는 셸에 있다.
          */}
          <span className="mb-4 w-fit rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[11.5px] font-bold backdrop-blur">
            문자 한 통으로 보내는 응원
          </span>

          <h1 className="text-[27px] leading-tight font-black tracking-[-0.035em] drop-shadow-sm sm:text-[34px]">
            {creator.displayName} 님에게
            <br />
            응원을 보내세요
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-white/85 drop-shadow-sm sm:text-[14.5px]">
            문자 1건당 {formatWon(creator.donationAmount)}. 결제가 끝나면 방송 화면과 유튜브 채팅에 내 메시지가
            표시됩니다.
          </p>
        </div>
      </section>

      {/* ── 크리에이터 카드 (히어로에 겹침) ─────────────────────────── */}
      <div
        id="donate"
        className="relative z-20 -mt-10 scroll-mt-20 rounded-[2rem] border border-white/80 bg-white/95 p-6 text-center shadow-xl backdrop-blur sm:mx-5 sm:p-8"
      >
        <span className="mx-auto block w-fit">
          <ProfileAvatar
            seed={creator.code}
            avatarIndex={creator.user.avatarIndex}
            name={creator.displayName}
            imageUrl={creator.avatarUrl}
            className={`h-20 w-20 border-4 border-white ${onAir ? 'animate-heartbeat' : ''}`}
          />
        </span>
        {/*
          ON AIR 배지. 크리에이터가 스튜디오 SNS·라이브 탭에서 켠 플랫폼마다 하나씩 붙고,
          누르면 그 플랫폼 링크로 이동한다. 동시송출이면 배지도 여러 개다.
        */}
        {liveLinks.length > 0 ? (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {liveLinks.map((l) => (
              <a
                key={l.platform.value}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-[#e5342f] px-3 py-1.5 text-[11.5px] font-black tracking-[0.04em] text-white shadow-[0_6px_16px_rgba(229,52,47,0.35)] transition-transform hover:-translate-y-0.5"
              >
                <span aria-hidden className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
                ON AIR · {l.platform.label}
              </a>
            ))}
          </div>
        ) : null}

        <h2 className="mt-4 text-[22px] font-black tracking-[-0.03em] text-ink-900">{creator.displayName}</h2>
        {creator.channelName ? (
          <p className="mt-1 text-[13px] font-semibold text-ink-400">{creator.channelName}</p>
        ) : null}
        {creator.description ? (
          <p className="mx-auto mt-3 max-w-lg text-[13.5px] leading-relaxed whitespace-pre-line text-ink-700">
            {creator.description}
          </p>
        ) : null}

        {/*
          SNS 링크 버튼. 크리에이터가 스튜디오에서 등록한 플랫폼만 그린다.
          방송 중인 플랫폼에는 빨간 점을 찍어 위 배지와 같은 것을 가리킨다는 걸 보여 준다.
        */}
        {snsLinks.length > 0 ? (
          <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {snsLinks.map((l) => {
              const Icon = SNS_ICONS[l.platform.value];
              return (
                <a
                  key={l.platform.value}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-[13px] font-bold text-ink-700 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                  style={{ borderColor: `${l.platform.color}26`, backgroundColor: `${l.platform.color}0a` }}
                >
                  <Icon size={16} strokeWidth={1.9} style={{ color: l.platform.color }} />
                  <span className="truncate">{l.platform.label}</span>
                  {l.live ? (
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e5342f]" />
                  ) : null}
                </a>
              );
            })}
          </div>
        ) : null}

        {/* 통계 3칸 — 금액이 아니라 건수·인원 (위 쿼리 주석 참고) */}
        <div className="mt-6 grid grid-cols-3 gap-2 sm:gap-3">
          <StatTile
            tone="#faf6ed"
            icon={<HandCoins className="mx-auto h-4 w-4 text-brand-700" strokeWidth={1.75} />}
            value={`${formatNumber(totalCount)}건`}
            label="누적 후원"
          />
          <StatTile
            tone="#f7f1e8"
            icon={<CalendarDays className="mx-auto h-4 w-4 text-brand-700" strokeWidth={1.75} />}
            value={`${formatNumber(monthCount)}건`}
            label="이번 달"
          />
          <StatTile
            tone="#f2f6ef"
            icon={<Users className="mx-auto h-4 w-4 text-brand-700" strokeWidth={1.75} />}
            value={`${formatNumber(supporterCount)}명`}
            label="후원해 주신 분"
          />
        </div>

        <p className="mx-auto mt-6 max-w-lg rounded-2xl bg-brand-50 px-4 py-3 text-[13px] leading-relaxed font-semibold text-brand-800">
          보내주신 응원은 {creator.displayName} 님의 방송 화면에 그대로 전해집니다.
        </p>

        {/*
          PC 웹 후원(내통장결제)은 MO 수신번호가 전혀 필요 없다.
          예전에는 번호 미배정 시 카드 전체를 안내문으로 갈아끼워 웹 후원까지 막았는데,
          그러면 번호를 기다리는 신규 크리에이터는 PC 후원도 하나도 받지 못했다.
          그래서 PC 패널은 번호 배정 여부와 무관하게 항상 노출하고,
          번호가 필요한 모바일 문자후원 영역만 조건부로 바꾼다.
        */}
        <div className="mt-6 hidden text-left sm:block">
          <p className="mb-4 text-center text-[15px] font-black tracking-[-0.02em] text-ink-900">
            {creator.displayName} 님에게 후원하기
          </p>
          {/* 기본은 PIN 인증 흐름이다. 구 즉시결제 화면은 되돌림 플래그를 켰을 때만 쓴다. */}
          {resolveWebDonationChannel() === 'PIN' ? (
            <WebDonationPinPanel
              creatorId={creator.id}
              creatorName={creator.displayName}
              defaultAmount={creator.donationAmount.toString()}
              minAmount={effMin.toString()}
              maxAmount={effMax.toString()}
              paymentMock={paymentMock}
            />
          ) : (
            <WebDonationPanel
              creatorId={creator.id}
              creatorName={creator.displayName}
              defaultAmount={creator.donationAmount.toString()}
              minAmount={effMin.toString()}
              maxAmount={effMax.toString()}
              paymentMock={paymentMock}
            />
          )}
        </div>

        {/* PC: 문자 후원번호 안내. 데스크톱에서는 문자를 보낼 수 없으므로 번호만 안내한다. */}
        {route ? (
          <div className="mt-5 hidden rounded-2xl border border-brand-200/70 bg-brand-50/60 px-4 py-3.5 text-left sm:block">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[12px] font-bold text-brand-700">
                  <Phone size={14} strokeWidth={1.8} />
                  문자 후원번호
                </p>
                <p className="mt-1 font-mono text-[22px] leading-none font-extrabold tracking-tight text-ink-900">
                  {moNumberLabel}
                </p>
              </div>
              <CopyButton value={route.phoneNumber} label="번호 복사" />
            </div>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-500">
              휴대폰에서 이 번호로 문자를 보내도 {creator.displayName} 님에게 후원됩니다.
            </p>
          </div>
        ) : null}

        {route ? (
          /* 모바일: 문자후원 (문자 1통 = 크리에이터 설정 금액) */
          <div className="mt-6 sm:hidden">
            <p className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-brand-700">
              <Phone size={14} strokeWidth={1.8} />
              {creator.displayName} 전용 후원 번호
            </p>
            <p className="mt-2 text-center font-mono text-[32px] leading-none font-extrabold tracking-tight text-ink-900">
              {moNumberLabel}
            </p>
            <div className="mt-3 flex justify-center">
              <CopyButton value={route.phoneNumber} label="번호 복사" />
            </div>

            <div className="mt-5 flex items-center justify-between rounded-2xl bg-warm-100 px-4 py-3">
              <span className="text-[13px] font-semibold text-ink-500">문자 1건당 후원금</span>
              <span className="text-[20px] font-extrabold tracking-tight text-brand-700">
                {formatWon(creator.donationAmount)}
              </span>
            </div>

            {/*
              문자후원 버튼은 **화면 하단 고정 바에만** 둔다.
              여기에도 같은 버튼을 두었더니 한 화면에 문자후원하기가 두 개로 보였다.
              이 자리에는 번호와 금액만 남기고, 실제 행동은 스크롤과 무관하게 항상 보이는
              하단 바가 받는다.
            */}
            <p className="mt-3 text-center text-[11.5px] leading-relaxed text-ink-400">
              아래 <span className="font-bold text-ink-500">문자후원하기</span>를 누르면 문자 앱이 열리며 후원 번호가
              자동 입력됩니다. 문자를 보내면 결제 PIN 입력 문자가 오고, PIN 을 입력하면{' '}
              {formatWon(creator.donationAmount)}이 등록된 내통장결제 계좌에서 결제됩니다.
            </p>
          </div>
        ) : (
          /* 번호 미배정: 문자후원 영역만 안내로 대체한다. 위 PC 웹 후원은 그대로 동작한다. */
          <div className="mt-6 sm:hidden">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-warning-50 text-warning-600">
              <CircleAlert size={22} strokeWidth={1.7} />
            </span>
            <p className="mt-3 text-[15px] font-extrabold text-ink-900">후원 번호가 아직 배정되지 않았습니다</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">
              아직 문자 수신 번호가 배정되지 않아 문자후원을 접수할 수 없습니다. 번호가 배정되면 이 페이지에
              표시됩니다. PC 에서는 지금도 후원하실 수 있습니다.
            </p>
          </div>
        )}
      </div>

      {/*
        방송 닉네임 안내.
        로그인한 후원자에게만 보여준다. 닉네임을 정하지 않았으면 번호 끝 4자리로
        방송에 표시된다는 사실을 알려주고, 정했으면 지금 이름을 확인시켜 준다.
      */}
      {viewerDonor ? (
        <section className="mt-5 rounded-[1.5rem] border border-brand-200/70 bg-brand-50 px-5 py-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
            <BellRing size={15} strokeWidth={1.8} className="shrink-0 text-brand-700" />
            {viewerDonor.displayName
              ? `방송에 ${viewerDonor.displayName} 님으로 표시됩니다`
              : '방송에 휴대폰 번호로 표시됩니다'}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
            {viewerDonor.displayName
              ? '후원하면 이 이름으로 방송 오버레이와 유튜브 채팅에 표시됩니다.'
              : `닉네임을 정하지 않아 번호 끝 4자리(${broadcastDonorName(defaultDonorName(viewerDonor.phoneMasked))})로 표시됩니다. 닉네임을 정하면 크리에이터가 누가 보냈는지 알아볼 수 있습니다.`}
          </p>
          <Link
            href={`/c/${creator.code}/account`}
            className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-brand-700 underline underline-offset-2"
          >
            닉네임 {viewerDonor.displayName ? '변경하기' : '설정하기'}
          </Link>
        </section>
      ) : null}

      {/* 첫 문자 안내 (모바일 문자후원) */}
      <section className="mt-5 rounded-[1.5rem] border border-warning-500/30 bg-warning-50 px-5 py-4 sm:hidden">
        <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
          <CircleAlert size={15} strokeWidth={1.8} className="shrink-0 text-warning-600" />
          처음 보내는 문자는 후원되지 않습니다
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
          최초 문자는 계좌 등록 안내만 발송됩니다. 안내 문자의 링크에서 계좌 등록과 이용 동의를 마친 뒤 다시
          문자를 보내주세요.
        </p>
      </section>

      {/* ── 후원 방법 ───────────────────────────────────────────────── */}
      <section id="how" className="mt-8 scroll-mt-20">
        <h2 className="px-1 text-[16px] font-black tracking-[-0.02em] text-ink-900">후원 방법</h2>

        {/* PC(웹 후원) */}
        <div className="mt-3 hidden space-y-2.5 sm:block">
          <Step
            no="1"
            icon={<MessageSquare size={17} strokeWidth={1.7} />}
            title="금액과 응원 메시지를 고릅니다"
            body="문자후원하기를 누르면 금액(직접 입력 포함)과 방송에 표시될 응원 메시지를 고를 수 있습니다."
          />
          <Step
            no="2"
            icon={<Smartphone size={17} strokeWidth={1.7} />}
            title="휴대전화 번호를 입력합니다"
            body="입력한 번호로 결제 PIN 입력 링크를 문자로 보내드립니다. 이 단계까지는 출금되지 않습니다. 처음이라면 등록 창에서 계좌를 1회 등록합니다."
          />
          <Step
            no="3"
            icon={<CreditCard size={17} strokeWidth={1.7} />}
            title="PIN 을 입력하면 결제됩니다"
            body="문자로 받은 링크에서 결제 PIN 을 입력하면 등록된 계좌에서 선택한 금액이 출금됩니다. 유효시간 안에 입력하지 않으면 자동 취소됩니다."
          />
          <Step
            no="4"
            icon={<ShieldCheck size={17} strokeWidth={1.7} />}
            title="유튜브와 방송에 표시됩니다"
            body="결제가 완료된 후원만 유튜브 라이브 채팅과 방송 오버레이, 음성 안내로 전달됩니다. 결제되지 않은 메시지는 표시되지 않습니다."
          />
        </div>

        {/* 모바일(문자후원) */}
        <div className="mt-3 space-y-2.5 sm:hidden">
          <Step
            no="1"
            icon={<CreditCard size={17} strokeWidth={1.7} />}
            title="계좌를 1회 등록합니다"
            body="첫 문자를 보내면 오는 안내 링크에서 본인 명의 계좌를 등록합니다. 계좌번호 원문은 저장하지 않고 은행명과 끝 4자리만 보관합니다."
          />
          <Step
            no="2"
            icon={<MessageSquare size={17} strokeWidth={1.7} />}
            title="응원 문자를 보냅니다"
            body={`위 번호로 메시지를 보내면 문자 1통당 ${formatWon(creator.donationAmount)}의 결제 PIN 입력 문자가 도착합니다.`}
          />
          <Step
            no="3"
            icon={<ShieldCheck size={17} strokeWidth={1.7} />}
            title="PIN 을 입력하면 결제됩니다"
            body="문자로 받은 링크에서 결제 PIN 을 입력하면 등록한 계좌에서 후원금이 출금됩니다. PIN 을 입력하지 않으면 결제되지 않습니다."
          />
          <Step
            no="4"
            icon={<BellRing size={17} strokeWidth={1.7} />}
            title="방송에 표시됩니다"
            body="결제가 완료된 후원만 유튜브 채팅과 방송 오버레이, 음성 안내로 전달됩니다. 결제되지 않은 메시지는 표시되지 않습니다."
          />
        </div>
      </section>

      {/* ── 최근 후원 ───────────────────────────────────────────────── */}
      <section id="recent" className="mt-8 scroll-mt-20">
        <Link href={`/c/${creator.code}/messages`} className="mb-5 flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-5 py-4 text-sm font-bold text-brand-900">
          <span>내 문자후원 · 크리에이터 답글 확인</span><span aria-hidden>→</span>
        </Link>
        <div className="flex items-end justify-between px-1">
          <h2 className="text-[16px] font-black tracking-[-0.02em] text-ink-900">최근 후원</h2>
          <span className="text-[11.5px] text-ink-400">결제 완료 건만 · 이름 일부 공개</span>
        </div>
        {donations.length === 0 ? (
          <div className="mt-3 rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-9 text-center">
            <p className="text-[13.5px] font-bold text-ink-700">아직 표시할 후원이 없습니다</p>
            <p className="mt-1 text-[12.5px] text-ink-400">첫 번째 응원 메시지를 보내보세요.</p>
          </div>
        ) : (
          <div className="mt-3 space-y-2.5">
            {donations.map((d) => (
              <div
                key={d.id}
                className="rounded-[1.5rem] border border-warm-300/70 bg-gradient-to-br from-white to-warm-50 p-4 shadow-card"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-100 text-[11px] font-black text-brand-800">
                      {(d.anonymous ? '익' : (d.displayName || '후')).slice(0, 1)}
                    </span>
                    <span className="truncate text-[13px] font-bold text-ink-900">
                      {d.anonymous ? '익명' : maskDisplayName(d.displayName)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[14px] font-extrabold tracking-tight text-brand-700">
                    {formatWon(d.amount)}
                  </span>
                </div>
                {d.message ? (
                  <p className="mt-1.5 text-[13px] leading-relaxed break-words text-ink-700">{d.message}</p>
                ) : null}
                <p className="mt-1.5 text-[11.5px] text-ink-300">{formatKst(d.paidAt, false)}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 이용 한도 · 유의 ────────────────────────────────────────── */}
      <section className="mt-8 rounded-[2rem] border border-warm-300/70 bg-gradient-to-br from-white to-warm-100 p-6 shadow-card sm:p-7">
        <p className="flex items-center gap-1.5 text-[14px] font-black tracking-[-0.02em] text-ink-900">
          <Gauge size={16} strokeWidth={1.7} className="text-brand-700" />
          이용 한도 안내
        </p>
        <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-ink-500">
          <li>1일 {formatWon(policy.donorDailyLimit)} · 1개월 {formatWon(policy.donorMonthlyLimit)}까지 후원할 수 있습니다.</li>
          <li>이 크리에이터에게는 1일 {formatWon(policy.perCreatorDailyLimit)}까지 후원할 수 있습니다.</li>
          <li>{formatNumber(policy.velocityWindowSec)}초 내 {formatNumber(policy.velocityMaxCount)}건을 넘으면 잠시 대기해야 합니다.</li>
          <li>만 19세 미만은 이용할 수 없습니다.</li>
        </ul>
      </section>

      {/* ── 신고 ────────────────────────────────────────────────────── */}
      <section
        id="help"
        className="mt-5 flex scroll-mt-20 items-start gap-3 rounded-[2rem] border border-warm-300/70 bg-white p-6 shadow-card"
      >
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warm-100 text-brand-700">
          <Flag size={17} strokeWidth={1.7} />
        </span>
        <div>
          <p className="text-[14px] font-black tracking-[-0.02em] text-ink-900">문제가 있나요</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
            부적절한 후원 유도, 결제 오류, 원치 않는 후원 노출은 고객센터로 신고해 주세요. 거래번호를 함께
            알려주시면 빠르게 확인할 수 있습니다.
          </p>
          <LinkButton href={`/c/${creator.code}/support`} variant="secondary" size="sm" className="mt-2.5">
            신고 · 문의하기
          </LinkButton>
        </div>
      </section>
    </CreatorDonateShell>
  );
}

/** 프로필 카드 안 통계 한 칸. 배경은 크림 계열로 서로 다르게 두어 세 칸이 구분된다. */
function StatTile({
  tone,
  icon,
  value,
  label,
}: {
  tone: string;
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-2xl px-2 py-4" style={{ backgroundColor: tone }}>
      {icon}
      <p className="mt-1.5 text-[14px] font-extrabold text-ink-900">{value}</p>
      <p className="text-[11px] text-ink-400">{label}</p>
    </div>
  );
}

function Step({ no, icon, title, body }: { no: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-[1.5rem] border border-warm-300/70 bg-white p-4 shadow-card">
      <span className="relative mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        {icon}
        <span className="absolute -top-1.5 -left-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[10px] font-black text-brand-400">
          {no}
        </span>
      </span>
      <div>
        <p className="text-[13.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </div>
  );
}

/**
 * 크리에이터를 찾지 못했을 때.
 *
 * 후원 페이지는 밖으로 나가는 길을 두지 않는 것이 원칙이지만, **이 화면만은 예외다.**
 * 코드가 잘못됐거나 정지된 채널이면 머무를 후원 페이지 자체가 없다. 여기서까지 길을 막으면
 * 방문자는 아무 데도 갈 수 없는 막다른 화면에 갇힌다.
 */
function NotFoundView() {
  return (
    <div className="grid min-h-dvh place-items-center bg-warm-50 px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rounded-[2rem] border border-warm-300/70 bg-white p-6 shadow-panel">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-600">
            <CircleAlert size={20} strokeWidth={1.7} />
          </span>
          <h1 className="mt-3 text-[19px] leading-snug font-extrabold tracking-tight text-ink-900">
            크리에이터를 찾을 수 없습니다.
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
            방송 화면 또는 크리에이터 프로필에 안내된 코드를 다시 확인해 주세요. 승인 전이거나 이용이 정지된
            크리에이터의 코드도 조회되지 않습니다.
          </p>
          <div className="mt-4">
            <CreatorCodeForm autoFocus />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <LinkButton href="/" variant="secondary" size="md" className="w-full">
              홈으로
            </LinkButton>
            <LinkButton href="/support" variant="secondary" size="md" className="w-full">
              고객센터
            </LinkButton>
          </div>
        </div>
        <div className="mt-5 flex justify-center opacity-70">
          <Link href="/" aria-label="도네이도 홈으로">
            <Logo compact />
          </Link>
        </div>
      </div>
    </div>
  );
}
