import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminSelect } from '@/components/admin/controls';
import { handleTalkReportAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 팬챗 관리 > 신고 메시지 (신고된 메시지만 열람한다) */
export default async function AdminTalkReportsPage() {
  await requireAdminPage('/admin/talk/reports');
  const reports = await prisma.talkReport.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 100 });
  const msgIds = reports.filter((r) => r.target === 'MESSAGE').map((r) => r.messageId);
  const sesIds = reports.filter((r) => r.target === 'SESSION_MESSAGE').map((r) => r.messageId);
  const [msgs, smsgs, creators] = await Promise.all([
    prisma.talkMessage.findMany({ where: { id: { in: msgIds } }, select: { id: true, body: true, kind: true, deletedAt: true } }),
    prisma.talkSessionMessage.findMany({ where: { id: { in: sesIds } }, select: { id: true, body: true, senderType: true } }),
    prisma.creatorProfile.findMany({ where: { id: { in: [...new Set(reports.map((r) => r.creatorId))] } }, select: { id: true, code: true, displayName: true } }),
  ]);
  return (
    <div>
      <PageHeader title="팬챗 신고 메시지" description="운영자는 신고된 메시지만 열람합니다(이용약관 · 개인정보처리방침 고지). 가리기를 선택하면 메시지가 팬챗방에서 사라집니다." />
      {reports.length === 0 ? <EmptyState title="신고된 메시지가 없습니다" /> : (
        <Table>
          <thead><tr><Th>신고 시각</Th><Th>크리에이터</Th><Th>구분</Th><Th>메시지</Th><Th>신고 사유</Th><Th>상태</Th><Th>처리</Th></tr></thead>
          <tbody>
            {reports.map((r) => {
              const m = r.target === 'MESSAGE' ? msgs.find((x) => x.id === r.messageId) : smsgs.find((x) => x.id === r.messageId);
              const c = creators.find((x) => x.id === r.creatorId);
              return (
                <tr key={r.id}>
                  <Td>{formatKst(r.createdAt, false)}</Td>
                  <Td>{c?.displayName} <span className="text-ink-400">{c?.code}</span></Td>
                  <Td>{r.target === 'MESSAGE' ? '팬챗방' : '1:1'} · 신고자 {r.reporterRole === 'CREATOR' ? '크리에이터' : '팬'}</Td>
                  <Td className="max-w-[280px] whitespace-pre-wrap break-words">{m?.body ?? '(삭제됨)'}</Td>
                  <Td className="max-w-[200px]">{r.reason}</Td>
                  <Td>{r.status === 'OPEN' ? <Badge tone="warning">접수</Badge> : r.status === 'RESOLVED' ? <Badge tone="success">처리</Badge> : <Badge>기각</Badge>}</Td>
                  <Td>
                    {r.status === 'OPEN' ? (
                      <ActionForm action={handleTalkReportAction} submitLabel="처리" compact>
                        <input type="hidden" name="reportId" value={r.id} />
                        <AdminSelect name="decision" defaultValue="delete">
                          <option value="delete">메시지 가리기</option>
                          <option value="resolve">처리 완료만</option>
                          <option value="dismiss">기각</option>
                        </AdminSelect>
                      </ActionForm>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
