import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { won } from '@/components/admin/engage-bits';
import { adminSessionOpAction } from '@/app/actions/admin/engagement';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { getTalkConfig } from '@/server/services/engagement/config';
import { SESSION_STATUS_LABEL, formatKstShort } from '@/server/services/talk/sessions';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 소통 관리 > 1:1 예약 관리 */
export default async function AdminTalkSessionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireAdminPage('/admin/talk/sessions');
  const status = (await searchParams).status ?? '';
  const [cfg, sessions] = await Promise.all([
    getTalkConfig(),
    prisma.talkSession.findMany({
      where: status ? { status } : {},
      orderBy: { startsAt: 'desc' },
      take: 100,
      include: { creator: { select: { code: true, displayName: true } }, user: { select: { email: true, name: true } } },
    }),
  ]);
  return (
    <div>
      <PageHeader title="1:1 예약 관리" description="기한이 지난 신청은 자동 만료 · 환불, 끝난 예약은 자동 완료 · 정산됩니다(화면을 열 때). 분쟁 · 신고 건은 여기서 환불할 수 있습니다." />
      {!cfg.sessionEnabled ? <div className="mb-3"><Notice tone="warning" title="1:1 채팅이 꺼져 있습니다">소통 설정에서 켤 수 있습니다. 꺼진 동안에도 남아 있는 예약은 여기서 처리할 수 있습니다.</Notice></div> : null}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <FilterBar action="/admin/talk/sessions">
          <AdminSelect name="status" defaultValue={status}>
            <option value="">전체 상태</option>
            {Object.entries(SESSION_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
          </AdminSelect>
        </FilterBar>
        <ActionForm action={adminSessionOpAction} submitLabel="기한 정리 지금 실행" variant="secondary" compact>
          <input type="hidden" name="op" value="sweep" />
        </ActionForm>
      </div>
      <Table>
        <thead><tr><Th>예약 시각</Th><Th>크리에이터</Th><Th>신청 회원</Th><Th className="text-right">금액</Th><Th className="text-right">정산액</Th><Th>상태</Th><Th>환불</Th></tr></thead>
        <tbody>
          {sessions.map((s) => {
            const st = SESSION_STATUS_LABEL[s.status] ?? { text: s.status, tone: 'neutral' as const };
            const canRefund = s.status === 'REQUESTED' || s.status === 'ACCEPTED' || (s.status === 'COMPLETED' && s.refundAmount === 0n);
            return (
              <tr key={s.id}>
                <Td>{formatKstShort(s.startsAt)} · {s.minutes}분<div className="text-[11px] text-ink-400">{s.sessionNo}</div></Td>
                <Td>{s.creator.displayName} <span className="text-ink-400">{s.creator.code}</span></Td>
                <Td>{s.user.name ?? '-'} <span className="text-ink-400">{s.user.email}</span></Td>
                <Td className="text-right">{won(s.price)}</Td>
                <Td className="text-right">{won(s.netAmount)}</Td>
                <Td><Badge tone={st.tone}>{st.text}</Badge>{s.refundAmount > 0n ? <div className="text-[11px] text-ink-400">환불 {won(s.refundAmount)}{s.cancelReason ? ` · ${s.cancelReason}` : ''}</div> : null}</Td>
                <Td>
                  {canRefund ? (
                    <ActionForm action={adminSessionOpAction} submitLabel="전액 환불" variant="danger" compact confirm="전액 환불할까요? 완료된 예약이면 크리에이터 정산액이 반대분개됩니다.">
                      <input type="hidden" name="op" value="refund" />
                      <input type="hidden" name="sessionId" value={s.id} />
                      <AdminInput name="reason" placeholder="사유" className="w-24" />
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
