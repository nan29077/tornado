import { PageHeader } from '@/components/layout/console-shell';
import { Card } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { ProductFormFields } from '@/components/shop/product-form-fields';
import { saveAdminProduct } from '@/app/actions/admin/shop';
import { prisma } from '@/server/db';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

export default async function AdminShopProductNewPage() {
  await requireAdminPage('/admin/shop/products');
  const suppliers = await prisma.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return (
    <div>
      <PageHeader title="관리자 상품 등록" description="도네이도가 판매 당사자인 상품입니다. 공급처를 지정하면 주문이 발주서로 모입니다." />
      <Card>
        <ActionForm action={saveAdminProduct} submitLabel="상품 저장">
          <ProductFormFields v={{ status: 'DRAFT', shippingFee: '3000', referralRatePercent: '5' }} isAdmin suppliers={suppliers} />
        </ActionForm>
      </Card>
    </div>
  );
}
