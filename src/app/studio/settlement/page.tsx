import Link from 'next/link';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, EmptyState, Field, Input, Notice, SectionTitle, Select, StatTile, Table, Td, Textarea, Th, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { BANKS } from '@/components/studio/banks';
import { ResidentField } from '@/components/studio/resident-field';
import { SettlementAmountField } from '@/components/studio/settlement-amount-field';
import { requestSettlementAction, saveSettlementAccountAction } from '@/app/actions/studio';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { getSettlementSummary, resolveFeePolicy, calculateWithholding, computeFees } from '@/server/services/settlement';
import { formatWon, formatNumber } from '@/lib/money';
import { env } from '@/lib/env';
import { formatKst, kstDateKey, kstMonthKey } from '@/lib/datetime';
import { settlementDateFor, toDateKey, formatDateKeyKo, SETTLEMENT_BUSINESS_DAYS } from '@/lib/business-day';
import { loadHolidaysAround, buildScheduleNotice } from '@/server/services/settlement-schedule';
import { ledgerEntryLabel, settlementStatusLabel } from '@/lib/labels';
import { PAID_STATUSES } from '@/components/studio/shared';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'overview', label: '정산 현황' },
  { key: 'request', label: '정산 요청' },
  { key: 'account', label: '정산 계좌' },
  { key: 'ledger', label: '정산 원장' },
] as const;

type SettlementTab = (typeof TABS)[number]['key'];

function ratePercent(rate: string): string {
  return `${(Number(rate) * 100).toFixed(2)}%`;
}

/** YYYY-MM 검증 후 KST 기준 월 시작/끝을 돌려준다. */
function monthRange(ym: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const now = kstMonthKey();
  const key = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? ym : now;
  const [y, mo] = key.split('-').map(Number);
  const start = new Date(`${key}-01T00:00:00+09:00`);
  const nextKey = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  const prevKey = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const end = new Date(`${nextKey}-01T00:00:00+09:00`);
  return { key, start, end, prevKey, nextKey, year: y, month: mo };
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export default async function StudioSettlementPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; tab?: string }>;
}) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;
  const activeTab: SettlementTab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as SettlementTab) : 'overview';
  const range = monthRange(sp.month ?? kstMonthKey());

  const [summary, feePolicy, ledger, requests, account, monthDonations, monthPayouts, priorResident] = await Promise.all([
    getSettlementSummary(creatorId),
    resolveFeePolicy(creatorId),
    prisma.settlementLedger.findMany({
      where: { creatorId },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: { id: true, entryType: true, amount: true, memo: true, occurredAt: true, settlementKey: true },
    }),
    /**
     * `select` 를 명시한다.
     *
     * 없으면 주민등록번호 암호문(`residentEnc`)까지 전 컬럼이 이 화면의 메모리로 올라온다.
     * 지금은 안전한 필드만 렌더하지만, 이 배열을 클라이언트 컴포넌트로 넘기는 리팩터가
     * 한 번만 있어도 곧바로 유출이 된다.
     */
    prisma.settlementRequest.findMany({
      where: { creatorId },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: {
        id: true,
        status: true,
        amount: true,
        withholding: true,
        payoutAmount: true,
        memo: true,
        adminMemo: true,
        payoutFailReason: true,
        payoutBatchNo: true,
        requestedAt: true,
        approvedAt: true,
        paidAt: true,
        rejectedAt: true,
      },
    }),
    prisma.settlementAccount.findUnique({
      where: { creatorId },
      select: {
        bankCode: true, bankName: true, accountTail4: true, holderMasked: true,
        verified: true, verifiedAt: true, updatedAt: true,
      },
    }),
    // 정산 예정일은 후원일보다 뒤에 온다. 지난달 후원이 이번 달에 정산되므로
    // 캘린더에 "정산 예정" 을 채우려면 앞쪽으로 한 달 이상 더 읽어야 한다.
    prisma.donation.findMany({
      where: {
        creatorId,
        status: { in: PAID_STATUSES },
        paidAt: { gte: new Date(range.start.getTime() - 45 * 86_400_000), lt: range.end },
      },
      select: { paidAt: true, amount: true, netAmount: true },
      // 일별 집계용이라 정렬·상한이 없으면 후원이 많은 채널에서 수만 행이 매 요청마다 올라온다.
      orderBy: { paidAt: 'desc' },
      take: 20000,
    }),
    prisma.settlementRequest.findMany({
      where: { creatorId, paidAt: { gte: range.start, lt: range.end } },
      select: { paidAt: true, payoutAmount: true },
    }),
    // 파기 전 등록된 주민번호가 있으면 재입력 없이 진행할 수 있게 마스킹만 보여준다.
    prisma.settlementRequest.findFirst({
      where: { creatorId, residentEnc: { not: null } },
      orderBy: { requestedAt: 'desc' },
      select: { residentMasked: true },
    }),
  ]);

  // 적용 중인 수수료 정책을 실제 정산 계산식에 넣은 예시(후원 1건 기준).
  const feeSample = computeFees(3_000n, {
    pgFeeRate: feePolicy ? feePolicy.pgFeeRate.toString() : '0.018',
    pgFixedFee: feePolicy?.pgFixedFee ?? 0n,
    platformFeeRate: feePolicy ? feePolicy.platformFeeRate.toString() : '0.15',
    vatIncluded: feePolicy ? feePolicy.vatIncluded : true,
  });

  // ── 공휴일 로드 (정산일 계산용) ──────────────────────────────────
  // 영업일 = 토·일과 공휴일을 뺀 날. 공휴일 표는 관리자가 관리한다.
  const holidays = await loadHolidaysAround(
    toDateKey(new Date(range.start.getTime() - 45 * 86_400_000)),
    toDateKey(range.end),
  );

  // ── 일별 집계 (KST) ─────────────────────────────────────────────
  // byDay        : 그 날 "후원" 이 얼마나 들어왔는지
  // scheduledDay : 그 날 "정산" 될 예정 금액 (후원일 + 영업일 5일)
  // payoutByDay  : 그 날 실제로 "지급" 된 금액
  const byDay = new Map<string, { amount: bigint; count: number; settlementDate: string }>();
  const scheduledByDay = new Map<string, { amount: bigint; count: number; from: string[] }>();
  let monthTotal = 0n;
  for (const d of monthDonations) {
    if (!d.paidAt) continue;
    const k = kstDateKey(d.paidAt);
    const settlementDate = settlementDateFor(k, holidays);

    // 이번 달 후원만 후원 집계·월합계에 넣는다(앞쪽 45일은 정산 예정 계산용).
    if (d.paidAt >= range.start) {
      const cur = byDay.get(k) ?? { amount: 0n, count: 0, settlementDate };
      cur.amount += d.amount;
      cur.count += 1;
      byDay.set(k, cur);
      monthTotal += d.amount;
    }

    // 정산 예정일이 이번 달 안이면 캘린더에 표시한다.
    if (settlementDate >= range.key && settlementDate < `${range.nextKey}-01`) {
      const s = scheduledByDay.get(settlementDate) ?? { amount: 0n, count: 0, from: [] };
      s.amount += d.netAmount ?? d.amount;
      s.count += 1;
      if (!s.from.includes(k)) s.from.push(k);
      scheduledByDay.set(settlementDate, s);
    }
  }
  const payoutByDay = new Map<string, bigint>();
  for (const p of monthPayouts) {
    if (!p.paidAt) continue;
    const k = kstDateKey(p.paidAt);
    payoutByDay.set(k, (payoutByDay.get(k) ?? 0n) + p.payoutAmount);
  }

  // 상단 안내에 쓸 예시 (오늘 후원하면 언제, 금·토·일 후원은 언제)
  const notice = await buildScheduleNotice();

  // ── 캘린더 격자 구성 ────────────────────────────────────────────
  const firstDow = new Date(range.start.getTime() + 9 * 3600_000).getUTCDay();
  const daysInMonth = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000);
  const todayKey = kstDateKey();
  const cells: Array<{ day: number; key: string } | null> = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => ({
      day: i + 1,
      key: `${range.key}-${String(i + 1).padStart(2, '0')}`,
    })),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  // 원천징수 미리보기는 실제 요청 시 계산과 **같은 함수**를 써야 한다.
  // 화면은 3.3% 단일 절사, 서버는 2단계 계산이면 요청 직후 금액이 달라져
  // 크리에이터가 "표시된 금액과 다르다"고 느끼게 된다.
  const minSettlement = env.settlement.minRequestAmount;
  const previewWithholding = calculateWithholding(summary.available);
  const isCurrentMonth = range.key === kstMonthKey();

  return (
    <>
      <PageHeader
        title="정산 관리"
        description="일별 후원 현황과 정산 요청·계좌·원장을 탭으로 나눠 관리합니다."
      />

      <nav
        aria-label="정산 관리 메뉴"
        /* 후원 설정 탭과 같은 규칙: 좁은 화면에서는 2x2 로 접어 글자가 잘리지 않게 한다. */
        className="mb-5 grid grid-cols-2 gap-1 rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)] sm:grid-cols-4 sm:gap-0"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/studio/settlement?tab=${tab.key}${sp.month ? `&month=${sp.month}` : ''}`}
            aria-current={activeTab === tab.key ? 'page' : undefined}
            className={cx(
              'flex min-h-11 items-center justify-center rounded-xl px-2 text-center text-[12.5px] font-bold whitespace-nowrap transition-colors sm:px-3 sm:text-[13px]',
              activeTab === tab.key ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-700',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="space-y-5">
        {/* ───────────────────────── 정산 현황 ───────────────────────── */}
        {activeTab === 'overview' ? (
          <>
            {/* ── 정산 주기 안내 ─────────────────────────────────────── */}
            <section>
              <div className="rounded-[22px] border border-brand-200/70 bg-[linear-gradient(135deg,#fffaf0_0%,#fff5e0_100%)] p-4 shadow-[0_8px_24px_rgba(237,166,0,0.10)] sm:p-5">
                <p className="flex items-center gap-1.5 text-[14px] font-black tracking-[-0.01em] text-ink-900">
                  <CalendarClock size={16} strokeWidth={1.9} className="text-brand-700" />
                  정산은 후원일로부터 <span className="text-brand-700">영업일 {SETTLEMENT_BUSINESS_DAYS}일 후</span>에 이루어집니다
                </p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-600">
                  영업일은 <strong>토요일·일요일과 공휴일(법정공휴일·대체공휴일·임시공휴일)을 뺀 날</strong>입니다.
                  연휴가 끼면 그만큼 정산일이 뒤로 밀립니다.
                </p>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-brand-200/60 bg-white/80 px-3.5 py-3">
                    <p className="text-[11px] font-bold text-ink-400">오늘 후원되면</p>
                    <p className="mt-1 text-[13.5px] font-extrabold text-ink-900">
                      {formatDateKeyKo(notice.today)}
                      <span className="mx-1.5 text-brand-500">→</span>
                      <span className="text-brand-700">{formatDateKeyKo(notice.todaySettlement)} 정산</span>
                    </p>
                  </div>
                  <div className="rounded-xl border border-brand-200/60 bg-white/80 px-3.5 py-3">
                    <p className="text-[11px] font-bold text-ink-400">금·토·일 후원분</p>
                    <p className="mt-1 text-[13.5px] font-extrabold text-ink-900">
                      {formatDateKeyKo(notice.weekendDonationDate, false)} ~ 주말
                      <span className="mx-1.5 text-brand-500">→</span>
                      <span className="text-brand-700">{formatDateKeyKo(notice.weekendSettlement)} 정산</span>
                    </p>
                  </div>
                </div>

                <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-400">
                  예) 8월 3일(월) 후원 → 8월 10일(월) 정산. 금·토·일 후원분은 하나로 묶여 다음 주 금요일에 정산됩니다.
                  아래 캘린더에서 <span className="font-bold text-ink-600">후원</span>과{' '}
                  <span className="font-bold text-brand-700">정산 예정</span>을 날짜별로 확인할 수 있습니다.
                </p>
              </div>
            </section>

            <section>
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <StatTile
                  label={`${range.month}월 후원 합계`}
                  value={formatWon(monthTotal)}
                  sub={`${formatNumber(byDay.size)}일 · 결제 완료`}
                />
                <StatTile label="정산 가능금" value={formatWon(summary.available)} tone="brand" />
                <StatTile label="정산 보류금" value={formatWon(summary.pending)} sub="요청 검토 중" tone="warning" />
                <StatTile label="정산 완료금" value={formatWon(summary.totalPaid)} tone="success" />
              </div>
            </section>

            <section>
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <CardTitle>
                    {range.year}년 {range.month}월
                  </CardTitle>
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/studio/settlement?tab=overview&month=${range.prevKey}`}
                      aria-label="이전 달"
                      className="grid h-9 w-9 place-items-center rounded-lg border border-ink-200 text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-900"
                    >
                      <ChevronLeft size={16} strokeWidth={1.8} />
                    </Link>
                    {!isCurrentMonth ? (
                      <Link
                        href="/studio/settlement?tab=overview"
                        className="flex h-9 items-center rounded-lg border border-ink-200 px-3 text-[12px] font-bold text-ink-700 transition-colors hover:bg-ink-50"
                      >
                        이번 달
                      </Link>
                    ) : null}
                    <Link
                      href={`/studio/settlement?tab=overview&month=${range.nextKey}`}
                      aria-label="다음 달"
                      className="grid h-9 w-9 place-items-center rounded-lg border border-ink-200 text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-900"
                    >
                      <ChevronRight size={16} strokeWidth={1.8} />
                    </Link>
                  </div>
                </div>

                <div className="grid grid-cols-7 border-b border-ink-100 pb-2">
                  {WEEKDAYS.map((w, i) => (
                    <p
                      key={w}
                      className={cx(
                        'text-center text-[11px] font-extrabold',
                        i === 0 ? 'text-danger-600' : i === 6 ? 'text-brand-700' : 'text-ink-400',
                      )}
                    >
                      {w}
                    </p>
                  ))}
                </div>

                <div className="grid grid-cols-7">
                  {cells.map((cell, i) => {
                    if (!cell) return <div key={`e${i}`} className="min-h-[72px] border-b border-ink-50 sm:min-h-[84px]" />;
                    const stat = byDay.get(cell.key);
                    const scheduled = scheduledByDay.get(cell.key);
                    const payout = payoutByDay.get(cell.key);
                    const isToday = cell.key === todayKey;
                    const dow = i % 7;
                    const isHoliday = holidays.has(cell.key);
                    return (
                      <div
                        key={cell.key}
                        className={cx(
                          'min-h-[72px] border-b border-ink-50 px-1 py-1.5 sm:min-h-[84px] sm:px-1.5',
                          isToday && 'rounded-lg bg-brand-50/70',
                          !isToday && isHoliday && 'bg-danger-50/40',
                        )}
                      >
                        <p
                          className={cx(
                            'text-[11px] font-bold tabular-nums',
                            isToday
                              ? 'inline-grid h-5 w-5 place-items-center rounded-full bg-brand-400 text-center text-ink-900'
                              : isHoliday || dow === 0
                                ? 'text-danger-600'
                                : dow === 6
                                  ? 'text-brand-700'
                                  : 'text-ink-400',
                          )}
                        >
                          {cell.day}
                        </p>

                        {/* 후원: 그 날 결제 완료된 금액 + 이 후원분이 언제 정산되는지 */}
                        {stat ? (
                          <div className="mt-1 rounded border-l-2 border-ink-300 pl-1">
                            <p className="truncate text-[10.5px] font-extrabold tabular-nums text-ink-900 sm:text-[12px]">
                              {formatWon(stat.amount)}
                            </p>
                            <p className="text-[9.5px] tabular-nums text-ink-400 sm:text-[10.5px]">
                              후원 {stat.count}건
                            </p>
                            <p className="truncate text-[9px] font-semibold tabular-nums text-brand-700 sm:text-[9.5px]">
                              → {formatDateKeyKo(stat.settlementDate, false)} 정산
                            </p>
                          </div>
                        ) : null}

                        {/* 정산 예정: 그 날 정산될 후원분 (영업일 5일 전 후원) */}
                        {scheduled ? (
                          <p className="mt-0.5 truncate rounded bg-brand-50 px-1 py-0.5 text-[9px] font-bold text-brand-700 ring-1 ring-inset ring-brand-200 sm:text-[10px]">
                            정산예정 {formatWon(scheduled.amount)}
                          </p>
                        ) : null}

                        {/* 지급 완료: 실제로 계좌에 나간 금액 */}
                        {payout ? (
                          <p className="mt-0.5 truncate rounded bg-[#e8f7f0] px-1 py-0.5 text-[9px] font-bold text-[#0b7d59] sm:text-[10px]">
                            지급완료 {formatWon(payout)}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {/* 범례 */}
                <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-ink-100 pt-2.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-500">
                    <span className="h-3 w-0.5 rounded bg-ink-300" /> 후원 (결제 완료)
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-500">
                    <span className="h-3 w-3 rounded bg-brand-50 ring-1 ring-inset ring-brand-200" /> 정산 예정
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-500">
                    <span className="h-3 w-3 rounded bg-[#e8f7f0]" /> 지급 완료
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-500">
                    <span className="h-3 w-3 rounded bg-danger-50" /> 공휴일 (영업일 제외)
                  </span>
                </div>

                <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
                  후원 금액은 해당 날짜(KST)에 결제가 완료된 합계이고, 각 날짜 아래의 &ldquo;→ 정산&rdquo;은 그 후원분이
                  지급될 예정일입니다. 정산 예정 금액은 수수료를 뺀 금액 기준이며, 원천징수는 정산 요청 시점에 계산됩니다.
                </p>
              </Card>
            </section>

            <section>
              <SectionTitle title="누적 정산 요약" description="정산 원장 기준 누적 금액입니다." />
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <StatTile label="총 후원금" value={formatWon(summary.totalGross)} />
                <StatTile label="결제수수료" value={formatWon(-summary.totalPgFee)} tone="danger" />
                <StatTile label="플랫폼수수료" value={formatWon(-summary.totalPlatformFee)} tone="danger" />
                <StatTile label="환불·차감" value={formatWon(-summary.totalRefund)} tone="danger" />
              </div>
            </section>
          </>
        ) : null}

        {/* ───────────────────────── 정산 요청 ───────────────────────── */}
        {activeTab === 'request' ? (
          <>
            <section>
              <SectionTitle title="정산 요청" />
              <Card>
                <div className="mb-3">
                  <DataRow
                    label="정산 계좌"
                    value={
                      account ? (
                        <span>
                          {account.bankName} ****{account.accountTail4} · {account.holderMasked}{' '}
                          {account.verified ? <Badge tone="success">인증됨</Badge> : <Badge tone="warning">미인증</Badge>}
                        </span>
                      ) : (
                        <Badge tone="warning">미등록</Badge>
                      )
                    }
                  />
                  <DataRow label="정산 가능금" value={formatWon(summary.available)} />
                  <DataRow
                    label="전액 요청 시 원천징수"
                    value={
                      previewWithholding.exempt
                        ? '0원 (소액부징수)'
                        : formatWon(previewWithholding.total)
                    }
                  />
                  <DataRow
                    label="전액 요청 시 실지급"
                    value={formatWon(summary.available - previewWithholding.total)}
                  />
                </div>

                {!account || !account.verified ? (
                  <Notice tone="warning" title="정산 계좌 인증이 필요합니다">
                    계좌가 등록되지 않았거나 예금주 실명확인이 완료되지 않아 정산을 요청할 수 없습니다. 정산 계좌
                    탭에서 계좌를 먼저 등록해 주세요.
                  </Notice>
                ) : summary.available <= 0n ? (
                  <Notice tone="neutral">현재 정산 가능한 금액이 없습니다.</Notice>
                ) : minSettlement > 0n && summary.available < minSettlement ? (
                  <Notice tone="neutral" title={`최소 정산 요청 금액은 ${formatWon(minSettlement)}입니다`}>
                    현재 정산 가능금은 {formatWon(summary.available)} 입니다. {formatWon(minSettlement)} 이상
                    쌓이면 정산을 요청할 수 있습니다.
                  </Notice>
                ) : (
                  <ActionForm action={requestSettlementAction} submitLabel="정산 요청">
                    <SettlementAmountField
                      available={summary.available.toString()}
                      minAmount={env.settlement.minRequestAmount.toString()}
                    />

                    <ResidentField priorMasked={priorResident?.residentMasked ?? null} />

                    <Field label="메모 (선택)" hint="200자 이내">
                      <Textarea name="memo" rows={2} maxLength={200} placeholder="정산 담당자에게 전달할 내용" />
                    </Field>
                  </ActionForm>
                )}

                <div className="mt-3">
                  <Notice tone="neutral" title="원천징수 계산 방식">
                    사업소득 기준으로 <strong>소득세 3%(10원 미만 절사)</strong> 와{' '}
                    <strong>지방소득세(소득세의 10%, 10원 미만 절사)</strong> 를 각각 산출해 더합니다. 소득세가
                    1,000원 미만이면 <strong>소액부징수</strong>로 원천징수하지 않습니다(정산액 33,334원 미만).
                    최종 세율은 세무 검토 후 확정되며, 사업자 등록 여부와 소득 구분에 따라 달라질 수 있습니다.
                  </Notice>
                </div>
              </Card>
            </section>

            <section>
              <SectionTitle title="정산 요청 내역" description="최근 20건입니다." />
              {requests.length === 0 ? (
                <EmptyState title="정산 요청 내역이 없습니다" />
              ) : (
                <Table className="min-w-full">
                  <thead>
                    <tr>
                      <Th>요청일</Th>
                      <Th>상태</Th>
                      <Th className="text-right">요청금</Th>
                      <Th className="text-right">원천징수</Th>
                      <Th className="text-right">실지급액</Th>
                      <Th>처리 메모</Th>
                      <Th>지급일</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => {
                      const st = settlementStatusLabel[r.status];
                      return (
                        <tr key={r.id}>
                          <Td className="whitespace-nowrap tabular-nums">{formatKst(r.requestedAt, false)}</Td>
                          <Td>
                            <Badge tone={st.tone}>{st.text}</Badge>
                            {r.status === 'PAYOUT_FAILED' && r.payoutFailReason ? (
                              <span className="mt-0.5 block max-w-[160px] break-words text-[11px] text-danger-600">
                                {r.payoutFailReason}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                          {/* 공제액이라 음수로 보여주되, 소액부징수(0원)일 때 "-0원" 이 되지 않게 한다. */}
                          <Td
                            className={cx(
                              'text-right tabular-nums',
                              r.withholding > 0n ? 'text-danger-600' : 'text-ink-400',
                            )}
                          >
                            {r.withholding > 0n ? `-${formatWon(r.withholding)}` : '0원'}
                          </Td>
                          <Td className="text-right font-semibold tabular-nums text-ink-900">{formatWon(r.payoutAmount)}</Td>
                          <Td>
                            {/* 관리자 반려/처리 메모를 크리에이터가 볼 수 있게 노출한다. */}
                            {r.adminMemo ? (
                              <span className="max-w-[200px] break-words text-ink-700">{r.adminMemo}</span>
                            ) : r.memo ? (
                              <span className="max-w-[200px] break-words text-ink-400">내 메모: {r.memo}</span>
                            ) : (
                              '-'
                            )}
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums">{formatKst(r.paidAt, false)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </section>
          </>
        ) : null}

        {/* ───────────────────────── 정산 계좌 ───────────────────────── */}
        {activeTab === 'account' ? (
          <section>
            <SectionTitle
              title="정산 계좌"
              description="정산금을 지급받을 계좌입니다. 변경하면 인증 상태가 초기화되어 다시 관리자 확인을 거칩니다."
            />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                {account ? (
                  <div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <CardTitle>{account.bankName}</CardTitle>
                      {account.verified ? <Badge tone="success">인증 완료</Badge> : <Badge tone="warning">인증 대기</Badge>}
                    </div>
                    <DataRow label="계좌번호" value={`****${account.accountTail4}`} />
                    <DataRow label="예금주" value={account.holderMasked} />
                    <DataRow label="마지막 수정" value={formatKst(account.updatedAt)} />
                    <DataRow label="인증 시각" value={formatKst(account.verifiedAt)} />
                    <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
                      계좌번호와 예금주는 암호화되어 저장되며 화면에는 은행명과 끝 4자리만 표시됩니다.
                    </p>
                  </div>
                ) : (
                  <Notice tone="neutral">등록된 정산 계좌가 없습니다. 오른쪽에서 계좌를 등록해 주세요.</Notice>
                )}
                <div className="mt-3">
                  <Notice tone="warning" title="계좌 실명확인은 아직 mock 단계입니다">
                    예금주 실명확인 API 계약 전이라 저장해도 자동 인증되지 않습니다. 통합 관리자가 확인한 뒤 인증 상태로
                    전환되며, 인증 전에는 정산을 요청할 수 없습니다.
                  </Notice>
                </div>
              </Card>

              <Card>
                <CardTitle>{account ? '계좌 변경' : '계좌 등록'}</CardTitle>
                <div className="mt-3">
                  <ActionForm action={saveSettlementAccountAction} submitLabel={account ? '계좌 변경' : '계좌 등록'}>
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="은행" required>
                        <Select name="bankCode" defaultValue={account?.bankCode ?? '004'}>
                          {BANKS.map((b) => (
                            <option key={b.code} value={b.code}>
                              {b.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="예금주" hint="사업자 계좌라면 사업자명과 동일해야 합니다." required>
                        <Input name="holderName" maxLength={30} placeholder="예금주명" autoComplete="off" />
                      </Field>
                    </div>
                    <Field label="계좌번호" hint="숫자만 입력해 주세요. (8~20자리)" required>
                      <Input
                        name="account"
                        inputMode="numeric"
                        maxLength={24}
                        placeholder="- 없이 숫자만"
                        autoComplete="off"
                        className="tabular-nums"
                      />
                    </Field>
                  </ActionForm>
                </div>
              </Card>
            </div>
          </section>
        ) : null}

        {/* ───────────────────────── 정산 원장 ───────────────────────── */}
        {activeTab === 'ledger' ? (
          <>
            <section>
              <SectionTitle title="적용 중인 수수료 정책" />
              <Card>
                {feePolicy ? (
                  <div>
                    <DataRow label="적용 범위" value={feePolicy.scope === 'CREATOR' ? '내 채널 전용 정책' : '플랫폼 공통 정책'} />
                    <DataRow label="결제수수료율" value={ratePercent(feePolicy.pgFeeRate.toString())} />
                    <DataRow label="결제 건당 고정비" value={formatWon(feePolicy.pgFixedFee)} />
                    <DataRow label="플랫폼수수료율" value={ratePercent(feePolicy.platformFeeRate.toString())} />
                    <DataRow label="문자 원가" value={formatWon(feePolicy.smsCost)} />
                    <DataRow
                      label="부가세"
                      value={feePolicy.vatIncluded ? '요율에 포함 (추가 차감 없음)' : '별도 (수수료의 10% 추가 차감)'}
                    />
                    <DataRow label="적용 시작" value={formatKst(feePolicy.effectiveFrom, false)} />
                    <DataRow
                      label={`${formatWon(feeSample.gross)} 후원 시 정산금`}
                      value={
                        <span>
                          {formatWon(feeSample.net)}
                          <span className="text-ink-400">
                            {' '}
                            (수수료 {formatWon(feeSample.pgFee + feeSample.platformFee)}
                            {feeSample.vat > 0n ? `, 이 중 부가세 ${formatWon(feeSample.vat)}` : ''} 차감)
                          </span>
                        </span>
                      }
                    />
                  </div>
                ) : (
                  <Notice tone="warning">적용 중인 수수료 정책이 없습니다. 고객센터로 문의해 주세요.</Notice>
                )}
                {summary.totalAdjustment !== 0n ? (
                  <div className="mt-2.5">
                    <Notice tone="neutral">
                      관리자 조정 분개가 {formatWon(summary.totalAdjustment)} 반영되어 있습니다. 상세 내용은 아래
                      원장에서 확인해 주세요.
                    </Notice>
                  </div>
                ) : null}
              </Card>
            </section>

            <section>
              <SectionTitle
                title="정산 원장"
                description="최근 50건입니다. 원장은 수정·삭제되지 않으며 정정은 반대 분개로 기록됩니다."
              />
              {ledger.length === 0 ? (
                <EmptyState title="원장 기록이 없습니다" description="결제가 완료된 후원이 발생하면 자동으로 기록됩니다." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>발생 시각</Th>
                      <Th>구분</Th>
                      <Th className="text-right">금액</Th>
                      <Th>정산월</Th>
                      <Th>메모</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((e) => (
                      <tr key={e.id}>
                        <Td className="whitespace-nowrap tabular-nums">{formatKst(e.occurredAt, false)}</Td>
                        <Td className="whitespace-nowrap">{ledgerEntryLabel[e.entryType]}</Td>
                        <Td
                          className={
                            e.amount < 0n
                              ? 'whitespace-nowrap text-right font-semibold tabular-nums text-danger-600'
                              : 'whitespace-nowrap text-right font-semibold tabular-nums text-success-600'
                          }
                        >
                          {e.amount >= 0n ? '+' : ''}
                          {formatWon(e.amount)}
                        </Td>
                        <Td className="whitespace-nowrap tabular-nums">{e.settlementKey}</Td>
                        <Td>{e.memo ?? '-'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </section>

            <Card>
              <CardTitle>정산 절차 안내</CardTitle>
              <ol className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-500">
                <li>1. 결제가 승인되면 후원 총액과 수수료가 정산 원장에 자동 기록됩니다.</li>
                <li>2. 환불이 발생하면 반대 분개로 차감되고 플랫폼수수료는 환입됩니다.</li>
                <li>3. 정산 가능금 범위에서 요청하면 통합 관리자 검토 후 지급대행으로 지급됩니다.</li>
                <li>4. 지급이 완료되면 원장에 지급·원천징수 분개가 추가되고 캘린더에 지급일이 표시됩니다.</li>
              </ol>
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
