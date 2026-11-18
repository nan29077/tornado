import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput, FilterBar } from '@/components/admin/controls';
import { won } from '@/components/admin/engage-bits';
import { refundTalkSubscriptionAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 팬챗 관리 > 팬챗방 · 구독 현황 */
export default async function AdminTalkSubscriptionsPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  await requireAdminPage('/admin/talk/subscriptions');
  const code = ((await searchParams).code ?? '').trim().toUpperCase();
  const now = new Date();
  const [rooms, subs] = await Promise.all([
    prisma.talkRoom.findMany({ where: { open: true }, include: { creator: { select: { id: true, code: true, displayName: true } } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.talkSubscription.findMany({
      where: code ? { creator: { code } } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { creator: { select: { code: true, displayName: true } }, user: { select: { email: true, name: true } } },
    }),
  ]);
  const counts = await Promise.all(rooms.map((r) => prisma.talkSubscription.findMany({ where: { creatorId: r.creatorId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } }, distinct: ['userId'], select: { id: true } })));
  return (
    <div>
      <PageHeader title="팬챗방 · 구독 현황" description="구독 결제는 승인 즉시 크리에이터 정산 원장(팬챗 구독 정산)에 적립됩니다. 환불하면 이용이 끝나고 정산액이 반대분개됩니다." />
      <Card className="mb-4">
        <CardTitle>열린 팬챗방 ({rooms.length})</CardTitle>
        <div className="mt-2 flex flex-wrap gap-2">
          {rooms.map((r, i) => (
            <a key={r.id} href={`/admin/talk/subscriptions?code=${r.creator.code}`} className="rounded-xl border border-ink-100 px-3 py-2 text-[12.5px] hover:bg-ink-50">
              <b>{r.creator.displayName}</b> <span className="text-ink-400">{r.creator.code}</span> · 이용 중 {counts[i].length}명
            </a>
          ))}
        </div>
      </Card>
      <div className="mb-3"><FilterBar action="/admin/talk/subscriptions"><AdminInput name="code" defaultValue={code} placeholder="크리에이터 코드" className="w-56" /></FilterBar></div>
      <Table>
        <thead><tr><Th>결제</Th><Th>크리에이터</Th><Th>회원</Th><Th>기간</Th><Th className="text-right">금액</Th><Th className="text-right">정산</Th><Th>상태</Th><Th>환불</Th></tr></thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id}>
              <Td>{formatKst(s.createdAt, false)}</Td>
              <Td>{s.creator.displayName} <span className="text-ink-400">{s.creator.code}</span></Td>
              <Td>{s.user.name ?? '-'} <span className="text-ink-400">{s.user.email}</span></Td>
              <Td>{formatKst(s.startsAt, false).slice(0, 10)} ~ {formatKst(s.endsAt, false).slice(0, 10)}</Td>
              <Td className="text-right">{won(s.price)}</Td>
              <Td className="text-right">{won(s.netAmount)}</Td>
              <Td>{s.status === 'ACTIVE' ? (s.endsAt > now ? <Badge tone="success">이용 중</Badge> : <Badge>만료</Badge>) : <Badge tone="danger">환불</Badge>}</Td>
              <Td>
                {s.status === 'ACTIVE' ? (
                  <ActionForm action={refundTalkSubscriptionAction} submitLabel="환불" variant="danger" compact confirm="이 구독을 환불할까요? 이용이 바로 끝납니다.">
                    <input type="hidden" name="subscriptionId" value={s.id} />
                    <AdminInput name="reason" placeholder="사유" className="w-24" />
                  </ActionForm>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
