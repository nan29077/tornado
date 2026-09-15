import { prisma } from '@/server/db';
import { kstMonthRange, kstMonthKey } from '@/lib/datetime';
import { normalizeTaxType, taxTypeLabel, type TaxType } from '@/lib/labels';

/**
 * 세무관리 집계 (최고관리자 `/admin/tax` 전용).
 *
 * ── 도네이도의 세무상 위치 ────────────────────────────────────────────────
 * 도네이도는 후원금을 **대신 받아 크리에이터에게 전달**한다. 따라서
 *   - 후원 총액(donation_gross) 은 도네이도의 매출이 **아니다**. 크리에이터에게 줄 채무다.
 *   - 도네이도의 매출은 **플랫폼 수수료** 뿐이다. 부가세 신고 과세표준도 이것이다.
 *   - 크리에이터에게 지급할 때, 크리에이터가 **비사업자(개인)** 이면 도네이도가
 *     사업소득 3.3% 를 원천징수하고 다음 달 10일까지 신고·납부한다.
 *     사업자(일반·간이·면세)면 원천징수하지 않고 크리에이터가 계산서를 발행한다.
 *
 * 이 파일은 **읽기 전용 집계만** 한다. 금액을 만들어 내지 않고, 이미 확정된
 * 정산 원장(settlement_ledger)과 정산 요청(settlement_request)을 다시 세어 보여 준다.
 * 원장은 append-only 이므로 여기서 나온 숫자는 언제 다시 뽑아도 같아야 한다.
 */

/** 원장 금액은 부호가 있다. 차감 분개(-)를 그대로 더하면 합계가 음수가 된다. */
function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * 부가세 포함 금액에서 공급가액과 세액을 뽑는다.
 * 공급가액 = 합계 / 1.1 (원 미만 절사), 세액 = 합계 - 공급가액.
 * 세액을 따로 반올림하면 둘의 합이 원금과 1원 어긋나므로 반드시 차액으로 구한다.
 */
export function splitVat(totalIncludingVat: bigint): { supply: bigint; vat: bigint } {
  if (totalIncludingVat <= 0n) return { supply: 0n, vat: 0n };
  const supply = (totalIncludingVat * 10n) / 11n;
  return { supply, vat: totalIncludingVat - supply };
}

export interface TaxMonthTotals {
  /** 후원 총액 — 거래대금. 도네이도 매출이 아니다. */
  donationGross: bigint;
  /** 플랫폼 수수료 = 도네이도 매출 (부가세 포함 여부는 vatIncluded 로 판단) */
  platformFee: bigint;
  /** 플랫폼 수수료의 공급가액 */
  platformFeeSupply: bigint;
  /** 플랫폼 수수료의 부가세 */
  platformFeeVat: bigint;
  /** PG 수수료 — 도네이도의 매입(비용) */
  pgFee: bigint;
  /** 환불 */
  refund: bigint;
  /** 조정 분개 합계(부호 그대로) */
  adjustment: bigint;
}

export interface TaxPayoutTotals {
  /** 지급 확정 건수 */
  count: number;
  /** 지급총액(과세소득) */
  amount: bigint;
  /** 소득세 3% */
  incomeTax: bigint;
  /** 지방소득세 = 소득세의 10% */
  localTax: bigint;
  /** 원천징수 합계 */
  withholding: bigint;
  /** 실지급액 */
  payoutAmount: bigint;
  /** 원천징수 신고를 아직 완료하지 않은 건수 */
  unfiled: number;
  /** 주민등록번호가 아직 입력되지 않은 건수 (지급명세서를 낼 수 없다) */
  missingResident: number;
}

/** 수수료 정책이 부가세 포함 기준인지. 화면 문구와 계산이 갈라지지 않도록 한 곳에서 읽는다. */
export async function isFeeVatIncluded(): Promise<boolean> {
  // 적용 여부는 `active` 가 아니라 시행 기간으로 판정한다. (정산 계산과 같은 기준)
  const now = new Date();
  const policy = await prisma.feePolicy.findFirst({
    where: {
      scope: 'GLOBAL',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { vatIncluded: true },
  });
  return policy?.vatIncluded ?? true;
}

/**
 * 한 달치 원장 집계.
 * `settlement_key` 가 아니라 **발생 시각(occurredAt)** 으로 자른다.
 * settlement_key 는 정산 회차 라벨이라 지연 분개가 이전 회차에 붙을 수 있고,
 * 부가세 신고 기준은 어디까지나 "그 기간에 발생한 거래" 다.
 */
export async function getLedgerTotals(ym: string, vatIncluded: boolean): Promise<TaxMonthTotals> {
  const { start, end } = kstMonthRange(ym);

  const rows = await prisma.settlementLedger.groupBy({
    by: ['entryType'],
    where: { occurredAt: { gte: start, lt: end } },
    _sum: { amount: true },
  });

  const sumOf = (t: string) => rows.find((r) => r.entryType === t)?._sum.amount ?? 0n;

  const platformFee = abs(sumOf('PLATFORM_FEE'));
  // 부가세 별도 정책이면 수수료 전액이 공급가액이고 세액은 청구 시점에 별도로 붙는다.
  const split = vatIncluded ? splitVat(platformFee) : { supply: platformFee, vat: platformFee / 10n };

  return {
    donationGross: abs(sumOf('DONATION_GROSS')),
    platformFee,
    platformFeeSupply: split.supply,
    platformFeeVat: split.vat,
    pgFee: abs(sumOf('PG_FEE')),
    refund: abs(sumOf('REFUND')) - abs(sumOf('REFUND_FEE_RETURN')),
    adjustment: sumOf('ADJUSTMENT'),
  };
}

/**
 * 한 달치 지급(원천징수) 집계.
 * **지급일(paidAt) 기준**이다. 원천징수 신고 기한은 지급일이 속한 달의 다음 달 10일이므로,
 * 후원일이나 정산 요청일로 자르면 신고 대상이 어긋난다.
 */
export async function getPayoutTotals(ym: string): Promise<TaxPayoutTotals> {
  const { start, end } = kstMonthRange(ym);

  const rows = await prisma.settlementRequest.findMany({
    where: { status: 'PAID', paidAt: { gte: start, lt: end } },
    select: {
      amount: true,
      incomeTax: true,
      localTax: true,
      withholding: true,
      payoutAmount: true,
      withholdingFiledAt: true,
      residentMasked: true,
      residentEnc: true,
    },
  });

  let amount = 0n;
  let incomeTax = 0n;
  let localTax = 0n;
  let withholding = 0n;
  let payoutAmount = 0n;
  let unfiled = 0;
  let missingResident = 0;

  for (const r of rows) {
    amount += r.amount;
    incomeTax += r.incomeTax;
    localTax += r.localTax;
    withholding += r.withholding;
    payoutAmount += r.payoutAmount;
    if (!r.withholdingFiledAt) unfiled += 1;
    // 원천징수액이 0원인 건(소액부징수)은 지급명세서 제출 대상이지만 주민번호가 없어도
    // 신고서에 올릴 수는 있다. 실제로 문제가 되는 건 **징수한 건에 주민번호가 없는 경우**다.
    if (r.withholding > 0n && !r.residentEnc && !r.residentMasked) missingResident += 1;
  }

  return { count: rows.length, amount, incomeTax, localTax, withholding, payoutAmount, unfiled, missingResident };
}

export interface CreatorPayoutRow {
  creatorId: string;
  displayName: string;
  code: string;
  taxType: TaxType;
  businessNo: string | null;
  count: number;
  amount: bigint;
  incomeTax: bigint;
  localTax: bigint;
  withholding: bigint;
  payoutAmount: bigint;
  /** 세무유형과 실제 원천징수가 어긋난 건. 신고 전에 반드시 확인해야 한다. */
  mismatch: boolean;
}

/**
 * 크리에이터별 지급·원천징수 내역 (지급명세서 작성 단위).
 *
 * `mismatch` 는 **세무유형과 실제 징수가 어긋난 상태**를 뜻한다.
 *  - 비사업자인데 원천징수가 0원 → 도네이도가 원천징수의무를 이행하지 않은 것
 *  - 사업자인데 원천징수가 있음 → 크리에이터가 과다 징수당한 것 (환급 필요)
 * 소액부징수(지급액 33,334원 미만)로 0원인 건은 정상이라 어긋남으로 보지 않는다.
 */
export async function getCreatorPayoutRows(ym: string, limit = 300): Promise<CreatorPayoutRow[]> {
  const { start, end } = kstMonthRange(ym);

  const grouped = await prisma.settlementRequest.groupBy({
    by: ['creatorId'],
    where: { status: 'PAID', paidAt: { gte: start, lt: end } },
    _count: { _all: true },
    _sum: { amount: true, incomeTax: true, localTax: true, withholding: true, payoutAmount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const creators = await prisma.creatorProfile.findMany({
    where: { id: { in: grouped.map((g) => g.creatorId) } },
    select: { id: true, displayName: true, code: true, taxType: true, businessNo: true },
  });
  const byId = new Map(creators.map((c) => [c.id, c]));

  return grouped.map((g) => {
    const c = byId.get(g.creatorId);
    const taxType = normalizeTaxType(c?.taxType);
    const amount = g._sum.amount ?? 0n;
    const withholding = g._sum.withholding ?? 0n;
    const shouldWithhold = taxTypeLabel[taxType].withholding;
    // 소액부징수 구간(지급액 33,334원 미만)은 0원이 정상이다.
    const smallAmountOnly = amount < 33_334n;
    const mismatch = shouldWithhold ? withholding === 0n && !smallAmountOnly : withholding > 0n;

    return {
      creatorId: g.creatorId,
      displayName: c?.displayName ?? '(삭제된 크리에이터)',
      code: c?.code ?? '-',
      taxType,
      businessNo: c?.businessNo ?? null,
      count: g._count._all,
      amount,
      incomeTax: g._sum.incomeTax ?? 0n,
      localTax: g._sum.localTax ?? 0n,
      withholding,
      payoutAmount: g._sum.payoutAmount ?? 0n,
      mismatch,
    };
  });
}

export interface CreatorFeeRow {
  creatorId: string;
  displayName: string;
  code: string;
  taxType: TaxType;
  businessNo: string | null;
  businessName: string | null;
  taxInvoiceEmail: string | null;
  /** 이 기간 플랫폼 수수료 합계 (부가세 포함 여부는 정책에 따름) */
  fee: bigint;
  supply: bigint;
  vat: bigint;
}

/**
 * 크리에이터별 플랫폼 수수료 (도네이도가 세금계산서를 **발행**할 대상).
 *
 * 도네이도 → 크리에이터로 나가는 것은 정산금이고, 도네이도가 받는 것은 수수료다.
 * 사업자 크리에이터에게는 그 수수료에 대한 세금계산서를 발행해야 한다.
 * 비사업자에게는 발행 대상이 아니다(수수료가 원천징수와 함께 정산에서 차감될 뿐이다).
 */
export async function getCreatorFeeRows(ym: string, vatIncluded: boolean, limit = 300): Promise<CreatorFeeRow[]> {
  const { start, end } = kstMonthRange(ym);

  const grouped = await prisma.settlementLedger.groupBy({
    by: ['creatorId'],
    where: { entryType: 'PLATFORM_FEE', occurredAt: { gte: start, lt: end } },
    _sum: { amount: true },
    // 차감 분개라 금액이 음수다. 오름차순이 곧 "수수료가 큰 순" 이다.
    orderBy: { _sum: { amount: 'asc' } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const creators = await prisma.creatorProfile.findMany({
    where: { id: { in: grouped.map((g) => g.creatorId) } },
    select: {
      id: true, displayName: true, code: true,
      taxType: true, businessNo: true, businessName: true, taxInvoiceEmail: true,
    },
  });
  const byId = new Map(creators.map((c) => [c.id, c]));

  return grouped.map((g) => {
    const c = byId.get(g.creatorId);
    const fee = abs(g._sum.amount ?? 0n);
    const split = vatIncluded ? splitVat(fee) : { supply: fee, vat: fee / 10n };
    return {
      creatorId: g.creatorId,
      displayName: c?.displayName ?? '(삭제된 크리에이터)',
      code: c?.code ?? '-',
      taxType: normalizeTaxType(c?.taxType),
      businessNo: c?.businessNo ?? null,
      businessName: c?.businessName ?? null,
      taxInvoiceEmail: c?.taxInvoiceEmail ?? null,
      fee,
      supply: split.supply,
      vat: split.vat,
    };
  });
}

/**
 * 세무 일정.
 *
 * 날짜를 하드코딩하지 않고 **기준월에서 계산**한다. 표에 적어 두면 해가 바뀔 때마다
 * 아무도 고치지 않아 작년 일정이 그대로 남는다.
 * (토·일·공휴일이면 다음 영업일로 밀리는 규칙은 국세청 안내를 따르므로 여기서는 원 기한만 적는다)
 */
export interface TaxDeadline {
  title: string;
  dueDate: string;
  detail: string;
  /** 남은 일수. 음수면 이미 지난 기한이다. */
  daysLeft: number;
}

export function getTaxDeadlines(today = new Date()): TaxDeadline[] {
  const kst = new Date(today.getTime() + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth() + 1; // 1~12
  const todayKey = kstMonthKey(today);

  const iso = (yy: number, mm: number, dd: number) =>
    `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const daysFrom = (key: string) =>
    Math.ceil((new Date(`${key}T00:00:00+09:00`).getTime() - today.getTime()) / 86_400_000);

  const items: Array<{ title: string; dueDate: string; detail: string }> = [];

  // 원천징수 이행상황신고 — 매달 10일, 전월 지급분
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  items.push({
    title: '원천징수 이행상황신고·납부',
    dueDate: iso(y, m, 10),
    detail: `${prevMonth} 지급분 사업소득 원천징수(소득세 3% + 지방소득세 0.3%) 신고·납부`,
  });

  // 부가가치세 — 1/25(2기 확정), 4/25(1기 예정), 7/25(1기 확정), 10/25(2기 예정)
  const vatMap: Record<number, string> = {
    1: `${y - 1}년 2기 확정 (7~12월) 신고·납부`,
    4: `${y}년 1기 예정 (1~3월) 신고·납부`,
    7: `${y}년 1기 확정 (4~6월) 신고·납부`,
    10: `${y}년 2기 예정 (7~9월) 신고·납부`,
  };
  for (const mm of [1, 4, 7, 10]) {
    items.push({ title: '부가가치세 신고', dueDate: iso(y, mm, 25), detail: vatMap[mm] });
  }

  // 사업소득 지급명세서(간이) — 반기별. 상반기 7/31, 하반기 다음 해 1/31
  items.push({
    title: '사업소득 간이지급명세서',
    dueDate: iso(y, 7, 31),
    detail: `${y}년 상반기(1~6월) 지급분 제출`,
  });
  items.push({
    title: '사업소득 간이지급명세서',
    dueDate: iso(y + 1, 1, 31),
    detail: `${y}년 하반기(7~12월) 지급분 제출`,
  });
  // 사업소득 지급명세서(연간) — 다음 해 3/10
  items.push({
    title: '사업소득 지급명세서(연간)',
    dueDate: iso(y + 1, 3, 10),
    detail: `${y}년 귀속 전체 지급분 제출`,
  });
  // 법인세 — 12월 결산 법인 기준 다음 해 3/31
  items.push({
    title: '법인세 신고·납부',
    dueDate: iso(y + 1, 3, 31),
    detail: `${y}년 귀속 (12월 결산 법인 기준)`,
  });

  return items
    .map((it) => ({ ...it, daysLeft: daysFrom(it.dueDate) }))
    // 이미 30일 넘게 지난 기한은 감춘다. 남은 기한이 가까운 순으로 본다.
    .filter((it) => it.daysLeft >= -30 || it.dueDate.startsWith(todayKey))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 6);
}
