import { Card } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ProductFormFields } from '@/components/shop/product-form-fields';
import { saveCreatorProductAction } from '@/app/actions/studio-shop';
import { requireCreator } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function StudioNewProductPage() {
  await requireCreator();
  return (
    <>
      <PageHeader title="직접 상품 등록" description="저장하면 최고관리자 검수를 거쳐 내 샵에만 노출됩니다." />
      <Card>
        <ActionForm action={saveCreatorProductAction} submitLabel="검수 요청하고 저장">
          <ProductFormFields v={{ status: 'ON_SALE' }} isAdmin={false} />
        </ActionForm>
      </Card>
    </>
  );
}
