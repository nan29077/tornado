import { Badge, Card, Checkbox, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { updateOverlayPlayModeAction } from '@/app/actions/studio';
import { overlayEffectLabel } from '@/lib/overlay-effect-catalog';
import {
  OVERLAY_LEVELS,
  OVERLAY_LEVEL_LABEL,
  ladderRangeText,
  type OverlayLadder,
  type OverlayTierMode,
} from '@/lib/overlay-ladder';

/**
 * 금액별 연출 방식 (2026-11-12).
 *
 *  - 자동      : 플랫폼 기준 금액 구간으로 연출 단계(1~5)가 정해진다. 아무것도 만들지 않아도 된다.
 *  - 직접 설정 : 아래 [금액 구간별 효과]에서 만든 구간을 따른다.
 *  - 끄기      : 금액과 무관하게 [알림 꾸미기]의 효과 하나로 재생한다.
 *
 * 서버 컴포넌트다. 저장은 ActionForm(클라이언트)이 맡는다.
 */

const MODE_OPTIONS: { value: OverlayTierMode; label: string; desc: string }[] = [
  {
    value: 'AUTO',
    label: '자동 (추천)',
    desc: '금액이 클수록 화려한 연출이 자동으로 나옵니다. 따로 만들 것이 없습니다.',
  },
  {
    value: 'CUSTOM',
    label: '직접 설정',
    desc: '아래 [금액 구간별 효과]에서 내가 만든 구간과 연출 단계를 따릅니다.',
  },
  {
    value: 'OFF',
    label: '끄기',
    desc: '금액과 무관하게 [알림 꾸미기]에서 고른 효과 하나로 재생합니다.',
  },
];

export function OverlayPlayModeCard({
  mode,
  comboBoost,
  lightEffects,
  ladder,
  tierCount,
}: {
  mode: OverlayTierMode;
  comboBoost: boolean;
  lightEffects: boolean;
  ladder: OverlayLadder;
  /** 직접 만든 금액 구간 수 */
  tierCount: number;
}) {
  const combo = ladder.combo;
  const windowText =
    combo.windowSec % 60 === 0 ? `${combo.windowSec / 60}분` : `${combo.windowSec.toLocaleString('ko-KR')}초`;

  return (
    <Card>
      <ActionForm action={updateOverlayPlayModeAction} submitLabel="연출 방식 저장" pendingLabel="저장 중">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-bold text-ink-900">연출 방식</legend>
          {MODE_OPTIONS.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-100 px-3 py-2.5 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50"
            >
              <input
                type="radio"
                name="tierMode"
                value={o.value}
                defaultChecked={mode === o.value}
                className="mt-0.5 h-5 w-5 shrink-0 border-ink-300 text-brand-700 focus:ring-brand-300"
              />
              <span>
                <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold leading-snug text-ink-900">
                  {o.label}
                  {mode === o.value ? <Badge tone="brand">사용 중</Badge> : null}
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-500">{o.desc}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode === 'CUSTOM' && tierCount === 0 ? (
          <Notice tone="warning">
            [직접 설정]을 쓰고 있지만 만든 금액 구간이 없습니다. 지금은 금액과 무관하게 같은 효과로 재생됩니다. 아래
            [금액 구간별 효과]에서 구간을 만들거나 [자동]으로 바꿔 주세요.
          </Notice>
        ) : null}

        <div className="mt-4">
          <p className="mb-1.5 text-[13px] font-bold text-ink-900">자동 방식의 금액 구간</p>
          <div className="overflow-x-auto rounded-xl border border-ink-100">
            <table className="w-full min-w-[420px] text-left text-[12.5px]">
              <thead className="bg-ink-50 text-ink-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">단계</th>
                  <th className="px-3 py-2 font-semibold">후원 금액</th>
                  <th className="px-3 py-2 font-semibold">효과</th>
                  <th className="px-3 py-2 text-right font-semibold">표시 시간</th>
                </tr>
              </thead>
              <tbody>
                {OVERLAY_LEVELS.map((lv) => {
                  const spec = ladder.levels[lv - 1]!;
                  return (
                    <tr key={lv} className="border-t border-ink-100">
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-ink-900">
                        {lv}단계 · {OVERLAY_LEVEL_LABEL[lv]}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-700">
                        {ladderRangeText(ladder, lv)}
                      </td>
                      <td className="px-3 py-2 text-ink-700">{overlayEffectLabel(spec.effect)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-ink-700">
                        {(spec.durationMs / 1000).toLocaleString('ko-KR')}초
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">
            이 기준은 도네이도 전체 공통이며 운영자가 조정할 수 있습니다. 단계가 오를수록 캐릭터가 커지고 파티클이
            많아지며, 5단계에서는 회오리가 화면을 한 번 휩쓸고 지나갑니다. 내 방송에 맞는 금액으로 바꾸려면 [직접
            설정]을 쓰세요.
          </p>
        </div>

        <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50 px-3 py-1">
          <Checkbox
            name="comboBoost"
            defaultChecked={comboBoost}
            label="연속 후원 단계 상승"
            description={
              combo.enabled
                ? `같은 후원자가 ${windowText} 안에 이어서 후원하면 ${combo.plusOneAt}번째부터 한 단계, ${combo.plusTwoAt}번째부터 두 단계 더 화려하게 재생합니다(최고 5단계). [끄기] 방식에서는 적용되지 않습니다.`
                : '지금은 운영자가 연속 후원 단계 상승을 꺼 두었습니다. 켜 두어도 적용되지 않습니다.'
            }
          />
          <Checkbox
            name="lightEffects"
            defaultChecked={lightEffects}
            label="가벼운 효과 모드"
            description="방송 PC 가 느려질 때 켜세요. 파티클 수를 줄이고 화면 테두리 빛·회오리 연출을 뺍니다."
          />
        </div>
      </ActionForm>
    </Card>
  );
}
