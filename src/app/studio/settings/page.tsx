import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Camera, Music2, Radio, ThumbsUp, Video } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, Field, Input, Notice, SectionTitle, Textarea, cx } from '@/components/ui';
import { DEFAULT_BANNERS, defaultBannerFor } from '@/lib/banners';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { DonationPageShare } from '@/components/studio/donation-page-share';
import {
  updateDonationSettingsAction,
  updateDonationPageAction,
  updateThanksMessageAction,
  updateSnsLinksAction,
} from '@/app/actions/studio';
import {
  THANKS_MT_MAX_LENGTH,
  THANKS_MT_VARIABLES,
  applyMtTemplateOverride,
  tplDonationSuccess,
} from '@/server/services/mt-templates';
import { ThanksMessageEditor } from '@/components/studio/thanks-message-editor';
import { formatMoNumber } from '@/server/emma';
import { SNS_PLATFORMS, type SnsPlatform } from '@/lib/sns-platforms';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { resolvePolicy } from '@/server/services/limits';
import { env } from '@/lib/env';
import { formatWon } from '@/lib/money';
import { moNumberStatusLabel, paymentModeLabel } from '@/lib/labels';
import { getPublicBaseUrl } from '@/server/public-base-url';

export const dynamic = 'force-dynamic';

/**
 * 플랫폼 아이콘.
 *
 * lucide 에는 브랜드 로고 아이콘이 없다(정책상 제거됐다). 프로젝트 규칙도 라인형 스트로크
 * 아이콘만 쓰므로, 플랫폼의 성격을 나타내는 일반 아이콘으로 묶는다.
 * 로고 대신 각 플랫폼의 상징색(SNS_PLATFORMS.color)으로 구분한다.
 */
const SNS_ICONS: Record<SnsPlatform, typeof Video> = {
  YOUTUBE: Video,
  INSTAGRAM: Camera,
  TIKTOK: Music2,
  FACEBOOK: ThumbsUp,
};

/**
 * 크리에이터 레코드에서 플랫폼별 값을 꺼낸다.
 *
 * 동적 키(`creator[platform.urlField]`)로 접근하면 select 로 좁혀 둔 타입이 풀려
 * 컬럼 이름 오타를 컴파일러가 잡지 못한다. 그래서 명시적으로 분기한다.
 */
function snsUrlOf(
  creator: {
    youtubeLiveUrl: string | null;
    instagramLiveUrl: string | null;
    tiktokLiveUrl: string | null;
    facebookLiveUrl: string | null;
  },
  platform: SnsPlatform,
): string {
  switch (platform) {
    case 'YOUTUBE':
      return creator.youtubeLiveUrl ?? '';
    case 'INSTAGRAM':
      return creator.instagramLiveUrl ?? '';
    case 'TIKTOK':
      return creator.tiktokLiveUrl ?? '';
    case 'FACEBOOK':
      return creator.facebookLiveUrl ?? '';
  }
}

function snsLiveOf(
  creator: {
    youtubeLive: boolean;
    instagramLive: boolean;
    tiktokLive: boolean;
    facebookLive: boolean;
  },
  platform: SnsPlatform,
): boolean {
  switch (platform) {
    case 'YOUTUBE':
      return creator.youtubeLive;
    case 'INSTAGRAM':
      return creator.instagramLive;
    case 'TIKTOK':
      return creator.tiktokLive;
    case 'FACEBOOK':
      return creator.facebookLive;
  }
}

const SETTINGS_TABS = [
  { key: 'amount', label: '후원금' },
  { key: 'thanks', label: '감사문자' },
  { key: 'sns', label: 'SNS·라이브' },
  { key: 'payment', label: '결제 모드' },
  { key: 'number', label: '문자번호' },
  { key: 'page', label: '후원페이지' },
] as const;

/** 감사 문자 미리보기 예시값. 실제 발송과 같은 템플릿 함수에 넣어 결과를 보여준다. */
const THANKS_PREVIEW = {
  donorName: '홍길동',
  creatorName: '도네이도',
  amount: 3_000n,
  message: '오늘 방송 정말 재밌었어요',
  cumulative: 12_000n,
} as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['key'];

export default async function StudioSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { creatorId } = await requireCreator();
  const requestedTab = (await searchParams).tab;
  const activeTab: SettingsTab = SETTINGS_TABS.some((tab) => tab.key === requestedTab)
    ? requestedTab as SettingsTab
    : 'amount';

  const [creator, moNumbers, policy] = await Promise.all([
    prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: {
        id: true,
        code: true,
        displayName: true,
        description: true,
        donationAmount: true,
        minAmount: true,
        maxAmount: true,
        paymentMode: true,
        thanksMtMessage: true,
        bannerUrl: true,
        liveOn: true,
        liveUrl: true,
        livePlatform: true,
        youtubeLiveUrl: true,
        instagramLiveUrl: true,
        tiktokLiveUrl: true,
        facebookLiveUrl: true,
        youtubeLive: true,
        instagramLive: true,
        tiktokLive: true,
        facebookLive: true,
      },
    }),
    prisma.creatorMoNumber.findMany({
      where: { creatorId },
      orderBy: { assignedAt: 'desc' },
      select: { id: true, phoneNumber: true, keyword: true, mode: true, status: true, assignedAt: true },
    }),
    resolvePolicy(creatorId, null),
  ]);

  if (!creator) notFound();

  const effectiveMode = creator.paymentMode ?? 'CONFIRM_LINK';
  // 설정 가능 범위 = 관리자 지정 범위 ∩ 한도 정책 범위
  const effMin = creator.minAmount > policy.minAmount ? creator.minAmount : policy.minAmount;
  const effMax = creator.maxAmount < policy.maxAmount ? creator.maxAmount : policy.maxAmount;
  const donationPageUrl = `${await getPublicBaseUrl()}/c/${creator.code}`;

  /**
   * 지금 설정으로 실제 발송되는 문장과, 설정을 비웠을 때의 기본 문장.
   *
   * **`applyMtTemplateOverride()` 를 반드시 거친다.** 이걸 빼면 최고관리자가 감사 문자 문구를
   * 바꿔 놓아도 크리에이터 화면에는 코드 기본값이 "기본 문구"로 표시되어, 화면에 보이는 문장과
   * 실제로 후원자에게 나가는 문장이 달라진다.
   * (크리에이터가 직접 설정한 경우에는 그 문구가 우선이므로 오버라이드가 적용되지 않는다)
   */
  const [thanksPreview, thanksDefaultPreview] = await Promise.all([
    applyMtTemplateOverride(
      tplDonationSuccess({
        ...THANKS_PREVIEW,
        creatorName: creator.displayName,
        custom: creator.thanksMtMessage,
      }),
    ).then((o) => o.text),
    applyMtTemplateOverride(
      tplDonationSuccess({ ...THANKS_PREVIEW, creatorName: creator.displayName }),
    ).then((o) => o.text),
  ]);

  return (
    <>
      <PageHeader title="후원 설정" description="문자 1건당 후원금과 수신번호, 후원 페이지 정보를 관리합니다." />

      <nav
        aria-label="후원 설정 메뉴"
        /**
         * 탭이 6개다. 360px 폭 휴대폰에서 6칸 그리드로 나누면 한 칸이 50px 남짓이라
         * "후원페이지" 같은 이름이 두 줄로 접히거나 잘렸다. 좁은 화면에서는 가로 스크롤로
         * 두어 글자가 온전히 보이게 하고, sm 이상에서만 6칸으로 나눠 담는다.
         */
        className="mb-5 flex snap-x snap-mandatory gap-1 overflow-x-auto rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)] [scrollbar-width:none] sm:grid sm:grid-cols-6 sm:gap-0 sm:overflow-hidden"
      >
        {SETTINGS_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/studio/settings?tab=${tab.key}`}
            aria-current={activeTab === tab.key ? 'page' : undefined}
            className={cx(
              'flex min-h-11 shrink-0 snap-start items-center justify-center rounded-xl whitespace-nowrap px-3 text-center text-[12px] font-bold transition-colors sm:shrink sm:px-3 sm:text-[13px]',
              activeTab === tab.key ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="space-y-5">
        {activeTab === 'amount' ? <section>
          <SectionTitle title="문자 1건당 후원금" description="후원자가 문자 1건을 보낼 때 결제되는 금액입니다." />
          <Card>
            <ActionForm action={updateDonationSettingsAction} submitLabel="후원금 저장">
              <Field
                label="문자 1건당 후원금 (원)"
                hint={`설정 가능 범위: ${formatWon(effMin)} ~ ${formatWon(effMax)} (관리자 정책 반영)`}
              >
                <Input
                  name="donationAmount"
                  inputMode="numeric"
                  defaultValue={creator.donationAmount.toString()}
                  className="tabular-nums"
                />
              </Field>
            </ActionForm>

            <div className="mt-4">
              <DataRow label="현재 설정 금액" value={formatWon(creator.donationAmount)} />
              <DataRow label="설정 가능 범위" value={`${formatWon(effMin)} ~ ${formatWon(effMax)}`} />
              <DataRow label="한도 정책 1건 허용 범위" value={`${formatWon(policy.minAmount)} ~ ${formatWon(policy.maxAmount)}`} />
              <DataRow label="후원자 1인 1일 한도" value={formatWon(policy.donorDailyLimit)} />
              <DataRow label="내 채널 기준 후원자 1일 한도" value={formatWon(policy.perCreatorDailyLimit)} />
            </div>
          </Card>
        </section> : null}

        {activeTab === 'thanks' ? <section>
          <SectionTitle
            title="감사 문자 내용 설정"
            description="후원 결제가 완료됐을 때 후원자에게 발송되는 문자 본문입니다."
          />
          <Card>
            <ActionForm action={updateThanksMessageAction} submitLabel="감사 문자 저장">
              <ThanksMessageEditor
                defaultBody={creator.thanksMtMessage ?? ''}
                variables={THANKS_MT_VARIABLES.map((v) => ({ token: v.token, label: v.label }))}
                maxLength={THANKS_MT_MAX_LENGTH}
                defaultPreview={thanksDefaultPreview}
              />
            </ActionForm>

            <div className="mt-5">
              <p className="text-[13px] font-bold text-ink-900">현재 저장된 상태로 발송되는 문자</p>
              <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-ink-50 px-4 py-3 text-[13px] leading-relaxed text-ink-500">
                {thanksPreview}
              </p>
              <p className="mt-1.5 text-[11.5px] text-ink-400">
                {creator.thanksMtMessage
                  ? '직접 설정한 문구가 적용되어 있습니다. 본문을 비우고 저장하면 기본 문구로 돌아갑니다.'
                  : '아직 직접 설정하지 않아 플랫폼 기본 문구가 나갑니다. 위에서 본문을 입력하면 그 문구가 우선합니다.'}
              </p>
            </div>

            <div className="mt-4">
              <Notice tone="warning" title="링크와 개인정보는 넣을 수 없습니다">
                감사 문자에 링크(http, www)나 전화번호·계좌번호를 넣으면 저장되지 않습니다. 통신사 스팸 차단으로 문자
                자체가 전달되지 않거나 후원자가 피싱으로 오인할 수 있기 때문입니다. 발신 주체 표기 [도네이도] 는 항상 문장
                앞에 자동으로 붙습니다.
              </Notice>
            </div>
          </Card>
        </section> : null}

        {activeTab === 'sns' ? <section>
          <SectionTitle
            title="SNS 링크 · 라이브"
            description="등록한 링크는 후원 페이지에 버튼으로 표시됩니다. 방송 중인 플랫폼의 스위치를 켜면 프로필이 두근거리고 ON AIR 배지가 붙습니다."
          />
          <Card>
            <ActionForm action={updateSnsLinksAction} submitLabel="SNS 링크 저장">
              <div className="space-y-3">
                {SNS_PLATFORMS.map((platform) => {
                  const Icon = SNS_ICONS[platform.value];
                  const url = snsUrlOf(creator, platform.value);
                  const live = snsLiveOf(creator, platform.value);
                  return (
                    <div key={platform.value} className="rounded-2xl border border-ink-100 bg-white p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-extrabold text-ink-900">
                          <span
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl"
                            style={{ backgroundColor: `${platform.color}14`, color: platform.color }}
                          >
                            <Icon size={16} strokeWidth={1.8} />
                          </span>
                          {platform.label}
                        </span>

                        {/*
                          플랫폼마다 스위치를 따로 둔다. 동시송출을 하는 크리에이터가 있어
                          하나만 고르게 하면 나머지 방송은 배지가 붙지 않는다.
                        */}
                        <label className="flex shrink-0 cursor-pointer items-center gap-2">
                          <span className="text-[11.5px] font-bold text-ink-500">방송중</span>
                          <input
                            type="checkbox"
                            name={platform.liveField}
                            defaultChecked={live}
                            className="peer sr-only"
                          />
                          <span className="relative h-6 w-11 rounded-full bg-ink-200 transition-colors peer-checked:bg-danger-500 after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
                        </label>
                      </div>

                      <Input
                        name={platform.urlField}
                        defaultValue={url}
                        placeholder={platform.placeholder}
                        className="mt-3"
                      />
                      <p className="mt-1.5 text-[11.5px] text-ink-400">{platform.hostHint} 주소만 사용할 수 있습니다.</p>
                    </div>
                  );
                })}
              </div>
            </ActionForm>

            <div className="mt-4">
              <Notice tone="brand" title="스위치를 켜면 후원 페이지가 이렇게 바뀝니다">
                <span className="flex items-center gap-1.5">
                  <Radio size={14} strokeWidth={1.8} className="shrink-0 text-danger-500" />
                  프로필 사진이 두근두근 움직이고, 그 아래에 <strong className="text-ink-900">ON AIR</strong> 배지가
                  붙습니다. 후원자가 배지를 누르면 그 플랫폼 링크로 이동합니다.
                </span>
                <span className="mt-2 block">
                  여러 곳에 동시송출 중이면 스위치를 여러 개 켜도 됩니다. 배지도 플랫폼마다 하나씩 표시됩니다.
                  방송이 끝나면 스위치를 꺼주세요.
                </span>
              </Notice>
            </div>
          </Card>
        </section> : null}

        {activeTab === 'payment' ? <section>
          <SectionTitle title="결제 모드" description="결제 모드는 크리에이터가 변경할 수 없습니다." />
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <CardTitle>{paymentModeLabel[effectiveMode]}</CardTitle>
              <Badge tone="neutral">읽기 전용</Badge>
            </div>
            <div className="mb-3">
              <DataRow label="확인형 (CONFIRM_LINK)" value={paymentModeLabel.CONFIRM_LINK} />
              <DataRow label="즉시형 (DIRECT_TRIGGER)" value={paymentModeLabel.DIRECT_TRIGGER} />
              <DataRow
                label="즉시형 허용 여부"
                value={
                  env.safety.allowDirectTrigger ? (
                    <Badge tone="success">플랫폼 허용</Badge>
                  ) : (
                    <Badge tone="warning">전체 비활성</Badge>
                  )
                }
              />
            </div>
            <Notice tone="warning" title="즉시형은 크리에이터가 켤 수 없습니다">
              즉시형(DIRECT_TRIGGER)은 금융사 서면승인 등록 후 통합 관리자만 활성화할 수 있습니다. 문자 수신 즉시
              출금이 일어나는 방식이므로, 서면승인 없이 사용하면 전자금융거래 관련 규정을 위반할 수 있습니다. 변경이
              필요하면 고객센터를 통해 신청해 주세요.
            </Notice>
          </Card>
        </section> : null}

        {activeTab === 'number' ? <section>
          <SectionTitle title="MO 수신번호" description="후원자가 문자를 보내는 번호입니다. 배정과 변경은 통합 관리자가 처리합니다." />
          <Card>
            {moNumbers.length === 0 ? (
              <Notice tone="warning">
                배정된 수신번호가 없습니다. 번호가 배정되기 전에는 문자후원을 받을 수 없습니다. 고객센터로 배정을
                요청해 주세요.
              </Notice>
            ) : (
              <div className="space-y-3">
                {moNumbers.map((mo) => (
                  <div key={mo.id} className="rounded-xl border border-ink-100 px-3 py-2">
                    <DataRow
                      label="수신번호"
                      value={<span className="font-mono">{formatMoNumber(mo.phoneNumber)}</span>}
                    />
                    <DataRow
                      label="수신 방식"
                      value={mo.mode === 'DEDICATED' ? '전용번호 (문자 내용만 전송)' : '대표번호 + 키워드'}
                    />
                    <DataRow label="키워드" value={mo.keyword ? <span className="font-mono">{mo.keyword}</span> : '없음'} />
                    <DataRow
                      label="상태"
                      value={<Badge tone={moNumberStatusLabel[mo.status].tone}>{moNumberStatusLabel[mo.status].text}</Badge>}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section> : null}

        {activeTab === 'page' ? <section>
          <SectionTitle
            title="후원페이지 꾸미기"
            description="시청자에게 공유하는 페이지의 배너·소개·라이브 표시를 관리합니다."
          />
          <Card>
            <div className="mb-5">
              <DonationPageShare url={donationPageUrl} creatorName={creator.displayName} />
            </div>

            <ActionForm action={updateDonationPageAction} submitLabel="후원페이지 설정 저장">
              {/* 배너 선택: 기본 5종 + 직접 입력 */}
              <div>
                <p className="text-[13px] font-bold text-ink-900">상단 배너</p>
                <p className="mt-0.5 mb-2 text-[12px] text-ink-400">
                  기본 배너 5종 중 선택하거나 직접 이미지 주소를 입력할 수 있습니다. 선택하지 않으면 기본 배너가
                  자동 적용됩니다.
                </p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {DEFAULT_BANNERS.map((b, i) => {
                    const checked = creator.bannerUrl === b || (!creator.bannerUrl && defaultBannerFor(creator.id) === b);
                    return (
                      <label key={b} className="group relative cursor-pointer">
                        <input
                          type="radio"
                          name="bannerPreset"
                          value={b}
                          defaultChecked={checked}
                          className="peer sr-only"
                        />
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={b}
                          alt={`기본 배너 ${i + 1}`}
                          className="h-16 w-full rounded-xl border-2 border-transparent object-cover transition-all peer-checked:border-brand-500 peer-checked:shadow-[0_4px_14px_rgba(237,166,0,0.35)]"
                        />
                        <span className="absolute left-1.5 top-1.5 rounded bg-ink-900/60 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          기본 {i + 1}
                        </span>
                      </label>
                    );
                  })}
                  <label className="flex cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-ink-200 text-[12.5px] font-bold text-ink-500 transition-colors has-[:checked]:border-brand-500 has-[:checked]:text-brand-700">
                    <input
                      type="radio"
                      name="bannerPreset"
                      value="custom"
                      defaultChecked={Boolean(creator.bannerUrl) && !DEFAULT_BANNERS.includes(creator.bannerUrl as (typeof DEFAULT_BANNERS)[number])}
                      className="sr-only"
                    />
                    직접 입력
                  </label>
                </div>
                <div className="mt-3">
                  <ImageUploadField
                    name="bannerUrl"
                    label="직접 입력 배너 (파일 업로드 또는 URL)"
                    aspect="wide"
                    defaultValue={
                      creator.bannerUrl && !DEFAULT_BANNERS.includes(creator.bannerUrl as (typeof DEFAULT_BANNERS)[number])
                        ? creator.bannerUrl
                        : ''
                    }
                    hint="위에서 '직접 입력'을 선택한 경우 적용됩니다. 권장 비율 3:1 이상."
                  />
                </div>
              </div>

              <Field label="크리에이터 소개" hint="후원페이지 상단 프로필 아래에 표시됩니다. 300자 이내.">
                <Textarea name="description" rows={3} maxLength={300} defaultValue={creator.description ?? ''} />
              </Field>

              <Notice tone="neutral">
                라이브 링크와 방송중 스위치는 <strong className="text-ink-900">SNS·라이브</strong> 탭으로 옮겼습니다.
                유튜브·인스타그램·틱톡·페이스북 링크를 각각 등록하고, 방송 중인 플랫폼의 스위치만 켜면 됩니다.
              </Notice>
            </ActionForm>
          </Card>
        </section> : null}
      </div>
    </>
  );
}
