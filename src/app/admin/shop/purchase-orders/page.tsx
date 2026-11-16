import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminTextarea } from '@/components/admin/controls';
import { createPurchaseOrdersAction, purchaseOrderStatusAction, uploadTrackingAction } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';
import { PO_STATUS_LABEL, pendingPurchaseItems } from '@/server/services/shop/purchase-orders';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 도네이도 샵 > 발주서 (공급처 로그인 없이 CSV 로 전달) */
export default async function AdminPurchaseOrdersPage() {
  await requireAdminPage('/admin/shop/purchase-orders');
  const [groups, pos] = await Promise.all([
    pendingPurchaseItems(),
    prisma.purchaseOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { supplier: { select: { name: true } }, _count: { select: { items: true } } },
    }),
  ]);

  return (
    <div>
      <PageHeader title="발주서" description="결제 완료된 도네이도 판매 주문을 공급처별로 묶어 발주서(엑셀에서 열리는 CSV)를 만듭니다. 공급처가 택배사·송장번호를 채워 돌려주면 그대로 올려 일괄 발송 처리합니다." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>발주 대기</CardTitle>
          {groups.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-400">발주할 주문이 없습니다.</p>
          ) : (
            <ActionForm action={createPurchaseOrdersAction} submitLabel="선택한 공급처 발주서 만들기" className="mt-2">
              <ul className="space-y-2">
                {groups.map((g) => (
                  <li key={g.supplierId ?? 'none'} className="rounded-xl border border-ink-100 p-3 text-[12.5px]">
                    <label className="flex items-center gap-2 font-bold">
                      {g.supplierId ? <input type="checkbox" name="supplierId" value={g.supplierId} defaultChecked /> : null}
                      {g.supplierName} <span className="font-normal text-ink-400">· {formatNumber(g.items.length)}개 항목</span>
                    </label>
                    {!g.supplierId ? <p className="mt-1 text-warning-600">상품에 공급처를 지정해야 발주서를 만들 수 있습니다. 직접 발송하려면 주문·배송에서 처리하세요.</p> : null}
                    <ul className="mt-1 text-ink-500">
                      {g.items.slice(0, 5).map((it) => (
                        <li key={it.id}>
                          {it.order.orderNo} · {it.productName}
                          {it.variantName ? ` (${it.variantName})` : ''} ×{it.quantity}
                        </li>
                      ))}
                      {g.items.length > 5 ? <li>… 외 {g.items.length - 5}개</li> : null}
                    </ul>
                  </li>
                ))}
              </ul>
            </ActionForm>
          )}
        </Card>
        <Card>
          <CardTitle>송장 일괄 등록</CardTitle>
          <p className="mt-1 text-[12px] text-ink-500">
            발주서 CSV 의 택배사·송장번호 칸을 채운 파일을 그대로 올리거나, 한 줄에 <code>주문번호,택배사,송장번호</code> 형식으로 붙여 넣으세요.
          </p>
          <ActionForm action={uploadTrackingAction} submitLabel="발송 처리" className="mt-2" confirm="입력한 주문을 발송 처리하고 구매자에게 알립니다.">
            <input type="file" name="file" accept=".csv,text/csv" className="text-[12.5px]" />
            <AdminTextarea name="csv" rows={4} placeholder={'SO2611170001,CJ대한통운,123456789012'} />
          </ActionForm>
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-[14px] font-bold text-ink-900">발주서 목록</h2>
      {pos.length === 0 ? (
        <EmptyState title="만든 발주서가 없습니다" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>발주번호</Th>
              <Th>공급처</Th>
              <Th>항목</Th>
              <Th>만든 시각</Th>
              <Th>상태</Th>
              <Th>처리</Th>
            </tr>
          </thead>
          <tbody>
            {pos.map((po) => (
              <tr key={po.id}>
                <Td className="font-mono text-[12px] font-bold">{po.poNo}</Td>
                <Td>{po.supplier.name}</Td>
                <Td>{po._count.items}</Td>
                <Td className="whitespace-nowrap">{formatKst(po.createdAt, false)}</Td>
                <Td>
                  <Badge tone={po.status === 'CANCELLED' ? 'danger' : po.status === 'DONE' ? 'success' : 'neutral'}>{PO_STATUS_LABEL[po.status] ?? po.status}</Badge>
                </Td>
                <Td className="min-w-[260px]">
                  {po.status !== 'CANCELLED' ? (
                    <div className="flex flex-wrap items-start gap-1">
                      <a href={`/api/admin/shop/po/${po.id}`} className="rounded-lg bg-ink-900 px-2.5 py-1.5 text-[12px] font-bold text-white">
                        CSV 내려받기
                      </a>
                      {po.status === 'DRAFT' ? (
                        <ActionForm action={purchaseOrderStatusAction} submitLabel="발주 완료" variant="secondary" compact>
                          <input type="hidden" name="poId" value={po.id} />
                          <input type="hidden" name="status" value="SENT" />
                        </ActionForm>
                      ) : null}
                      {po.status === 'SENT' || po.status === 'SHIPPED' ? (
                        <ActionForm action={purchaseOrderStatusAction} submitLabel="완료" variant="secondary" compact>
                          <input type="hidden" name="poId" value={po.id} />
                          <input type="hidden" name="status" value="DONE" />
                        </ActionForm>
                      ) : null}
                      {po.status === 'DRAFT' || po.status === 'SENT' ? (
                        <ActionForm action={purchaseOrderStatusAction} submitLabel="취소" variant="ghost" compact confirm="발주서를 취소하면 항목이 다시 발주 대기로 돌아갑니다.">
                          <input type="hidden" name="poId" value={po.id} />
                          <input type="hidden" name="status" value="CANCELLED" />
                        </ActionForm>
                      ) : null}
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
