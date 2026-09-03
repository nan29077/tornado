import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, CreatorOptions, FilterBar, Pager } from '@/components/admin/controls';
import { shortId } from '@/components/admin/mask';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { moResultLabel, donationStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { MoProcessResult } from '@/generated/prisma/enums';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

const RESULTS: MoProcessResult[] = [
  'PENDING', 'ROUTED', 'UNKNOWN_ROUTE', 'DUPLICATE', 'UNREGISTERED_DONOR', 'BLOCKED', 'ERROR',
];

function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(`${raw}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AdminMoMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{
    result?: string; creatorId?: string; from?: string; to?: string; number?: string; page?: string;
  }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/mo-messages');

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const result = RESULTS.includes(sp.result as MoProcessResult) ? (sp.result as MoProcessResult) : undefined;
  const creatorId = (sp.creatorId ?? '').trim() || undefined;
  const receivedNumber = (sp.number ?? '').trim();
  const from = parseDate(sp.from);
  const toRaw = parseDate(sp.to);
  const to = toRaw ? new Date(toRaw.getTime() + 86_400_000) : undefined;

  const where: Prisma.MoInboundMessageWhereInput = {
    ...(result ? { result } : {}),
    ...(creatorId ? { creatorId } : {}),
    ...(receivedNumber ? { receivedNumber: { contains: receivedNumber } } : {}),
    ...(from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };

  const [total, messages, grouped, creators] = await Promise.all([
    prisma.moInboundMessage.count({ where }),
    prisma.moInboundMessage.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, providerMessageId: true, providerCode: true, receivedNumber: true, phoneMasked: true,
        messageType: true, contentFiltered: true, matchedKeyword: true, result: true, resultDetail: true,
        receivedAt: true, processedAt: true,
        creator: { select: { id: true, displayName: true, code: true } },
        donation: { select: { id: true, transactionNo: true, status: true } },
      },
    }),
    prisma.moInboundMessage.groupBy({ by: ['result'], _count: { _all: true } }),
    // 필터 옵션은 승인 크리에이터만, 상한을 두고 읽는다.
    // (반려·정지 채널까지 전부 옵션으로 렌더할 이유가 없다)
    prisma.creatorProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
      take: CREATOR_OPTION_LIMIT,
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/mo-messages', { result: result ?? '', creatorId: creatorId ?? '', number: receivedNumber, from: sp.from ?? '', to: sp.to ?? '' }, page, lastPage, total);
  const countOf = (r: MoProcessResult) => grouped.find((g) => g.result === r)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="수신 문자 관리"
        description="MO 사업자로부터 수신한 원문은 암호화 보관되며 관리자 화면에서도 복호화하지 않습니다. 필터링된 노출용 문구만 표시합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="정상 라우팅" value={formatNumber(countOf('ROUTED'))} tone="success" />
        <StatTile label="대상 없음" value={formatNumber(countOf('UNKNOWN_ROUTE'))} tone={countOf('UNKNOWN_ROUTE') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="미등록 후원자" value={formatNumber(countOf('UNREGISTERED_DONOR'))} tone={countOf('UNREGISTERED_DONOR') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="처리 오류" value={formatNumber(countOf('ERROR'))} tone={countOf('ERROR') > 0 ? 'danger' : 'neutral'} />
      </div>

      <FilterBar action="/admin/mo-messages" resetHref="/admin/mo-messages">
        <AdminField label="처리 결과" className="w-40">
          <AdminSelect name="result" defaultValue={result ?? ''}>
            <option value="">전체</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {moResultLabel[r].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="크리에이터" className="w-52">
          <AdminSelect name="creatorId" defaultValue={creatorId ?? ''}>
            <CreatorOptions creators={creators} />
          </AdminSelect>
        </AdminField>
        <AdminField label="수신번호" className="w-40">
          <AdminInput name="number" defaultValue={receivedNumber} placeholder="168812341001" />
        </AdminField>
        <AdminField label="시작일 (KST)" className="w-40">
          <AdminInput type="date" name="from" defaultValue={sp.from ?? ''} />
        </AdminField>
        <AdminField label="종료일 (KST)" className="w-40">
          <AdminInput type="date" name="to" defaultValue={sp.to ?? ''} />
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="원문 비노출 원칙">
        수신 문자 원문(content_enc)은 분쟁 대응 목적의 암호문으로만 보관합니다. 관리자 화면에는 금칙어 필터링을 거친
        방송 노출용 문구만 표시되며, 발신 번호는 마스킹된 값만 제공합니다.
      </Notice>

      <div className="mt-4">
        {messages.length === 0 ? (
          <EmptyState title="조건에 맞는 수신 문자가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>수신 시각</Th>
                  <Th>사업자 메시지 ID</Th>
                  <Th>수신번호</Th>
                  <Th>발신(마스킹)</Th>
                  <Th>유형</Th>
                  <Th>결과</Th>
                  <Th>매칭 키워드</Th>
                  <Th>크리에이터</Th>
                  <Th>필터링된 내용</Th>
                  <Th>연결 거래</Th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <Td className="whitespace-nowrap">
                      {formatKst(m.receivedAt, false)}
                      {m.processedAt ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">처리 {formatKst(m.processedAt, false)}</span>
                      ) : null}
                    </Td>
                    <Td className="font-mono text-[12px]">
                      {shortId(m.providerMessageId, 10, 6)}
                      <span className="mt-0.5 block text-[11px] text-ink-400">{m.providerCode}</span>
                    </Td>
                    <Td className="font-mono text-[12px]">{m.receivedNumber}</Td>
                    <Td>{m.phoneMasked}</Td>
                    <Td>{m.messageType}</Td>
                    <Td>
                      <Badge tone={moResultLabel[m.result].tone}>{moResultLabel[m.result].text}</Badge>
                      {m.resultDetail ? (
                        <span className="mt-0.5 block max-w-[160px] text-[11px] break-words text-ink-400">{m.resultDetail}</span>
                      ) : null}
                    </Td>
                    <Td>{m.matchedKeyword ?? '-'}</Td>
                    <Td>
                      {m.creator ? (
                        <Link href={`/admin/creators/${m.creator.id}`} className="font-semibold text-brand-700">
                          {m.creator.displayName}
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="max-w-[240px] break-words">{m.contentFiltered ?? <span className="text-ink-300">표시 가능한 내용 없음</span>}</Td>
                    <Td>
                      {m.donation ? (
                        <>
                          <span className="block font-mono text-[12px]">{m.donation.transactionNo}</span>
                          <Badge tone={donationStatusLabel[m.donation.status].tone}>
                            {donationStatusLabel[m.donation.status].text}
                          </Badge>
                        </>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/mo-messages"
              params={{
                result: result ?? '', creatorId: creatorId ?? '', number: receivedNumber,
                from: sp.from ?? '', to: sp.to ?? '',
              }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>
    </>
  );
}
