'use client';

import { Heart } from '@/components/brand/icons';
import { toggleWishAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';

export function WishButton({ productId, wished }: { productId: string; wished: boolean }) {
  return (
    <ShopActionForm action={toggleWishAction} hideMessage>
      {(pending) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="on" value={wished ? '0' : '1'} />
          <button type="submit" disabled={pending} aria-pressed={wished} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold text-ink-600 hover:bg-warm-100">
            <Heart size={15} strokeWidth={1.9} className={wished ? 'fill-current text-danger-600' : ''} />
            {wished ? '관심 상품에 담김' : '관심 상품 담기'}
          </button>
        </>
      )}
    </ShopActionForm>
  );
}
