import Link from 'next/link';
import { LayoutGrid, Rows3, Search } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Td, Th, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { buildQuery, one, type SearchParamsRecord } from '@/components/studio/shared';
import { DonationCardGrid } from '@/components/studio/donation-cards';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import { deliveryStatusLabel, donationStatusLabel, refundStatusLabel } from '@/lib/labels';
import type { DonationStatus, Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

const PERIODS = [
  { value: 'today', label: '오늘' },
  { value: '7d', label: '최근 7일' },
  { value: '30d', label: '최근 30일' },
  { value: 'all', label: '전체' },
] as const;

const STATUS_VALUES = Object.keys(donationStatusLabel) as DonationStatus[];

/**
 * 보기 방식. 기본은 카드다.
 * 표는 컬럼이 12개라 모바일에서 가로 스크롤 없이는 읽을 수 없으므로,
 * 한 건씩 세로로 읽히는 카드를 기본으로 두고 표는 선택할 수 있게 남긴다.
 */
const VIEWS = [
  { value: 'card', label: '카드', icon: LayoutGrid },
  { value: 'table', label: '표', icon: Rows3 },
] as const;

type ViewMode = (typeof VIEWS)[number]['value'];

/**
 * 기간 필터의 시작 시각.
 *
 * 모두 **KST 날짜 경계**로 맞춘다. 예전에는 '오늘'만 KST 자정이고 7일·30일은 현재 시각
 * 기준 롤링이라, 오전에 "최근 7일"을 열면 7일 전 오전까지만 보였다. 사용자가 기대하는
 * "지난 7일치 날짜"와 다르고, 두 기준이 한 화면에 섞여 있었다.
 */
function periodStart(period: string): Date | null {
  const now = new Date();
  if (period === 'today') return kstStartOfDay(now);
  if (period === '7d') return kstStartOfDay(new Date(now.getTime() - 6 * 86_400_000));
  if (period === '30d') return kstStartOfDay(new Date(now.getTime() - 29 * 86_400_000));
  return null;
}

export default async function StudioDonationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;

  const period = one(sp.period) || '30d';
  const status = one(sp.status);
  const q = one(sp.q).trim();
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const rawView = one(sp.view);
  const view: ViewMode = VIEWS.some((v) => v.value === rawView) ? (rawView as ViewMode) : 'card';

  const where: Prisma.DonationWhereInput = { creatorId };
  const gte = periodStart(period);
  if (gte) where.receivedAt = { gte };
  if (status && (STATUS_VALUES as string[]).includes(status)) where.status = status as DonationStatus;
  /**
   * 거래번호는 `TRD-` 접두사가 붙은 고정 포맷이고 유니크 인덱스가 있다.
   * 앞뒤 와일드카드(contains) + insensitive 로 찾으면 그 인덱스를 전혀 쓰지 못해
   * 후원이 쌓일수록 검색이 통째로 느려진다. 앞부분 일치로 바꾼다.
   */
  if (q) where.transactionNo = { startsWith: q.toUpperCase() };

  // 먼저 전체 건수를 알아야 페이지 번호를 범위 안으로 자를 수 있다.
  const total = await prisma.donation.count({ where });
  const totalPagesForClamp = Math.max(1, Math.ceil(total / PAGE_SIZE));
  /**
   * 범위를 벗어난 페이지로 들어와도 빈 화면에 갇히지 않게 마지막 쪽으로 자른다.
   * (`?page=99999` 면 "조건에 맞는 내역이 없습니다"가 떠서 필터 문제로 오인했다)
   */
  const safePage = Math.min(page, totalPagesForClamp);

  const [rows] = await Promise.all([
    prisma.donation.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: (safePage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        transactionNo: true,
        receivedAt: true,
        displayName: true,
        anonymous: true,
        message: true,
        channel: true,
        amount: true,
        status: true,
        youtubeStatus: true,
        overlayStatus: true,
        mtStatus: true,
        donor: { select: { phoneMasked: true } },
        refunds: { orderBy: { requestedAt: 'desc' }, take: 1, select: { status: true } },
      },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 보기 방식은 페이지를 넘겨도 유지된다.
  const base = { period, status, q, view };

  return (
    <>
      <PageHeader
        title="후원 내역"
        description={`조건에 해당하는 후원 ${formatNumber(total)}건 (${safePage}/${totalPages} 페이지)`}
      />

      <div className="space-y-4">
        <Card>
          <form method="get" className="grid gap-3 md:grid-cols-[1fr_1fr_2fr_auto] md:items-end">
            <Field label="기간">
              <Select name="period" defaultValue={period}>
                {PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="상태">
              <Select name="status" defaultValue={status}>
                <option value="">전체 상태</option>
                {STATUS_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {donationStatusLabel[s].text}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="거래번호 검색">
              <Input name="q" defaultValue={q} placeholder="TRD-20260819-XXXXXXXX" />
            </Field>
            <Button type="submit" variant="secondary">
              <Search size={16} strokeWidth={1.7} />
              조회
            </Button>
            {/* 조회해도 보기 방식이 초기화되지 않게 함께 넘긴다 */}
            <input type="hidden" name="view" value={view} />
          </form>
        </Card>

        {/* 보기 전환 */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-ink-400">
            후원 {formatNumber(total)}건 중 {formatNumber(rows.length)}건 표시
          </p>
          <nav
            aria-label="보기 방식"
            className="flex shrink-0 items-center gap-1 rounded-xl border border-ink-100 bg-white p-1"
          >
            {VIEWS.map((v) => {
              const Icon = v.icon;
              const active = view === v.value;
              return (
                <Link
                  key={v.value}
                  href={`/studio/donations${buildQuery(base, { view: v.value, page })}`}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-bold transition-colors',
                    active ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
                  )}
                >
                  <Icon size={15} strokeWidth={1.7} />
                  {v.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {rows.length === 0 ? (
          <EmptyState title="조건에 맞는 후원 내역이 없습니다" description="기간이나 상태 조건을 바꿔서 다시 조회해 보세요." />
        ) : view === 'card' ? (
          <DonationCardGrid
            items={rows.map((d) => ({
              id: d.id,
              transactionNo: d.transactionNo,
              receivedAt: d.receivedAt,
              displayName: d.displayName,
              anonymous: d.anonymous,
              message: d.message,
              amount: d.amount,
              status: d.status,
              channel: d.channel,
              // 마스킹된 값만 내려온다. 원문 전화번호는 크리에이터에게 제공하지 않는다.
              phoneMasked: d.donor?.phoneMasked ?? null,
              delivery: { youtube: d.youtubeStatus, overlay: d.overlayStatus, mt: d.mtStatus },
              refundStatus: d.refunds[0]?.status ?? null,
            }))}
          />
        ) : (
          <Table className="min-w-full">
            <thead>
              <tr>
                <Th>거래번호</Th>
                <Th>수신시각</Th>
                <Th>후원자</Th>
                <Th>표시명</Th>
                <Th>접수</Th>
                <Th>내용</Th>
                <Th className="text-right">후원금</Th>
                <Th>결제 상태</Th>
                <Th>유튜브</Th>
                <Th>오버레이</Th>
                <Th>MT 안내</Th>
                <Th>환불</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const st = donationStatusLabel[d.status];
                const yt = deliveryStatusLabel[d.youtubeStatus];
                const ov = deliveryStatusLabel[d.overlayStatus];
                const mt = deliveryStatusLabel[d.mtStatus];
                const refund = d.refunds[0] ? refundStatusLabel[d.refunds[0].status] : null;
                return (
                  <tr key={d.id} className="hover:bg-ink-50">
                    <Td>
                      <Link
                        href={`/studio/donations/${d.id}`}
                        className="font-mono text-[12px] font-semibold text-brand-700 underline-offset-2 hover:underline"
                      >
                        {d.transactionNo}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(d.receivedAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{d.donor?.phoneMasked ?? '-'}</Td>
                    <Td className="whitespace-nowrap">{d.anonymous ? '익명의 후원자' : d.displayName}</Td>
                    <Td>
                      <Badge tone={d.channel === 'WEB' ? 'brand' : 'neutral'}>
                        {d.channel === 'WEB' ? '웹(PC)' : '문자(MO)'}
                      </Badge>
                    </Td>
                    <Td className="max-w-[280px]">
                      <span className="line-clamp-2">{d.message || '-'}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-right font-semibold tabular-nums text-ink-900">
                      {formatWon(d.amount)}
                    </Td>
                    <Td>
                      <Badge tone={st.tone}>{st.text}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={yt.tone}>{yt.text}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={ov.tone}>{ov.text}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={mt.tone}>{mt.text}</Badge>
                    </Td>
                    <Td>{refund ? <Badge tone={refund.tone}>{refund.text}</Badge> : <span className="text-ink-300">-</span>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {totalPages > 1 ? (
          <nav className="flex items-center justify-center gap-2">
            <PageLink href={`/studio/donations${buildQuery(base, { page: safePage - 1 })}`} disabled={safePage <= 1}>
              이전
            </PageLink>
            <span className="text-[13px] tabular-nums text-ink-500">
              {safePage} / {totalPages}
            </span>
            <PageLink href={`/studio/donations${buildQuery(base, { page: safePage + 1 })}`} disabled={safePage >= totalPages}>
              다음
            </PageLink>
          </nav>
        ) : null}
      </div>
    </>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return (
      <span className="inline-flex h-9 items-center rounded-lg border border-ink-100 px-3 text-[13px] font-semibold text-ink-300">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center rounded-lg border border-ink-200 bg-white px-3 text-[13px] font-semibold text-ink-700 hover:bg-ink-50"
    >
      {children}
    </Link>
  );
}
