import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { won } from '@/components/admin/engage-bits';
import { adjustTicketsAction, refundTicketOrderAdminAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { LEDGER_TYPE_LABEL, getBalance } from '@/server/services/vote/wallet';
import { PAY_METHOD_LABEL, type PayMethod } from '@/server/services/vote/purchase';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 투표 관리 > 투표권 지급·회수 · 충전 결제 */
export default async function AdminVoteTicketsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdminPage('/admin/vote/tickets');
  const q = ((await searchParams).q ?? '').trim();
  const member = q ? await prisma.user.findFirst({ where: { OR: [{ email: q.toLowerCase() }, { id: q }] }, select: { id: true, email: true, name: true } }) : null;
  const [balance, ledger, orders] = await Promise.all([
    member ? getBalance(member.id) : null,
    member ? prisma.voteTicketLedger.findMany({ where: { userId: member.id }, orderBy: { createdAt: 'desc' }, take: 30 }) : [],
    prisma.voteTicketOrder.findMany({ where: { status: { in: ['PAID', 'REFUNDED'] }, ...(member ? { userId: member.id } : {}) }, orderBy: { createdAt: 'desc' }, take: 60, include: { user: { select: { email: true, name: true } } } }),
  ]);
  return (
    <div>
      <PageHeader title="투표권 지급·회수" description="이벤트 보상 · 오류 보상은 무료 또는 보너스로 지급합니다(유료는 결제로만 생깁니다). 모든 지급·회수는 회원 내역과 감사로그에 남습니다." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>회원 조회</CardTitle>
          <div className="mt-2">
            <FilterBar action="/admin/vote/tickets"><AdminInput name="q" defaultValue={q} placeholder="이메일 또는 회원 ID" className="w-72" /></FilterBar>
          </div>
          {q && !member ? <p className="mt-2 text-[12.5px] text-danger-600">회원을 찾을 수 없습니다.</p> : null}
          {member && balance ? (
            <div className="mt-2 text-[13px]">
              <p className="font-bold">{member.name ?? '-'} <span className="text-ink-400">{member.email}</span></p>
              <p className="mt-1">전체 <b>{balance.total.toLocaleString('ko-KR')}</b> · 무료 {balance.free.toLocaleString('ko-KR')} · 유료 {balance.paid.toLocaleString('ko-KR')} · 보너스 {balance.bonus.toLocaleString('ko-KR')}</p>
              <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto text-[12px] text-ink-600">
                {ledger.map((l) => <li key={l.id}>{formatKst(l.createdAt, false)} · {LEDGER_TYPE_LABEL[l.type] ?? l.type} · {l.bucket} · {l.delta > 0 ? '+' : ''}{l.delta}{l.memo ? ` · ${l.memo}` : ''}</li>)}
              </ul>
            </div>
          ) : null}
        </Card>
        <Card>
          <CardTitle>지급 · 회수</CardTitle>
          <ActionForm action={adjustTicketsAction} submitLabel="실행" className="mt-2" confirm="실행할까요? 회원 내역에 사유가 표시됩니다.">
            {member ? <input type="hidden" name="userId" value={member.id} /> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              {!member ? <AdminField label="회원 이메일" className="sm:col-span-2"><AdminInput name="email" type="email" required /></AdminField> : null}
              <AdminField label="작업"><AdminSelect name="op" defaultValue="grant"><option value="grant">지급</option><option value="revoke">회수</option></AdminSelect></AdminField>
              <AdminField label="종류"><AdminSelect name="bucket" defaultValue="BONUS"><option value="BONUS">보너스</option><option value="FREE">무료</option><option value="PAID">유료 (회수만)</option></AdminSelect></AdminField>
              <AdminField label="수량"><AdminInput name="amount" inputMode="numeric" required /></AdminField>
              <AdminField label="사유 (회원에게 표시)"><AdminInput name="memo" required maxLength={100} /></AdminField>
            </div>
          </ActionForm>
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-[14px] font-bold text-ink-900">충전 결제</h2>
      <Table>
        <thead><tr><Th>결제 시각</Th><Th>회원</Th><Th>상품</Th><Th>수단</Th><Th className="text-right">금액</Th><Th>상태</Th><Th>환불</Th></tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <Td>{formatKst(o.paidAt ?? o.createdAt, false)}<div className="text-[11px] text-ink-400">{o.orderNo}</div></Td>
              <Td>{o.user.name ?? '-'} <span className="text-ink-400">{o.user.email}</span></Td>
              <Td>{o.productName}</Td>
              <Td>{PAY_METHOD_LABEL[o.method as PayMethod] ?? o.method}</Td>
              <Td className="text-right">{won(o.price)}</Td>
              <Td>{o.status === 'PAID' ? <Badge tone="success">결제</Badge> : <Badge>환불</Badge>}</Td>
              <Td>
                {o.status === 'PAID' ? (
                  <ActionForm action={refundTicketOrderAdminAction} submitLabel="환불" variant="danger" compact confirm="미사용 결제만 환불됩니다(기간 무관). 투표권이 회수되고 결제가 취소됩니다.">
                    <input type="hidden" name="orderId" value={o.id} />
                    <AdminInput name="reason" placeholder="사유" className="w-24" />
                  </ActionForm>
                ) : <span className="text-[11.5px] text-ink-400">{o.refundReason}</span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
