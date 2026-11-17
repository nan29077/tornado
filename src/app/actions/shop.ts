'use server';

/**
 * 도네이도 샵 — 회원 동작 (구독·영상 후원·장바구니·주문·배송지·구매 확정·취소/반품·찜) (2026-11-17)
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { setFollow, setFollowNotify } from '@/server/services/shop/follow';
import { donateToVideo } from '@/server/services/shop/video-donation';
import { addToCart, confirmOrder, placeOrder, removeCartItems, requestClaim, updateCartQuantity } from '@/server/services/shop/orders';
import { deleteMemberAddress, saveMemberAddress, setDefaultAddress, openAddress, type AddressInput } from '@/server/services/shop/address';

export interface ShopActionState {
  ok: boolean;
  message?: string;
  redirectTo?: string;
}

async function member() {
  const user = await getSessionUser().catch(() => null);
  if (!user) throw new Error('로그인이 필요합니다.');
  if (user.role === 'ADMIN') throw new Error('관리자 계정으로는 이용할 수 없습니다. 회원 계정으로 로그인해 주세요.');
  return user;
}

async function wrap(fn: () => Promise<ShopActionState | string | void>): Promise<ShopActionState> {
  let result: ShopActionState;
  try {
    const r = await fn();
    result = typeof r === 'string' ? { ok: true, message: r } : (r ?? { ok: true });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '처리하지 못했습니다.' };
  }
  /*
    이동은 서버에서 한다 (2026-11-17).
    결제 직후 장바구니가 비면 주문서 폼이 화면에서 사라져, 브라우저 쪽 이동(router.push)이
    실행되지 못하고 빈 장바구니에 머무는 문제가 있었다. 사이트 안 경로만 허용한다.
  */
  if (result.ok && result.redirectTo && result.redirectTo.startsWith('/') && !result.redirectTo.startsWith('//')) {
    redirect(result.redirectTo);
  }
  return result;
}

function str(fd: FormData, k: string) {
  return String(fd.get(k) ?? '').trim();
}

// ------------------------------------------------------------------ 구독

export async function toggleFollowAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const creatorId = str(fd, 'creatorId');
    const on = str(fd, 'on') === '1';
    await setFollow(user.id, creatorId, on);
    revalidatePath('/my/following');
    return on ? '구독했습니다. 새 영상·방송 소식을 알려 드릴게요.' : '구독을 해지했습니다.';
  });
}

export async function setFollowNotifyAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    await setFollowNotify(user.id, str(fd, 'creatorId'), str(fd, 'notify') === '1');
    revalidatePath('/my/following');
    return '알림 설정을 바꿨습니다.';
  });
}

// ------------------------------------------------------------------ 영상 후원

export async function donateVideoAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const limited = await consumeIpRateLimit('shop-video-donate', 10, 60);
    if (!limited.ok) throw new Error('잠시 후 다시 시도해 주세요.');
    const amountRaw = str(fd, 'amount').replace(/[,원\s]/g, '');
    if (!/^\d{3,7}$/.test(amountRaw)) throw new Error('후원 금액을 확인해 주세요.');
    const r = await donateToVideo(
      { id: user.id, name: user.name },
      {
        creatorId: str(fd, 'creatorId'),
        videoRef: str(fd, 'videoRef').slice(0, 80),
        videoTitle: str(fd, 'videoTitle').slice(0, 120),
        amount: BigInt(amountRaw),
        message: str(fd, 'message'),
        nickname: str(fd, 'nickname'),
        anonymous: str(fd, 'anonymous') === 'on',
      },
    );
    if (!r.ok) throw new Error(r.message);
    return { ok: true, message: `${r.message} (거래번호 ${r.transactionNo ?? '-'})` };
  });
}

/** 도네이도 샵 [후원하기] 탭 · 신용카드 후원 (PG, 지금은 테스트 결제). 결제·송출 흐름은 영상 후원과 같다. */
export async function donateCardAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const limited = await consumeIpRateLimit('shop-card-donate', 10, 60);
    if (!limited.ok) throw new Error('잠시 후 다시 시도해 주세요.');
    const amountRaw = str(fd, 'amount').replace(/[,원\s]/g, '');
    if (!/^\d{3,7}$/.test(amountRaw)) throw new Error('후원 금액을 확인해 주세요.');
    const r = await donateToVideo(
      { id: user.id, name: user.name },
      {
        creatorId: str(fd, 'creatorId'),
        videoRef: 'CARD',
        videoTitle: '신용카드 후원',
        amount: BigInt(amountRaw),
        message: str(fd, 'message'),
        nickname: str(fd, 'nickname'),
        anonymous: str(fd, 'anonymous') === 'on',
        kind: 'CARD',
      },
    );
    if (!r.ok) throw new Error(r.message);
    return { ok: true, message: `${r.message} (거래번호 ${r.transactionNo ?? '-'})` };
  });
}

// ------------------------------------------------------------------ 장바구니 · 주문

export async function addToCartAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const code = str(fd, 'shopCode');
    const shop = await prisma.creatorProfile.findUnique({ where: { code }, select: { id: true } });
    if (!shop) throw new Error('샵을 찾을 수 없습니다.');
    await addToCart(user.id, shop.id, str(fd, 'productId'), str(fd, 'variantId'), Number.parseInt(str(fd, 'quantity') || '1', 10));
    revalidatePath(`/c/${code}/cart`);
    return str(fd, 'buyNow') === '1'
      ? { ok: true, redirectTo: `/c/${code}/cart?buy=1` }
      : { ok: true, message: '장바구니에 담았습니다.' };
  });
}

export async function updateCartAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const id = str(fd, 'cartItemId');
    if (str(fd, 'remove') === '1') await removeCartItems(user.id, [id]);
    else await updateCartQuantity(user.id, id, Number.parseInt(str(fd, 'quantity'), 10));
  });
}

function addressFrom(fd: FormData): AddressInput {
  return {
    label: str(fd, 'label') || null,
    recipient: str(fd, 'recipient'),
    phone: str(fd, 'phone'),
    zipcode: str(fd, 'zipcode'),
    address1: str(fd, 'address1'),
    address2: str(fd, 'address2') || null,
  };
}

export async function checkoutAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const limited = await consumeIpRateLimit('shop-checkout', 10, 60);
    if (!limited.ok) throw new Error('잠시 후 다시 시도해 주세요.');
    const ids = fd.getAll('cartItemId').map(String).filter(Boolean);
    let address: AddressInput;
    const addressId = str(fd, 'addressId');
    if (addressId) {
      const row = await prisma.memberAddress.findFirst({ where: { id: addressId, userId: user.id } });
      if (!row) throw new Error('배송지를 찾을 수 없습니다.');
      const a = openAddress(row);
      address = { recipient: a.recipient, phone: a.phone, zipcode: a.zipcode, address1: a.address, address2: null };
    } else {
      address = addressFrom(fd);
      if (str(fd, 'saveAddress') === 'on') await saveMemberAddress(user.id, address).catch(() => undefined);
    }
    if (str(fd, 'agree') !== 'on') throw new Error('주문 내용 확인 및 결제 진행에 동의해 주세요.');
    const r = await placeOrder({ id: user.id, name: user.name }, { cartItemIds: ids, address, memo: str(fd, 'memo') });
    if (!r.ok) throw new Error(r.message ?? '주문하지 못했습니다.');
    revalidatePath('/my/orders');
    const code = str(fd, 'shopCode');
    return { ok: true, redirectTo: code ? `/c/${code}/orders?done=${encodeURIComponent(r.paymentNo ?? '')}` : `/my/orders?done=${encodeURIComponent(r.paymentNo ?? '')}` };
  });
}

export async function confirmOrderAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    await confirmOrder(str(fd, 'orderId'), { type: 'BUYER', userId: user.id });
    revalidatePath('/my/orders');
    return '구매를 확정했습니다. 감사합니다.';
  });
}

export async function requestClaimAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const type = str(fd, 'type') === 'RETURN' ? 'RETURN' : 'CANCEL';
    const r = await requestClaim(user.id, str(fd, 'orderId'), type, str(fd, 'reason'));
    revalidatePath('/my/orders');
    return r.autoApproved ? '주문을 취소하고 환불했습니다.' : `${type === 'CANCEL' ? '취소' : '반품'} 요청을 접수했습니다. 판매자 확인 후 처리됩니다.`;
  });
}

// ------------------------------------------------------------------ 배송지 · 찜

export async function saveAddressAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    await saveMemberAddress(user.id, addressFrom(fd), { id: str(fd, 'id') || undefined, makeDefault: str(fd, 'isDefault') === 'on' });
    revalidatePath('/my/addresses');
    return '배송지를 저장했습니다.';
  });
}

export async function addressOpAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const id = str(fd, 'id');
    if (str(fd, 'op') === 'delete') await deleteMemberAddress(user.id, id);
    else await setDefaultAddress(user.id, id);
    revalidatePath('/my/addresses');
    return str(fd, 'op') === 'delete' ? '배송지를 삭제했습니다.' : '기본 배송지로 지정했습니다.';
  });
}

export async function toggleWishAction(_p: ShopActionState, fd: FormData): Promise<ShopActionState> {
  return wrap(async () => {
    const user = await member();
    const productId = str(fd, 'productId');
    if (str(fd, 'on') === '1') {
      const p = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true } });
      if (!p) throw new Error('상품을 찾을 수 없습니다.');
      await prisma.productWish.upsert({ where: { userId_productId: { userId: user.id, productId } }, create: { id: newId(), userId: user.id, productId }, update: {} });
      revalidatePath('/my/wishlist');
      return '관심 상품에 담았습니다.';
    }
    await prisma.productWish.deleteMany({ where: { userId: user.id, productId } });
    revalidatePath('/my/wishlist');
    return '관심 상품에서 뺐습니다.';
  });
}
