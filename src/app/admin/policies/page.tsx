import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, CreatorOptions } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { saveLimitPolicy, toggleLimitPolicy } from '@/app/actions/admin/policy';
import { prisma } from '@/server/db';
import { FALLBACK_POLICY } from '@/server/services/limits';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

interface LimitValues {
  defaultAmount: string;
  minAmount: string;
  maxAmount: string;
  donorDailyLimit: string;
  donorMonthlyLimit: string;
  perCreatorDailyLimit: string;
  donorDailyMaxCount: string;
  velocityWindowSec: string;
  velocityMaxCount: string;
  cooldownAfterCount: string;
  cooldownSec: string;
  failureLockThreshold: string;
  newDonorFirstDayLimit: string;
  manualReviewAmount: string;
  ttsMinAmount: string;
}

const fallbackValues: LimitValues = {
  defaultAmount: FALLBACK_POLICY.defaultAmount.toString(),
  minAmount: FALLBACK_POLICY.minAmount.toString(),
  maxAmount: FALLBACK_POLICY.maxAmount.toString(),
  donorDailyLimit: FALLBACK_POLICY.donorDailyLimit.toString(),
  donorMonthlyLimit: FALLBACK_POLICY.donorMonthlyLimit.toString(),
  perCreatorDailyLimit: FALLBACK_POLICY.perCreatorDailyLimit.toString(),
  donorDailyMaxCount: String(FALLBACK_POLICY.donorDailyMaxCount),
  velocityWindowSec: String(FALLBACK_POLICY.velocityWindowSec),
  velocityMaxCount: String(FALLBACK_POLICY.velocityMaxCount),
  cooldownAfterCount: String(FALLBACK_POLICY.cooldownAfterCount),
  cooldownSec: String(FALLBACK_POLICY.cooldownSec),
  failureLockThreshold: String(FALLBACK_POLICY.failureLockThreshold),
  newDonorFirstDayLimit: FALLBACK_POLICY.newDonorFirstDayLimit.toString(),
  manualReviewAmount: FALLBACK_POLICY.manualReviewAmount.toString(),
  ttsMinAmount: FALLBACK_POLICY.ttsMinAmount.toString(),
};

function LimitFields({ v }: { v: LimitValues }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <AdminField label="기본 후원금 (원)" hint="문자 1건당 기본 결제 금액">
        <AdminInput name="defaultAmount" inputMode="numeric" defaultValue={v.defaultAmount} required />
      </AdminField>
      <AdminField label="1회 최소 (원)">
        <AdminInput name="minAmount" inputMode="numeric" defaultValue={v.minAmount} required />
      </AdminField>
      <AdminField label="1회 최대 (원)">
        <AdminInput name="maxAmount" inputMode="numeric" defaultValue={v.maxAmount} required />
      </AdminField>
      <AdminField label="후원자 1일 한도 (원)">
        <AdminInput name="donorDailyLimit" inputMode="numeric" defaultValue={v.donorDailyLimit} required />
      </AdminField>
      <AdminField label="후원자 1개월 한도 (원)">
        <AdminInput name="donorMonthlyLimit" inputMode="numeric" defaultValue={v.donorMonthlyLimit} required />
      </AdminField>
      <AdminField label="크리에이터별 1일 한도 (원)">
        <AdminInput name="perCreatorDailyLimit" inputMode="numeric" defaultValue={v.perCreatorDailyLimit} required />
      </AdminField>
      <AdminField label="1인 1일 최대 건수" hint="금액과 별개로 하루 후원 건수를 제한">
        <AdminInput name="donorDailyMaxCount" inputMode="numeric" defaultValue={v.donorDailyMaxCount} required />
      </AdminField>
      <AdminField label="속도 제한 구간 (초)" hint="이 시간 안의 건수를 제한">
        <AdminInput name="velocityWindowSec" inputMode="numeric" defaultValue={v.velocityWindowSec} required />
      </AdminField>
      <AdminField label="속도 제한 최대 건수">
        <AdminInput name="velocityMaxCount" inputMode="numeric" defaultValue={v.velocityMaxCount} required />
      </AdminField>
      <AdminField label="연속 후원 기준 건수" hint="이 건수를 넘기면 대기 부여">
        <AdminInput name="cooldownAfterCount" inputMode="numeric" defaultValue={v.cooldownAfterCount} required />
      </AdminField>
      <AdminField label="연속 후원 대기 (초)">
        <AdminInput name="cooldownSec" inputMode="numeric" defaultValue={v.cooldownSec} required />
      </AdminField>
      <AdminField label="결제 실패 허용 (회)" hint="초과 시 자동 잠금">
        <AdminInput name="failureLockThreshold" inputMode="numeric" defaultValue={v.failureLockThreshold} required />
      </AdminField>
      <AdminField label="신규 후원자 첫날 한도 (원)">
        <AdminInput name="newDonorFirstDayLimit" inputMode="numeric" defaultValue={v.newDonorFirstDayLimit} required />
      </AdminField>
      <AdminField label="수동 검수 기준 (원)" hint="이 금액 이상이면 검수 대상">
        <AdminInput name="manualReviewAmount" inputMode="numeric" defaultValue={v.manualReviewAmount} required />
      </AdminField>
      <AdminField label="TTS 최소 후원금 (원)">
        <AdminInput name="ttsMinAmount" inputMode="numeric" defaultValue={v.ttsMinAmount} required />
      </AdminField>
    </div>
  );
}

export default async function AdminPoliciesPage() {
  const [policies, creators] = await Promise.all([
    prisma.donationLimitPolicy.findMany({
      orderBy: [{ active: 'desc' }, { scope: 'asc' }, { effectiveFrom: 'desc' }],
      take: 50,
      select: {
        id: true, scope: true, creatorId: true, donorId: true, active: true,
        effectiveFrom: true, effectiveTo: true, updatedAt: true,
        defaultAmount: true, minAmount: true, maxAmount: true,
        donorDailyLimit: true, donorMonthlyLimit: true, perCreatorDailyLimit: true, donorDailyMaxCount: true,
        velocityWindowSec: true, velocityMaxCount: true, cooldownAfterCount: true, cooldownSec: true,
        failureLockThreshold: true, newDonorFirstDayLimit: true, manualReviewAmount: true, ttsMinAmount: true,
        creator: { select: { id: true, displayName: true, code: true } },
      },
    }),
    prisma.creatorProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
      take: CREATOR_OPTION_LIMIT,
    }),
  ]);

  const globalActive = policies.find((p) => p.active && p.scope === 'GLOBAL');
  const donorScoped = policies.filter((p) => p.scope === 'DONOR').length;
  const creatorScoped = policies.filter((p) => p.scope === 'CREATOR').length;

  return (
    <>
      <PageHeader
        title="한도 정책"
        description="정책 우선순위는 후원자(DONOR) → 크리에이터(CREATOR) → 전역(GLOBAL) 순으로 적용됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="전역 1일 한도"
          value={formatWon(globalActive?.donorDailyLimit ?? FALLBACK_POLICY.donorDailyLimit)}
          sub={globalActive ? '활성 전역 정책' : '정책 미등록 · 코드 기본값'}
          tone="brand"
        />
        <StatTile
          label="전역 1회 범위"
          value={`${formatWon(globalActive?.minAmount ?? FALLBACK_POLICY.minAmount)} ~ ${formatWon(globalActive?.maxAmount ?? FALLBACK_POLICY.maxAmount)}`}
        />
        <StatTile label="크리에이터 정책" value={formatNumber(creatorScoped)} />
        <StatTile label="후원자 정책" value={formatNumber(donorScoped)} />
      </div>

      <Notice tone="warning" title="한도 값 변경은 즉시 반영됩니다">
        저장 즉시 새로 들어오는 문자에 적용됩니다. 변경 전/후 값은 모두 감사로그에 기록되며, 한도를 크게 올릴 때는
        이상거래 탐지 기준(수동 검수 금액)도 함께 검토해 주세요.
      </Notice>

      <section className="mt-5">
        <SectionTitle title="새 정책 등록" description="전역 정책은 활성 상태로 1개만 둘 수 있습니다." />
        <Card>
          <ActionForm action={saveLimitPolicy} submitLabel="정책 등록" confirm="새 한도 정책을 등록합니다.">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <AdminField label="적용 범위">
                <AdminSelect name="scope" defaultValue="CREATOR">
                  <option value="GLOBAL">전역 (GLOBAL)</option>
                  <option value="CREATOR">크리에이터 (CREATOR)</option>
                  <option value="DONOR">후원자 (DONOR)</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="크리에이터" hint="CREATOR 범위일 때만 사용">
                <AdminSelect name="creatorId" defaultValue="">
                  <CreatorOptions creators={creators} allLabel="선택 안 함" />
                </AdminSelect>
              </AdminField>
              <AdminField label="후원자 ID" hint="DONOR 범위일 때만 사용. 후원자 상세 화면의 ID">
                <AdminInput name="donorId" placeholder="01JXXXXXXXXXXXXXXXXXXXXXXX" />
              </AdminField>
              <AdminField label="적용 시작일 (KST)">
                <AdminInput type="date" name="effectiveFrom" defaultValue={kstDateKey()} />
              </AdminField>
            </div>
            <LimitFields v={fallbackValues} />
            <label className="flex items-center gap-2 text-[13px] text-ink-700">
              <input type="checkbox" name="active" defaultChecked className="h-4 w-4 rounded border-ink-300" />
              등록 즉시 활성화
            </label>
          </ActionForm>
        </Card>
      </section>

      <section className="mt-6">
        <SectionTitle title="등록된 정책" description="최대 50건까지 표시합니다." />
        {policies.length === 0 ? (
          <EmptyState
            title="등록된 한도 정책이 없습니다"
            description="정책이 없으면 코드 기본값(1일 10만원 / 1개월 100만원)이 적용됩니다."
          />
        ) : (
          <div className="space-y-4">
            {policies.map((p) => (
              <Card key={p.id}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>
                      {p.scope === 'GLOBAL'
                        ? '전역 정책'
                        : p.scope === 'CREATOR'
                          ? `크리에이터 정책 · ${p.creator?.displayName ?? p.creatorId ?? '-'}`
                          : `후원자 정책 · ${p.donorId ?? '-'}`}
                    </CardTitle>
                    <Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? '활성' : '비활성'}</Badge>
                    {p.scope === 'CREATOR' && p.creator ? (
                      <Link href={`/admin/creators/${p.creator.id}`} className="text-[12px] font-semibold text-brand-700">
                        크리에이터 상세
                      </Link>
                    ) : null}
                    {p.scope === 'DONOR' && p.donorId ? (
                      <Link href={`/admin/donors/${p.donorId}`} className="text-[12px] font-semibold text-brand-700">
                        후원자 상세
                      </Link>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-400">
                      적용 {formatKst(p.effectiveFrom, false)} · 수정 {formatKst(p.updatedAt, false)}
                    </span>
                    <ActionButton
                      action={toggleLimitPolicy}
                      values={{ id: p.id }}
                      label={p.active ? '비활성화' : '활성화'}
                      variant={p.active ? 'danger' : 'secondary'}
                      confirm={p.active ? '이 정책을 비활성화합니다.' : '이 정책을 활성화합니다.'}
                    />
                  </div>
                </div>

                <ActionForm action={saveLimitPolicy} submitLabel="변경 저장" variant="secondary" confirm="한도 값을 저장합니다. 변경 전/후 값이 감사로그에 기록됩니다.">
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="active" value={p.active ? 'on' : ''} />
                  <input type="hidden" name="effectiveFrom" value={p.effectiveFrom.toISOString()} />
                  <LimitFields
                    v={{
                      defaultAmount: p.defaultAmount.toString(),
                      minAmount: p.minAmount.toString(),
                      maxAmount: p.maxAmount.toString(),
                      donorDailyLimit: p.donorDailyLimit.toString(),
                      donorMonthlyLimit: p.donorMonthlyLimit.toString(),
                      perCreatorDailyLimit: p.perCreatorDailyLimit.toString(),
                      donorDailyMaxCount: String(p.donorDailyMaxCount),
                      velocityWindowSec: String(p.velocityWindowSec),
                      velocityMaxCount: String(p.velocityMaxCount),
                      cooldownAfterCount: String(p.cooldownAfterCount),
                      cooldownSec: String(p.cooldownSec),
                      failureLockThreshold: String(p.failureLockThreshold),
                      newDonorFirstDayLimit: p.newDonorFirstDayLimit.toString(),
                      manualReviewAmount: p.manualReviewAmount.toString(),
                      ttsMinAmount: p.ttsMinAmount.toString(),
                    }}
                  />
                </ActionForm>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
