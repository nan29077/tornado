import Link from 'next/link';
import { ShoppingBag } from '@/components/brand/icons';
import { formatWon } from '@/lib/money';

export interface ShopProductCardData {
  id: string;
  name: string;
  summary: string | null;
  thumbnailUrl: string | null;
  listPrice: bigint | null;
  price: bigint;
  status: string;
  ownerType: string;
  shippingFee: bigint;
  freeShippingOver: bigint | null;
}

/** 도네이도 샵 쇼핑 탭 상품 그리드 (셀러샵 스타일) */
export function ShopProductGrid({ code, products, categories, activeCategory }: { code: string; products: ShopProductCardData[]; categories: string[]; activeCategory: string | null }) {
  return (
    <section className="mt-6">
      <div className="flex items-end justify-between px-1">
        <h2 className="text-[16px] font-black tracking-[-0.02em] text-ink-900">쇼핑</h2>
        <Link href={`/c/${code}/cart`} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-brand-700">
          <ShoppingBag size={14} strokeWidth={1.9} />
          장바구니
        </Link>
      </div>
      {categories.length > 1 ? (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
          <Chip href={`/c/${code}?tab=shop`} on={!activeCategory} label="전체" />
          {categories.map((c) => (
            <Chip key={c} href={`/c/${code}?tab=shop&cat=${encodeURIComponent(c)}`} on={activeCategory === c} label={c} />
          ))}
        </div>
      ) : null}
      {products.length === 0 ? (
        <div className="mt-3 rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-9 text-center">
          <p className="text-[13.5px] font-bold text-ink-700">아직 전시된 상품이 없어요</p>
          <p className="mt-1 text-[12.5px] text-ink-400">곧 크리에이터가 고른 상품이 올라올 거예요.</p>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {products.map((p) => {
            const discount = p.listPrice && p.listPrice > p.price ? Math.round((Number(p.listPrice - p.price) / Number(p.listPrice)) * 100) : 0;
            return (
              <Link key={p.id} href={`/c/${code}/shop/${p.id}`} className="group overflow-hidden rounded-2xl border border-warm-300/70 bg-white shadow-card transition hover:-translate-y-0.5">
                <div className="relative aspect-square bg-ink-50">
                  {p.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center text-ink-300">
                      <ShoppingBag size={32} strokeWidth={1.4} />
                    </div>
                  )}
                  {p.status === 'SOLD_OUT' ? (
                    <span className="absolute inset-0 grid place-items-center bg-ink-900/55 text-[14px] font-extrabold text-white">품절</span>
                  ) : null}
                </div>
                <div className="p-3">
                  <p className="line-clamp-2 text-[13px] font-bold leading-snug text-ink-900">{p.name}</p>
                  <p className="mt-1.5 flex items-baseline gap-1.5">
                    {discount > 0 ? <span className="text-[13px] font-extrabold text-danger-600">{discount}%</span> : null}
                    <span className="text-[15px] font-black text-ink-900">{formatWon(p.price)}</span>
                  </p>
                  {discount > 0 && p.listPrice ? <p className="text-[11.5px] text-ink-300 line-through">{formatWon(p.listPrice)}</p> : null}
                  <p className="mt-1 text-[11px] text-ink-400">
                    {p.shippingFee === 0n ? '무료배송' : p.freeShippingOver ? `${formatWon(p.freeShippingOver)} 이상 무료배송` : `배송비 ${formatWon(p.shippingFee)}`}
                    {p.ownerType === 'CREATOR' ? ' · 크리에이터 직접 판매' : ''}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Chip({ href, on, label }: { href: string; on: boolean; label: string }) {
  return (
    <Link href={href} className={`inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-[12.5px] font-bold ${on ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}>
      {label}
    </Link>
  );
}
