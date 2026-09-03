import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton, ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import { updateReportStatus, createBannedWord, deleteBannedWord } from '@/app/actions/admin/policy';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import type { ReportStatus, ContentAction } from '@/generated/prisma/enums';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

const REPORT_STATUSES: ReportStatus[] = ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'];

const reportStatusLabel: Record<ReportStatus, { text: string; tone: 'warning' | 'brand' | 'success' | 'neutral' }> = {
  OPEN: { text: '접수', tone: 'warning' },
  REVIEWING: { text: '검토중', tone: 'brand' },
  RESOLVED: { text: '처리완료', tone: 'success' },
  DISMISSED: { text: '기각', tone: 'neutral' },
};

const actionLabel: Record<ContentAction, { text: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  BLOCK: { text: '차단', tone: 'danger' },
  MASK: { text: '마스킹', tone: 'warning' },
  FLAG: { text: '표시', tone: 'neutral' },
};

export default async function AdminModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/moderation');

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const status = REPORT_STATUSES.includes(sp.status as ReportStatus) ? (sp.status as ReportStatus) : undefined;

  const where: Prisma.ReportWhereInput = status ? { status } : {};

  const [total, reports, byStatus, words] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, donationId: true, creatorId: true, category: true, content: true,
        status: true, handledBy: true, handledAt: true, createdAt: true, reporterUserId: true,
      },
    }),
    prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.bannedWord.findMany({
      where: { scope: 'GLOBAL' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, word: true, action: true, active: true, createdAt: true },
    }),
  ]);

  // 접수자 계정 정보는 통합 관리자 화면에서만 조회한다 (본문에는 저장하지 않는다).
  const reporterIds = [...new Set(reports.map((r) => r.reporterUserId).filter((v): v is string => Boolean(v)))];
  const reporters = reporterIds.length
    ? await prisma.user.findMany({
        where: { id: { in: reporterIds } },
        select: { id: true, name: true, email: true, phoneMasked: true },
      })
    : [];
  const reporterById = new Map(reporters.map((u) => [u.id, u]));

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/moderation', { status: status ?? '' }, page, lastPage, total);
  const countOf = (s: ReportStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="신고·금칙어 관리"
        description="이용자 신고를 처리하고, 방송 노출 문구에 적용되는 전역 금칙어를 관리합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="접수" value={formatNumber(countOf('OPEN'))} tone={countOf('OPEN') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="검토중" value={formatNumber(countOf('REVIEWING'))} tone="brand" />
        <StatTile label="처리완료" value={formatNumber(countOf('RESOLVED'))} tone="success" />
        <StatTile label="전역 금칙어" value={formatNumber(words.length)} />
      </div>

      <Notice tone="neutral" title="금칙어 처리 방식">
        차단(BLOCK)은 해당 문자를 방송에서 완전히 제외하고, 마스킹(MASK)은 단어만 가려 노출하며, 표시(FLAG)는 노출은
        하되 검토 대상으로 기록합니다. 크리에이터가 직접 등록한 개별 금칙어는 각 스튜디오에서 관리합니다.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>전역 금칙어 추가</CardTitle>
          <div className="mt-3">
            <ActionForm action={createBannedWord} submitLabel="금칙어 등록">
              <AdminField label="단어">
                <AdminInput name="word" required maxLength={40} />
              </AdminField>
              <AdminField label="처리 방식">
                <AdminSelect name="action" defaultValue="MASK">
                  <option value="MASK">마스킹 (MASK)</option>
                  <option value="BLOCK">차단 (BLOCK)</option>
                  <option value="FLAG">표시 (FLAG)</option>
                </AdminSelect>
              </AdminField>
            </ActionForm>
          </div>

          <div className="mt-4">
            <CardTitle>등록된 금칙어</CardTitle>
            {words.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-400">등록된 전역 금칙어가 없습니다.</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {words.map((w) => (
                  <div key={w.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink-900">{w.word}</span>
                      <Badge tone={actionLabel[w.action].tone}>{actionLabel[w.action].text}</Badge>
                      {!w.active ? <Badge tone="neutral">비활성</Badge> : null}
                    </div>
                    <ActionButton
                      action={deleteBannedWord}
                      values={{ id: w.id }}
                      label="삭제"
                      variant="ghost"
                      confirm={`금칙어 "${w.word}" 를 삭제합니다.`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="신고 처리" />
          <FilterBar action="/admin/moderation" resetHref="/admin/moderation">
            <AdminField label="처리 상태" className="w-40">
              <AdminSelect name="status" defaultValue={status ?? ''}>
                <option value="">전체</option>
                {REPORT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {reportStatusLabel[s].text}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
          </FilterBar>

          {reports.length === 0 ? (
            <EmptyState title="조건에 맞는 신고가 없습니다" />
          ) : (
            <>
              <Table className="min-w-[900px]">
                <thead>
                  <tr>
                    <Th>접수 시각</Th>
                    <Th>분류</Th>
                    <Th>접수자</Th>
                    <Th>내용</Th>
                    <Th>연결 거래</Th>
                    <Th>상태</Th>
                    <Th>처리</Th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap">
                        {formatKst(r.createdAt, false)}
                        {r.handledAt ? (
                          <span className="mt-0.5 block text-[11px] text-ink-400">처리 {formatKst(r.handledAt, false)}</span>
                        ) : null}
                      </Td>
                      <Td>{r.category}</Td>
                      <Td className="whitespace-nowrap text-[12px]">
                        {(() => {
                          const u = r.reporterUserId ? reporterById.get(r.reporterUserId) : null;
                          if (!u) return <span className="text-ink-400">비회원</span>;
                          return (
                            <>
                              <span className="block text-ink-900">{u.name ?? u.email ?? '회원'}</span>
                              <span className="block text-[11px] text-ink-400">{u.phoneMasked ?? u.email ?? ''}</span>
                            </>
                          );
                        })()}
                      </Td>
                      <Td className="max-w-[280px] break-words">{r.content}</Td>
                      <Td className="font-mono text-[11px] text-ink-400">{r.donationId ?? '-'}</Td>
                      <Td>
                        <Badge tone={reportStatusLabel[r.status].tone}>{reportStatusLabel[r.status].text}</Badge>
                      </Td>
                      <Td>
                        <SelectActionForm
                        ariaLabel="신고 처리 상태 변경"
                          action={updateReportStatus}
                          values={{ reportId: r.id }}
                          name="status"
                          defaultValue={r.status}
                          options={REPORT_STATUSES.map((s) => ({ value: s, label: reportStatusLabel[s].text }))}
                          confirm="신고 처리 상태를 변경합니다. 처리자가 기록됩니다."
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pager
                basePath="/admin/moderation"
                params={{ status: status ?? '' }}
                page={page}
                lastPage={lastPage}
                total={total}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
