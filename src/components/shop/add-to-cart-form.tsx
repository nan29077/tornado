'use client';

import * as React from 'react';
import { Minus, Plus, ShoppingBag } from '@/components/brand/icons';
import { addToCartAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';

/** 상품 상세: 옵션·수량 선택 → 장바구니 / 바로 구매 */
export function AddToCartForm({
  shopCode,
  productId,
  basePrice,
  variants,
  soldOut,
  loggedIn,
  loginHref,
  sourceVideo,
}: {
  shopCode: string;
  productId: string;
  basePrice: number;
  variants: Array<{ id: string; name: string; extraPrice: number; stock: number }>;
  soldOut: boolean;
  loggedIn: boolean;
  loginHref: string;
  /** 영상 상품 스티커에서 열었으면 그 영상 키 (구매 출처 기록) */
  sourceVideo?: string;
}) {
  const first = variants.find((v) => v.stock > 0) ?? variants[0];
  const [variantId, setVariantId] = React.useState(first?.id ?? '');
  const [qty, setQty] = React.useState(1);
  const v = variants.find((x) => x.id === variantId);
  const unit = basePrice + (v?.extraPrice ?? 0);
  const max = Math.min(99, v?.stock ?? 0);

  if (soldOut || !v) {
    return <div className="rounded-2xl bg-ink-100 py-4 text-center text-[14px] font-extrabold text-ink-500">품절된 상품입니다</div>;
  }
  if (!loggedIn) {
    return (
      <a href={loginHref} className="flex h-12 items-center justify-center rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900">
        로그인하고 구매하기
      </a>
    );
  }
  return (
    <ShopActionForm action={addToCartAction} className="space-y-3">
      {(pending) => (
        <>
          <input type="hidden" name="shopCode" value={shopCode} />
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="variantId" value={variantId} />
          <input type="hidden" name="quantity" value={qty} />
          {sourceVideo ? <input type="hidden" name="sourceVideo" value={sourceVideo} /> : null}
          {variants.length > 1 || variants[0]?.name !== '기본' ? (
            <label className="block">
              <span className="text-[12.5px] font-bold text-ink-600">옵션</span>
              <select
                value={variantId}
                onChange={(e) => {
                  setVariantId(e.target.value);
                  setQty(1);
                }}
                className="mt-1 h-11 w-full rounded-xl border border-warm-300 bg-white px-3 text-[14px]"
              >
                {variants.map((o) => (
                  <option key={o.id} value={o.id} disabled={o.stock <= 0}>
                    {o.name}
                    {o.extraPrice ? ` (${o.extraPrice > 0 ? '+' : ''}${o.extraPrice.toLocaleString('ko-KR')}원)` : ''}
                    {o.stock <= 0 ? ' - 품절' : o.stock <= 5 ? ` - ${o.stock}개 남음` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="flex items-center justify-between rounded-2xl bg-warm-50 px-3 py-2.5">
            <div className="flex items-center gap-1">
              <button type="button" aria-label="수량 줄이기" onClick={() => setQty((q) => Math.max(1, q - 1))} className="grid h-9 w-9 place-items-center rounded-full border border-warm-300 bg-white">
                <Minus size={15} />
              </button>
              <span className="w-10 text-center text-[15px] font-extrabold tabular-nums">{qty}</span>
              <button type="button" aria-label="수량 늘리기" onClick={() => setQty((q) => Math.min(max, q + 1))} disabled={qty >= max} className="grid h-9 w-9 place-items-center rounded-full border border-warm-300 bg-white disabled:opacity-40">
                <Plus size={15} />
              </button>
            </div>
            <span className="text-[17px] font-black text-ink-900">{(unit * qty).toLocaleString('ko-KR')}원</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="submit" name="buyNow" value="0" disabled={pending} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl border border-ink-200 bg-white text-[14px] font-extrabold text-ink-900 disabled:opacity-50">
              <ShoppingBag size={16} strokeWidth={1.9} />
              장바구니
            </button>
            <button type="submit" name="buyNow" value="1" disabled={pending} className="h-12 rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] disabled:opacity-50">
              바로 구매
            </button>
          </div>
        </>
      )}
    </ShopActionForm>
  );
}
