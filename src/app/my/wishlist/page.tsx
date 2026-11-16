import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Heart } from '@/components/brand/icons';
import { ShopActionForm } from '@/components/shop/shop-action-form';
import { toggleWishAction } from '@/app/actions/shop';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 마이페이지 > 찜한 상품. 상품을 누르면 그 상품을 진열한 샵(구독 중인 샵 우선)으로 간다 */
export default async function MyWishlistPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/my/wishlist');
  const wishes = await prisma.productWish.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { product: { select: { id: true, name: true, price: true, thumbnailUrl: true, status: true, deletedAt: true, reviewStatus: true, ownerType: true, creatorId: true } } },
  });
  const productIds = wishes.map((w) => w.productId);
  const [displays, follows] = await Promise.all([
    prisma.creatorProduct.findMany({
      where: { productId: { in: productIds }, active: true, blocked: false, creator: { status: 'APPROVED' } },
      select: { productId: true, creatorId: true, creator: { select: { code: true, displayName: true } } },
    }),
    prisma.memberFollow.findMany({ where: { userId: user.id }, select: { creatorId: true } }),
  ]);
  const followed = new Set(follows.map((f) => f.creatorId));
  const shopOf = new Map<string, { code: string; displayName: string }>();
  for (const d of displays) {
    const prev = shopOf.get(d.productId);
    if (!prev || followed.has(d.creatorId)) shopOf.set(d.productId, d.creator);
  }

  if (wishes.length === 0) {
    return (
      <div className="rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-12 text-center">
        <Heart size={28} strokeWidth={1.5} className="mx-auto text-ink-300" />
        <p className="mt-2 text-[14px] font-bold text-ink-700">찜한 상품이 없어요</p>
        <p className="mt-1 text-[12.5px] text-ink-400">도네이도 샵 상품의 하트를 누르면 여기에 담깁니다.</p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {wishes.map((w) => {
        const p = w.product;
        const shop = shopOf.get(p.id);
        const sellable = !p.deletedAt && p.reviewStatus === 'APPROVED' && (p.status === 'ON_SALE' || p.status === 'SOLD_OUT') && shop;
        const inner = (
          <>
            {p.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.thumbnailUrl} alt="" className="aspect-square w-full rounded-xl object-cover" loading="lazy" />
            ) : (
              <span className="block aspect-square w-full rounded-xl bg-ink-100" />
            )}
            <p className="mt-2 line-clamp-2 text-[13px] font-bold text-ink-900">{p.name}</p>
            <p className="text-[13px] font-extrabold">{formatWon(p.price)}</p>
            <p className="text-[11.5px] text-ink-400">{sellable ? `${shop.displayName} 샵${p.status === 'SOLD_OUT' ? ' · 품절' : ''}` : '지금은 구매할 수 없어요'}</p>
          </>
        );
        return (
          <li key={w.id} className="relative rounded-[1.25rem] border border-warm-300/70 bg-white p-2.5 shadow-card">
            {sellable ? (
              <Link href={`/c/${shop.code}/shop/${p.id}`} className="block">
                {inner}
              </Link>
            ) : (
              <div className="opacity-60">{inner}</div>
            )}
            <ShopActionForm action={toggleWishAction} hideMessage className="absolute right-3 top-3">
              <input type="hidden" name="productId" value={p.id} />
              <input type="hidden" name="on" value="0" />
              <button aria-label="찜 해제" className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-accent-500 shadow">
                <Heart size={16} strokeWidth={2} className="fill-current" />
              </button>
            </ShopActionForm>
          </li>
        );
      })}
    </ul>
  );
}
