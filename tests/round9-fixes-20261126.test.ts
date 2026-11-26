import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { checkTicketRefund, purchaseTickets, refundTicketOrder } from '@/server/services/vote/purchase';
import { contributeSupport, createSupport } from '@/server/services/vote/support';
import { castVote } from '@/server/services/vote/cast';
import { expireLots } from '@/server/services/vote/wallet';
import { parseProductForm, saveProduct, getShopProduct } from '@/server/services/shop/catalog';
import { addToCart, confirmOrder, markPreparing, markShipped, placeOrder, processClaim, requestClaim, OWN_PRODUCT_MESSAGE } from '@/server/services/shop/orders';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const session = vi.hoisted(() => ({ creator: null as null | { id: string; creatorId: string } }));
vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    requireCreator: vi.fn(async () => {
      if (!session.creator) throw new Error('크리에이터 권한이 필요합니다.');
      return { id: session.creator.id, creatorId: session.creator.creatorId, role: 'CREATOR', email: null, name: 'c', avatarIndex: 0 };
    }),
  };
});
const studio = await import('@/app/actions/studio-shop');

/**
 * 2026-11-26 9차 기능 점검 수정 회귀 테스트
 */

const DAY = 86_400_000;
const ADDR = { recipient: '홍길동', phone: '010-1234-5678', zipcode: '06236', address1: '서울특별시 강남구 테헤란로 123', address2: '101동 202호' };
const ADMIN = { type: 'ADMIN' as const, userId: 'admin-r9' };
let fx: Fixture;

async function member(name = '팬') {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'DONOR' } });
  return { id: u.id, name: u.name };
}
async function creator(name: string) {
  const u = await prisma.user.create({ data: { id: newId(), email: `c-${newId()}@test.kr`, name, role: 'CREATOR' } });
  const c = await prisma.creatorProfile.create({ data: { id: newId(), userId: u.id, code: `TOR-${newId().slice(-5)}`, displayName: name, status: 'APPROVED' } });
  return c.id;
}
async function adminProduct(stock: number, shops: string[], status = 'ON_SALE') {
  const fd = new FormData();
  fd.set('name', `상품${newId().slice(-4)}`);
  fd.set('price', '10000');
  fd.set('shippingFee', '3000');
  fd.set('referralRate', '5');
  fd.set('status', status);
  fd.set('variants', `단일 | 0 | ${stock}`);
  const id = await saveProduct(parseProductForm(fd, { forAdmin: true }), { type: 'ADMIN' });
  for (const s of shops) await prisma.creatorProduct.create({ data: { id: newId(), creatorId: s, productId: id } });
  const variants = await prisma.productVariant.findMany({ where: { productId: id } });
  return { id, variantId: variants[0].id };
}
async function directProduct(creatorId: string, price = '15000') {
  await prisma.creatorProfile.update({ where: { id: creatorId }, data: { sellerBizName: '상호', sellerBizNo: '123-45-67890', sellerCsPhone: '02-123-4567', sellerReturnAddress: '서울시 반품로 1' } });
  const fd = new FormData();
  fd.set('name', '내 굿즈'); fd.set('price', price); fd.set('shippingFee', '0'); fd.set('status', 'ON_SALE'); fd.set('stock', '10');
  const id = await saveProduct(parseProductForm(fd, { forAdmin: false }), { type: 'CREATOR', creatorId });
  await prisma.product.update({ where: { id }, data: { reviewStatus: 'APPROVED' } });
  const v = await prisma.productVariant.findFirstOrThrow({ where: { productId: id } });
  return { id, variantId: v.id };
}
async function buy(user: { id: string; name: string | null }, shop: string, p: { id: string; variantId: string }, qty = 1) {
  await addToCart(user.id, shop, p.id, p.variantId, qty);
  const cart = await prisma.cartItem.findMany({ where: { userId: user.id, shopCreatorId: shop, variantId: p.variantId } });
  const r = await placeOrder(user, { cartItemIds: cart.map((c) => c.id), address: ADDR });
  expect(r.ok, r.message).toBe(true);
  return prisma.shopOrder.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  session.creator = { id: fx.creatorUserId, creatorId: fx.creatorId };
});

describe('[P1-1] 보너스를 서포트에 쓰면 팬투표권 결제를 환불할 수 없다', () => {
  it('서포트에 보너스만 넣어도 환불 거절 (사용자 · 관리자 모두)', async () => {
    const pid = newId();
    await prisma.voteTicketProduct.create({ data: { id: pid, name: '팩', price: 5500n, tickets: 500, bonus: 30 } });
    const sid = await createSupport({ creatorId: fx.creatorId, title: '신문 광고', rewardType: 'NEWSPAPER', goalTickets: 1000, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY) }, 'admin');
    const u = await member();
    expect((await purchaseTickets(u, pid, 'CARD')).ok).toBe(true);
    expect((await contributeSupport(u.id, sid, 30)).ok).toBe(true);
    const order = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: u.id } });
    const chk = await checkTicketRefund(order.id);
    expect(chk.refundable).toBe(false);
    expect(chk.reason).toContain('서포트');
    expect((await refundTicketOrder(order.id, { type: 'USER', userId: u.id }, '테스트')).ok).toBe(false);
    expect((await refundTicketOrder(order.id, { type: 'ADMIN', userId: 'adm' }, '테스트')).ok).toBe(false);
    expect((await prisma.voteTicketOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('기존 규칙 유지: 팬투표에 쓰면 거절, 쓰지 않거나 보너스가 만료로 사라졌으면 환불', async () => {
    const pid = newId();
    await prisma.voteTicketProduct.create({ data: { id: pid, name: '팩', price: 5500n, tickets: 500, bonus: 30 } });
    const a = await member();
    await purchaseTickets(a, pid, 'CARD');
    expect((await castVote(a, { creatorId: fx.creatorId, votes: 5 })).ok).toBe(true);
    const oa = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: a.id } });
    expect((await checkTicketRefund(oa.id)).refundable).toBe(false);

    const b = await member();
    await purchaseTickets(b, pid, 'CARD');
    const ob = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: b.id } });
    expect((await checkTicketRefund(ob.id)).refundable).toBe(true);
    await prisma.voteTicketLot.update({ where: { id: ob.bonusLotId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireLots();
    expect((await refundTicketOrder(ob.id, { type: 'USER', userId: b.id }, '테스트')).ok).toBe(true);
  });
});

describe('[P2-3 · P3-8] 취소 · 반품되면 자동 품절을 풀고 판매 수량을 되돌린다', () => {
  it('마지막 재고 주문 취소 → 판매중 복귀, 판매 수량 원래대로, 다른 회원이 살 수 있다', async () => {
    const p = await adminProduct(1, [fx.creatorId]);
    const before = (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).soldCount;
    const u = await member('구매자');
    const order = await buy(u, fx.creatorId, p);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SOLD_OUT');
    expect((await requestClaim(u.id, order.id, 'CANCEL', '단순 변심')).autoApproved).toBe(true);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe('ON_SALE');
    expect(after.soldCount).toBe(before);
    expect((await getShopProduct(fx.creatorId, p.id))?.status).toBe('ON_SALE');
    const u2 = await member('둘째');
    await expect(addToCart(u2.id, fx.creatorId, p.id, p.variantId, 1)).resolves.toBeUndefined();
  });

  it('반품 승인도 같다', async () => {
    const p = await adminProduct(1, [fx.creatorId]);
    const u = await member('구매자');
    const order = await buy(u, fx.creatorId, p);
    await markShipped(order.id, ADMIN, 'CJ', '1234567890');
    await requestClaim(u.id, order.id, 'RETURN', '불량');
    const claim = await prisma.orderClaim.findFirstOrThrow({ where: { orderId: order.id } });
    await processClaim(claim.id, ADMIN, true);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe('ON_SALE');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })).stock).toBe(1);
  });

  it('재고가 남아 있는데 직접 품절로 둔 상품은 취소돼도 품절 그대로', async () => {
    const p = await adminProduct(5, [fx.creatorId]);
    const u = await member('구매자');
    const order = await buy(u, fx.creatorId, p);
    await prisma.product.update({ where: { id: p.id }, data: { status: 'SOLD_OUT' } }); // 관리자가 직접 품절 처리
    await requestClaim(u.id, order.id, 'CANCEL', '단순 변심');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SOLD_OUT');
  });

  it('판매 수량은 0 아래로 내려가지 않는다', async () => {
    const p = await adminProduct(3, [fx.creatorId]);
    const u = await member('구매자');
    const order = await buy(u, fx.creatorId, p);
    await prisma.product.update({ where: { id: p.id }, data: { soldCount: 0 } });
    await requestClaim(u.id, order.id, 'CANCEL', '단순 변심');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).soldCount).toBe(0);
  });
});

describe('[P3-6] 결제 후 장바구니는 주문한 샵의 항목만 지운다', () => {
  it('같은 상품을 두 샵에 담고 한 샵만 결제 → 다른 샵 항목은 남는다', async () => {
    const shop2 = await creator('둘째샵');
    const p = await adminProduct(10, [fx.creatorId, shop2]);
    const u = await member('구매자');
    await addToCart(u.id, fx.creatorId, p.id, p.variantId, 1);
    await addToCart(u.id, shop2, p.id, p.variantId, 2);
    const first = await prisma.cartItem.findFirstOrThrow({ where: { userId: u.id, shopCreatorId: fx.creatorId } });
    expect((await placeOrder(u, { cartItemIds: [first.id], address: ADDR })).ok).toBe(true);
    const left = await prisma.cartItem.findMany({ where: { userId: u.id } });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ shopCreatorId: shop2, quantity: 2 });
  });
});

describe('[P3-7] 취소 요청은 동시에 눌러도 1건만 접수된다', () => {
  it('준비중 주문에 취소 요청 2건 동시 → 1건 접수, 1건 거절', async () => {
    const p = await adminProduct(5, [fx.creatorId]);
    const u = await member('구매자');
    const order = await buy(u, fx.creatorId, p);
    await markPreparing(order.id, ADMIN);
    const rs = await Promise.allSettled([requestClaim(u.id, order.id, 'CANCEL', '사유 하나'), requestClaim(u.id, order.id, 'CANCEL', '사유 둘')]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toContain('이미 처리 중');
    expect(await prisma.orderClaim.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('거절된 요청 뒤에는 다시 신청할 수 있다', async () => {
    const p = await adminProduct(5, [fx.creatorId]);
    const u = await member('구매자');
    const order = await buy(u, fx.creatorId, p);
    await markPreparing(order.id, ADMIN);
    await requestClaim(u.id, order.id, 'CANCEL', '사유 하나');
    const c = await prisma.orderClaim.findFirstOrThrow({ where: { orderId: order.id } });
    await processClaim(c.id, ADMIN, false, '이미 포장 완료');
    await expect(requestClaim(u.id, order.id, 'CANCEL', '다시 요청')).resolves.toMatchObject({ autoApproved: false });
  });
});

describe('[P2-4] 크리에이터 본인 구매', () => {
  it('내 샵 직접 상품은 장바구니 · 주문 모두 막힌다', async () => {
    const own = await directProduct(fx.creatorId);
    const me = { id: fx.creatorUserId, name: '본인' };
    await expect(addToCart(me.id, fx.creatorId, own.id, own.variantId, 1)).rejects.toThrow(OWN_PRODUCT_MESSAGE);
    // 장바구니에 직접 넣어도(예전 데이터) 주문 단계에서 막힌다
    const cartId = newId();
    await prisma.cartItem.create({ data: { id: cartId, userId: me.id, shopCreatorId: fx.creatorId, productId: own.id, variantId: own.variantId, quantity: 1 } });
    const r = await placeOrder(me, { cartItemIds: [cartId], address: ADDR });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(OWN_PRODUCT_MESSAGE);
    expect(await prisma.shopOrder.count({ where: { userId: me.id } })).toBe(0);
  });

  it('내 샵의 도네이도 상품은 살 수 있지만 레퍼럴 수익은 0', async () => {
    const p = await adminProduct(5, [fx.creatorId]);
    const me = { id: fx.creatorUserId, name: '본인' };
    const order = await buy(me, fx.creatorId, p);
    const items = await prisma.shopOrderItem.findMany({ where: { orderId: order.id } });
    expect(items[0].referralAmount).toBe(0n);
    await markShipped(order.id, ADMIN, 'CJ', '1234567890');
    await confirmOrder(order.id, { type: 'BUYER', userId: me.id });
    expect(await prisma.settlementLedger.count({ where: { creatorId: fx.creatorId, entryType: 'REFERRAL_COMMISSION' } })).toBe(0);
  });

  it('다른 크리에이터는 내 직접 상품을 살 수 있고, 다른 샵 상품의 레퍼럴은 그대로 쌓인다', async () => {
    const own = await directProduct(fx.creatorId);
    const otherShop = await creator('다른샵');
    const otherUser = (await prisma.creatorProfile.findUniqueOrThrow({ where: { id: otherShop } })).userId;
    await buy({ id: otherUser, name: '다른 크리에이터' }, fx.creatorId, own);
    const p = await adminProduct(5, [fx.creatorId]);
    const order = await buy({ id: otherUser, name: '다른 크리에이터' }, fx.creatorId, p);
    const items = await prisma.shopOrderItem.findMany({ where: { orderId: order.id } });
    expect(items[0].referralAmount).toBe(500n);
  });
});

describe('[P2-5] 판매 중인 직접 상품이 있으면 판매자 정보를 비울 수 없다', () => {
  const full = { sellerBizName: '상호', sellerBizNo: '1234567890', sellerCsPhone: '02-123-4567', sellerReturnAddress: '서울시 반품로 1' };
  function form(v: Record<string, string>) {
    const fd = new FormData();
    for (const [k, x] of Object.entries(v)) fd.set(k, x);
    return fd;
  }
  it('판매 중이면 거절, 수정은 허용', async () => {
    await directProduct(fx.creatorId);
    const r = await studio.saveSellerInfoAction({ ok: false }, form({ ...full, sellerBizNo: '' }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('사업자등록번호');
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } })).sellerBizNo).toBe('123-45-67890');
    const ok = await studio.saveSellerInfoAction({ ok: false }, form({ ...full, sellerCsPhone: '02-999-8888' }));
    expect(ok.ok, ok.message).toBe(true);
  });
  it('판매 중인 직접 상품이 없으면 비울 수 있다', async () => {
    const own = await directProduct(fx.creatorId);
    await prisma.product.update({ where: { id: own.id }, data: { status: 'HIDDEN' } });
    const r = await studio.saveSellerInfoAction({ ok: false }, form({ sellerBizName: '', sellerBizNo: '', sellerCsPhone: '', sellerReturnAddress: '' }));
    expect(r.ok, r.message).toBe(true);
  });
});
