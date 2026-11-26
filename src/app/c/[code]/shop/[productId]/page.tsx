import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Info, Truck } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { AddToCartForm } from '@/components/shop/add-to-cart-form';
import { WishButton } from '@/components/shop/wish-button';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { getShopProduct } from '@/server/services/shop/catalog';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';
export const metadata = { title: '상품 | 도네이도 샵' };

/**
 * 도네이도 샵 상품 상세.
 * 판매자 표시: 관리자 상품은 도네이도(판매 당사자), 크리에이터 직접 상품은 크리에이터 + 통신판매중개자 고지.
 */
export default async function ShopProductPage({ params }: { params: Promise<{ code: string; productId: string }> }) {
  const { code, productId } = await params;
  const creator = await loadCreatorDonateProfile(code);
  const product = await getShopProduct(creator.id, productId);
  if (!product) notFound();
  const viewer = await getSessionUser().catch(() => null);
  const wished = viewer ? Boolean(await prisma.productWish.findUnique({ where: { userId_productId: { userId: viewer.id, productId } }, select: { id: true } })) : false;
  const notice = Array.isArray(product.notice) ? (product.notice as Array<{ label: string; value: string }>) : [];
  const images = product.images.length > 0 ? product.images.map((i) => i.url) : product.thumbnailUrl ? [product.thumbnailUrl] : [];
  const discount = product.listPrice && product.listPrice > product.price ? Math.round((Number(product.listPrice - product.price) / Number(product.listPrice)) * 100) : 0;
  const isDirect = product.ownerType === 'CREATOR';
  // [9차 P2-4] 크리에이터 본인의 직접 판매 상품은 구매 버튼 대신 안내를 보여 준다 (서버에서도 막는다)
  const myCreatorId = viewer ? (await prisma.creatorProfile.findUnique({ where: { userId: viewer.id }, select: { id: true } }))?.id ?? null : null;
  const ownDirect = isDirect && myCreatorId != null && product.creatorId === myCreatorId;
  const here = `/c/${creator.code}/shop/${product.id}`;

  return (
    <CreatorDonateShell creator={creator}>
      <div className="py-4">
        <Link href={`/c/${creator.code}?tab=shop`} className="inline-flex items-center gap-1 text-[13px] font-bold text-ink-600">
          <ChevronLeft size={16} />
          쇼핑으로
        </Link>
      </div>

      <div className="overflow-hidden rounded-[1.5rem] border border-warm-300/70 bg-white shadow-card">
        {images.length > 0 ? (
          <div className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]">
            {images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt={i === 0 ? product.name : ''} className="aspect-square w-full shrink-0 snap-start object-cover" />
            ))}
          </div>
        ) : (
          // [9차 P3-10] 이미지가 없을 때 PC 에서 정사각 빈 영역이 화면을 거의 다 차지해 가격 · 구매 버튼이 아래로 밀렸다
          <div className="grid aspect-[4/3] place-items-center bg-ink-50 text-[13px] text-ink-300 sm:aspect-[16/7]">이미지 준비 중</div>
        )}
        <div className="p-5">
          <p className="text-[12px] font-bold text-ink-400">{isDirect ? `${creator.displayName} 직접 판매` : `${creator.displayName} 추천 · 도네이도 판매`}</p>
          <h1 className="mt-1 text-[19px] font-black leading-snug text-ink-900">{product.name}</h1>
          {product.summary ? <p className="mt-1.5 text-[13.5px] text-ink-500">{product.summary}</p> : null}
          <p className="mt-3 flex items-baseline gap-2">
            {discount > 0 ? <span className="text-[18px] font-black text-danger-600">{discount}%</span> : null}
            <span className="text-[22px] font-black text-ink-900">{formatWon(product.price)}</span>
            {discount > 0 && product.listPrice ? <span className="text-[13px] text-ink-300 line-through">{formatWon(product.listPrice)}</span> : null}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-500">
            <Truck size={14} strokeWidth={1.8} />
            {product.shippingFee === 0n ? '무료배송' : `배송비 ${formatWon(product.shippingFee)}`}
            {product.freeShippingOver ? ` · ${formatWon(product.freeShippingOver)} 이상 구매 시 무료` : ''}
          </p>
          <div className="mt-4">
            {ownDirect ? (
              <p className="rounded-2xl border border-warm-300/70 bg-warm-50 px-4 py-3 text-[13px] font-bold text-ink-600">
                내 샵에서 직접 판매하는 상품이에요. 본인은 구매할 수 없어요.
              </p>
            ) : (
            <AddToCartForm
              shopCode={creator.code}
              productId={product.id}
              basePrice={Number(product.price)}
              variants={product.variants.map((v) => ({ id: v.id, name: v.name, extraPrice: Number(v.extraPrice), stock: v.stock }))}
              soldOut={product.status !== 'ON_SALE'}
              loggedIn={Boolean(viewer)}
              loginHref={`/c/${creator.code}/login?next=${encodeURIComponent(here)}`}
            />
            )}
          </div>
          {viewer ? (
            <div className="mt-2">
              <WishButton productId={product.id} wished={wished} />
            </div>
          ) : null}
        </div>
      </div>

      {product.description ? (
        <section className="mt-5 rounded-[1.5rem] border border-warm-300/70 bg-white p-5 shadow-card">
          <h2 className="text-[15px] font-black text-ink-900">상품 설명</h2>
          <p className="mt-2 whitespace-pre-line break-words text-[13.5px] leading-relaxed text-ink-700">{product.description}</p>
        </section>
      ) : null}

      {notice.length > 0 ? (
        <section className="mt-5 rounded-[1.5rem] border border-warm-300/70 bg-white p-5 shadow-card">
          <h2 className="text-[15px] font-black text-ink-900">상품정보 제공고시</h2>
          <dl className="mt-2 divide-y divide-warm-200 text-[12.5px]">
            {notice.map((n, i) => (
              <div key={i} className="grid grid-cols-[110px_1fr] gap-2 py-2">
                <dt className="font-bold text-ink-500">{n.label}</dt>
                <dd className="break-words text-ink-800">{n.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="mt-5 rounded-[1.5rem] border border-warm-300/70 bg-warm-50 p-5 text-[12px] leading-relaxed text-ink-500">
        <p className="flex items-center gap-1.5 text-[13px] font-extrabold text-ink-800">
          <Info size={14} strokeWidth={1.8} />
          판매자 정보
        </p>
        {isDirect ? (
          <>
            <p className="mt-2">
              판매자: {product.creator?.sellerBizName ?? product.creator?.displayName ?? '-'} · 사업자등록번호 {product.creator?.sellerBizNo ?? '-'}
              {product.creator?.sellerMailOrderNo ? ` · 통신판매업 ${product.creator.sellerMailOrderNo}` : ''}
            </p>
            <p>고객 문의 {product.creator?.sellerCsPhone ?? '-'} · 반품지 {product.creator?.sellerReturnAddress ?? product.returnAddress ?? '-'}</p>
            <p className="mt-2 font-semibold text-ink-700">
              도네이도는 통신판매중개자이며 이 상품의 판매 당사자가 아닙니다. 상품·거래 정보와 거래에 대한 책임은 판매자에게 있습니다.
            </p>
          </>
        ) : (
          <>
            <p className="mt-2">판매자: {env.business.name || '도네이도'} (판매 당사자)</p>
            <p>{creator.displayName} 님이 추천한 상품입니다. 주문·배송·교환·반품은 도네이도가 처리합니다.</p>
          </>
        )}
      </section>
    </CreatorDonateShell>
  );
}
