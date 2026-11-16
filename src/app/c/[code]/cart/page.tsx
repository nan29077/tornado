import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShoppingBag } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { CheckoutForm } from '@/components/shop/checkout-form';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { listCart } from '@/server/services/shop/orders';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { isShopPaymentMock } from '@/server/adapters/shop-payment';

export const dynamic = 'force-dynamic';
export const metadata = { title: '장바구니 | 도네이도 샵', robots: { index: false, follow: false } };

/** 장바구니 + 주문서 (모든 샵에서 담은 상품이 함께 보인다 — 계정은 하나) */
export default async function ShopCartPage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const user = await getSessionUser().catch(() => null);
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(`/c/${creator.code}/cart`)}`);
  const [cart, addresses] = await Promise.all([
    listCart(user.id),
    prisma.memberAddress.findMany({
      where: { userId: user.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, label: true, recipientMasked: true, phoneMasked: true, zipcode: true, addressMasked: true, isDefault: true },
    }),
  ]);

  return (
    <CreatorDonateShell creator={creator} activeMenu="cart">
      <div className="py-6">
        <h1 className="flex items-center gap-2 text-[20px] font-black text-ink-900">
          <ShoppingBag size={20} strokeWidth={1.8} />
          장바구니 · 주문
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-500">도네이도 회원 계정 하나로 모든 크리에이터 샵의 상품을 함께 주문할 수 있어요.</p>
      </div>
      {cart.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-12 text-center">
          <p className="text-[14px] font-bold text-ink-700">장바구니가 비어 있어요</p>
          <Link href={`/c/${creator.code}?tab=shop`} className="mt-3 inline-block text-[13px] font-extrabold text-brand-700">
            쇼핑하러 가기
          </Link>
        </div>
      ) : (
        <CheckoutForm
          shopCode={creator.code}
          paymentMock={isShopPaymentMock()}
          addresses={addresses}
          lines={cart.map((c) => ({
            id: c.id,
            shopName: c.shop?.displayName ?? '-',
            productName: c.product.name,
            variantName: c.variant.name,
            thumbnail: c.product.thumbnailUrl,
            unitPrice: Number(c.unitPrice),
            quantity: c.quantity,
            sellable: c.sellable,
            sellerKey: c.product.ownerType === 'ADMIN' ? 'DONAIDO' : `CREATOR:${c.product.creatorId}`,
            sellerLabel: c.product.ownerType === 'ADMIN' ? '도네이도 판매' : '크리에이터 직접 판매',
            shippingFee: Number(c.product.shippingFee),
            freeShippingOver: c.product.freeShippingOver != null ? Number(c.product.freeShippingOver) : null,
          }))}
        />
      )}
    </CreatorDonateShell>
  );
}
