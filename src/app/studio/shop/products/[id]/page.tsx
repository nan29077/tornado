import { notFound } from 'next/navigation';
import { Badge, Card, Notice } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ProductFormFields, productToFormValues } from '@/components/shop/product-form-fields';
import { deleteCreatorProductAction, saveCreatorProductAction } from '@/app/actions/studio-shop';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { REVIEW_STATUS_LABEL } from '@/server/services/shop/catalog';

export const dynamic = 'force-dynamic';

export default async function StudioEditProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { creatorId } = await requireCreator();
  const { id } = await params;
  const sp = await searchParams;
  const product = await prisma.product.findFirst({
    where: { id, ownerType: 'CREATOR', creatorId, deletedAt: null },
    include: { images: { orderBy: { sortOrder: 'asc' } }, variants: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!product) notFound();
  return (
    <>
      <PageHeader title={product.name} description="수정하면 다시 검수 대기로 바뀌고, 승인될 때까지 샵에서 잠시 내려갑니다." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={product.reviewStatus === 'APPROVED' ? 'success' : product.reviewStatus === 'REJECTED' ? 'danger' : 'warning'}>{REVIEW_STATUS_LABEL[product.reviewStatus]}</Badge>
        {product.reviewStatus === 'REJECTED' && product.rejectReason ? <span className="text-[13px] text-danger-600">반려 사유: {product.rejectReason}</span> : null}
      </div>
      {sp.saved ? (
        <div className="mb-3">
          <Notice tone="success">저장했습니다. 최고관리자 검수 후 샵에 노출됩니다.</Notice>
        </div>
      ) : null}
      <Card>
        <ActionForm action={saveCreatorProductAction} submitLabel="수정 저장 (재검수)" confirmMessage="수정하면 검수가 끝날 때까지 샵에서 내려갑니다. 저장할까요?">
          <ProductFormFields v={productToFormValues(product)} isAdmin={false} />
        </ActionForm>
        <div className="mt-4 border-t border-ink-100 pt-4">
          <ActionForm action={deleteCreatorProductAction} submitLabel="상품 삭제" variant="danger" confirmMessage="상품을 삭제하면 샵과 장바구니에서 빠집니다. 지난 주문 기록은 남습니다." confirmVariant="danger">
            <input type="hidden" name="id" value={product.id} />
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
