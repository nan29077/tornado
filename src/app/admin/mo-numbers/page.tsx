import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import {
  ActionButton,
  ActionForm,
  BulkActionForm,
  DatalistActionForm,
} from '@/components/admin/action-form';
import {
  createMoNumber,
  assignMoNumber,
  changeMoNumberStatus,
  reissueLegacyMoNumbersAction,
} from '@/app/actions/admin/transactions';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatMoNumber } from '@/server/emma';
import { getMoNumberCapacity } from '@/server/services/mo-number-issue';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { moNumberStatusLabel } from '@/lib/labels';
import type { Prisma } from '@/generated/prisma/client';
import type { MoNumberStatus } from '@/generated/prisma/enums';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

const STATUSES: MoNumberStatus[] = ['AVAILABLE', 'RESERVED', 'ASSIGNED', 'RECLAIMED', 'DISABLED'];

export default async function AdminMoNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/mo-numbers');

  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const status = STATUSES.includes(sp.status as MoNumberStatus) ? (sp.status as MoNumberStatus) : undefined;

  /**
   * 화면 안내에 쓰는 대표번호.
   * 계약 확정 전에는 EMMA_MO_BASE_NUMBER 가 비어 있으므로 예시 번호를 보여 준다.
   */
  const moBaseSample = (env.emma.baseNumber || '16881234').replace(/\D/g, '');
  const moBaseLabel = `${moBaseSample.slice(0, 4)}-${moBaseSample.slice(4)}`;
  const cooldownDays = Number(process.env.MO_SUBCODE_COOLDOWN_DAYS ?? 180);

  const where: Prisma.CreatorMoNumberWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ phoneNumber: { contains: q } }, { keyword: { contains: q.toUpperCase() } }] } : {}),
  };

  const [numbers, grouped, costSum, approvedCreators, capacity, legacyAssigned] = await Promise.all([
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
    // 대표번호 소진 현황. 서브번호는 4자리라 1만 개가 상한이고, 회수 냉각분도 잠겨 있다.
    getMoNumberCapacity(),
    /**
     * 현재 대표번호 체계가 **아닌** 배정 번호.
     * 구 0505·1588 번호는 물론, 대표번호가 교체되면 옛 대표번호 배정분도 여기 잡힌다.
     * 이 번호들은 배정된 것처럼 보이지만 실제로는 문자가 수신되지 않는다.
     */
    prisma.creatorMoNumber.findMany({
      where: {
        status: 'ASSIGNED',
        creatorId: { not: null },
        NOT: { phoneNumber: { startsWith: moBaseSample } },
      },
      take: 500,
      select: { id: true, phoneNumber: true, creator: { select: { displayName: true } } },
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
            크리에이터 승인 시 <strong className="text-ink-200">대표번호 + 4자리</strong> 번호가 자동으로
            발급됩니다. 이 화면은 특정 번호를 직접 지정하거나 옛 번호를 정리할 때만 사용합니다.
          </p>
          <ActionForm action={createMoNumber} submitLabel="재고 등록">
            <AdminField label="수신번호" hint={`숫자만 입력 (예: ${moBaseSample}5678)`}>
              <AdminInput name="phoneNumber" inputMode="numeric" placeholder={`${moBaseSample}5678`} required />
            </AdminField>
            <AdminField label="키워드" hint="대표번호 공유 모드에서만 사용합니다. 전용번호는 비워 둡니다.">
              <AdminInput name="keyword" placeholder="(전용번호는 비워 둠)" />
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
          <Notice tone="neutral" title="번호 체계와 배정·회수 규칙">
            수신번호는 <strong className="text-ink-200">{moBaseLabel}-XXXX</strong> 형태입니다. 앞 8자리는 계약한
            대표번호로 고정이고, 뒤 4자리만 크리에이터마다 다릅니다. 이 4자리는 인포뱅크 승인 없이 도네이도가
            직접 부여하므로 크리에이터 승인과 동시에 자동 발급됩니다.
            <br />
            회수하면 크리에이터 연결이 끊기고 그 번호로 온 문자는 대상 없음으로 처리됩니다.{' '}
            <strong className="text-ink-200">회수한 번호는 냉각기간({cooldownDays}일)이 지나야 다시 배정됩니다.</strong>{' '}
            이전 크리에이터를 후원하던 사람의 문자가 새 크리에이터에게 결제되는 것을 막기 위함입니다.
            모든 변경은 감사로그에 기록됩니다.
          </Notice>

          <div className="mt-3">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>구 번호 정리 · 대표번호 교체</CardTitle>
                <Badge tone={legacyAssigned.length > 0 ? 'warning' : 'success'}>
                  {legacyAssigned.length > 0 ? `구 체계 ${legacyAssigned.length}건` : '정리 완료'}
                </Badge>
              </div>

              <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
                현재 대표번호(<strong className="text-ink-200">{moBaseLabel}</strong>)로 시작하지 않는 배정 번호를
                모두 새 번호로 바꿉니다. 구 0505·1588 번호 정리에 쓰고,{' '}
                <strong className="text-ink-200">
                  인포뱅크 계약으로 대표번호가 확정되면 EMMA_MO_BASE_NUMBER 를 바꾸고 서버를 재시작한 뒤 이 버튼을
                  한 번 누르면 전원이 새 대표번호로 옮겨집니다.
                </strong>
              </p>

              <div className="mt-3">
                <Notice tone="warning">
                  실행하면 후원자들이 알고 있던 번호가 바뀝니다. 바뀐 번호는 아래에 목록으로 남으니, 크리에이터에게
                방송 안내 문구를 교체하도록 알려 주세요. 옛 번호는 회수되어 냉각기간({cooldownDays}일) 동안 아무에게도
                  배정되지 않습니다.
                </Notice>
              </div>

              {legacyAssigned.length > 0 ? (
                <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50 p-3">
                  {legacyAssigned.map((n) => (
                    <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                      <span className="font-semibold text-ink-700">{n.creator?.displayName ?? '(이름 없음)'}</span>
                      <span className="font-mono text-[11.5px] text-danger-500">{formatMoNumber(n.phoneNumber)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-3">
                <BulkActionForm
                  action={reissueLegacyMoNumbersAction}
                  submitLabel="구 체계 번호 일괄 재발급"
                  variant="danger"
                  confirm={
                    `현재 대표번호 체계가 아닌 배정 번호 ${legacyAssigned.length}건을 모두 새 번호로 바꿉니다. ` +
                    '후원자가 알고 있던 번호가 즉시 바뀝니다. 진행할까요?'
                  }
                  emptyLabel="바꿀 구 체계 번호가 없습니다."
                />
              </div>

              <div className="mt-4 border-t border-ink-100 pt-3">
                <p className="text-[11px] font-semibold text-ink-500">대표번호 소진 현황</p>
                <p className="mt-1 text-[12px] text-ink-700">
                  {capacity.baseNumber ? (
                    <>
                      <span className="font-mono font-semibold">{formatMoNumber(capacity.baseNumber)}</span> · 배정{' '}
                      <strong className="text-ink-200">{formatNumber(capacity.assigned)}</strong> · 냉각·사용중{' '}
                      {formatNumber(capacity.blocked)} · 남은 번호{' '}
                      <strong className="text-ink-200">{formatNumber(capacity.available)}</strong> /{' '}
                      {formatNumber(capacity.total)}
                    </>
                  ) : (
                    'EMMA_MO_BASE_NUMBER 가 설정되지 않아 소진 현황을 계산할 수 없습니다.'
                  )}
                </p>
              </div>
            </Card>
          </div>
          <div className="mt-3">
            <FilterBar action="/admin/mo-numbers" resetHref="/admin/mo-numbers">
              <AdminField label="번호·키워드 검색" className="w-52">
                <AdminInput name="q" defaultValue={q} placeholder={`${moBaseSample}... 또는 뒤 4자리`} />
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
                <Td className="font-mono text-[13px] font-semibold">{formatMoNumber(n.phoneNumber)}</Td>
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
