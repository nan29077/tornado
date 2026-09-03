import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import { updateCreatorStatus, applyGlobalAmountBounds } from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { creatorStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { CreatorStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const STATUS_OPTIONS: Array<{ value: CreatorStatus; label: string }> = [
  { value: 'PENDING', label: '심사대기' },
  { value: 'APPROVED', label: '승인' },
  { value: 'REJECTED', label: '반려' },
  { value: 'SUSPENDED', label: '정지' },
];

const creatorSelect = {
  id: true,
  displayName: true,
  channelName: true,
  code: true,
  status: true,
  donationAmount: true,
  approvedAt: true,
  createdAt: true,
  user: { select: { email: true, name: true, phoneMasked: true } },
  moRoutes: { where: { status: 'ASSIGNED' as const }, select: { phoneNumber: true, keyword: true } },
  _count: { select: { donations: true } },
} satisfies Prisma.CreatorProfileSelect;

function CreatorRows({
  creators,
}: {
  creators: Array<{
    id: string;
    displayName: string;
    channelName: string | null;
    code: string;
    status: CreatorStatus;
    donationAmount: bigint;
    approvedAt: Date | null;
    createdAt: Date;
    user: { email: string | null; name: string | null; phoneMasked: string | null };
    moRoutes: Array<{ phoneNumber: string; keyword: string | null }>;
    _count: { donations: number };
  }>;
}) {
  return (
    <tbody>
      {creators.map((c) => (
        <tr key={c.id}>
          <Td>
            <Link href={`/admin/creators/${c.id}`} className="font-semibold text-brand-700">
              {c.displayName}
            </Link>
            <span className="mt-0.5 block text-[11px] text-ink-400">{c.channelName ?? '채널명 미등록'}</span>
          </Td>
          <Td className="font-mono text-[12px]">{c.code}</Td>
          <Td>
            {c.user.email ?? '-'}
            <span className="mt-0.5 block text-[11px] text-ink-400">{c.user.phoneMasked ?? '연락처 미등록'}</span>
          </Td>
          <Td className="text-right tabular-nums">{formatWon(c.donationAmount)}</Td>
          <Td>
            {c.moRoutes.length === 0 ? (
              <Badge tone="warning">미배정</Badge>
            ) : (
              c.moRoutes.map((m) => (
                <span key={`${m.phoneNumber}-${m.keyword ?? ''}`} className="block text-[12px]">
                  {m.phoneNumber}
                  {m.keyword ? ` (${m.keyword})` : ''}
                </span>
              ))
            )}
          </Td>
          <Td className="text-right tabular-nums">{formatNumber(c._count.donations)}</Td>
          <Td>
            <Badge tone={creatorStatusLabel[c.status].tone}>{creatorStatusLabel[c.status].text}</Badge>
            <span className="mt-0.5 block text-[11px] text-ink-400">
              신청 {formatKst(c.createdAt, false)}
              {c.approvedAt ? ` · 승인 ${formatKst(c.approvedAt, false)}` : ''}
            </span>
          </Td>
          <Td>
            <SelectActionForm
                        ariaLabel="크리에이터 심사 상태 변경"
              action={updateCreatorStatus}
              values={{ creatorId: c.id }}
              name="status"
              defaultValue={c.status}
              options={STATUS_OPTIONS}
              confirm={`${c.displayName} 님의 심사 상태를 변경합니다.`}
              hint={c.status === 'PENDING' ? '승인 후 MO 번호 배정이 필요합니다.' : undefined}
            />
          </Td>
        </tr>
      ))}
    </tbody>
  );
}

const HEAD = (
  <thead>
    <tr>
      <Th>크리에이터</Th>
      <Th>코드</Th>
      <Th>담당자</Th>
      <Th className="text-right">1건 후원금</Th>
      <Th>MO 번호</Th>
      <Th className="text-right">후원 건수</Th>
      <Th>상태</Th>
      <Th>심사 처리</Th>
    </tr>
  </thead>
);

export default async function AdminCreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const status = STATUS_OPTIONS.some((s) => s.value === sp.status) ? (sp.status as CreatorStatus) : undefined;

  const where: Prisma.CreatorProfileWhereInput = {
    /**
     * 상단 "심사 대기" 표에 이미 나오는 대상은 하단 전체 목록에서 뺀다.
     * 두 곳에 같은 크리에이터의 심사 폼이 동시에 뜨면, 한쪽에서 승인한 뒤에도
     * 다른 쪽 폼이 옛 상태를 그대로 보여 준다(낙관적 상태가 서로 동기화되지 않는다).
     * 상태 필터를 직접 '심사대기'로 고른 경우에는 그대로 보여 준다.
     */
    ...(status ? { status } : { status: { not: 'PENDING' } }),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: 'insensitive' as const } },
            { channelName: { contains: q, mode: 'insensitive' as const } },
            { code: { contains: q.toUpperCase() } },
            { user: { email: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [pending, pendingTotal, total, creators, byStatus, bounds] = await Promise.all([
    prisma.creatorProfile.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: creatorSelect,
    }),
    prisma.creatorProfile.count({ where: { status: 'PENDING' } }),
    prisma.creatorProfile.count({ where }),
    prisma.creatorProfile.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: creatorSelect,
    }),
    // 상단 타일은 전체 현황을 보여 주는 것이 목적이므로 필터를 적용하지 않는다(라벨로 명시).
    prisma.creatorProfile.groupBy({ by: ['status'], _count: { _all: true } }),
    // 일괄 적용 폼에 채울 "현재 적용 중인 범위". 대다수가 공유하는 값을 대표값으로 쓴다.
    prisma.creatorProfile.aggregate({
      where: { status: 'APPROVED' },
      _min: { minAmount: true },
      _max: { maxAmount: true },
    }),
  ]);

  const currentBounds = {
    min: (bounds._min.minAmount ?? 1000n).toString(),
    max: (bounds._max.maxAmount ?? 50000n).toString(),
  };

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/creators', { q, status: status ?? '' }, page, lastPage, total);
  const count = (s: CreatorStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="크리에이터 심사"
        description="심사 대기 건을 먼저 처리하고, 승인 후에는 MO 번호를 배정해야 문자후원이 접수됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="심사대기" value={formatNumber(count('PENDING'))} sub="전체 기준" tone={count('PENDING') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="승인" value={formatNumber(count('APPROVED'))} sub="전체 기준" tone="success" />
        <StatTile label="반려" value={formatNumber(count('REJECTED'))} sub="전체 기준" />
        <StatTile label="정지" value={formatNumber(count('SUSPENDED'))} sub="전체 기준" tone={count('SUSPENDED') > 0 ? 'danger' : 'neutral'} />
      </div>

      <section className="mb-5">
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>1건 후원금 허용 범위 공통 적용</CardTitle>
            <Badge tone="warning">전체 크리에이터 일괄 변경</Badge>
          </div>
          <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-500">
            승인된 크리에이터 <strong>{formatNumber(count('APPROVED'))}명</strong>의 문자 1건당 후원금 최소·최대 허용
            범위를 한 번에 변경합니다. 현재 설정 금액이 새 범위를 벗어난 크리에이터는 범위 안으로 자동 보정되며,
            <strong> 개별로 조정해 둔 값도 함께 덮어씁니다.</strong> 개별 범위는 상세 화면에서 다시 조정할 수 있습니다.
          </p>
          <ActionForm
            action={applyGlobalAmountBounds}
            submitLabel="전체 적용"
            confirm={`승인된 크리에이터 ${count('APPROVED')}명 전체에 새 허용 범위를 적용합니다. 개별로 조정해 둔 값도 함께 덮어쓰며 되돌릴 수 없습니다. 계속할까요?`}
          >
            <div className="grid max-w-xl grid-cols-2 gap-2">
              <AdminField label="1건 최소 (원)">
                {/* 기본값을 하드코딩하지 않고 현재 적용 중인 값을 그대로 보여 준다.
                    예전에는 1000/50000 이 늘 채워져 있어, 다른 목적으로 들어온 운영자가
                    그 값을 현재 설정으로 오해하고 [전체 적용]을 눌러 전원을 초기화할 수 있었다. */}
                <AdminInput name="minAmount" inputMode="numeric" defaultValue={String(currentBounds.min)} required />
              </AdminField>
              <AdminField label="1건 최대 (원)">
                <AdminInput name="maxAmount" inputMode="numeric" defaultValue={String(currentBounds.max)} required />
              </AdminField>
            </div>
          </ActionForm>
        </Card>
      </section>

      {pending.length > 0 ? (
        <section className="mb-6">
          <SectionTitle
            title={`심사 대기 ${pendingTotal}건`}
            description={
              pendingTotal > pending.length
                ? `신청 순서대로 ${pending.length}건까지 표시합니다. 승인 시 승인 시각이 기록되고 감사로그가 남습니다.`
                : '신청 순서대로 표시합니다. 승인 시 승인 시각이 기록되고 감사로그가 남습니다.'
            }
          />
          <Notice tone="warning" title="승인 전 확인 사항">
            채널 실명 확인, 사업자 정보, 정산 계좌 인증 여부를 함께 검토해 주세요. 승인 후 MO 번호 배정 화면에서 수신
            번호를 지정해야 후원 문자가 라우팅됩니다.
          </Notice>
          <div className="mt-3">
            <Table className="min-w-[1100px]">
              {HEAD}
              <CreatorRows creators={pending} />
            </Table>
          </div>
        </section>
      ) : (
        <Notice tone="success" title="심사 대기 건이 없습니다">
          새 신청이 들어오면 이 위치에 우선 표시됩니다.
        </Notice>
      )}

      <SectionTitle title="전체 크리에이터" />

      <FilterBar action="/admin/creators" resetHref="/admin/creators">
        <AdminField label="검색 (이름/채널/코드/이메일)" className="w-64">
          <AdminInput name="q" defaultValue={q} placeholder="도네이도 또는 TOR-8K2M" />
        </AdminField>
        <AdminField label="상태" className="w-36">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </FilterBar>

      {creators.length === 0 ? (
        <EmptyState title="조건에 맞는 크리에이터가 없습니다" />
      ) : (
        <>
          <Table className="min-w-[1100px]">
            {HEAD}
            <CreatorRows creators={creators} />
          </Table>
          <Pager
            basePath="/admin/creators"
            params={{ q, status: status ?? '' }}
            page={page}
            lastPage={lastPage}
            total={total}
          />
        </>
      )}
    </>
  );
}
