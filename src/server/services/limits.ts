import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import type { DonorProfileModel as DonorProfile } from '@/generated/prisma/models';

/** 전체 합계 행 센티널 */
export const ALL = 'ALL';

/** 트랜잭션 클라이언트 (prisma.$transaction 의 콜백 인자) */
export type LimitsTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
/** 한도 조회에 쓰는 클라이언트 (전역 prisma 또는 트랜잭션 tx) */
type LimitsClient = typeof prisma | LimitsTx;

/**
 * 한도 / 이상거래 정책 엔진.
 * 정책 우선순위: DONOR > CREATOR > GLOBAL
 */

export interface EffectivePolicy {
  defaultAmount: bigint;
  minAmount: bigint;
  maxAmount: bigint;
  donorDailyLimit: bigint;
  donorMonthlyLimit: bigint;
  perCreatorDailyLimit: bigint;
  /** 1인(후원자) 1일 최대 후원 건수 */
  donorDailyMaxCount: number;
  velocityWindowSec: number;
  velocityMaxCount: number;
  cooldownAfterCount: number;
  cooldownSec: number;
  failureLockThreshold: number;
  newDonorFirstDayLimit: bigint;
  manualReviewAmount: bigint;
  ttsMinAmount: bigint;
}

export const FALLBACK_POLICY: EffectivePolicy = {
  defaultAmount: 3000n,
  minAmount: 1000n,
  maxAmount: 50000n,
  donorDailyLimit: 100000n,
  donorMonthlyLimit: 1000000n,
  perCreatorDailyLimit: 50000n,
  donorDailyMaxCount: 30,
  velocityWindowSec: 60,
  velocityMaxCount: 3,
  cooldownAfterCount: 5,
  cooldownSec: 300,
  failureLockThreshold: 3,
  newDonorFirstDayLimit: 30000n,
  manualReviewAmount: 200000n,
  ttsMinAmount: 3000n,
};

type PolicyRow = {
  defaultAmount: bigint; minAmount: bigint; maxAmount: bigint;
  donorDailyLimit: bigint; donorMonthlyLimit: bigint; perCreatorDailyLimit: bigint;
  donorDailyMaxCount: number; velocityWindowSec: number; velocityMaxCount: number; cooldownAfterCount: number; cooldownSec: number;
  failureLockThreshold: number; newDonorFirstDayLimit: bigint; manualReviewAmount: bigint; ttsMinAmount: bigint;
};

function pick(row: PolicyRow): EffectivePolicy {
  return {
    defaultAmount: row.defaultAmount,
    minAmount: row.minAmount,
    maxAmount: row.maxAmount,
    donorDailyLimit: row.donorDailyLimit,
    donorMonthlyLimit: row.donorMonthlyLimit,
    perCreatorDailyLimit: row.perCreatorDailyLimit,
    donorDailyMaxCount: row.donorDailyMaxCount,
    velocityWindowSec: row.velocityWindowSec,
    velocityMaxCount: row.velocityMaxCount,
    cooldownAfterCount: row.cooldownAfterCount,
    cooldownSec: row.cooldownSec,
    failureLockThreshold: row.failureLockThreshold,
    newDonorFirstDayLimit: row.newDonorFirstDayLimit,
    manualReviewAmount: row.manualReviewAmount,
    ttsMinAmount: row.ttsMinAmount,
  };
}

export async function resolvePolicy(
  creatorId?: string | null,
  donorId?: string | null,
  now: Date = new Date(),
  client: LimitsClient = prisma,
): Promise<EffectivePolicy> {
  const rows = await client.donationLimitPolicy.findMany({
    where: {
      active: true,
      // 시행일이 아직 오지 않았거나 이미 종료된 정책은 적용하지 않는다.
      // (예약 등록한 미래 정책이 곧바로 적용돼 한도가 바뀌는 사고를 막는다)
      effectiveFrom: { lte: now },
      OR: [
        { scope: 'GLOBAL' },
        ...(creatorId ? [{ scope: 'CREATOR' as const, creatorId }] : []),
        ...(donorId ? [{ scope: 'DONOR' as const, donorId }] : []),
      ],
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  const byScope = (s: 'GLOBAL' | 'CREATOR' | 'DONOR') => rows.find((r) => r.scope === s);
  const chosen = byScope('DONOR') ?? byScope('CREATOR') ?? byScope('GLOBAL');
  return chosen ? pick(chosen as unknown as PolicyRow) : FALLBACK_POLICY;
}

export type LimitDenyCode =
  | 'AMOUNT_RANGE'
  | 'DONOR_DAILY'
  | 'DONOR_DAILY_COUNT'
  | 'DONOR_MONTHLY'
  | 'CREATOR_DAILY'
  | 'VELOCITY'
  | 'COOLDOWN'
  | 'LOCKED'
  | 'BLOCKED'
  | 'NEW_DONOR_FIRST_DAY';

export interface LimitCheckResult {
  ok: boolean;
  code?: LimitDenyCode;
  message?: string;
  requiresManualReview: boolean;
  policy: EffectivePolicy;
}

export interface LimitCheckInput {
  donor: Pick<DonorProfile, 'id' | 'dailyLimit' | 'monthlyLimit' | 'lockedUntil' | 'blockedAt' | 'firstSeenAt'>;
  creatorId: string;
  amount: bigint;
  now?: Date;
  /** 크리에이터가 이 후원자를 차단했는지 */
  blockedByCreator?: boolean;
  /**
   * 속도 제한(velocity/streak) 카운터를 이번 호출에서 소진할지 여부. 기본 true.
   *
   * 같은 후원 1건에 대해 checkLimits 를 두 번 호출하는 경로(접수 시 + 결제 직전 재검사)에서는
   * 두 번째 호출을 false 로 둬야 한다. 그렇지 않으면 1건이 2건으로 계산돼
   * 설정한 속도 제한의 절반에서 정상 후원자가 차단되고 쿨다운도 두 배 빨리 걸린다.
   */
  consumeVelocity?: boolean;
  /**
   * 결제 판정 트랜잭션. 넘기면 모든 조회를 이 트랜잭션 안에서 수행하고,
   * 한도 집계를 읽기 직전에 후원자 행을 `FOR UPDATE` 로 잠근다.
   * 같은 후원자의 동시 요청은 앞선 트랜잭션이 끝날 때까지 여기서 대기하므로,
   * 두 요청이 같은 집계를 읽고 나란히 통과하는 일이 생기지 않는다.
   */
  tx?: LimitsTx;
}

/**
 * 후원자 행 잠금 (`SELECT ... FOR UPDATE`).
 * donor_profile 행은 항상 존재하므로 집계 행이 아직 없어도 직렬화 지점이 된다.
 * (donation_counter 를 잠그면 첫 후원처럼 행이 없을 때 아무것도 잠기지 않는다)
 */
async function lockDonorRow(tx: LimitsTx, donorId: string) {
  await tx.$queryRawUnsafe('SELECT id FROM donor_profile WHERE id = $1 FOR UPDATE', donorId);
}

async function readCounter(
  client: LimitsClient,
  donorId: string,
  creatorId: string,
  periodType: string,
  periodKey: string,
) {
  const row = await client.donationCounter.findUnique({
    where: {
      donorId_creatorId_periodType_periodKey: { donorId, creatorId, periodType, periodKey },
    },
  });
  return { count: row?.count ?? 0, amount: row?.amount ?? 0n };
}

export async function checkLimits(input: LimitCheckInput): Promise<LimitCheckResult> {
  const now = input.now ?? new Date();
  const db: LimitsClient = input.tx ?? prisma;
  const policy = await resolvePolicy(input.creatorId, input.donor.id, now, db);

  const donorDaily = input.donor.dailyLimit ?? policy.donorDailyLimit;
  const donorMonthly = input.donor.monthlyLimit ?? policy.donorMonthlyLimit;

  const deny = (code: LimitDenyCode, message: string): LimitCheckResult => ({
    ok: false, code, message, requiresManualReview: false, policy,
  });

  if (input.blockedByCreator) return deny('BLOCKED', '크리에이터가 차단한 후원자입니다.');
  if (input.donor.blockedAt) return deny('BLOCKED', '이용이 제한된 후원자입니다.');
  // 후원자가 /my/blocks 에서 직접 건 차단(donorCreatorLink.donorBlockedAt). 결제 경로 전부에서 막아야 한다.
  // 크리에이터가 건 차단은 blockedByCreator(blocked_donor) 로 따로 들어온다.
  const link = await db.donorCreatorLink.findUnique({
    where: { donorId_creatorId: { donorId: input.donor.id, creatorId: input.creatorId } },
    select: { donorBlockedAt: true },
  });
  if (link?.donorBlockedAt) return deny('BLOCKED', '후원자가 차단한 크리에이터입니다. 내 정보 > 차단 관리에서 해제할 수 있습니다.');
  if (input.donor.lockedUntil && input.donor.lockedUntil > now) {
    return deny('LOCKED', '결제 실패가 반복되어 일시적으로 잠겼습니다. 관리자 해제가 필요합니다.');
  }
  // 허용 범위 = 플랫폼 한도 정책 ∩ 크리에이터가 후원샵 설정에서 정한 범위.
  // 크리에이터 설정을 보지 않으면, 후원자가 문자로 금액을 지정했을 때
  // 크리에이터가 정한 상·하한을 그냥 넘어가 버린다.
  const creatorRange = await db.creatorProfile.findUnique({
    where: { id: input.creatorId },
    select: { minAmount: true, maxAmount: true },
  });
  const effMin =
    creatorRange && creatorRange.minAmount > policy.minAmount ? creatorRange.minAmount : policy.minAmount;
  const effMax =
    creatorRange && creatorRange.maxAmount < policy.maxAmount ? creatorRange.maxAmount : policy.maxAmount;

  if (input.amount < effMin || input.amount > effMax) {
    return deny('AMOUNT_RANGE', `후원금은 ${effMin}원 ~ ${effMax}원 사이여야 합니다.`);
  }

  const dayKey = kstDateKey(now);
  const monthKey = kstMonthKey(now);

  // 한도 집계를 읽기 직전에 후원자 행을 잠근다.
  // 잠금을 잡은 트랜잭션이 커밋될 때까지 같은 후원자의 다음 요청은 여기서 멈춘다.
  if (input.tx) await lockDonorRow(input.tx, input.donor.id);

  const donorDay = await readCounter(db, input.donor.id, ALL, 'DAY', dayKey);
  if (donorDay.amount + input.amount > donorDaily) {
    return deny('DONOR_DAILY', '일일 후원 한도를 초과했습니다.');
  }

  // 1인 1일 최대 건수 (금액과 별개로 건수 자체를 제한)
  if (donorDay.count + 1 > policy.donorDailyMaxCount) {
    return deny('DONOR_DAILY_COUNT', `하루 최대 ${policy.donorDailyMaxCount}건까지 후원할 수 있습니다.`);
  }

  const donorMonth = await readCounter(db, input.donor.id, ALL, 'MONTH', monthKey);
  if (donorMonth.amount + input.amount > donorMonthly) {
    return deny('DONOR_MONTHLY', '월간 후원 한도를 초과했습니다.');
  }

  const creatorDay = await readCounter(db, input.donor.id, input.creatorId, 'DAY', dayKey);
  if (creatorDay.amount + input.amount > policy.perCreatorDailyLimit) {
    return deny('CREATOR_DAILY', '해당 크리에이터에 대한 일일 한도를 초과했습니다.');
  }

  // 신규 후원자 첫날 한도
  if (kstDateKey(input.donor.firstSeenAt) === dayKey && donorDay.amount + input.amount > policy.newDonorFirstDayLimit) {
    return deny('NEW_DONOR_FIRST_DAY', '신규 후원자 첫날 한도를 초과했습니다.');
  }

  // ------------------------------------------------------------------
  // 여기부터는 Redis 를 쓰는 판정(연속 후원 대기·속도 제한)이다.
  //
  // 트랜잭션 안에서는 하지 않는다.
  // 결제 판정(executePayment)은 후원자 행을 FOR UPDATE 로 잠근 채 이 함수를 부르는데,
  // 그 상태로 Redis 응답을 기다리면 DB 잠금과 커넥션을 쥔 채 외부 네트워크에 매달리게 된다.
  // Redis 가 죽지 않고 느려지기만 해도(페일오버, 순단) 인터랙티브 트랜잭션 제한 시간을 넘겨
  // 결제 승인이 통째로 실패하고, 같은 후원자의 다른 요청까지 줄줄이 막힌다. DB 는 멀쩡한데도.
  //
  // 이 두 판정은 접수 시점(트랜잭션 밖)에서 이미 한 번 거친다.
  // 결제 직전 재검사가 반드시 확인해야 하는 것은 DB 집계 기반 한도이고, 그건 위에서 끝냈다.
  // ------------------------------------------------------------------
  if (!input.tx) {
    // Redis 장애로 인메모리 폴백 중이면 인스턴스마다 카운터가 따로 놀아
    // 연속후원 대기·속도 제한이 실제로는 우회될 수 있다. 조용히 통과시키는 대신
    // 정상화될 때까지 보수적으로 차단한다(L-1).
    if (kv.isDegraded()) {
      logger.warn('Redis 폴백 상태에서 속도 제한 판정 — 보수적으로 차단합니다.', { donorId: input.donor.id });
      return deny('VELOCITY', '일시적으로 후원이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
    }

    const cooldownKey = `cooldown:${input.donor.id}`;
    if (await kv.get(cooldownKey)) {
      return deny('COOLDOWN', '연속 후원으로 대기 중입니다. 잠시 후 다시 시도해 주세요.');
    }

    if (input.consumeVelocity !== false) {
      // 속도 제한: window 내 최대 건수
      const velocityKey = `velocity:${input.donor.id}:${Math.floor(now.getTime() / (policy.velocityWindowSec * 1000))}`;
      const vCount = await kv.incr(velocityKey, policy.velocityWindowSec);
      if (vCount > policy.velocityMaxCount) {
        return deny('VELOCITY', `${policy.velocityWindowSec}초 내 최대 ${policy.velocityMaxCount}건까지 후원할 수 있습니다.`);
      }

      // 연속 N건 이후 쿨다운 부여
      const streakKey = `streak:${input.donor.id}`;
      const streak = await kv.incr(streakKey, policy.cooldownSec);
      if (streak >= policy.cooldownAfterCount) {
        await kv.set(cooldownKey, '1', policy.cooldownSec);
        await kv.del(streakKey);
      }
    }
  }

  return {
    ok: true,
    requiresManualReview: input.amount >= policy.manualReviewAmount,
    policy,
  };
}

/**
 * 집계 반영.
 * 결제 판정 트랜잭션 안에서 호출하면(client=tx) 잠금이 풀리기 전에 집계가 확정되므로,
 * 뒤이어 대기하던 동시 요청은 갱신된 집계를 보고 한도 초과로 막힌다.
 */
export async function commitCounters(
  donorId: string,
  creatorId: string,
  amount: bigint,
  now = new Date(),
  client: LimitsClient = prisma,
) {
  const dayKey = kstDateKey(now);
  const monthKey = kstMonthKey(now);
  const targets: Array<{ creatorId: string; periodType: string; periodKey: string }> = [
    { creatorId: ALL, periodType: 'DAY', periodKey: dayKey },
    { creatorId: ALL, periodType: 'MONTH', periodKey: monthKey },
    { creatorId, periodType: 'DAY', periodKey: dayKey },
    { creatorId, periodType: 'MONTH', periodKey: monthKey },
  ];

  for (const t of targets) {
    await client.donationCounter.upsert({
      where: {
        donorId_creatorId_periodType_periodKey: {
          donorId, creatorId: t.creatorId, periodType: t.periodType, periodKey: t.periodKey,
        },
      },
      create: {
        id: newId(), donorId, creatorId: t.creatorId,
        periodType: t.periodType, periodKey: t.periodKey, count: 1, amount,
      },
      update: { count: { increment: 1 }, amount: { increment: amount } },
    });
  }
}

/**
 * 환불 시 집계 되돌림.
 *
 * updateMany 의 decrement 는 0 밑으로 내려갈 수 있다(늦게 들어온 환불이 이미 날짜가 바뀐
 * 집계를 건드리거나, 같은 건이 이중으로 롤백되는 경우 등). 마이너스로 쌓인 집계는 다음
 * 한도 판정에서 실제보다 더 많이 허용해 버리므로, 0 을 바닥으로 둔다(L-2).
 */
export async function rollbackCounters(
  donorId: string,
  creatorId: string,
  amount: bigint,
  at: Date,
  client: LimitsClient = prisma,
) {
  const dayKey = kstDateKey(at);
  const monthKey = kstMonthKey(at);
  const targets: Array<{ creatorId: string; periodType: string; periodKey: string }> = [
    { creatorId: ALL, periodType: 'DAY', periodKey: dayKey },
    { creatorId: ALL, periodType: 'MONTH', periodKey: monthKey },
    { creatorId, periodType: 'DAY', periodKey: dayKey },
    { creatorId, periodType: 'MONTH', periodKey: monthKey },
  ];
  for (const t of targets) {
    await client.$executeRawUnsafe(
      `UPDATE donation_counter
         SET count = GREATEST(count - 1, 0),
             amount = GREATEST(amount - $1::bigint, 0),
             updated_at = now()
       WHERE donor_id = $2 AND creator_id = $3 AND period_type = $4 AND period_key = $5`,
      amount.toString(),
      donorId,
      t.creatorId,
      t.periodType,
      t.periodKey,
    );
  }
}

/**
 * 결제 실패 시 속도 카운터를 되돌린다.
 *
 * DB 집계(rollbackCounters)는 되돌리면서 Redis 카운터만 남으면, 결제가 실패한 건이
 * 계속 "후원 1건"으로 세어져 정상 후원자가 속도 제한과 쿨다운에 걸린다.
 * 실패해도 되돌아가지 않던 비대칭을 없앤다. (되돌리기 실패는 무시한다 — TTL 로 자연 소멸한다)
 */
export async function rollbackVelocity(donorId: string, policy: EffectivePolicy, at: Date = new Date()) {
  const velocityKey = `velocity:${donorId}:${Math.floor(at.getTime() / (policy.velocityWindowSec * 1000))}`;
  await kv.incrBy(velocityKey, -1, policy.velocityWindowSec).catch(() => 0);
  await kv.incrBy(`streak:${donorId}`, -1, policy.cooldownSec).catch(() => 0);
}

export async function registerFailure(donorId: string, threshold: number) {
  const donor = await prisma.donorProfile.update({
    where: { id: donorId },
    data: { failCount: { increment: 1 } },
  });
  if (donor.failCount >= threshold) {
    /**
     * 잠금 기간을 **1년에서 정책값(기본 24시간)으로** 줄인다.
     *
     * 은행 점검이나 일시적 잔액부족 3회로 1년 잠금이 걸리는데, 해제 경로는 관리자 수동 처리
     * 하나뿐이었다. 정상 후원자가 스스로 풀 방법이 없어 사실상 계정이 죽는다.
     * 반복 실패에 대한 방어는 유지하되 시간이 지나면 스스로 풀리게 하고, 정말 위험한 계정은
     * 관리자가 [이용 제한](blockedAt)으로 따로 막는다.
     */
    const lockSec = Math.max(600, Number(process.env.DONOR_FAIL_LOCK_SEC) || 24 * 3600);
    await prisma.donorProfile.update({
      where: { id: donorId },
      data: { lockedUntil: new Date(Date.now() + lockSec * 1000) },
    });
    return true;
  }
  return false;
}

/**
 * 잠금 시간이 지난 후원자의 실패 카운터를 초기화한다.
 * 카운터가 남아 있으면 잠금이 풀린 직후 한 번만 실패해도 다시 잠긴다.
 */
export async function clearExpiredFailureLocks(now = new Date()): Promise<number> {
  const r = await prisma.donorProfile.updateMany({
    where: { lockedUntil: { not: null, lt: now }, failCount: { gt: 0 } },
    data: { lockedUntil: null, failCount: 0 },
  });
  return r.count;
}

export async function clearFailures(donorId: string) {
  await prisma.donorProfile.update({ where: { id: donorId }, data: { failCount: 0 } });
}
