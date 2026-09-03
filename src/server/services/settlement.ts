import { prisma, withAdvisoryLock } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, decrypt, maskResident, normalizeResident } from '@/lib/crypto';
import { applyRate, formatWon } from '@/lib/money';
import { env } from '@/lib/env';
import { calculateWithholding } from '@/lib/withholding';
import { kstMonthKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import type { LedgerEntryType } from '@/generated/prisma/enums';

/**
 * 정산 원장.
 *
 * 규칙
 *  - settlement_ledger 는 APPEND ONLY. UPDATE/DELETE 하지 않는다.
 *  - 정정이 필요하면 반대 부호 분개를 추가한다.
 *  - 후원 거래 원장 / 결제 거래 원장 / 정산 원장은 분리하되 donation_id 로 추적한다.
 *  - 정산 가능 금액 = 원장 합계 - 보류(미정산 요청 중) - 이미 지급
 */

/**
 * 원천징수 계산은 `src/lib/withholding.ts` 에 있다.
 * 서버(정산 요청 확정)와 브라우저(요청 금액 입력 중 미리보기)가 **같은 함수**를 써야
 * 화면에 보이는 실지급액과 실제 기록되는 금액이 어긋나지 않는다.
 * 기존 import 경로(`@/server/services/settlement`)를 유지하기 위해 여기서 다시 내보낸다.
 */
export {
  WITHHOLDING_RATE,
  INCOME_TAX_RATE,
  LOCAL_TAX_RATE,
  SMALL_AMOUNT_EXEMPTION,
  calculateWithholding,
} from '@/lib/withholding';
export type { WithholdingBreakdown } from '@/lib/withholding';

/** 부가가치세율 10% */
export const VAT_RATE = 0.1;

export interface FeeBreakdown {
  gross: bigint;
  /** 결제수수료 차감액 (부가세 포함 총액) */
  pgFee: bigint;
  /** 결제수수료 공급가액 (부가세 제외) */
  pgFeeSupply: bigint;
  /** 결제수수료에 붙는 부가세 */
  pgFeeVat: bigint;
  /** 플랫폼수수료 차감액 (부가세 포함 총액) */
  platformFee: bigint;
  /** 플랫폼수수료 공급가액 (부가세 제외) */
  platformFeeSupply: bigint;
  /** 플랫폼수수료에 붙는 부가세 */
  platformFeeVat: bigint;
  /** 부가세 합계 = pgFeeVat + platformFeeVat */
  vat: bigint;
  net: bigint;
  pgFeeRate: string;
  platformFeeRate: string;
  /** 적용된 정책의 부가세 포함 여부 */
  vatIncluded: boolean;
}

/** computeFees 가 필요로 하는 수수료 정책 값. FeePolicy 행을 그대로 넘길 수 있다. */
export interface FeeRates {
  pgFeeRate: string | number;
  pgFixedFee?: bigint | null;
  platformFeeRate: string | number;
  vatIncluded: boolean;
}

/** 유효한 수수료 정책이 없을 때 쓰는 기본값. FeePolicy 스키마 기본값과 같아야 한다. */
export const FALLBACK_FEE_RATES: FeeRates = {
  pgFeeRate: '0.018',
  pgFixedFee: 0n,
  platformFeeRate: '0.15',
  vatIncluded: true,
};

/**
 * 수수료 계산 (부가세 포함).
 *
 *   공급가액  = 후원금 x 요율            (원 미만 버림)
 *   부가세    = 공급가액 x 10%           (원 미만 버림)
 *   차감액    = 공급가액 + 부가세
 *   정산금    = 후원금 - 결제수수료 차감액 - 플랫폼수수료 차감액
 *
 * `vatIncluded = true` 이면 요율 자체에 부가세가 이미 포함된 것으로 보고
 * **부가세를 추가로 차감하지 않는다.** (요율 10% = 부가세 포함 10%)
 *
 * 예) 3,000원 후원 / 플랫폼 10% / vatIncluded=false / 결제수수료 0%
 *     공급가액 300원 + 부가세 30원 = 330원 차감 -> 크리에이터 정산 2,670원
 *
 * 예) 같은 조건에 vatIncluded=true
 *     300원만 차감 -> 크리에이터 정산 2,700원
 */
export function computeFees(amount: bigint, rates: FeeRates): FeeBreakdown {
  const pgRate = String(rates.pgFeeRate);
  const platformRate = String(rates.platformFeeRate);

  const pgFeeSupply = applyRate(amount, pgRate, rates.pgFixedFee ?? 0n);
  const platformFeeSupply = applyRate(amount, platformRate);

  const pgFeeVat = rates.vatIncluded ? 0n : applyRate(pgFeeSupply, VAT_RATE);
  const platformFeeVat = rates.vatIncluded ? 0n : applyRate(platformFeeSupply, VAT_RATE);

  const pgFee = pgFeeSupply + pgFeeVat;
  const platformFeeRaw = platformFeeSupply + platformFeeVat;

  // 수수료 합은 절대 후원금을 넘지 않는다.
  //
  // 예전에는 net 만 0 으로 보정하고 pgFee·platformFee 는 보정 전 값을 그대로 원장에 넣었다.
  // 그래서 요율을 잘못 넣으면 화면에는 "정산예정금 0원" 으로 보이는데 원장 합계는 음수가 되어
  // 그 크리에이터의 정산 가능액을 깎았다. 화면과 장부가 어긋나면 원인을 찾기 매우 어렵다.
  //
  // 결제 수수료는 실제로 PG 에 나가는 돈이므로 먼저 채우고, 남는 만큼만 플랫폼 수수료로 잡는다.
  const pgFeeCapped = pgFee > amount ? amount : pgFee;
  const room = amount - pgFeeCapped;
  const platformFee = platformFeeRaw > room ? room : platformFeeRaw;
  const net = amount - pgFeeCapped - platformFee;

  return {
    gross: amount,
    pgFee: pgFeeCapped,
    pgFeeSupply,
    pgFeeVat,
    platformFee,
    platformFeeSupply,
    platformFeeVat,
    vat: pgFeeVat + platformFeeVat,
    net,
    pgFeeRate: pgRate,
    platformFeeRate: platformRate,
    vatIncluded: rates.vatIncluded,
  };
}

/** FeePolicy 행(또는 null)을 computeFees 입력으로 바꾼다. */
export function feeRatesOf(policy: FeeRates | null | undefined): FeeRates {
  if (!policy) return FALLBACK_FEE_RATES;
  return {
    pgFeeRate: policy.pgFeeRate,
    pgFixedFee: policy.pgFixedFee ?? 0n,
    platformFeeRate: policy.platformFeeRate,
    vatIncluded: policy.vatIncluded,
  };
}

export async function resolveFeePolicy(creatorId: string, now: Date = new Date()) {
  const rows = await prisma.feePolicy.findMany({
    // 시행일 전/종료 후 정책은 적용하지 않는다. (예약 수수료가 즉시 반영돼 정산액이 틀어지는 것을 막는다)
    where: {
      active: true,
      effectiveFrom: { lte: now },
      OR: [{ scope: 'GLOBAL' }, { scope: 'CREATOR', creatorId }],
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.find((r) => r.scope === 'CREATOR') ?? rows.find((r) => r.scope === 'GLOBAL') ?? null;
}

export async function calculateFees(creatorId: string, amount: bigint): Promise<FeeBreakdown> {
  const policy = await resolveFeePolicy(creatorId);
  return computeFees(
    amount,
    feeRatesOf(
      policy
        ? {
            pgFeeRate: policy.pgFeeRate.toString(),
            pgFixedFee: policy.pgFixedFee,
            platformFeeRate: policy.platformFeeRate.toString(),
            vatIncluded: policy.vatIncluded,
          }
        : null,
    ),
  );
}

export interface LedgerInput {
  creatorId: string;
  entryType: LedgerEntryType;
  amount: bigint;
  donationId?: string | null;
  refundId?: string | null;
  requestId?: string | null;
  memo?: string;
  occurredAt?: Date;
}

/** appendLedger 가 받는 클라이언트 (전역 prisma 또는 트랜잭션 tx) */
type LedgerClient = Pick<typeof prisma, 'settlementLedger'> | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function appendLedger(entries: LedgerInput[], client: LedgerClient = prisma) {
  if (entries.length === 0) return;
  await client.settlementLedger.createMany({
    data: entries.map((e) => {
      const at = e.occurredAt ?? new Date();
      return {
        id: newId(),
        creatorId: e.creatorId,
        entryType: e.entryType,
        amount: e.amount,
        donationId: e.donationId ?? null,
        refundId: e.refundId ?? null,
        requestId: e.requestId ?? null,
        memo: e.memo ?? null,
        occurredAt: at,
        settlementKey: kstMonthKey(at),
      };
    }),
  });
}

/**
 * 수수료 분개 메모.
 * 부가세는 별도 분개를 만들지 않고 해당 수수료 분개에 포함해 차감하되(원장 잔액 = 실제 정산금),
 * 얼마가 부가세인지 메모로 남겨 사후 대사가 가능하게 한다.
 */
function feeMemo(label: string, rate: string, vat: bigint): string {
  return vat > 0n ? `${label} ${rate} (부가세 ${vat.toString()}원 포함)` : `${label} ${rate}`;
}

/**
 * 후원 결제 성공 시 3분개 (총액 / PG수수료 / 플랫폼수수료).
 *
 * 반드시 결제 승인 기록과 **같은 트랜잭션**에서 호출한다(client 로 tx 전달).
 * 분리되면 "후원은 성공인데 원장에는 없는" 상태가 생기고, 조기 return 가드 때문에
 * 재시도로도 복구되지 않아 크리에이터가 그 금액을 영영 받지 못한다.
 * 재시도·중복 호출에도 분개가 두 번 쌓이지 않도록 이미 기록된 후원은 건너뛴다.
 */
export async function postDonationSettlement(
  input: {
    creatorId: string;
    donationId: string;
    amount: bigint;
    fees: FeeBreakdown;
    occurredAt?: Date;
  },
  client: LedgerClient = prisma,
) {
  const already = await client.settlementLedger.findFirst({
    where: { donationId: input.donationId, entryType: 'DONATION_GROSS' },
    select: { id: true },
  });
  if (already) return;

  await appendLedger(
    [
      {
        creatorId: input.creatorId, entryType: 'DONATION_GROSS', amount: input.fees.gross,
        donationId: input.donationId, occurredAt: input.occurredAt, memo: '문자후원 결제 승인',
      },
      {
        creatorId: input.creatorId, entryType: 'PG_FEE', amount: -input.fees.pgFee,
        donationId: input.donationId, occurredAt: input.occurredAt,
        memo: feeMemo('결제수수료', input.fees.pgFeeRate, input.fees.pgFeeVat),
      },
      {
        creatorId: input.creatorId, entryType: 'PLATFORM_FEE', amount: -input.fees.platformFee,
        donationId: input.donationId, occurredAt: input.occurredAt,
        memo: feeMemo('플랫폼수수료', input.fees.platformFeeRate, input.fees.platformFeeVat),
      },
    ],
    client,
  );
}

/**
 * 환불 시 환입할 수수료를 "원 거래에 실제로 기록된 분개"에서 계산한다.
 *
 * 환불 시점의 수수료율로 다시 계산하면(calculateFees(refundAmount)) 두 가지 오차가 난다.
 *  1) 원 결제 이후 수수료 정책이 바뀌면 환입액이 원 차감액과 달라져 원장이 영구히 틀어진다.
 *  2) 부분 환불에서 정액 수수료(pgFixedFee)가 통째로 다시 계산돼 과다 환입된다.
 * 따라서 원 거래의 PLATFORM_FEE 분개를 환불 비율만큼만 되돌리고,
 * 이미 환입한 금액을 빼서 여러 번 부분 환불해도 총 환입액이 원 차감액을 넘지 않게 한다.
 */
export async function resolveRefundFeeReturn(
  donationId: string,
  refundAmount: bigint,
  client: LedgerClient = prisma,
): Promise<{ platformFeeReturn: bigint; grossPosted: bigint; platformFeePosted: bigint }> {
  const rows = await client.settlementLedger.findMany({
    where: { donationId },
    select: { entryType: true, amount: true },
  });

  const sumOf = (t: LedgerEntryType) =>
    rows.filter((r) => r.entryType === t).reduce((acc, r) => acc + r.amount, 0n);

  const grossPosted = sumOf('DONATION_GROSS');
  // 수수료는 음수로 기록되므로 부호를 뒤집어 "차감된 금액"으로 만든다.
  const platformFeePosted = -sumOf('PLATFORM_FEE');
  const alreadyReturned = sumOf('REFUND_FEE_RETURN');
  const alreadyRefunded = -sumOf('REFUND');

  if (grossPosted <= 0n || platformFeePosted <= 0n) {
    return { platformFeeReturn: 0n, grossPosted, platformFeePosted };
  }

  // 이번 환불까지 포함한 누적 환불 비율에 해당하는 환입액에서, 이미 환입한 금액을 뺀다.
  const cumulativeRefund = alreadyRefunded + refundAmount;
  const capped = cumulativeRefund > grossPosted ? grossPosted : cumulativeRefund;
  const targetReturn = (platformFeePosted * capped) / grossPosted;
  const platformFeeReturn = targetReturn - alreadyReturned;

  return {
    platformFeeReturn: platformFeeReturn < 0n ? 0n : platformFeeReturn,
    grossPosted,
    platformFeePosted,
  };
}

/**
 * 환불 시 반대 분개 (수수료 환입 정책 포함).
 *
 * 환불 확정 기록과 **같은 트랜잭션**에서 호출한다(client 로 tx 전달).
 * 분리되면 커밋 사이에 프로세스가 죽었을 때 원장에 환불 분개가 누락된다.
 */
export async function postRefundSettlement(
  input: {
    creatorId: string;
    donationId: string;
    refundId: string;
    amount: bigint;
    fees: FeeBreakdown;
    returnPlatformFee?: boolean;
    occurredAt?: Date;
  },
  client: LedgerClient = prisma,
) {
  const entries: LedgerInput[] = [
    {
      creatorId: input.creatorId, entryType: 'REFUND', amount: -input.amount,
      donationId: input.donationId, refundId: input.refundId, occurredAt: input.occurredAt, memo: '후원 환불',
    },
  ];
  if (input.returnPlatformFee !== false) {
    // 원 거래 분개에서 환입액을 산출한다. (환불 시점 요율로 재계산하면 원장이 틀어진다)
    // 트랜잭션 안에서 호출됐다면 같은 tx로 읽어야 한다. 전역 prisma를 쓰면 커넥션 풀이
    // 작은 환경에서 서로의 연결을 기다리며 타임아웃되고, 읽기 스냅샷도 어긋날 수 있다.
    const { platformFeeReturn } = await resolveRefundFeeReturn(input.donationId, input.amount, client);
    if (platformFeeReturn > 0n) {
      entries.push({
        creatorId: input.creatorId, entryType: 'REFUND_FEE_RETURN', amount: platformFeeReturn,
        donationId: input.donationId, refundId: input.refundId, occurredAt: input.occurredAt,
        memo: '환불에 따른 플랫폼수수료 환입',
      });
    }
  }
  await appendLedger(entries, client);
}

export interface SettlementSummary {
  totalGross: bigint;
  totalPgFee: bigint;
  totalPlatformFee: bigint;
  totalRefund: bigint;
  totalAdjustment: bigint;
  totalPaid: bigint;
  /** 원장 순합계 */
  balance: bigint;
  /** 정산 요청 중이라 보류된 금액 */
  pending: bigint;
  /** 지금 정산 요청 가능한 금액 */
  available: bigint;
}

/** 요약 집계에 쓰는 클라이언트 (전역 prisma 또는 트랜잭션 tx) */
type SummaryClient = Pick<typeof prisma, 'settlementLedger' | 'settlementRequest'>
  | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * 크리에이터 정산 요약.
 *
 * 잠금 안에서 잔액을 검증할 때는 반드시 `client` 로 tx 를 넘겨야 한다.
 * 전역 prisma 로 읽으면 트랜잭션 밖 스냅샷을 보게 되어, 락을 잡은 의미가 사라진다.
 */
export async function getSettlementSummary(
  creatorId: string,
  client: SummaryClient = prisma,
): Promise<SettlementSummary> {
  const grouped = await client.settlementLedger.groupBy({
    by: ['entryType'],
    where: { creatorId },
    _sum: { amount: true },
  });

  const sum = (t: LedgerEntryType) => grouped.find((g) => g.entryType === t)?._sum.amount ?? 0n;

  const totalGross = sum('DONATION_GROSS');
  const totalPgFee = -sum('PG_FEE');
  const totalPlatformFee = -sum('PLATFORM_FEE');
  const totalRefund = -(sum('REFUND') + sum('REFUND_FEE_RETURN'));
  const totalAdjustment = sum('ADJUSTMENT');
  const totalPaid = -(sum('PAYOUT') + sum('PAYOUT_WITHHOLDING'));

  const balance = grouped.reduce((acc, g) => acc + (g._sum.amount ?? 0n), 0n);

  const pendingAgg = await client.settlementRequest.aggregate({
    where: { creatorId, status: { in: ['REQUESTED', 'REVIEWING', 'APPROVED'] } },
    _sum: { amount: true },
  });
  const pending = pendingAgg._sum.amount ?? 0n;
  const available = balance - pending;

  return {
    totalGross, totalPgFee, totalPlatformFee, totalRefund, totalAdjustment, totalPaid,
    balance,
    pending,
    available: available < 0n ? 0n : available,
  };
}

/**
 * 정산 요청 생성. 가능 금액 초과 요청을 막는다.
 * 크리에이터 단위 advisory lock 으로 동시 요청을 직렬화한다.
 * (잠금 없이는 두 요청이 같은 가용 금액을 읽고 둘 다 통과해 잔액 초과 이중 요청이 생긴다)
 */
export interface CreateSettlementInput {
  memo?: string;
  /** 원천징수 신고용 주민등록번호(정규화된 13자리). 신고 후 파기된다. */
  resident?: string | null;
}

export async function createSettlementRequest(
  creatorId: string,
  amount: bigint,
  input: CreateSettlementInput = {},
) {
  if (amount <= 0n) throw new Error('정산 요청 금액이 올바르지 않습니다.');

  // 이체 1건당 은행 수수료와 확인 공수가 고정으로 드는 만큼 하한을 둔다(0 이면 하한 없음).
  const minAmount = env.settlement.minRequestAmount;
  if (minAmount > 0n && amount < minAmount) {
    throw new Error(`최소 정산 요청 금액은 ${formatWon(minAmount)}입니다.`);
  }

  // 개인(사업소득 3.3% 원천징수) 크리에이터는 신고용 주민등록번호가 반드시 필요하다.
  const resident = input.resident ? normalizeResident(input.resident) : null;
  if (input.resident && !resident) throw new Error('주민등록번호 형식이 올바르지 않습니다.');

  return prisma.$transaction(async (tx) =>
    withAdvisoryLock(tx, `settlement:creator:${creatorId}`, async () => {
      // 잠금 획득 후 트랜잭션 안에서 읽어야 앞선 요청의 커밋 결과가 반영된 값을 본다
      const summary = await getSettlementSummary(creatorId, tx);
      if (amount > summary.available) throw new Error('정산 가능 금액을 초과했습니다.');

      const account = await tx.settlementAccount.findUnique({ where: { creatorId } });
      if (!account || !account.verified) throw new Error('정산 계좌 인증이 완료되지 않았습니다.');

      // 사업소득 원천징수: 소득세 3%(10원절사) + 지방소득세 10%(10원절사), 소액부징수 적용.
      const wh = calculateWithholding(amount);

      return tx.settlementRequest.create({
        data: {
          id: newId(),
          creatorId,
          amount,
          withholding: wh.total,
          incomeTax: wh.incomeTax,
          localTax: wh.localTax,
          payoutAmount: amount - wh.total,
          memo: input.memo ?? null,
          // 주민등록번호는 암호화 저장하고 화면에는 마스킹만 노출한다.
          residentEnc: resident ? encrypt(resident) : null,
          residentMasked: resident ? maskResident(resident) : null,
        },
      });
    }),
  );
}

/**
 * 지급 실행 **전** 사전 검증.
 *
 * 계좌 인증·잔액 확인은 반드시 돈이 나가기 전에 해야 한다.
 * 이체가 끝난 뒤(markSettlementPaid) 검증해서 throw 하면 이미 나간 돈이
 * 원장에 남지 않아 잔액이 줄지 않고, 크리에이터가 다시 신청해 **이중 지급**이 된다.
 * 이체파일을 만들 때 이 함수로 걸러낸다.
 */
export async function assertPayable(
  requestId: string,
  /**
   * 같은 크리에이터의 **다른 승인 건**이 이미 잡아 둔 금액.
   * 여러 건을 한 이체파일에 담을 때, 앞 건이 쓴 금액만큼 잔액에서 빼고 판정해야 한다.
   */
  alreadyClaimed: bigint = 0n,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const req = await prisma.settlementRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false, reason: '정산 요청을 찾을 수 없습니다.' };
  if (req.status !== 'APPROVED') return { ok: false, reason: '승인(APPROVED) 상태가 아닙니다.' };

  const account = await prisma.settlementAccount.findUnique({ where: { creatorId: req.creatorId } });
  if (!account || !account.verified) return { ok: false, reason: '정산 계좌 인증이 완료되지 않았습니다.' };

  /**
   * 잔액과 비교할 때 **같은 배치의 앞선 건이 이미 쓴 금액을 반드시 뺀다.**
   *
   * 예전에는 요청 1건만 `balance` 와 비교했다. 그래서 같은 크리에이터의 승인 건이
   * 여러 개면 각각 독립적으로 통과했고, 그 사이에 환불이 생겨 잔액이 줄면
   * 합계가 잔액을 넘긴 채 이체파일이 만들어졌다. 실제로 돈이 나간 뒤라 되돌릴 수 없다.
   *
   * (아직 승인되지 않은 REQUESTED/REVIEWING 건은 지금 지급하지 않으므로 빼지 않는다.
   *  그것까지 예약하면 정상적인 지급이 막힌다)
   */
  const summary = await getSettlementSummary(req.creatorId);
  const payable = summary.balance - alreadyClaimed;

  if (req.amount > payable) {
    return {
      ok: false,
      reason:
        `정산 가능 잔액 부족 (요청 ${req.amount.toString()}원 / 지급 가능 ${payable.toString()}원` +
        (alreadyClaimed > 0n ? `, 같은 배치의 앞선 건 ${alreadyClaimed.toString()}원 반영` : '') +
        `)`,
    };
  }
  return { ok: true };
}

/**
 * 지급 완료 처리 시 원장에 PAYOUT 분개를 추가한다.
 *
 * ── 이 함수가 불리는 시점 ────────────────────────────────────────────────
 * **이미 지급대행(쿠콘)이 이체를 실행한 뒤**, 그 결과를 반영하는 단계다.
 * 따라서 여기서 검증 실패로 throw 하면 "돈은 나갔는데 원장에는 없는" 상태가 되어
 * 잔액이 줄지 않고 재신청 시 이중 지급된다. 사전 검증은 assertPayable() 에서
 * 이체 전에 끝내고, 여기서는 **어떤 경우에도 분개를 남긴다.**
 * 문제가 있는 건은 막는 대신 경고 메모를 붙여 사람이 확인하도록 한다.
 *
 * advisory lock 키는 요청ID가 아니라 **크리에이터**다.
 * 실제로 보호해야 하는 자원은 그 크리에이터의 잔액이므로, 요청ID로 잠그면
 * 같은 크리에이터의 서로 다른 요청 2건이 서로 다른 락을 잡고 동시에 통과한다.
 */
export async function markSettlementPaid(requestId: string, adminId?: string, payoutRef?: string) {
  return prisma.$transaction(async (tx) =>
    withAdvisoryLock(tx, `settlement:creator:${await creatorIdOf(tx, requestId)}`, async () => {
      const req = await tx.settlementRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new Error('정산 요청을 찾을 수 없습니다.');
      if (req.status === 'PAID') return req;

      // 이미 지급 실패로 되돌린 건을 다시 지급 완료로 올리는 것은 사람이 판단해야 한다.
      if (req.status !== 'APPROVED' && req.status !== 'PAYOUT_FAILED') {
        throw new Error('승인(APPROVED) 또는 지급실패(PAYOUT_FAILED) 상태만 지급 완료 처리할 수 있습니다.');
      }

      // 이체는 이미 끝난 뒤다. 이상이 있어도 분개는 반드시 남기고, 메모로 경고만 남긴다.
      const warnings: string[] = [];
      const account = await tx.settlementAccount.findUnique({ where: { creatorId: req.creatorId } });
      if (!account || !account.verified) warnings.push('계좌 인증 해제 상태에서 지급됨');

      const summary = await getSettlementSummary(req.creatorId, tx);
      if (req.amount > summary.balance) {
        warnings.push(
          `잔액 초과 지급 (요청 ${req.amount.toString()}원 / 잔액 ${summary.balance.toString()}원)`,
        );
      }

      const now = new Date();
      await appendLedger(
        [
          {
            creatorId: req.creatorId, entryType: 'PAYOUT', amount: -req.payoutAmount,
            requestId: req.id, occurredAt: now, memo: '정산 지급',
          },
          {
            creatorId: req.creatorId, entryType: 'PAYOUT_WITHHOLDING', amount: -req.withholding,
            requestId: req.id, occurredAt: now, memo: '원천징수',
          },
        ],
        tx,
      );

      if (warnings.length > 0) {
        logger.error('정산 지급 완료 처리 중 이상 감지 — 확인 필요', {
          requestId, creatorId: req.creatorId, warnings,
        });
      }

      return tx.settlementRequest.update({
        where: { id: requestId },
        data: {
          status: 'PAID',
          paidAt: now,
          adminId: adminId ?? null,
          payoutRef: payoutRef ?? null,
          payoutFailReason: null,
          adminMemo: warnings.length > 0 ? `[주의] ${warnings.join(' / ')}` : req.adminMemo,
        },
      });
    }),
  );
}

/** 락 키로 쓸 크리에이터 ID를 먼저 조회한다. */
async function creatorIdOf(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  requestId: string,
): Promise<string> {
  const row = await tx.settlementRequest.findUnique({
    where: { id: requestId },
    select: { creatorId: true },
  });
  if (!row) throw new Error('정산 요청을 찾을 수 없습니다.');
  return row.creatorId;
}

/**
 * 지급대행 이체파일 발급 이력 기록.
 *
 * 같은 승인 건으로 파일을 두 번 받아 두 번 업로드하면 이중이체가 된다.
 * 최초 발급 시각·배치번호를 남기고, 이미 발급된 건이 섞여 있으면 재발급 목록으로 돌려준다.
 */
export async function markPayoutFileIssued(
  requestIds: string[],
  adminId?: string,
): Promise<{ batchNo: string; reissued: string[] }> {
  const batchNo = `B${newId().slice(-10).toUpperCase()}`;
  if (requestIds.length === 0) return { batchNo, reissued: [] };

  /**
   * 읽기와 쓰기를 **한 트랜잭션 안에서** 처리한다.
   *
   * 예전에는 "이미 발급된 건 조회" 와 "발급 표시" 가 분리돼 있었다. 재무 담당 두 명이
   * 같은 승인 건을 동시에 내려받으면 둘 다 `existing = []` 를 읽어 각자 "재발급 아님"
   * 판정을 받았고, 같은 내용의 이체파일 두 개가 만들어졌다. 둘 다 올리면 이중이체다.
   *
   * 선점은 조건부 갱신(`payoutIssuedAt: null`)의 결과 건수로 판정한다.
   * 실제로 선점한 쪽만 "최초 발급"이 되고, 나머지는 재발급으로 표시된다.
   */
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.settlementRequest.updateMany({
      where: { id: { in: requestIds }, payoutIssuedAt: null },
      data: { payoutIssuedAt: new Date(), payoutBatchNo: batchNo },
    });

    // 선점하지 못한 나머지가 곧 재발급 대상이다.
    const reissuedRows = await tx.settlementRequest.findMany({
      where: { id: { in: requestIds }, payoutBatchNo: { not: batchNo } },
      select: { id: true },
    });
    const reissued = reissuedRows.map((r) => r.id);

    // 재발급 건은 최초 발급 시각을 보존하고 최신 배치번호만 갱신한다.
    if (reissued.length > 0) {
      await tx.settlementRequest.updateMany({
        where: { id: { in: reissued } },
        data: { payoutBatchNo: batchNo },
      });
      logger.warn('지급대행 이체파일 재발급', {
        batchNo,
        reissued,
        claimed: claimed.count,
        adminId: adminId ?? null,
      });
    }
    return { batchNo, reissued };
  });
}

/**
 * 지급 실패 처리.
 * 지급대행(쿠콘) 결과가 실패로 회신된 건을 처리한다.
 * 이미 PAID 로 원장에 기록됐다면 지급/원천징수 분개를 반대 부호로 환입해
 * 잔액이 되살아나게 하고, 재요청할 수 있도록 상태만 PAYOUT_FAILED 로 둔다.
 */
export async function markSettlementPayoutFailed(requestId: string, reason: string, adminId?: string) {
  return prisma.$transaction(async (tx) =>
    // 지급 완료 처리와 같은 락(크리에이터 단위)을 잡아야 서로 경합하지 않는다.
    withAdvisoryLock(tx, `settlement:creator:${await creatorIdOf(tx, requestId)}`, async () => {
      const req = await tx.settlementRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new Error('정산 요청을 찾을 수 없습니다.');
      if (req.status === 'PAYOUT_FAILED') return req;
      if (req.status !== 'PAID' && req.status !== 'APPROVED') {
        throw new Error('지급 완료 또는 승인 상태의 요청만 지급 실패로 처리할 수 있습니다.');
      }

      const now = new Date();
      // 이미 지급 분개가 기록된 경우에만 환입한다.
      if (req.status === 'PAID') {
        await appendLedger(
          [
            {
              creatorId: req.creatorId, entryType: 'PAYOUT', amount: req.payoutAmount,
              requestId: req.id, occurredAt: now, memo: `지급 실패 환입: ${reason}`.slice(0, 200),
            },
            {
              creatorId: req.creatorId, entryType: 'PAYOUT_WITHHOLDING', amount: req.withholding,
              requestId: req.id, occurredAt: now, memo: '지급 실패 원천징수 환입',
            },
          ],
          tx,
        );
      }

      return tx.settlementRequest.update({
        where: { id: requestId },
        data: {
          status: 'PAYOUT_FAILED',
          payoutFailReason: reason.slice(0, 300),
          adminId: adminId ?? null,
        },
      });
    }),
  );
}

/**
 * 원천징수 지급명세서 신고 완료 처리 + 주민등록번호 파기.
 *
 * 지급명세서에 담긴 금액·원천징수·지급일 등 회계 기록은 세법상 보존 의무가 있어 그대로 남기고,
 * **주민등록번호 원문만** 즉시 삭제한다. 출금 신청 화면에서 안내한 "신고 후 파기" 를 실제로 이행한다.
 */
export async function fileWithholdingAndPurgeResident(requestId: string, adminId?: string) {
  const now = new Date();
  const req = await prisma.settlementRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, residentEnc: true, residentPurgedAt: true },
  });
  if (!req) throw new Error('정산 요청을 찾을 수 없습니다.');
  if (req.status !== 'PAID') throw new Error('지급 완료된 요청만 원천징수 신고 처리할 수 있습니다.');

  await prisma.settlementRequest.update({
    where: { id: requestId },
    data: {
      withholdingFiledAt: now,
      // 주민등록번호 원문만 파기한다. 마스킹·금액·원천징수 기록은 유지.
      residentEnc: null,
      residentPurgedAt: req.residentEnc ? now : req.residentPurgedAt ?? now,
      adminId: adminId ?? null,
    },
  });
  return { purged: Boolean(req.residentEnc) };
}

/**
 * 신고 대상이 아닌 건의 주민등록번호 즉시 파기.
 *
 * 반려(REJECTED)·지급실패(PAYOUT_FAILED) 건은 애초에 원천징수 신고 대상이 아니므로
 * 주민등록번호를 보관할 근거가 없다. 지급 완료 건에만 파기 기능이 있으면
 * 이 사본들이 영구히 남아 "신고 후 즉시 파기" 안내와 어긋난다.
 * 상태 전이 시점에 자동으로 호출한다.
 */
export async function purgeResidentIfNotFilable(requestId: string) {
  const req = await prisma.settlementRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, residentEnc: true },
  });
  if (!req || !req.residentEnc) return { purged: false };
  if (req.status !== 'REJECTED' && req.status !== 'PAYOUT_FAILED') {
    return { purged: false };
  }
  await prisma.settlementRequest.update({
    where: { id: requestId },
    data: { residentEnc: null, residentPurgedAt: new Date() },
  });
  logger.info('신고 대상 아님 — 주민등록번호 파기', { requestId, status: req.status });
  return { purged: true };
}

/** 지급대행 이체 파일 한 줄에 담기는 값. */
export interface PayoutRow {
  requestId: string;
  creatorName: string;
  creatorCode: string;
  bankCode: string;
  bankName: string;
  account: string;
  holder: string;
  amount: bigint;
  note: string;
}

/**
 * 승인 건을 지급대행(쿠콘) 이체 대상으로 변환한다.
 * 계좌번호·예금주는 암호화 저장돼 있으므로 여기서 복호화한다(파일 생성 목적).
 * 반환값은 그대로 CSV/엑셀로 만든다.
 */
export async function buildPayoutRows(requestIds: string[]): Promise<PayoutRow[]> {
  if (requestIds.length === 0) return [];
  const reqs = await prisma.settlementRequest.findMany({
    where: { id: { in: requestIds }, status: 'APPROVED' },
    // 같은 크리에이터의 여러 건이 섞여 있을 때 판정이 순서에 좌우되지 않도록 고정 순서로 읽는다.
    orderBy: [{ creatorId: 'asc' }, { requestedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, creatorId: true, amount: true, payoutAmount: true,
      creator: {
        select: {
          displayName: true, code: true,
          settlementAccount: {
            select: { bankCode: true, bankName: true, accountEnc: true, holderNameEnc: true, verified: true },
          },
        },
      },
    },
  });

  const rows: PayoutRow[] = [];
  /** 이 배치에서 크리에이터별로 이미 잡은 금액. 뒤 건은 그만큼 줄어든 잔액으로 판정한다. */
  const claimedByCreator = new Map<string, bigint>();

  for (const r of reqs) {
    const acc = r.creator.settlementAccount;
    if (!acc || !acc.verified) continue; // 미인증 계좌는 이체 대상에서 제외
    // 잔액까지 여기서 걸러낸다. 검증은 반드시 **이체 전** 에 끝나야 한다.
    // 이체가 끝난 뒤(markSettlementPaid) 막으면 이미 나간 돈이 원장에 안 남아 이중 지급이 된다.
    const alreadyClaimed = claimedByCreator.get(r.creatorId) ?? 0n;
    const payable = await assertPayable(r.id, alreadyClaimed);
    if (!payable.ok) {
      logger.warn('지급대행 이체파일에서 제외', { requestId: r.id, reason: payable.reason });
      continue;
    }
    claimedByCreator.set(r.creatorId, alreadyClaimed + r.amount);
    rows.push({
      requestId: r.id,
      creatorName: r.creator.displayName,
      creatorCode: r.creator.code,
      bankCode: acc.bankCode,
      bankName: acc.bankName,
      account: decrypt(acc.accountEnc),
      holder: decrypt(acc.holderNameEnc),
      amount: r.payoutAmount,
      note: `도네이도 정산 ${r.creator.code}`,
    });
  }
  return rows;
}
