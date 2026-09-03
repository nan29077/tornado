import { ChevronDown, ExternalLink } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, Field, Input, LinkButton, Notice, SectionTitle, Textarea } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { CopyField } from '@/components/studio/copy';
import { OverlayTiersEditor } from '@/components/studio/overlay-tiers-editor';
import { OverlayQuickSettings } from '@/components/studio/overlay-quick-settings';
import { BroadcastPreview } from '@/components/studio/broadcast-preview';
import { OverlayTestHistory, type OverlayTestHistoryRow } from '@/components/studio/overlay-test-history';
import { OverlayTabs } from '@/components/studio/overlay-tabs';
import { GameStudio } from '@/components/studio/game-studio';
import {
  regenerateOverlayTokenAction,
  testOverlayAction,
} from '@/app/actions/studio';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { deliveryStatusLabel } from '@/lib/labels';
import { findCharacterSticker } from '@/lib/overlay-effect-catalog';
import { listOverlayTiers } from '@/server/services/overlay-tiers';
import { countOverlayConnections, MAX_OVERLAY_CONNECTIONS } from '@/server/services/overlay-connections';
import { findActiveRound } from '@/server/services/game-state';
import { clampOverlayLayout } from '@/lib/overlay-layout';

export const dynamic = 'force-dynamic';

/** 테스트 전송 내역에 보여 줄 최근 건수 */
const TEST_HISTORY_SIZE = 20;

/** 파티클 효과 이름. 캐릭터 스티커는 카탈로그의 라벨을 그대로 쓴다. */
const EFFECT_LABELS: Record<string, string> = {
  DEFAULT: '기본',
  NONE: '없음',
  HEART: '하트',
  STAR: '별',
  COIN: '코인',
  FIREWORK: '폭죽',
  CONFETTI: '꽃가루',
};

function effectLabel(effect: string): string {
  return EFFECT_LABELS[effect.toUpperCase()] ?? findCharacterSticker(effect)?.label ?? effect;
}

/**
 * OverlayEvent.payload 는 Json 이라 타입이 보장되지 않는다.
 * 예전 형식(효과 값이 sticker 에만 있는 이벤트)도 그대로 읽히도록 방어적으로 꺼낸다.
 */
function readTestPayload(payload: unknown): { donorName: string; amount: string; effect: string; tierLabel: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rawAmount = typeof p.amount === 'string' ? p.amount : '';
  const rawEffect =
    (typeof p.effect === 'string' && p.effect) || (typeof p.sticker === 'string' && p.sticker) || 'DEFAULT';
  return {
    donorName: typeof p.donorName === 'string' && p.donorName ? p.donorName : '-',
    amount: /^\d+$/.test(rawAmount) ? formatWon(BigInt(rawAmount)) : '-',
    effect: effectLabel(rawEffect),
    tierLabel: typeof p.tierLabel === 'string' ? p.tierLabel : '',
  };
}

type Search = Record<string, string | string[] | undefined>;

export default async function StudioOverlayPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: 'donation' | 'game' = rawTab === 'game' ? 'game' : 'donation';
  const [setting, ttsSetting, tiers, testEvents] = await Promise.all([
    prisma.overlaySetting.findUnique({ where: { creatorId } }),
    prisma.ttsSetting.findUnique({ where: { creatorId } }),
    listOverlayTiers(creatorId),
    // 테스트 전송 기록은 overlay_event 에만 남는다. donation 과는 무관하다.
    prisma.overlayEvent.findMany({
      where: { creatorId, isTest: true },
      orderBy: { createdAt: 'desc' },
      take: TEST_HISTORY_SIZE,
      select: { id: true, createdAt: true, status: true, payload: true },
    }),
  ]);

  const testHistory: OverlayTestHistoryRow[] = testEvents.map((e) => {
    const { donorName, amount, effect, tierLabel } = readTestPayload(e.payload);
    const status = deliveryStatusLabel[e.status];
    return {
      id: e.id,
      sentAt: formatKst(e.createdAt),
      donorName,
      amount,
      effect,
      tierLabel,
      statusText: status.text,
      statusTone: status.tone,
    };
  });

  // BigInt 는 클라이언트 컴포넌트로 넘길 수 없으므로 숫자로 바꿔 전달한다.
  const tierInputs = tiers.map((t) => ({
    minAmount: Number(t.minAmount),
    label: t.label,
    effect: t.effect,
    banner: t.banner,
    durationMs: t.durationMs,
    ttsEnabled: t.ttsEnabled,
    ttsVoice: t.ttsVoice,
    ttsSpeed: t.ttsSpeed,
    ttsPitch: t.ttsPitch,
  }));

  // OBS 브라우저 소스가 실제로 붙어 있는지 크리에이터가 확인할 수 있게 현재 연결 수를 보여 준다.
  // (이 서버 인스턴스 기준. 다중 인스턴스 배포에서는 인스턴스별 수치다)
  const donationConnections = countOverlayConnections(creatorId, 'broadcast', 'donation');
  const gameConnections = countOverlayConnections(creatorId, 'broadcast', 'game');
  const liveConnections = donationConnections + gameConnections;

  // 게임이 방송 화면에 떠 있으면 탭 라벨에 상태 점을 찍는다(다른 탭에 있어도 알 수 있게).
  const activeRound = await findActiveRound(creatorId);

  const urlBase = `${env.baseUrl}/overlay/${creatorId}?token=`;
  const gameUrlBase = `${env.baseUrl}/overlay/${creatorId}/game?token=`;

  return (
    <>
      <PageHeader title="후원·게임 오버레이" description="OBS·PRISM 브라우저 소스를 관리합니다. 후원 알림과 시청자 참여 게임을 각각 방송 화면에 올릴 수 있습니다." />

      <div className="space-y-6">
        {/*
          ── 1. 방송 준비 ────────────────────────────────────
          연결 주소 발급·등록은 보통 처음 한 번이다. 매 방송 쓰는 것은 아래 [방송 화면]과
          [테스트]·[게임 진행]이므로, 준비가 끝나면 접어 두고 한 줄 요약만 남긴다.
        */}
        <section>
          <details className="group rounded-2xl border border-ink-100 bg-white" open={!setting}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">
                <span className="block text-[14px] font-bold text-ink-900">
                  방송 준비 — 방송 프로그램(OBS·PRISM) 연결
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-400">
                  {setting ? (
                    <Badge tone="success">연결 주소 발급됨</Badge>
                  ) : (
                    <Badge tone="warning">연결 주소 미발급</Badge>
                  )}
                  <span>
                    지금 방송에 붙어 있는 소스 {liveConnections}개 (후원 {donationConnections} · 게임 {gameConnections})
                  </span>
                </span>
              </span>
              <ChevronDown
                size={18}
                strokeWidth={1.7}
                className="shrink-0 text-ink-400 transition-transform group-open:rotate-180"
              />
            </summary>

            <div className="border-t border-ink-100 px-4 py-4">
              <p className="mb-3 text-[12.5px] leading-relaxed text-ink-500">
                OBS 또는 PRISM 에서 [소스 추가] → [브라우저]를 선택하고 아래 주소를 붙여넣습니다. 후원 알림과 게임은
                소스를 나눠 등록하면 크기와 위치를 따로 잡을 수 있습니다. (권장 크기 1920x1080)
              </p>
          <div className="grid gap-2.5 lg:grid-cols-2">
            <Card>
              <CardTitle>방송 프로그램 연결 주소</CardTitle>
              <div className="mt-2">
                <DataRow
                  label="발급 상태"
                  value={setting ? <Badge tone="success">발급됨</Badge> : <Badge tone="warning">미발급</Badge>}
                />
                <DataRow
                  label="토큰(마스킹)"
                  value={<span className="font-mono text-[12px]">{setting?.tokenMasked ?? '-'}</span>}
                />
                <DataRow label="마지막 변경" value={formatKst(setting?.updatedAt)} />
                <DataRow
                  label="전체 방송 연결"
                  value={
                    liveConnections > 0 ? (
                      <Badge tone="success">{liveConnections}개 연결됨</Badge>
                    ) : (
                      <Badge tone="neutral">연결 없음</Badge>
                    )
                  }
                />
                <DataRow
                  label="후원 오버레이"
                  value={
                    donationConnections > 0 ? (
                      <Badge tone="success">{donationConnections}개 연결됨</Badge>
                    ) : (
                      <Badge tone="neutral">연결 없음</Badge>
                    )
                  }
                />
                <DataRow
                  label="게임 오버레이"
                  value={
                    gameConnections > 0 ? (
                      <Badge tone="success">{gameConnections}개 연결됨</Badge>
                    ) : (
                      <Badge tone="neutral">연결 없음</Badge>
                    )
                  }
                />
              </div>
              <div className="mt-3 space-y-3">
                <CopyField
                  label="후원 알림 연결 주소"
                  value={`${urlBase}<발급된 토큰>`}
                  hint="후원이 들어올 때 감사 애니메이션이 뜨는 소스입니다."
                />
                <CopyField
                  label="게임 연결 주소"
                  value={`${gameUrlBase}<발급된 토큰>`}
                  hint="시청자 참여 게임이 뜨는 소스입니다. 토큰은 위와 같은 값을 씁니다. 게임을 쓰지 않는다면 등록하지 않아도 됩니다."
                />
                <p className="text-[12px] leading-relaxed text-ink-400">
                  토큰은 해시로만 저장되어 원문을 다시 확인할 수 없습니다. 전체 URL은 발급 직후 한 번만 표시되니
                  그때 복사해 두세요. 소스를 두 개로 나누면 게임은 화면 가운데 크게, 후원 알림은 아래쪽에 작게
                  배치할 수 있고 게임만 잠시 숨기는 것도 됩니다.
                </p>
                <p className="text-[12px] leading-relaxed text-ink-400">
                  OBS · PRISM 에서 브라우저 소스를 열어 두면 위 [현재 연결] 수치가 올라갑니다. 아래 미리보기 창은
                  이 수치에 포함되지 않습니다. 방송용 브라우저 소스는 최대 {MAX_OVERLAY_CONNECTIONS}개까지 동시에
                  열 수 있고, 넘으면 가장 오래된 방송용 연결부터 자동으로 정리됩니다. 방송 중 연결이 끊겼다가 다시
                  붙으면 끊긴 사이의 후원 알림(최근 5분 이내)을 자동으로 다시 받아 재생합니다.
                </p>
                <LinkButton
                  href={`/overlay/${creatorId}?preview=1&debug=1`}
                  target="_blank"
                  variant="secondary"
                  size="sm"
                >
                  <ExternalLink size={15} strokeWidth={1.7} />
                  새 탭에서 미리보기
                </LinkButton>
              </div>
            </Card>

            <Card>
              <CardTitle>{setting ? '연결 주소 재발급' : '연결 주소 발급'}</CardTitle>
              <div className="mb-3 mt-2">
                {setting ? (
                  <Notice tone="danger" title="재발급하면 기존 URL이 즉시 무효화됩니다">
                    방송 프로그램에 등록된 기존 브라우저 소스는 더 이상 동작하지 않습니다. 재발급 후 표시되는 새 URL을
                    OBS·PRISM에 다시 등록해 주세요. 새 URL은 발급 직후 이 화면에서 한 번만 표시됩니다.
                  </Notice>
                ) : (
                  <Notice tone="brand" title="먼저 URL을 발급해 주세요">
                    발급 버튼을 누르면 OBS에 붙여넣을 전체 주소가 표시됩니다. 이 값은 한 번만 표시되니 바로 복사해
                    두세요.
                  </Notice>
                )}
              </div>
              <ActionForm
                action={regenerateOverlayTokenAction}
                submitLabel={setting ? '연결 주소 재발급' : '연결 주소 발급'}
                variant={setting ? 'danger' : 'primary'}
                size="md"
                confirmTitle={setting ? '연결 주소를 다시 발급할까요?' : '연결 주소를 발급할까요?'}
                confirmMessage={
                  setting
                    ? '기존 URL이 즉시 무효화되어 OBS·PRISM에 등록된 브라우저 소스가 동작하지 않습니다. 새 URL을 다시 등록해야 합니다.'
                    : 'OBS·PRISM에 붙여넣을 전체 URL이 발급됩니다. 발급 직후 한 번만 표시되니 바로 복사해 주세요.'
                }
                confirmActionLabel={setting ? '재발급' : '발급'}
                doneTitle={setting ? 'URL을 다시 발급했습니다' : 'URL을 발급했습니다'}
              />
            </Card>
          </div>

          <details className="group mt-2.5 rounded-2xl border border-ink-100 bg-white">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-[14px] font-bold text-ink-900">자세한 등록 방법</span>
                <span className="block text-[12px] text-ink-400">OBS · PRISM 브라우저 소스 추가 순서</span>
              </span>
              <ChevronDown size={18} strokeWidth={1.7} className="text-ink-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-ink-100 px-4 py-4">
              <ol className="space-y-2 text-[13px] leading-relaxed text-ink-700">
                <li>1. 방송 프로그램의 소스 목록에서 [+] 를 눌러 브라우저(Browser) 소스를 추가합니다.</li>
                <li>2. URL 칸에 위에서 발급한 연결 주소를 그대로 붙여넣습니다.</li>
                <li>3. 너비 1920, 높이 1080 으로 설정합니다. (권장 해상도 1920x1080)</li>
                <li>4. 사용자 정의 CSS는 비워 두세요. 오버레이가 자체적으로 투명 배경을 사용합니다.</li>
                <li>5. &quot;장면이 활성화될 때 브라우저 새로 고침&quot; 옵션을 켜면 방송 시작 시 연결이 안정적입니다.</li>
                <li>6. 소스를 화면 맨 위 레이어로 올려 다른 소스에 가려지지 않게 배치합니다.</li>
              </ol>
              <div className="mt-3">
                <Notice tone="neutral">
                  URL이 유출되면 제3자가 후원 알림 내용을 볼 수 있습니다. 방송 화면 공유·원격 지원 중에는 URL이
                  노출되지 않도록 주의하고, 노출이 의심되면 즉시 재발급해 주세요.
                </Notice>
              </div>
            </div>
          </details>
            </div>
          </details>
        </section>

        {/*
          ── 2·3. 방송 화면 + 조작 ────────────────────────────
          넓은 화면(1280px↑)에서는 **왼쪽 = 방송 화면(화면에 고정), 오른쪽 = 탭·조작**으로 나눈다.
          세로로 한 줄이면 조작하려고 내리는 순간 방송 화면이 위로 사라지고, 화면을 보려고
          올리면 조작이 아래로 사라진다. [참여 마감] → 화면 확인 → [발표] 는 눈과 손이 동시에
          필요한 동작이라 그 사이에 스크롤이 끼면 안 된다.
          좁은 화면에서는 위아래로 쌓되, 방송 화면이 시야에서 벗어나면 작은 창으로 따라다닌다
          (BroadcastPreview 안에서 처리).
        */}
        <div className="gap-5 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,600px)] xl:items-start">
          {setting ? (
            <section
              id="broadcast-preview"
              className="mb-6 scroll-mt-20 xl:sticky xl:top-[calc(var(--console-header-h)+0.75rem)] xl:mb-0 xl:max-h-[calc(100dvh-var(--console-header-h)-1.5rem)] xl:overflow-y-auto xl:pb-2"
            >
              <SectionTitle
                title="방송 화면"
                description="후원 알림과 게임이 실제로 겹쳐 보이는 모습입니다. [테스트 후원 보내기]나 게임 [방송에 시작]을 누르면 이 화면에서 바로 재생됩니다. [배치 조정]으로 위치와 크기도 여기서 바로 잡을 수 있습니다."
              />
              <Card>
                <BroadcastPreview
                  creatorId={creatorId}
                  donationLayout={clampOverlayLayout(setting)}
                  gameLayout={clampOverlayLayout({
                    offsetX: setting.gameOffsetX,
                    offsetY: setting.gameOffsetY,
                    scalePct: setting.gameScalePct,
                  })}
                />
              </Card>
            </section>
          ) : (
            <div className="hidden xl:block" />
          )}

          <div className="min-w-0">
        {/*
          ── 탭 ─────────────────────────────────────────────
          탭 바는 화면에 붙으므로 space-y 바깥에 둔다. 사이 간격을 space-y 로 주면 그 틈으로
          스크롤되는 내용이 비쳐 보인다. 간격은 탭 바 자신의 아래 여백(pb-4)으로 만든다.
        */}
        <OverlayTabs active={tab} gameLive={Boolean(activeRound)} />

        <div className="space-y-6">
        {tab === 'game' ? (
          <GameStudio creatorId={creatorId} />
        ) : (
          <>
        {/* ── 4. 알림 꾸미기 (효과 · 테마 · TTS) ───────────────── */}
        <section>
          {setting ? (
            <OverlayQuickSettings
              setting={{
                enabled: setting.enabled,
                showAmount: setting.showAmount,
                showMessage: setting.showMessage,
                anonymize: setting.anonymize,
                maxMessageLen: setting.maxMessageLen,
                durationMs: setting.durationMs,
                position: setting.position,
                theme: setting.theme,
                stickerSet: setting.stickerSet,
                soundEnabled: setting.soundEnabled,
                soundVolume: setting.soundVolume,
              }}
              tts={
                ttsSetting
                  ? {
                      enabled: ttsSetting.enabled,
                      voice: ttsSetting.voice,
                      speed: ttsSetting.speed,
                      provider: ttsSetting.provider,
                      // 인증 정보 원문은 어떤 경로로도 화면에 내려보내지 않는다.
                      naverClientIdMasked: ttsSetting.naverClientIdMasked,
                      hasNaverKey: Boolean(ttsSetting.naverClientIdEnc && ttsSetting.naverClientSecretEnc),
                    }
                  : null
              }
            />
          ) : (
            <>
              <SectionTitle title="알림 꾸미기" description="효과 · 테마 · TTS 를 설정합니다." />
              <Notice tone="warning">
                오버레이 설정이 아직 없습니다. 위 [방송 준비]에서 연결 주소를 먼저 발급해 주세요.
              </Notice>
            </>
          )}
        </section>

        {/* ── 5. 고급 설정 (금액 구간별 효과) ─────────────────── */}
        <section>
          <details className="group rounded-2xl border border-ink-100 bg-white">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-[14px] font-bold text-ink-900">고급 설정 — 금액 구간별 효과</span>
                <span className="block text-[12px] text-ink-400">
                  금액대별로 다른 효과 · 배너 · TTS 를 적용하려면 여기서 설정하세요.
                </span>
              </span>
              <ChevronDown size={18} strokeWidth={1.7} className="text-ink-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-ink-100 px-4 py-4">
              <p className="mb-3 text-[12.5px] leading-relaxed text-ink-500">
                후원 금액에 따라 스티커 효과, 배너, TTS 를 다르게 재생합니다. 설정을 바꾼 뒤에는 [구간 저장]을 눌러야
                미리보기와 실제 방송에 반영됩니다.
              </p>
              <OverlayTiersEditor creatorId={creatorId} initialTiers={tierInputs} />
            </div>
          </details>
        </section>

        {/* ── 6. 테스트 ───────────────────────────────────────── */}
        <section>
          <SectionTitle title="테스트 후원 실행" description="설정한 화면을 실제 방송 전에 확인해 보세요." />
          <Card>
            <div className="mb-3 space-y-2.5">
              <Notice tone="brand" title="테스트 후원은 결제·정산에 반영되지 않습니다">
                다만 <strong>방송용 브라우저 소스가 연결돼 있으면 실제 방송 화면에도 그대로 표시됩니다.</strong>{' '}
                시청자에게 보이지 않게 확인하려면 방송을 시작하기 전이나 오버레이 소스를 잠시 숨긴 상태에서 눌러 주세요.
                {liveConnections > 0 ? (
                  <span className="mt-1 block font-bold text-danger-500">
                    지금 방송용 소스 {liveConnections}개가 연결돼 있습니다. 방송 중이라면 시청자에게도 보입니다.
                  </span>
                ) : null}
              </Notice>
              {setting && !setting.enabled ? (
                <Notice tone="warning" title="후원 알림이 방송 화면에 보이지 않는 상태입니다">
                  위 [방송 화면] 미리보기에는 재생되지만, OBS·PRISM 에는 아무것도 표시되지 않습니다. [알림 꾸미기]에서
                  [방송 화면에 보이기]를 켜 주세요.
                </Notice>
              ) : null}
            </div>

            {setting ? null : (
              <div className="mb-4">
                <Notice tone="warning" title="연결 주소를 먼저 발급해 주세요">
                  위 [방송 준비]에서 연결 주소를 발급하면, 화면 위쪽 [방송 화면]에서 실제 방송에 표시되는 모습을 그대로
                  확인할 수 있습니다.
                </Notice>
              </div>
            )}

            {/*
              확인창을 두지 않는다. 테스트 후원은 되돌릴 필요가 없는 동작인데,
              완료 알림창이 화면 전체를 덮는 동안 7초짜리 효과가 그대로 지나가 버려
              "눌러도 아무것도 안 나온다" 가 된다. 결과는 위 미리보기에서 바로 보이고,
              실패하면 폼 아래에 문구가 뜬다.
            */}
            <ActionForm
              action={testOverlayAction}
              submitLabel="테스트 후원 보내기"
              pendingLabel="보내는 중"
              variant="secondary"
              scrollToId="broadcast-preview"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="표시명" hint="20자 이내">
                  <Input name="donorName" defaultValue="테스트 후원자" maxLength={20} />
                </Field>
                <Field label="금액 (원)" hint="100원 ~ 1,000,000원">
                  <Input name="amount" inputMode="numeric" defaultValue="3000" className="tabular-nums" />
                </Field>
              </div>
              <Field label="메시지">
                <Textarea name="message" rows={2} maxLength={200} defaultValue="오늘 방송 재미있어요" />
              </Field>
            </ActionForm>
          </Card>
        </section>

        {/* ── 7. 테스트 전송 내역 ─────────────────────────────── */}
        <section>
          <SectionTitle
            title="테스트 전송 내역"
            description={`최근 테스트 전송 ${TEST_HISTORY_SIZE}건입니다. 후원 내역·매출·정산과는 완전히 분리된 기록입니다.`}
          />
          <Card>
            <OverlayTestHistory rows={testHistory} />
          </Card>
        </section>
          </>
        )}
        </div>
          </div>
        </div>
      </div>
    </>
  );
}
