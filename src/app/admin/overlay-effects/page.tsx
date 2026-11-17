import Image from 'next/image';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Notice, SectionTitle, StatTile } from '@/components/ui';
import { TableCards } from '@/components/ui/table-cards';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { resetOverlayLadderAction, updateOverlayLadder } from '@/app/actions/admin/broadcast';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { getOverlayLadderView } from '@/server/services/overlay-ladder';
import { DONAIDO_CHARACTER_STICKERS, findCharacterSticker, overlayEffectLabel } from '@/lib/overlay-effect-catalog';
import {
  LADDER_LIMITS,
  OVERLAY_LEVELS,
  OVERLAY_LEVEL_LABEL,
  ladderRangeText,
} from '@/lib/overlay-ladder';

export const dynamic = 'force-dynamic';

/**
 * 후원 연출 기준 (통합 관리자 · 2026-11-12).
 *
 * 자동 방식을 쓰는 모든 크리에이터에게 적용되는 값이다.
 *  - 연출 단계(1~5)가 시작되는 금액, 단계별 효과와 표시 시간
 *  - 연속 후원 단계 상승 규칙
 * 수정은 최고관리자만 할 수 있고, 다른 등급은 조회만 한다.
 */

const EFFECT_OPTIONS: { value: string; label: string }[] = [
  ...['HEART', 'STAR', 'FIREWORK', 'CONFETTI', 'COIN'].map((v) => ({ value: v, label: overlayEffectLabel(v) })),
  ...DONAIDO_CHARACTER_STICKERS.map((s) => ({ value: s.value as string, label: `캐릭터 · ${s.label}` })),
];

export default async function AdminOverlayEffectsPage() {
  // 레이아웃 가드에만 기대지 않는다(레이아웃과 페이지는 병렬로 렌더된다).
  const admin = await requireAdminPage('/admin/overlay-effects');
  const isSuper = admin.adminPermission === 'SUPER_ADMIN';
  const denyReason = isSuper ? undefined : '후원 연출 기준은 최고관리자만 수정할 수 있습니다.';

  const [view, modeCounts] = await Promise.all([
    getOverlayLadderView(),
    prisma.creatorProfile.groupBy({
      by: ['overlayTierMode'],
      where: { status: 'APPROVED' },
      _count: { _all: true },
    }),
  ]);
  const { ladder } = view;
  const countOf = (mode: string) => modeCounts.find((m) => m.overlayTierMode === mode)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="후원 연출 기준"
        description="후원 금액에 따라 방송 화면 연출이 몇 단계로 나올지 정합니다. 자동 방식을 쓰는 모든 크리에이터에게 적용되며, 저장하면 다음 후원부터 반영됩니다."
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="자동 방식" value={`${formatNumber(countOf('AUTO'))}명`} sub="이 기준이 적용됩니다" tone="brand" />
          <StatTile label="직접 설정" value={`${formatNumber(countOf('CUSTOM'))}명`} sub="크리에이터가 만든 구간 사용" />
          <StatTile label="끄기" value={`${formatNumber(countOf('OFF'))}명`} sub="금액과 무관하게 같은 효과" />
          <StatTile
            label="기준 상태"
            value={view.configured ? '직접 설정됨' : '기본값 사용 중'}
            sub={view.updatedAt ? `마지막 수정 ${formatKst(view.updatedAt)}` : undefined}
            tone={view.configured ? 'success' : 'neutral'}
          />
        </div>

        {!isSuper ? <Notice tone="warning">{denyReason} 지금 화면은 조회 전용입니다.</Notice> : null}

        <section>
          <SectionTitle title="현재 적용 중인 구간" description="경계 금액은 위 단계에 포함됩니다 (예: 2단계 시작 금액과 같은 금액은 2단계)." />
          <Card>
            <TableCards className="donaido-table-cards overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead className="text-ink-500">
                  <tr>
                    <th className="py-1.5 pr-3 font-semibold">단계</th>
                    <th className="py-1.5 pr-3 font-semibold">후원 금액</th>
                    <th className="py-1.5 pr-3 font-semibold">효과</th>
                    <th className="py-1.5 text-right font-semibold">표시 시간</th>
                  </tr>
                </thead>
                <tbody>
                  {OVERLAY_LEVELS.map((lv) => {
                    const spec = ladder.levels[lv - 1]!;
                    const sticker = findCharacterSticker(spec.effect);
                    return (
                      <tr key={lv} className="border-t border-ink-100">
                        <td className="whitespace-nowrap py-2 pr-3 font-semibold text-ink-900">
                          {lv}단계 · {OVERLAY_LEVEL_LABEL[lv]}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-700">{ladderRangeText(ladder, lv)}</td>
                        <td className="py-2 pr-3 text-ink-700">
                          <div className="flex items-center gap-2">
                            {sticker ? (
                              <Image src={sticker.image} alt="" width={48} height={48} unoptimized className="shrink-0" />
                            ) : null}
                            <span>{overlayEffectLabel(spec.effect)}</span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-2 text-right tabular-nums text-ink-700">
                          {(spec.durationMs / 1000).toLocaleString('ko-KR')}초
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableCards>
          </Card>
        </section>

        <section>
          <SectionTitle
            title="기준 수정"
            description="시작 금액은 1단계부터 5단계까지 반드시 커져야 합니다. 1단계 시작 금액보다 작은 후원도 1단계로 재생됩니다."
          />
          <Card>
            <ActionForm
              action={updateOverlayLadder}
              submitLabel="기준 저장"
              confirm="후원 연출 기준을 저장할까요? 자동 방식을 쓰는 모든 크리에이터의 다음 후원부터 적용됩니다."
              disabledReason={denyReason}
            >
              <div className="space-y-3">
                {OVERLAY_LEVELS.map((lv) => {
                  const spec = ladder.levels[lv - 1]!;
                  return (
                    <div key={lv} className="rounded-xl border border-ink-100 p-3">
                      <p className="mb-2 text-[13px] font-bold text-ink-900">
                        {lv}단계 · {OVERLAY_LEVEL_LABEL[lv]}
                      </p>
                      <div className="grid gap-2.5 sm:grid-cols-3">
                        <AdminField label="시작 금액 (원)" hint="이 금액 이상부터 이 단계">
                          <AdminInput
                            name={`minAmount${lv}`}
                            inputMode="numeric"
                            className="tabular-nums"
                            defaultValue={String(spec.minAmount)}
                            required
                          />
                        </AdminField>
                        <AdminField label="효과">
                          <AdminSelect name={`effect${lv}`} defaultValue={spec.effect}>
                            {EFFECT_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </AdminSelect>
                        </AdminField>
                        <AdminField
                          label="표시 시간 (ms)"
                          hint={`${formatNumber(LADDER_LIMITS.minDurationMs)} ~ ${formatNumber(LADDER_LIMITS.maxDurationMs)}`}
                        >
                          <AdminInput
                            name={`durationMs${lv}`}
                            type="number"
                            min={LADDER_LIMITS.minDurationMs}
                            max={LADDER_LIMITS.maxDurationMs}
                            step={500}
                            defaultValue={String(spec.durationMs)}
                            required
                          />
                        </AdminField>
                      </div>
                    </div>
                  );
                })}

                <div className="rounded-xl border border-ink-100 p-3">
                  <p className="mb-1 text-[13px] font-bold text-ink-900">연속 후원 단계 상승</p>
                  <p className="mb-2 text-[12px] leading-relaxed text-ink-500">
                    같은 후원자가 정해진 시간 안에 이어서 후원하면 연출 단계를 올립니다. 누적 금액은 보지 않고 횟수만
                    봅니다. 최대 두 단계까지 오르고 5단계를 넘지 않습니다. 결제가 끝난 후원만 세며 테스트 후원과 환불
                    건은 세지 않습니다.
                  </p>
                  <label className="mb-2 flex items-center gap-2 text-[13px] text-ink-900">
                    <input
                      type="checkbox"
                      name="comboEnabled"
                      defaultChecked={ladder.combo.enabled}
                      className="h-4 w-4 rounded border-ink-300 text-brand-700 focus:ring-brand-300"
                    />
                    연속 후원 단계 상승 사용
                  </label>
                  <div className="grid gap-2.5 sm:grid-cols-3">
                    <AdminField label="인정 시간 (초)" hint="직전 후원으로부터 이 시간 안이면 연속">
                      <AdminInput
                        name="comboWindowSec"
                        type="number"
                        min={LADDER_LIMITS.minWindowSec}
                        max={LADDER_LIMITS.maxWindowSec}
                        defaultValue={String(ladder.combo.windowSec)}
                        required
                      />
                    </AdminField>
                    <AdminField label="+1단계 기준 (번째)" hint="연속 몇 번째부터 한 단계 상승">
                      <AdminInput
                        name="comboPlusOneAt"
                        type="number"
                        min={LADDER_LIMITS.minComboAt}
                        max={LADDER_LIMITS.maxComboAt}
                        defaultValue={String(ladder.combo.plusOneAt)}
                        required
                      />
                    </AdminField>
                    <AdminField label="+2단계 기준 (번째)" hint="연속 몇 번째부터 두 단계 상승">
                      <AdminInput
                        name="comboPlusTwoAt"
                        type="number"
                        min={LADDER_LIMITS.minComboAt}
                        max={LADDER_LIMITS.maxComboAt}
                        defaultValue={String(ladder.combo.plusTwoAt)}
                        required
                      />
                    </AdminField>
                  </div>
                </div>
              </div>
            </ActionForm>
          </Card>
        </section>

        <section>
          <Card>
            <CardTitle>기본값으로 되돌리기</CardTitle>
            <p className="mb-3 text-[12.5px] leading-relaxed text-ink-500">
              1,000원 / 10,000원 / 30,000원 / 50,000원 / 100,000원 구간과 연속 후원 3분 · 2번째 +1 · 4번째 +2 규칙으로
              되돌립니다. 변경 내용은 감사로그에 남습니다.
            </p>
            <ActionForm
              action={resetOverlayLadderAction}
              submitLabel="기본값으로 되돌리기"
              variant="secondary"
              confirm="후원 연출 기준을 기본값으로 되돌릴까요?"
              disabledReason={denyReason}
            />
          </Card>
        </section>
      </div>
    </>
  );
}
