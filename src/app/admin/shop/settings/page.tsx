import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { saveCreatorCommission, saveShopSettings, saveSupplier } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';
import { getShopConfig, rateToPercentText } from '@/server/services/shop/config';

export const dynamic = 'force-dynamic';

function SupplierFields({ s }: { s?: { id: string; name: string; contactName: string | null; phone: string | null; email: string | null; memo: string | null; active: boolean } }) {
  return (
    <>
      {s ? <input type="hidden" name="id" value={s.id} /> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <AdminField label="공급처 이름">
          <AdminInput name="name" defaultValue={s?.name} required maxLength={60} />
        </AdminField>
        <AdminField label="담당자">
          <AdminInput name="contactName" defaultValue={s?.contactName ?? ''} maxLength={40} />
        </AdminField>
        <AdminField label="연락처">
          <AdminInput name="phone" defaultValue={s?.phone ?? ''} maxLength={30} />
        </AdminField>
        <AdminField label="이메일 (발주서 전달용)">
          <AdminInput name="email" type="email" defaultValue={s?.email ?? ''} maxLength={120} />
        </AdminField>
        <AdminField label="메모">
          <AdminInput name="memo" defaultValue={s?.memo ?? ''} maxLength={300} />
        </AdminField>
        <AdminField label="사용">
          <AdminSelect name="active" defaultValue={s && !s.active ? 'off' : 'on'}>
            <option value="on">사용</option>
            <option value="off">사용 안 함</option>
          </AdminSelect>
        </AdminField>
      </div>
    </>
  );
}

/** 최고관리자 > 도네이도 샵 > 설정 (공급처 · 크리에이터 수익률 · 중개 수수료 · 자동 구매 확정) */
export default async function AdminShopSettingsPage() {
  await requireAdminPage('/admin/shop/settings');
  const [config, suppliers, commissions] = await Promise.all([
    getShopConfig(),
    prisma.supplier.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { _count: { select: { products: true } } } }),
    prisma.creatorCommission.findMany({ include: { creator: { select: { displayName: true, code: true } } }, orderBy: { updatedAt: 'desc' } }),
  ]);

  return (
    <div>
      <PageHeader title="샵 설정" description="크리에이터 수익률은 '크리에이터×상품 개별 지정 → 크리에이터 지정 → 상품 기본값' 순서로 적용됩니다. 바꾼 값은 이후 주문부터 적용됩니다." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>기본 설정</CardTitle>
          <ActionForm action={saveShopSettings} submitLabel="저장" className="mt-2" confirm="이후 주문부터 적용됩니다.">
            <AdminField label="크리에이터 직접 상품 중개 수수료(%)" hint="크리에이터가 판매자인 상품에서 도네이도가 받는 수수료">
              <AdminInput name="brokerFeeRate" inputMode="decimal" defaultValue={rateToPercentText(config.brokerFeeRate).replace('%', '')} required />
            </AdminField>
            <AdminField label="자동 구매 확정(일)" hint="배송 완료 후 이 기간이 지나면 자동으로 구매 확정되고 정산 원장에 적립됩니다">
              <AdminInput name="autoConfirmDays" inputMode="numeric" defaultValue={String(config.autoConfirmDays)} required />
            </AdminField>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle>크리에이터별 기본 수익률</CardTitle>
          <p className="mt-1 text-[12px] text-ink-500">관리자 상품을 판매했을 때 그 샵 크리에이터가 받는 비율입니다. 상품별 개별 지정은 상품 상세에서 합니다.</p>
          {commissions.length > 0 ? (
            <div className="mt-2">
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>크리에이터</Th>
                    <Th>수익률</Th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.map((c) => (
                    <tr key={c.id}>
                      <Td>
                        {c.creator.displayName} <span className="text-ink-400">{c.creator.code}</span>
                      </Td>
                      <Td>{rateToPercentText(c.rate)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
          <ActionForm action={saveCreatorCommission} submitLabel="저장" className="mt-3" confirm="이후 주문부터 적용됩니다.">
            <div className="grid gap-2 sm:grid-cols-2">
              <AdminField label="크리에이터 코드">
                <AdminInput name="creatorCode" placeholder="TOR-XXXX" required />
              </AdminField>
              <AdminField label="수익률(%)" hint="비우면 지정을 지웁니다">
                <AdminInput name="rate" inputMode="decimal" placeholder="예: 10" />
              </AdminField>
            </div>
          </ActionForm>
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-[14px] font-bold text-ink-900">공급처 ({suppliers.length})</h2>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>공급처 추가</CardTitle>
          <ActionForm action={saveSupplier} submitLabel="추가" className="mt-2">
            <SupplierFields />
          </ActionForm>
        </Card>
        {suppliers.map((s) => (
          <Card key={s.id}>
            <CardTitle>
              {s.name} {s.active ? null : <Badge>사용 안 함</Badge>} <span className="text-[12px] font-normal text-ink-400">상품 {s._count.products}개</span>
            </CardTitle>
            <ActionForm action={saveSupplier} submitLabel="저장" variant="secondary" className="mt-2">
              <SupplierFields s={s} />
            </ActionForm>
          </Card>
        ))}
      </div>
    </div>
  );
}
