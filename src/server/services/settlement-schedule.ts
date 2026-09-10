import { prisma } from '@/server/db';
import {
  SETTLEMENT_BUSINESS_DAYS,
  addDaysKey,
  isBusinessDay,
  settlementDateFor,
  toDateKey,
} from '@/lib/business-day';

/**
 * 정산 주기 계산.
 *
 * 운영 규칙: **후원(결제 완료)일 다음날부터 영업일 5일째가 정산일.**
 * 영업일에서 토·일과 공휴일(법정공휴일·대체공휴일·임시공휴일·근로자의 날)을 뺀다.
 *
 * 공휴일은 public_holiday 표에서 읽는다. 임시공휴일은 매년 갑자기 지정되므로
 * 코드 상수로 두면 그때마다 배포해야 하고, 배포가 늦으면 정산일이 통째로 틀어진다.
 */

/**
 * 공휴일 조회에 쓸 수 있는 최소 클라이언트.
 *
 * **트랜잭션 안에서 부를 때는 그 tx 를 반드시 넘겨야 한다.**
 * 전역 `prisma` 로 읽으면 트랜잭션이 이미 커넥션 하나를 쥔 채 **풀에서 또 하나를 달라고
 * 기다리게 된다.** 그 커넥션은 트랜잭션이 끝나야 반납되는데 트랜잭션은 이 조회를 기다리므로
 * 서로를 기다리다 `timeout exceeded when trying to connect` 로 죽는다.
 * (정산 요청은 `withAdvisoryLock` 트랜잭션 안에서 `computeHoldingAmount` 를 부르므로
 *  정확히 이 경로를 탄다 — 커넥션 풀이 작은 환경에서 정산 요청이 통째로 실패했다)
 */
type HolidayClient = Pick<typeof prisma, 'publicHoliday'>;

/** 조회 구간에 걸치는 공휴일 집합을 읽는다. */
export async function loadHolidays(
  fromDateKey: string,
  toDateKeyStr: string,
  client: HolidayClient = prisma,
): Promise<Set<string>> {
  const rows = await client.publicHoliday.findMany({
    where: { active: true, date: { gte: fromDateKey, lte: toDateKeyStr } },
    select: { date: true },
  });
  return new Set(rows.map((r) => r.date));
}

/**
 * 정산일 계산에 필요한 여유 구간까지 포함해 공휴일을 읽는다.
 * 월 마지막 날 후원의 정산일은 다음 달로 넘어가므로 뒤쪽을 넉넉히 잡는다.
 */
export async function loadHolidaysAround(
  fromDateKey: string,
  toDateKeyStr: string,
  client: HolidayClient = prisma,
): Promise<Set<string>> {
  return loadHolidays(addDaysKey(fromDateKey, -40), addDaysKey(toDateKeyStr, 40), client);
}

/** 공휴일이 하나도 등록되지 않은 연도를 찾아낸다(정산일 오계산 조기 경보). */
export async function findYearsMissingHolidays(years: number[]): Promise<number[]> {
  const missing: number[] = [];
  for (const y of years) {
    const count = await prisma.publicHoliday.count({
      where: { active: true, date: { gte: `${y}-01-01`, lte: `${y}-12-31` } },
    });
    if (count === 0) missing.push(y);
  }
  return missing;
}

export interface SettlementScheduleRow {
  /** 후원(결제 완료)일 YYYY-MM-DD */
  donationDate: string;
  /** 정산 예정일 YYYY-MM-DD */
  settlementDate: string;
  count: number;
  gross: bigint;
  net: bigint;
}

/**
 * 기간 내 결제 완료 후원을 후원일별로 묶고, 각 후원일의 정산 예정일을 붙인다.
 *
 * 쓰는 곳
 *  - `tests/settlement-process.test.ts` — 정산일 규칙(영업일 5일·주말 병합)의 기준 검증
 *  - 후원일별 정산 예정표가 필요한 화면을 만들 때의 단일 출처
 *
 * **정산 가능액에서 보류 금액을 빼는 실제 판정**은 여기가 아니라
 * `services/settlement.ts` 의 `computeHoldingAmount` 가 한다(원장 기준으로 계산해야
 * 환불·수수료 환입까지 순액으로 반영되기 때문). 두 함수 모두 `settlementDateFor` +
 * `loadHolidaysAround` 라는 같은 규칙을 쓰므로 결과가 어긋나지 않는다.
 */
export async function buildSettlementSchedule(
  creatorId: string,
  start: Date,
  end: Date,
): Promise<SettlementScheduleRow[]> {
  const donations = await prisma.donation.findMany({
    where: {
      creatorId,
      paidAt: { gte: start, lt: end },
      status: { in: ['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'] },
    },
    select: { paidAt: true, amount: true, netAmount: true },
  });

  const holidays = await loadHolidaysAround(toDateKey(start), toDateKey(end));

  const byDate = new Map<string, { count: number; gross: bigint; net: bigint }>();
  for (const d of donations) {
    if (!d.paidAt) continue;
    const key = toDateKey(d.paidAt);
    const cur = byDate.get(key) ?? { count: 0, gross: 0n, net: 0n };
    cur.count += 1;
    cur.gross += d.amount;
    cur.net += d.netAmount ?? 0n;
    byDate.set(key, cur);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([donationDate, v]) => ({
      donationDate,
      settlementDate: settlementDateFor(donationDate, holidays),
      count: v.count,
      gross: v.gross,
      net: v.net,
    }));
}

export interface ScheduleNotice {
  /** 오늘(KST) */
  today: string;
  /** 오늘 후원하면 언제 정산되는지 */
  todaySettlement: string;
  /** 이번 주 금·토·일 후원이 언제 정산되는지 (동일 정산일로 모인다) */
  weekendDonationDate: string;
  weekendSettlement: string;
  businessDays: number;
  /** 오늘이 영업일인지 */
  todayIsBusinessDay: boolean;
}

/** 정산 현황 상단 안내에 쓰는 예시값. */
export async function buildScheduleNotice(now: Date = new Date()): Promise<ScheduleNotice> {
  const today = toDateKey(now);
  const holidays = await loadHolidaysAround(addDaysKey(today, -10), addDaysKey(today, 40));

  // 이번 주 금요일(오늘 기준 가장 가까운 금요일)을 예시로 잡는다.
  let friday = today;
  for (let i = 0; i < 7; i += 1) {
    const [y, m, d] = friday.split('-').map(Number);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 5) break;
    friday = addDaysKey(friday, 1);
  }

  return {
    today,
    todaySettlement: settlementDateFor(today, holidays),
    weekendDonationDate: friday,
    weekendSettlement: settlementDateFor(friday, holidays),
    businessDays: SETTLEMENT_BUSINESS_DAYS,
    todayIsBusinessDay: isBusinessDay(today, holidays),
  };
}
