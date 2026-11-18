import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { voidCastAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requestNowMs } from '@/lib/vote-period';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 팬투표 관리 > 팬투표 내역 · 이상 팬투표 */
export default async function AdminVoteCastsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdminPage('/admin/vote/casts');
  const q = ((await searchParams).q ?? '').trim();
  const since = new Date(requestNowMs() - 86_400_000);
  const where = q
    ? { OR: [{ creator: { code: q.toUpperCase() } }, { user: { email: q.toLowerCase() } }, { userId: q }] }
    : {};
  const [casts, sharedIp, heavy] = await Promise.all([
    prisma.voteCast.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { user: { select: { email: true, name: true, createdAt: true } }, creator: { select: { code: true, displayName: true } } } }),
    // 24시간 안에 같은 네트워크(IP)에서 여러 계정이 팬투표
    prisma.voteCast.groupBy({ by: ['ipHash'], where: { createdAt: { gte: since }, ipHash: { not: null }, voidedAt: null }, _count: { userId: true }, _sum: { votes: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 }),
    // 24시간 안에 많이 팬투표한 계정
    prisma.voteCast.groupBy({ by: ['userId'], where: { createdAt: { gte: since }, voidedAt: null }, _sum: { votes: true }, orderBy: { _sum: { votes: 'desc' } }, take: 10 }),
  ]);
  const ipUsers = await Promise.all(sharedIp.map(async (g) => (await prisma.voteCast.findMany({ where: { ipHash: g.ipHash, createdAt: { gte: since } }, distinct: ['userId'], select: { userId: true } })).length));
  const heavyUsers = await prisma.user.findMany({ where: { id: { in: heavy.map((h) => h.userId) } }, select: { id: true, email: true, name: true, createdAt: true } });

  return (
    <div>
      <PageHeader title="팬투표 내역 · 이상 팬투표" description="무효 처리하면 집계에서 빠지고 크리에이터 몫이 있었다면 반대분개됩니다. 이미 확정된 지난 기간 순위는 바뀌지 않습니다." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>같은 네트워크에서 여러 계정 (24시간)</CardTitle>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {sharedIp.filter((_, i) => ipUsers[i] > 1).length === 0 ? <li className="text-ink-400">의심 항목 없음</li> : sharedIp.map((g, i) => ipUsers[i] > 1 ? (
              <li key={g.ipHash}>네트워크 {g.ipHash?.slice(0, 8)} · 계정 <b>{ipUsers[i]}</b>개 · {(g._sum.votes ?? 0).toLocaleString('ko-KR')}표</li>
            ) : null)}
          </ul>
        </Card>
        <Card>
          <CardTitle>많이 팬투표한 계정 (24시간)</CardTitle>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {heavy.length === 0 ? <li className="text-ink-400">없음</li> : heavy.map((h) => {
              const u = heavyUsers.find((x) => x.id === h.userId);
              const fresh = u && requestNowMs() - u.createdAt.getTime() < 3 * 86_400_000;
              return <li key={h.userId}>{u?.name ?? '-'} <span className="text-ink-400">{u?.email}</span> · {(h._sum.votes ?? 0).toLocaleString('ko-KR')}표 {fresh ? <Badge tone="warning">가입 3일 이내</Badge> : null}</li>;
            })}
          </ul>
        </Card>
      </div>
      <div className="mt-4">
        <FilterBar action="/admin/vote/casts">
          <AdminInput name="q" defaultValue={q} placeholder="크리에이터 코드 · 회원 이메일 · 회원 ID" className="w-72" />
        </FilterBar>
      </div>
      <Table>
        <thead><tr><Th>시각</Th><Th>회원</Th><Th>크리에이터</Th><Th className="text-right">표</Th><Th>사용 (무료/보너스/유료)</Th><Th className="text-right">크리에이터 몫</Th><Th>처리</Th></tr></thead>
        <tbody>
          {casts.map((c) => (
            <tr key={c.id}>
              <Td>{formatKst(c.createdAt, false)}{c.roundId ? <Badge tone="brand">회차</Badge> : null}</Td>
              <Td>{c.user.name ?? '-'} <span className="text-ink-400">{c.user.email}</span></Td>
              <Td>{c.creator.displayName} <span className="text-ink-400">{c.creator.code}</span></Td>
              <Td className="text-right">{c.votes.toLocaleString('ko-KR')}</Td>
              <Td>{c.fromFree}/{c.fromBonus}/{c.fromPaid}</Td>
              <Td className="text-right">{Number(c.shareAmount).toLocaleString('ko-KR')}원</Td>
              <Td>
                {c.voidedAt ? <Badge tone="danger">무효 · {c.voidReason}</Badge> : (
                  <ActionForm action={voidCastAction} submitLabel="무효" variant="danger" compact confirm="이 팬투표를 무효 처리할까요?">
                    <input type="hidden" name="castId" value={c.id} />
                    <AdminInput name="reason" placeholder="사유" className="w-28" required />
                    <AdminSelect name="refund" defaultValue="off"><option value="off">팬투표권 회수</option><option value="on">팬투표권 반환</option></AdminSelect>
                  </ActionForm>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
