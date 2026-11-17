import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { OnOff, won } from '@/components/admin/engage-bits';
import { createDefaultTicketProductsAction, saveTicketProductAction } from '@/app/actions/admin/engagement';
import { requireAdminPage } from '@/server/admin-guard';
import { listTicketProducts } from '@/server/services/vote/purchase';

export const dynamic = 'force-dynamic';

function Fields({ p }: { p?: { id: string; name: string; price: bigint; tickets: number; bonus: number; badge: string | null; sortOrder: number; active: boolean } }) {
  return (
    <>
      {p ? <input type="hidden" name="id" value={p.id} /> : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <AdminField label="상품 이름" className="sm:col-span-2"><AdminInput name="name" defaultValue={p?.name} required maxLength={40} /></AdminField>
        <AdminField label="가격(원)"><AdminInput name="price" inputMode="numeric" defaultValue={p ? p.price.toString() : ''} required /></AdminField>
        <AdminField label="투표권(유료)"><AdminInput name="tickets" inputMode="numeric" defaultValue={p?.tickets} required /></AdminField>
        <AdminField label="보너스" hint="환불 시 회수"><AdminInput name="bonus" inputMode="numeric" defaultValue={p?.bonus ?? 0} /></AdminField>
        <AdminField label="배지 (BEST · 인기)"><AdminInput name="badge" defaultValue={p?.badge ?? ''} maxLength={10} /></AdminField>
        <AdminField label="노출 순서"><AdminInput name="sortOrder" inputMode="numeric" defaultValue={p?.sortOrder ?? 0} /></AdminField>
        <AdminField label="판매"><OnOff name="active" value={p ? p.active : true} onLabel="판매 중" offLabel="판매 중지" /></AdminField>
      </div>
    </>
  );
}

/** 최고관리자 > 투표 관리 > 투표권 상품 */
export default async function AdminVoteProductsPage() {
  await requireAdminPage('/admin/vote/products');
  const products = await listTicketProducts(true);
  return (
    <div>
      <PageHeader title="투표권 상품" description="충전소 [구매하기]에 보이는 투표권 팩입니다. 결제는 신용카드 · 간편계좌이체 (실 PG 계약 전에는 테스트 결제)." />
      {products.length === 0 ? (
        <Card className="mb-4">
          <CardTitle>상품이 없습니다</CardTitle>
          <p className="mt-1 text-[12.5px] text-ink-500">기본 상품 5종(1,100원~55,000원)을 한 번에 만들고 가격을 고칠 수 있습니다.</p>
          <ActionForm action={createDefaultTicketProductsAction} submitLabel="기본 상품 만들기" className="mt-2" />
        </Card>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>상품 추가</CardTitle>
          <ActionForm action={saveTicketProductAction} submitLabel="추가" className="mt-2"><Fields /></ActionForm>
        </Card>
        {products.map((p) => (
          <Card key={p.id}>
            <CardTitle>
              {p.name} {p.active ? <Badge tone="success">판매 중</Badge> : <Badge>판매 중지</Badge>}{' '}
              <span className="text-[12px] font-normal text-ink-400">{won(p.price)} · 1개당 {(Number(p.price) / Math.max(1, p.tickets + p.bonus)).toFixed(1)}원</span>
            </CardTitle>
            <ActionForm action={saveTicketProductAction} submitLabel="저장" variant="secondary" className="mt-2"><Fields p={p} /></ActionForm>
          </Card>
        ))}
      </div>
    </div>
  );
}
