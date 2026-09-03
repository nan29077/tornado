import type * as React from 'react';
import Link from 'next/link';
import { Badge, Card, EmptyState, Notice, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { InlineActionForm } from '@/components/studio/action-form';
import { PAID_STATUSES, one, type SearchParamsRecord } from '@/components/studio/shared';
import { blockDonorAction } from '@/app/actions/studio';
import { MoNumberPanel, type MoNumberView } from '@/components/studio/mo-number-panel';
import { formatMoNumber } from '@/server/emma';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { donationStatusLabel, moResultLabel, moNumberStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

const TAKE = 50;

const TABS = [
  { value: 'all', label: '전체 수신' },
  { value: 'success', label: '후원 성공' },
  { value: 'failed', label: '결제 실패' },
  { value: 'unregistered', label: '미등록 사용자' },
  { value: 'blocked', label: '차단됨' },
  { value: 'filtered', label: '금칙어 포함' },
  { value: 'youtube_failed', label: '유튜브 전송 실패' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

function tabWhere(tab: TabValue): Prisma.MoInboundMessageWhereInput {
  switch (tab) {
    case 'success':
      return { donation: { status: { in: PAID_STATUSES } } };
    case 'failed':
      return { donation: { status: 'PAYMENT_FAILED' } };
    case 'unregistered':
      return { OR: [{ result: 'UNREGISTERED_DONOR' }, { donation: { status: 'UNREGISTERED' } }] };
    case 'blocked':
      return { OR: [{ result: 'BLOCKED' }, { donation: { status: { in: ['LIMIT_BLOCKED', 'CONTENT_BLOCKED'] } } }] };
    case 'filtered':
      return { OR: [{ donation: { status: 'CONTENT_BLOCKED' } }, { contentFiltered: { contains: '*' } }] };
    case 'youtube_failed':
      return { donation: { youtubeStatus: 'FAILED' } };
    default:
      return {};
  }
}

export default async function StudioMessagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;

  const raw = one(sp.tab) as TabValue;
  const tab: TabValue = TABS.some((t) => t.value === raw) ? raw : 'all';

  const where: Prisma.MoInboundMessageWhereInput = { creatorId, ...tabWhere(tab) };

  /**
   * 페이지네이션을 붙인다.
   *
   * 예전에는 최근 50건만 보여 주고 다음 페이지로 가는 수단이 아예 없었다.
   * 어제 온 문자를 확인할 방법이 없어, 같은 성격의 후원 내역 화면(페이저 있음)과
   * 기능 수준도 어긋났다.
   */
  const rawPage = Number(one(sp.page));
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

  const [total, rows, blockedRows, moNumbers, creator] = await Promise.all([
    prisma.moInboundMessage.count({ where }),
    prisma.moInboundMessage.findMany({
      where,
      // 보조 정렬키가 없으면 웹훅으로 대량 동시 수신될 때 페이지 간 중복·누락이 생긴다.
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * TAKE,
      take: TAKE,
      select: {
        id: true,
        receivedAt: true,
        phoneMasked: true,
        matchedKeyword: true,
        messageType: true,
        contentFiltered: true,
        result: true,
        resultDetail: true,
        donation: {
          select: { id: true, transactionNo: true, status: true, amount: true, donorId: true, youtubeStatus: true },
        },
      },
    }),
    // 차단 목록 전체를 읽을 필요가 없다. 화면에 그릴 50건과 겹치는지만 알면 된다.
    // (차단 후원자가 수천 명이면 매 요청마다 전량을 읽게 된다)
    prisma.blockedDonor.findMany({ where: { creatorId }, select: { donorId: true }, take: 2000 }),
    prisma.creatorMoNumber.findMany({
      where: { creatorId },
      orderBy: [{ status: 'asc' }, { assignedAt: 'desc' }],
      select: { id: true, phoneNumber: true, keyword: true, mode: true, status: true, assignedAt: true },
    }),
    prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { displayName: true, donationAmount: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / TAKE));
  // 범위를 벗어난 페이지로 들어와도 빈 화면에 갇히지 않게 표시용 값은 잘라 둔다.
  const safePage = Math.min(page, totalPages);
  const blockedSet = new Set(blockedRows.map((b) => b.donorId));

  const numbers: MoNumberView[] = moNumbers.map((m) => ({
    id: m.id,
    phoneNumber: formatMoNumber(m.phoneNumber),
    keyword: m.keyword,
    mode: m.mode,
    statusText: moNumberStatusLabel[m.status].text,
    statusTone: moNumberStatusLabel[m.status].tone,
    assignedAt: m.assignedAt ? formatKst(m.assignedAt, false) : null,
  }));

  // 방송 화면에 띄울 안내 문구 (배정된 번호가 있을 때만)
  const primary = moNumbers.find((m) => m.status === 'ASSIGNED') ?? moNumbers[0] ?? null;
  const guideText = primary
    ? [
        `${creator?.displayName ?? '크리에이터'} 문자후원`,
        `${formatMoNumber(primary.phoneNumber)} 으로 문자를 보내주세요.`,
        primary.keyword ? `문자 맨 앞에 ${primary.keyword} 를 붙여주세요.` : null,
        `문자 1건당 ${formatWon(creator?.donationAmount ?? 3000n)}이 후원됩니다.`,
        '최초 1회 계좌 등록이 필요하며, 만 19세 이상만 이용할 수 있습니다.',
      ]
        .filter(Boolean)
        .join('\n')
    : null;

  return (
    <>
      <PageHeader
        title="문자 관리"
        description={`수신된 문자 ${formatNumber(total)}건 · ${formatNumber(totalPages)}쪽 중 ${formatNumber(safePage)}쪽`}
      />

      <div className="space-y-4">
        <MoNumberPanel numbers={numbers} guideText={guideText} />

        <Notice tone="neutral" title="문자 원문은 표시되지 않습니다">
          방송 노출용으로 필터링된 내용만 확인할 수 있습니다. 개인정보가 포함될 수 있는 원문과 후원자 전화번호 전체는
          크리에이터에게 제공되지 않습니다.
        </Notice>

        <Card padded={false}>
          <div className="flex flex-wrap gap-1.5 p-2">
            {TABS.map((t) => (
              <Link
                key={t.value}
                href={t.value === 'all' ? '/studio/messages' : `/studio/messages?tab=${t.value}`}
                className={
                  t.value === tab
                    ? 'rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-700'
                    : 'rounded-lg px-3 py-2 text-[13px] font-medium text-ink-500 hover:bg-ink-50 hover:text-ink-900'
                }
              >
                {t.label}
              </Link>
            ))}
          </div>
        </Card>

        {rows.length === 0 ? (
          <EmptyState title="해당 조건의 문자가 없습니다" description="다른 탭을 선택해 보세요." />
        ) : (
          <Table className="min-w-full">
            <thead>
              <tr>
                <Th>수신시각</Th>
                <Th>후원자</Th>
                <Th>키워드</Th>
                <Th>내용(필터링됨)</Th>
                <Th>처리 결과</Th>
                <Th>후원 상태</Th>
                <Th className="text-right">후원금</Th>
                <Th>조치</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const res = moResultLabel[m.result];
                const donation = m.donation;
                const ds = donation ? donationStatusLabel[donation.status] : null;
                const donorId = donation?.donorId ?? null;
                const isBlocked = donorId ? blockedSet.has(donorId) : false;
                return (
                  <tr key={m.id} className="hover:bg-ink-50">
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(m.receivedAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m.phoneMasked}</Td>
                    <Td className="whitespace-nowrap">{m.matchedKeyword ?? '-'}</Td>
                    <Td className="max-w-[320px]">
                      <span className="line-clamp-2">{m.contentFiltered ?? '(표시할 내용 없음)'}</span>
                    </Td>
                    <Td>
                      <Badge tone={res.tone}>{res.text}</Badge>
                      {m.resultDetail ? (
                        <span className="mt-1 block text-[11.5px] text-ink-400">{m.resultDetail}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {donation && ds ? (
                        <Link href={`/studio/donations/${donation.id}`} className="inline-block">
                          <Badge tone={ds.tone}>{ds.text}</Badge>
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {donation ? formatWon(donation.amount) : '-'}
                    </Td>
                    <Td>
                      {donorId ? (
                        isBlocked ? (
                          <Badge tone="danger">차단됨</Badge>
                        ) : (
                          <InlineActionForm
                            action={blockDonorAction}
                            submitLabel="후원자 차단"
                            variant="danger"
                            confirmMessage="이 후원자를 차단하시겠습니까? 이후 문자는 후원으로 접수되지 않습니다."
                            fields={{ donorId, reason: '문자 관리 화면에서 차단' }}
                          />
                        )
                      ) : (
                        <span className="text-[12px] text-ink-300">후원자 미확인</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {totalPages > 1 ? (
          <nav className="flex items-center justify-center gap-2" aria-label="문자 목록 페이지 이동">
            <PageLink href={`/studio/messages?tab=${tab}&page=${safePage - 1}`} disabled={safePage <= 1}>
              이전
            </PageLink>
            <span className="text-[13px] tabular-nums text-ink-500">
              {safePage} / {totalPages}
            </span>
            <PageLink href={`/studio/messages?tab=${tab}&page=${safePage + 1}`} disabled={safePage >= totalPages}>
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
      className="inline-flex h-9 items-center rounded-lg border border-ink-200 px-3 text-[13px] font-semibold text-ink-700 hover:bg-ink-50"
    >
      {children}
    </Link>
  );
}
