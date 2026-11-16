import Link from 'next/link';
import {Gauge, ChevronLeft } from '@/components/brand/icons';
import { Card, CardTitle, EmptyState, Notice, DataRow, SectionTitle, StatTile } from '@/components/ui';
import { LimitsForm } from '@/components/my/limits-form';
import { requireDonorContext, NO_DONOR_TITLE, NO_DONOR_DESC } from '@/components/my/donor';
import { prisma } from '@/server/db';
import { resolvePolicy } from '@/server/services/limits';
import { formatWon, formatNumber } from '@/lib/money';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const ALL = 'ALL';

export default async function MyLimitsPage() {
  const { donorId } = await requireDonorContext('/my/limits');
  if (!donorId) return <EmptyState title={NO_DONOR_TITLE} description={NO_DONOR_DESC} />;

  const [donor, policy] = await Promise.all([
    prisma.donorProfile.findUnique({
      where: { id: donorId },
      select: { dailyLimit: true, monthlyLimit: true },
    }),
    resolvePolicy(null, donorId),
  ]);

  const [dayCounter, monthCounter] = await Promise.all([
    prisma.donationCounter.findUnique({
      where: {
        donorId_creatorId_periodType_periodKey: {
          donorId,
          creatorId: ALL,
          periodType: 'DAY',
          periodKey: kstDateKey(),
        },
      },
      select: { amount: true, count: true },
    }),
    prisma.donationCounter.findUnique({
      where: {
        donorId_creatorId_periodType_periodKey: {
          donorId,
          creatorId: ALL,
          periodType: 'MONTH',
          periodKey: kstMonthKey(),
        },
      },
      select: { amount: true, count: true },
    }),
  ]);

  const effectiveDaily = donor?.dailyLimit ?? policy.donorDailyLimit;
  const effectiveMonthly = donor?.monthlyLimit ?? policy.donorMonthlyLimit;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/my/account"
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-400 transition-colors hover:text-ink-900"
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
          내 정보로 돌아가기
        </Link>
        <h2 className="mt-1 text-[18px] font-black tracking-[-0.025em] text-ink-900">한도 설정</h2>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile
          label="오늘 사용"
          value={formatWon(dayCounter?.amount ?? 0n)}
          sub={`한도 ${formatWon(effectiveDaily)}`}
          tone="brand"
        />
        <StatTile
          label="이번 달 사용"
          value={formatWon(monthCounter?.amount ?? 0n)}
          sub={`한도 ${formatWon(effectiveMonthly)}`}
        />
      </div>

      <Notice tone="brand" title="한도는 낮추는 방향으로만 설정할 수 있습니다">
        도네이도 기본 정책보다 높은 한도는 설정할 수 없습니다. 과도한 후원이 걱정된다면 한도를 더 낮게 조정해 주세요.
      </Notice>

      <section>
        <SectionTitle title="내 한도 설정" description="설정한 한도를 넘는 문자는 후원으로 접수되지 않습니다." />
        <Card>
          <LimitsForm
            defaultDaily={donor?.dailyLimit != null ? donor.dailyLimit.toString() : ''}
            defaultMonthly={donor?.monthlyLimit != null ? donor.monthlyLimit.toString() : ''}
            maxDaily={policy.donorDailyLimit.toString()}
            maxMonthly={policy.donorMonthlyLimit.toString()}
            maxDailyText={formatWon(policy.donorDailyLimit)}
            maxMonthlyText={formatWon(policy.donorMonthlyLimit)}
          />
        </Card>
      </section>

      <section>
        <SectionTitle title="기본 정책" description="아래 값은 도네이도가 모든 후원자에게 공통 적용하는 상한입니다." />
        <Card>
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Gauge size={16} strokeWidth={1.7} />
            </span>
            <CardTitle>전역 한도 정책</CardTitle>
          </div>
          <DataRow label="1건 허용 범위" value={`${formatWon(policy.minAmount)} ~ ${formatWon(policy.maxAmount)}`} />
          <DataRow label="1일 최대" value={formatWon(policy.donorDailyLimit)} />
          <DataRow label="1개월 최대" value={formatWon(policy.donorMonthlyLimit)} />
          <DataRow label="크리에이터 1명당 1일 최대" value={formatWon(policy.perCreatorDailyLimit)} />
          <DataRow
            label="연속 후원 제한"
            value={`${formatNumber(policy.velocityWindowSec)}초 내 ${formatNumber(policy.velocityMaxCount)}건`}
          />
          <DataRow
            label="연속 후원 시 대기"
            value={`${formatNumber(policy.cooldownAfterCount)}건 이후 ${formatNumber(policy.cooldownSec)}초`}
          />
          <DataRow label="신규 후원자 첫날 한도" value={formatWon(policy.newDonorFirstDayLimit)} />
          <DataRow label="결제 실패 누적" value={`${formatNumber(policy.failureLockThreshold)}회 시 자동 잠금`} />
        </Card>
      </section>

      <Notice tone="neutral">
        오늘·이번 달 사용 금액은 결제가 완료된 후원 기준이며 KST(한국 시간) 기준으로 집계됩니다. 환불이 완료되면 사용
        금액에서 다시 차감됩니다.
      </Notice>
    </div>
  );
}
