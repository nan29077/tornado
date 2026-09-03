import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, JsonView, Pager } from '@/components/admin/controls';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import { adminPermissionLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(`${raw}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; targetType?: string; from?: string; to?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const action = (sp.action ?? '').trim();
  const targetType = (sp.targetType ?? '').trim();
  const from = parseDate(sp.from);
  const toRaw = parseDate(sp.to);
  const to = toRaw ? new Date(toRaw.getTime() + 86_400_000) : undefined;

  const where: Prisma.AdminAuditLogWhereInput = {
    ...(action ? { action: { contains: action, mode: 'insensitive' as const } } : {}),
    ...(targetType ? { targetType } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };

  const [total, logs, actions, targetTypes, todayCount] = await Promise.all([
    prisma.adminAuditLog.count({ where }),
    prisma.adminAuditLog.findMany({
      where,
      // 같은 시각 행이 페이지마다 뒤바뀌지 않도록 id 를 보조 정렬키로 둔다.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, action: true, targetType: true, targetId: true,
        beforeValue: true, afterValue: true, ip: true, userAgent: true, createdAt: true,
        admin: { select: { permission: true, user: { select: { email: true, name: true } } } },
      },
    }),
    /**
     * 종류 목록은 **groupBy 로 집계**한다.
     *
     * 예전에는 `distinct + take` 로 잘라 온 배열의 length 를 그대로 "액션 종류" 타일에
     * 표시했다. 액션이 100종을 넘는 순간 그 타일은 영원히 "100"을 보여 주고, 필터 목록에서도
     * 뒤쪽 액션이 사라져 **검색할 수 없는 액션 종류**가 생겼다.
     */
    prisma.adminAuditLog.groupBy({ by: ['action'], orderBy: { action: 'asc' } }),
    prisma.adminAuditLog.groupBy({ by: ['targetType'], orderBy: { targetType: 'asc' } }),
    prisma.adminAuditLog.count({ where: { createdAt: { gte: kstStartOfDay() } } }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/audit', { action, targetType, from: sp.from ?? '', to: sp.to ?? '' }, page, lastPage, total);

  return (
    <>
      <PageHeader
        title="감사로그"
        description="관리자가 수행한 모든 변경의 전/후 값과 접속 정보를 기록합니다. 로그는 수정하거나 삭제할 수 없습니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 기록" value={formatNumber(total)} sub="현재 조건 기준" />
        <StatTile label="오늘 기록" value={formatNumber(todayCount)} tone="brand" />
        <StatTile label="액션 종류" value={formatNumber(actions.length)} />
        <StatTile label="대상 유형" value={formatNumber(targetTypes.length)} />
      </div>

      <FilterBar action="/admin/audit" resetHref="/admin/audit">
        <AdminField label="액션" className="w-56">
          <AdminInput name="action" defaultValue={action} placeholder="예: REFUND_APPROVE" list="audit-actions" />
        </AdminField>
        <datalist id="audit-actions">
          {actions.map((a) => (
            <option key={a.action} value={a.action} />
          ))}
        </datalist>
        <AdminField label="대상 유형" className="w-48">
          <AdminSelect name="targetType" defaultValue={targetType}>
            <option value="">전체</option>
            {targetTypes.map((t) => (
              <option key={t.targetType} value={t.targetType}>
                {t.targetType}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="시작일 (KST)" className="w-40">
          <AdminInput type="date" name="from" defaultValue={sp.from ?? ''} />
        </AdminField>
        <AdminField label="종료일 (KST)" className="w-40">
          <AdminInput type="date" name="to" defaultValue={sp.to ?? ''} />
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="기록 범위">
        회원 상태 변경, 후원자 잠금·제한, 크리에이터 심사와 결제 모드, 코드 재발급, MO 번호 배정·회수, 환불 승인·거절,
        정산 처리, 정책·약관·배너·금칙어 변경, 관리자 권한 변경이 모두 기록됩니다.
      </Notice>

      <div className="mt-4">
        {logs.length === 0 ? (
          <EmptyState title="조건에 맞는 감사로그가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1200px]">
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>관리자</Th>
                  <Th>액션</Th>
                  <Th>대상</Th>
                  <Th>변경 전</Th>
                  <Th>변경 후</Th>
                  <Th>접속 정보</Th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap">{formatKst(l.createdAt)}</Td>
                    <Td>
                      {l.admin?.user.email ?? '시스템'}
                      {l.admin ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">{adminPermissionLabel[l.admin.permission]}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone="neutral">{l.action}</Badge>
                    </Td>
                    <Td>
                      {l.targetType}
                      <span className="mt-0.5 block font-mono text-[11px] break-all text-ink-400">{l.targetId ?? '-'}</span>
                    </Td>
                    <Td>
                      <JsonView value={l.beforeValue} maxLength={400} />
                    </Td>
                    <Td>
                      <JsonView value={l.afterValue} maxLength={400} />
                    </Td>
                    <Td className="max-w-[180px] text-[11px] break-words text-ink-400">
                      {l.ip ?? '-'}
                      {l.userAgent ? <span className="block">{l.userAgent.slice(0, 60)}</span> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/audit"
              params={{ action, targetType, from: sp.from ?? '', to: sp.to ?? '' }}
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
