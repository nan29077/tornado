import type { Metadata } from 'next';
import Link from 'next/link';
import {
  MessageSquare, CreditCard, ShieldCheck, CircleAlert,
  Gauge, Flag, Phone, BellRing, Smartphone,
} from 'lucide-react';
import { CreatorCodeForm } from '@/components/creator-code-form';
import { CopyButton } from '@/components/public/copy-button';
import { WebDonationPanel } from '@/components/public/web-donation-panel';
import { WebDonationPinPanel } from '@/components/public/web-donation-pin-panel';
import { defaultBannerFor } from '@/lib/banners';
import { maskDisplayName } from '@/components/public/mask';
import { Logo } from '@/components/brand/logo';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { LinkButton } from '@/components/ui';
import { normalizeCreatorCode } from '@/lib/id';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { formatMoNumber } from '@/server/emma/number';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { broadcastDonorName, defaultDonorName } from '@/lib/donor-name';
import { resolvePolicy } from '@/server/services/limits';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { resolveWebDonationChannel } from '@/server/services/web-donation';

export const dynamic = 'force-dynamic';

/**
 * 크리에이터 전용 후원 페이지.
 *
 * 메인 서비스(PublicShell)의 하단 탭·우측 메뉴를 쓰지 않는 완전히 독립된 페이지다.
 * 방송·프로필에 붙는 "크리에이터 자신의 링크"로 보여야 하므로
 *  - 상단은 크리에이터 아이덴티티(아바타·이름·채널)가 차지하고
 *  - 도네이도 브랜드는 하단 풋터에 서비스 표기로만 남긴다.
 *  - 모바일에서는 하단 고정 CTA(문자 보내기)가 탭바를 대신한다.
 */

type Params = { params: Promise<{ code: string }> };

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

  const [policy, donations] = await Promise.all([
    resolvePolicy(creator.id),
    prisma.donation.findMany({
      where: {
        creatorId: creator.id,
        status: { in: ['BROADCASTED', 'SETTLEMENT_PENDING', 'PARTIAL_DELIVERY_FAILED', 'SETTLED'] },
      },
      orderBy: { paidAt: 'desc' },
      take: 10,
      select: { id: true, displayName: true, amount: true, message: true, paidAt: true, anonymous: true },
    }),
  ]);

  // 허용 범위 = 플랫폼 정책 ∩ 크리에이터 설정 (결제 시 checkLimits 가 같은 교집합으로 판정한다).
  // 정책 범위만 보여 주면 본인인증까지 마친 뒤 금액 범위 오류로 거절된다.
  const effMin = creator.minAmount > policy.minAmount ? creator.minAmount : policy.minAmount;
  const effMax = creator.maxAmount < policy.maxAmount ? creator.maxAmount : policy.maxAmount;

  // 로그인한 후원자라면 방송에 어떤 이름으로 표시되는지 알려준다.
  // 비로그인 방문자에게는 아무것도 보여주지 않는다(안내할 대상이 없다).
  const viewerDonor = await currentViewerDonor();

  const route = creator.moRoutes[0] ?? null;
  const onAir = creator.liveOn && Boolean(creator.liveUrl);
  const bannerUrl = creator.bannerUrl ?? defaultBannerFor(creator.id);

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
    <div className="min-h-dvh bg-[#f7f5ef]">
      {/* ── 크리에이터 히어로 ─────────────────────────────────────────── */}
      <header className="relative isolate overflow-hidden bg-ink-900 pb-24 pt-10">
        {/* 크리에이터 배너 (미설정 시 기본 배너 5종 중 크리에이터별 고정 적용) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={bannerUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-70" />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(23,22,26,0.4)_0%,rgba(23,22,26,0.66)_70%,rgba(23,22,26,0.9)_100%)]" />
        <div className="relative mx-auto w-full max-w-[560px] px-5 text-center">
          {/* 아바타 */}
          <div className="mx-auto w-fit">
            {onAir ? (
              <a href={creator.liveUrl!} target="_blank" rel="noopener noreferrer" aria-label="라이브 방송 보기">
                <ProfileAvatar
                  seed={creator.code}
                  avatarIndex={creator.user.avatarIndex}
                  name={creator.displayName}
                  imageUrl={creator.avatarUrl}
                  className="h-24 w-24 animate-heartbeat border-2 border-danger-500"
                />
              </a>
            ) : (
              <ProfileAvatar
                seed={creator.code}
                avatarIndex={creator.user.avatarIndex}
                name={creator.displayName}
                imageUrl={creator.avatarUrl}
                className="h-24 w-24 border-2 border-brand-400/70"
              />
            )}
          </div>

          {onAir ? (
            <a
              href={creator.liveUrl!}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#e5342f] px-3.5 py-1.5 text-[11.5px] font-black tracking-[0.06em] text-white shadow-[0_6px_18px_rgba(229,52,47,0.4)] transition-transform hover:-translate-y-0.5"
            >
              <span aria-hidden className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
              </span>
              ON AIR · 라이브 보러가기
            </a>
          ) : null}

          <h1 className="mt-4 text-[26px] font-black leading-tight tracking-[-0.04em] text-white">
            {creator.displayName}
          </h1>
          {creator.channelName ? (
            <p className="mt-1 text-[13.5px] font-semibold text-white/60">{creator.channelName}</p>
          ) : null}

          {creator.description ? (
            <p className="mx-auto mt-4 max-w-[440px] whitespace-pre-line text-[13px] leading-relaxed text-white/70">
              {creator.description}
            </p>
          ) : null}
        </div>
      </header>

      {/* ── 본문 ─────────────────────────────────────────────────────── */}
      <main className="relative z-10 mx-auto w-full max-w-[560px] px-4 pb-32 sm:pb-16">
        {/* 후원 카드 (히어로에 겹침) */}
        <section className="-mt-16">
          {/*
            PC 웹 후원(내통장결제)은 MO 수신번호가 전혀 필요 없다.
            예전에는 번호 미배정 시 카드 전체를 안내문으로 갈아끼워 웹 후원까지 막았는데,
            그러면 번호를 기다리는 신규 크리에이터는 PC 후원도 하나도 받지 못했다.
            그래서 PC 패널은 번호 배정 여부와 무관하게 항상 노출하고,
            번호가 필요한 모바일 문자후원 영역만 조건부로 바꾼다.
          */}
          <div className="rounded-[26px] border border-brand-200/60 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.14)]">
            {/* PC: 텍스트 + 금액 선택 웹 후원 (내통장결제 즉시 결제 → 유튜브 댓글·오버레이) */}
            <div className="hidden sm:block">
              <p className="mb-4 text-center text-[16px] font-black tracking-[-0.02em] text-ink-900">
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
              <div className="mt-5 hidden rounded-2xl border border-brand-200/70 bg-brand-50/60 px-4 py-3.5 sm:block">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[12px] font-bold text-brand-700">
                      <Phone size={14} strokeWidth={1.8} />
                      문자 후원번호
                    </p>
                    <p className="mt-1 font-mono text-[22px] font-extrabold leading-none tracking-tight text-ink-900">
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
              <div className="sm:hidden">
              <p className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-brand-700">
                <Phone size={14} strokeWidth={1.8} />
                {creator.displayName} 전용 후원 번호
              </p>
              <p className="mt-2 text-center font-mono text-[34px] font-extrabold leading-none tracking-tight text-ink-900">
                {moNumberLabel}
              </p>
              <div className="mt-3 flex justify-center">
                <CopyButton value={route.phoneNumber} label="번호 복사" />
              </div>


              <div className="mt-5 flex items-center justify-between rounded-xl bg-ink-50 px-4 py-3">
                <span className="text-[13px] font-semibold text-ink-500">문자 1건당 후원금</span>
                <span className="text-[20px] font-extrabold tracking-tight text-brand-700">
                  {formatWon(creator.donationAmount)}
                </span>
              </div>

              <a
                href={smsHref ?? undefined}
                className="mt-4 inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[16px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] transition-colors hover:bg-brand-500 active:bg-brand-600"
              >
                <MessageSquare size={18} strokeWidth={1.7} />
                문자후원하기
              </a>
              <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-ink-400">
                문자 앱이 열리며 후원 번호가 자동 입력됩니다. 문자를 보내면 결제 PIN 입력 문자가 오고, PIN 을 입력하면{' '}
                {formatWon(creator.donationAmount)}이 등록된 내통장결제 계좌에서 결제됩니다.
              </p>
              </div>
            ) : (
              /* 번호 미배정: 문자후원 영역만 안내로 대체한다. 위 PC 웹 후원은 그대로 동작한다. */
              <div className="sm:hidden text-center">
                <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-warning-50 text-warning-500">
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
        </section>

        {/*
          방송 닉네임 안내.
          로그인한 후원자에게만 보여준다. 닉네임을 정하지 않았으면 번호 끝 4자리로
          방송에 표시된다는 사실을 알려주고, 정했으면 지금 이름을 확인시켜 준다.
        */}
        {viewerDonor ? (
          <section className="mt-6">
            <div className="rounded-2xl border border-brand-200/70 bg-brand-50 px-4 py-3.5">
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
                href="/my/account#nickname"
                className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-brand-700 underline underline-offset-2"
              >
                닉네임 {viewerDonor.displayName ? '변경하기' : '설정하기'}
              </Link>
            </div>
          </section>
        ) : null}

        {/* 첫 문자 안내 (모바일 문자후원) */}
        <section className="mt-6 sm:hidden">
          <div className="rounded-2xl border border-warning-500/30 bg-warning-50 px-4 py-3.5">
            <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
              <CircleAlert size={15} strokeWidth={1.8} className="shrink-0 text-warning-500" />
              처음 보내는 문자는 후원되지 않습니다
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
              최초 문자는 계좌 등록 안내만 발송됩니다. 안내 문자의 링크에서 계좌 등록과 이용 동의를 마친 뒤 다시
              문자를 보내주세요.
            </p>
          </div>
        </section>

        {/* 후원 방법 — PC(웹 후원) */}
        <section className="mt-8 hidden sm:block">
          <h2 className="px-1 text-[15px] font-black tracking-[-0.02em] text-ink-900">후원 방법</h2>
          <div className="mt-2.5 space-y-2.5">
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
        </section>

        {/* 후원 방법 — 모바일(문자후원) */}
        <section className="mt-8 sm:hidden">
          <h2 className="px-1 text-[15px] font-black tracking-[-0.02em] text-ink-900">후원 방법</h2>
          <div className="mt-2.5 space-y-2.5">
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

        {/* 최근 후원 */}
        <section className="mt-8">
          <div className="flex items-end justify-between px-1">
            <h2 className="text-[15px] font-black tracking-[-0.02em] text-ink-900">최근 후원</h2>
            <span className="text-[11.5px] text-ink-400">결제 완료 건만 · 이름 일부 공개</span>
          </div>
          {donations.length === 0 ? (
            <div className="mt-2.5 rounded-2xl border border-dashed border-ink-200 bg-white/60 px-5 py-8 text-center">
              <p className="text-[13.5px] font-bold text-ink-700">아직 표시할 후원이 없습니다</p>
              <p className="mt-1 text-[12.5px] text-ink-400">첫 번째 응원 메시지를 보내보세요.</p>
            </div>
          ) : (
            <div className="mt-2.5 space-y-2">
              {donations.map((d) => (
                <div key={d.id} className="rounded-2xl border border-ink-100 bg-white p-4">
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
                    <p className="mt-1.5 break-words text-[13px] leading-relaxed text-ink-700">{d.message}</p>
                  ) : null}
                  <p className="mt-1.5 text-[11.5px] text-ink-300">{formatKst(d.paidAt, false)}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 이용 한도 · 유의 */}
        <section className="mt-8">
          <div className="rounded-2xl border border-ink-100 bg-white p-5">
            <p className="flex items-center gap-1.5 text-[13.5px] font-bold text-ink-900">
              <Gauge size={16} strokeWidth={1.7} className="text-brand-700" />
              이용 한도 안내
            </p>
            <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-500">
              <li>1일 {formatWon(policy.donorDailyLimit)} · 1개월 {formatWon(policy.donorMonthlyLimit)}까지 후원할 수 있습니다.</li>
              <li>이 크리에이터에게는 1일 {formatWon(policy.perCreatorDailyLimit)}까지 후원할 수 있습니다.</li>
              <li>{formatNumber(policy.velocityWindowSec)}초 내 {formatNumber(policy.velocityMaxCount)}건을 넘으면 잠시 대기해야 합니다.</li>
              <li>만 19세 미만은 이용할 수 없습니다.</li>
            </ul>
          </div>
        </section>

        {/* 신고 */}
        <section className="mt-4">
          <div className="flex items-start gap-3 rounded-2xl border border-ink-100 bg-white p-5">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Flag size={17} strokeWidth={1.7} />
            </span>
            <div>
              <p className="text-[13.5px] font-bold text-ink-900">문제가 있나요</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                부적절한 후원 유도, 결제 오류, 원치 않는 후원 노출은 고객센터로 신고해 주세요. 거래번호를 함께
                알려주시면 빠르게 확인할 수 있습니다.
              </p>
              <LinkButton href="/support" variant="secondary" size="sm" className="mt-2.5">
                신고 · 문의하기
              </LinkButton>
            </div>
          </div>
        </section>

        {/* 서비스 풋터 */}
        <footer className="mt-10 border-t border-ink-100 pt-6 text-center">
          <p className="text-[11.5px] leading-relaxed text-ink-400">
            이 페이지는 <span className="font-bold text-ink-500">도네이도 문자후원</span>으로 운영됩니다.
            <br />
            유튜브 공식 슈퍼챗이 아닌 외부 후원 서비스입니다.
          </p>
          <div className="mt-3 flex items-center justify-center gap-4 text-[12px] font-semibold text-ink-400">
            <Link href="/how-it-works" className="transition-colors hover:text-ink-900">이용방법</Link>
            <span aria-hidden className="h-3 w-px bg-ink-200" />
            <Link href="/support" className="transition-colors hover:text-ink-900">고객센터</Link>
            <span aria-hidden className="h-3 w-px bg-ink-200" />
            <Link href="/" className="transition-colors hover:text-ink-900">도네이도 홈</Link>
          </div>
        </footer>
      </main>

      {/* ── 모바일 하단 고정 CTA (문자후원하기) ─────────────────────── */}
      {smsHref && route ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-100 bg-white/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur-xl sm:hidden">
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
      ) : null}

    </div>
  );
}

function Step({ no, icon, title, body }: { no: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-ink-100 bg-white p-4">
      <span className="relative mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        {icon}
        <span className="absolute -left-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[10px] font-black text-brand-400">
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

function NotFoundView() {
  return (
    <div className="grid min-h-dvh place-items-center bg-[#f7f5ef] px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rounded-[26px] border border-ink-100 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.1)]">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-500">
            <CircleAlert size={20} strokeWidth={1.7} />
          </span>
          <h1 className="mt-3 text-[19px] font-extrabold leading-snug tracking-tight text-ink-900">
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
