import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { ActionButton, ActionForm, DatalistActionForm, SelectActionForm } from '@/components/admin/action-form';
import { createMoNumber, assignMoNumber, changeMoNumberStatus } from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { moNumberStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { MoNumberStatus } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

const STATUSES: MoNumberStatus[] = ['AVAILABLE', 'RESERVED', 'ASSIGNED', 'RECLAIMED', 'DISABLED'];

export default async function AdminMoNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const status = STATUSES.includes(sp.status as MoNumberStatus) ? (sp.status as MoNumberStatus) : undefined;

  const where: Prisma.CreatorMoNumberWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ phoneNumber: { contains: q } }, { keyword: { contains: q.toUpperCase() } }] } : {}),
  };

  const [numbers, grouped, costSum, approvedCreators] = await Promise.all([
    prisma.creatorMoNumber.findMany({
      where,
      orderBy: [{ status: 'asc' }, { phoneNumber: 'asc' }],
      take: 200,
      select: {
        id: true, phoneNumber: true, keyword: true, mode: true, status: true, monthlyCost: true,
        assignedAt: true, releasedAt: true, memo: true,
        creator: { select: { id: true, displayName: true, code: true } },
      },
    }),
    prisma.creatorMoNumber.groupBy({ by: ['status'], _count: { _all: true }, _sum: { monthlyCost: true } }),
    prisma.creatorMoNumber.aggregate({ _sum: { monthlyCost: true } }),
    prisma.creatorProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
      // 배정 <select> 가 행마다 렌더된다. 상한이 없으면 크리에이터 수 x 행 수만큼
      // <option> 이 생겨(수백 명이면 수만~수십만 개) 페이지가 사실상 열리지 않는다.
      // 절단 여부를 알아야 경고를 띄울 수 있으므로 한 건 더 가져온다.
      take: CREATOR_OPTION_LIMIT + 1,
    }),
  ]);

  /**
   * 배정 선택지. 예전에는 이 목록을 행마다 `<select>` 로 그렸다.
   * 200행 x 300명이면 `<option>` 이 6만 개가 되어 화면이 사실상 열리지 않았다.
   * 이제 `<datalist>` 를 화면에 한 번만 두고 각 행이 그것을 참조한다.
   */
  const creatorFilterTruncated = approvedCreators.length > CREATOR_OPTION_LIMIT;
  const creatorOptions = approvedCreators
    .slice(0, CREATOR_OPTION_LIMIT)
    .map((c) => ({ value: c.id, label: `${c.displayName} (${c.code})` }));

  const countOf = (s: MoNumberStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const assignedCost = grouped.find((g) => g.status === 'ASSIGNED')?._sum.monthlyCost ?? 0n;

  return (
    <>
      <PageHeader
        title="MO 번호 재고·배정"
        description="수신번호는 전용번호(DEDICATED) 또는 대표번호 공유(SHARED_PREFIX + 키워드) 두 가지 방식으로 운영합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-6">
        {STATUSES.map((s) => (
          <StatTile
            key={s}
            label={moNumberStatusLabel[s].text}
            value={formatNumber(countOf(s))}
            tone={s === 'ASSIGNED' ? 'success' : s === 'DISABLED' ? 'danger' : 'neutral'}
          />
        ))}
        <StatTile
          label="월 비용 합계"
          value={formatWon(costSum._sum.monthlyCost ?? 0n)}
          sub={`배정분 ${formatWon(assignedCost)}`}
          tone="brand"
        />
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardTitle>번호 등록</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            사업자에게 발급받은 수신번호를 재고로 등록합니다. 대표번호 공유 모드는 키워드가 반드시 필요합니다.
          </p>
          <ActionForm action={createMoNumber} submitLabel="재고 등록">
            <AdminField label="수신번호" hint="숫자만 입력 (예: 05051234567)">
              <AdminInput name="phoneNumber" inputMode="numeric" placeholder="05051234567" required />
            </AdminField>
            <AdminField label="키워드" hint="대표번호 공유 모드에서 문자 맨 앞에 붙는 식별 키워드">
              <AdminInput name="keyword" placeholder="DONAIDO" />
            </AdminField>
            <AdminField label="수신 모드">
              <AdminSelect name="mode" defaultValue="DEDICATED">
                <option value="DEDICATED">전용번호 (DEDICATED)</option>
                <option value="SHARED_PREFIX">대표번호 공유 (SHARED_PREFIX)</option>
              </AdminSelect>
            </AdminField>
            <AdminField label="월 비용 (원)">
              <AdminInput name="monthlyCost" inputMode="numeric" defaultValue="0" required />
            </AdminField>
            <AdminField label="메모">
              <AdminInput name="memo" placeholder="계약 사업자, 회선 구분 등" />
            </AdminField>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <Notice tone="neutral" title="배정·회수 규칙">
            승인된 크리에이터에게만 번호를 배정할 수 있습니다. 회수하면 크리에이터 연결이 끊기고 상태가 회수로
            바뀌며, 해당 번호로 들어온 문자는 대상 없음으로 처리됩니다. 사용중지는 회선 해지 등 더 이상 사용하지 않는
            번호에 사용합니다. 모든 변경은 감사로그에 기록됩니다.
          </Notice>
          <div className="mt-3">
            <FilterBar action="/admin/mo-numbers" resetHref="/admin/mo-numbers">
              <AdminField label="번호·키워드 검색" className="w-52">
                <AdminInput name="q" defaultValue={q} placeholder="0505... 또는 DONAIDO" />
              </AdminField>
              <AdminField label="상태" className="w-40">
                <AdminSelect name="status" defaultValue={status ?? ''}>
                  <option value="">전체</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {moNumberStatusLabel[s].text}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
            </FilterBar>
          </div>
        </div>
      </div>

      <SectionTitle title="번호 목록" description="최대 200건까지 표시합니다." />

      {/* 배정 선택지는 화면에 한 번만 둔다. 각 행의 입력칸이 list 속성으로 이것을 가리킨다. */}
      <datalist id="mo-assign-creators">
        {creatorOptions.map((o) => (
          <option key={o.value} value={o.label} />
        ))}
      </datalist>

      {creatorFilterTruncated ? (
        <div className="mb-3">
          <Notice tone="warning" title={`배정 목록에 이름순 ${CREATOR_OPTION_LIMIT}명까지만 담깁니다`}>
            승인된 크리에이터가 {CREATOR_OPTION_LIMIT}명을 넘습니다. 목록에 없는 크리에이터에게 번호를 배정하려면
            크리에이터 상세 화면에서 배정해 주세요.
          </Notice>
        </div>
      ) : null}

      {numbers.length === 0 ? (
        <EmptyState title="등록된 MO 번호가 없습니다" description="왼쪽 등록 폼으로 재고를 먼저 추가하세요." />
      ) : (
        <Table className="min-w-[1100px]">
          <thead>
            <tr>
              <Th>번호</Th>
              <Th>키워드</Th>
              <Th>모드</Th>
              <Th>상태</Th>
              <Th>배정 크리에이터</Th>
              <Th className="text-right">월 비용</Th>
              <Th>배정·회수</Th>
              <Th>배정</Th>
              <Th>상태 변경</Th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n.id}>
                <Td className="font-mono text-[13px] font-semibold">{n.phoneNumber}</Td>
                <Td>{n.keyword ?? '-'}</Td>
                <Td>{n.mode === 'DEDICATED' ? '전용번호' : '대표번호 공유'}</Td>
                <Td>
                  <Badge tone={moNumberStatusLabel[n.status].tone}>{moNumberStatusLabel[n.status].text}</Badge>
                  {n.memo ? <span className="mt-0.5 block max-w-[140px] text-[11px] break-words text-ink-400">{n.memo}</span> : null}
                </Td>
                <Td>
                  {n.creator ? (
                    <Link href={`/admin/creators/${n.creator.id}`} className="font-semibold text-brand-700">
                      {n.creator.displayName}
                    </Link>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{formatWon(n.monthlyCost)}</Td>
                <Td className="whitespace-nowrap text-[11px] text-ink-400">
                  {n.assignedAt ? `배정 ${formatKst(n.assignedAt, false)}` : '-'}
                  {n.releasedAt ? <span className="block">회수 {formatKst(n.releasedAt, false)}</span> : null}
                </Td>
                <Td>
                  {n.status === 'ASSIGNED' || n.status === 'DISABLED' ? (
                    <span className="text-[12px] text-ink-300">-</span>
                  ) : (
                    <DatalistActionForm
                      action={assignMoNumber}
                      values={{ id: n.id }}
                      name="creatorId"
                      listId="mo-assign-creators"
                      options={creatorOptions}
                      placeholder="크리에이터 검색"
                      submitLabel="배정"
                      confirm="선택한 크리에이터에게 이 수신번호를 배정합니다."
                    />
                  )}
                </Td>
                <Td>
                  <div className="flex flex-col gap-1.5">
                    {n.status === 'ASSIGNED' ? (
                      <ActionButton
                        action={changeMoNumberStatus}
                        values={{ id: n.id, status: 'RECLAIMED' }}
                        label="회수"
                        confirm="배정을 해제하고 번호를 회수합니다. 이 번호로 들어오는 문자는 대상 없음으로 처리됩니다."
                      />
                    ) : null}
                    {n.status !== 'DISABLED' ? (
                      <ActionButton
                        action={changeMoNumberStatus}
                        values={{ id: n.id, status: 'DISABLED' }}
                        label="사용중지"
                        variant="danger"
                        confirm="번호를 사용중지 처리합니다."
                      />
                    ) : (
                      <ActionButton
                        action={changeMoNumberStatus}
                        values={{ id: n.id, status: 'AVAILABLE' }}
                        label="재고 복귀"
                        confirm="사용중지를 해제하고 재고로 되돌립니다."
                      />
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
