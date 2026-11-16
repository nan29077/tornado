import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { ProductFormFields, productToFormValues } from '@/components/shop/product-form-fields';
import { deleteAdminProduct, saveAdminProduct, saveCreatorCommission, setDisplayBlocked } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';
import { rateToPercentText } from '@/server/services/shop/config';
import { REVIEW_STATUS_LABEL } from '@/server/services/shop/catalog';

export const dynamic = 'force-dynamic';

export default async function AdminShopProductEditPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  await requireAdminPage('/admin/shop/products');
  const { id } = await params;
  const sp = await searchParams;
  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    include: {
      images: { orderBy: { sortOrder: 'asc' } },
      variants: { orderBy: { sortOrder: 'asc' } },
      creator: { select: { displayName: true, code: true } },
      displays: { include: { creator: { select: { displayName: true, code: true } } }, orderBy: { createdAt: 'desc' } },
      commissions: { include: { creator: { select: { displayName: true, code: true } } } },
    },
  });
  if (!product) notFound();
  const suppliers = await prisma.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const isAdminProduct = product.ownerType === 'ADMIN';

  return (
    <div>
      <PageHeader
        title={product.name}
        description={isAdminProduct ? '관리자 상품 (판매 당사자: 도네이도)' : `크리에이터 직접 상품 · ${product.creator?.displayName} (${product.creator?.code}) · ${REVIEW_STATUS_LABEL[product.reviewStatus]}`}
      />
      {sp.saved ? (
        <div className="mb-4">
          <Notice tone="success">저장했습니다.</Notice>
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          {isAdminProduct ? (
            <ActionForm action={saveAdminProduct} submitLabel="상품 저장">
              <ProductFormFields v={productToFormValues(product)} isAdmin suppliers={suppliers} />
            </ActionForm>
          ) : (
            <div className="text-[13px] text-ink-600">
              <p>크리에이터 직접 상품은 크리에이터가 수정합니다. 최고관리자는 상품 목록에서 검수(승인·반려)하거나 아래에서 판매를 중지할 수 있습니다.</p>
              <p className="mt-2">
                판매가 {product.price.toString()}원 · 옵션 {product.variants.filter((v) => v.active).length}개
              </p>
            </div>
          )}
          <div className="mt-4 border-t border-ink-100 pt-4">
            <ActionForm action={deleteAdminProduct} submitLabel="상품 삭제(판매 중지)" variant="danger" confirm="상품을 삭제하면 모든 샵에서 내려가고 장바구니에서도 빠집니다. 지난 주문 기록은 남습니다.">
              <input type="hidden" name="id" value={product.id} />
            </ActionForm>
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardTitle>전시 중인 샵 ({product.displays.length})</CardTitle>
            {product.displays.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-ink-400">아직 이 상품을 고른 크리에이터가 없습니다.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {product.displays.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                    <Link href={`/c/${d.creator.code}/shop/${product.id}`} className="font-bold text-brand-700 underline">
                      {d.creator.displayName}
                    </Link>
                    {d.blocked ? <Badge tone="danger">판매 차단</Badge> : d.active ? <Badge tone="success">전시</Badge> : <Badge>숨김</Badge>}
                    <ActionForm action={setDisplayBlocked} submitLabel={d.blocked ? '차단 해제' : '이 샵 차단'} variant="secondary" compact>
                      <input type="hidden" name="displayId" value={d.id} />
                      <input type="hidden" name="blocked" value={d.blocked ? '0' : '1'} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {isAdminProduct ? (
            <Card>
              <CardTitle>크리에이터별 이 상품 수익률</CardTitle>
              <p className="mt-1 text-[12px] text-ink-500">상품 기본 {rateToPercentText(product.referralRate)}. 개별 지정이 가장 우선합니다.</p>
              {product.commissions.length > 0 ? (
                <div className="mt-2">
                  <Table className="min-w-0">
                    <thead>
                      <tr>
                        <Th>크리에이터</Th>
                        <Th>수익률</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.commissions.map((c) => (
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
              <div className="mt-3">
                <ActionForm action={saveCreatorCommission} submitLabel="저장" confirm="이후 주문부터 적용됩니다.">
                  <input type="hidden" name="productId" value={product.id} />
                  <AdminField label="크리에이터 코드">
                    <AdminInput name="creatorCode" placeholder="TOR-XXXX" required />
                  </AdminField>
                  <AdminField label="수익률(%)" hint="비우면 개별 지정을 지웁니다">
                    <AdminInput name="rate" inputMode="decimal" placeholder="예: 8" />
                  </AdminField>
                </ActionForm>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
