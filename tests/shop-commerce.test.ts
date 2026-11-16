import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { applyRate, percentToRate } from '@/server/services/shop/config';
import { resolveReferralRate } from '@/server/services/shop/commission';
import { parseProductForm, parseVariantLines, saveProduct } from '@/server/services/shop/catalog';
import { addToCart, autoConfirmOrders, confirmOrder, groupShippingFee, markShipped, placeOrder, processClaim, requestClaim } from '@/server/services/shop/orders';
import { applyTrackingCsv, createPurchaseOrders, parseCsvLine, purchaseOrderCsv } from '@/server/services/shop/purchase-orders';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 도네이도 샵 상품·주문 (2026-11-17)
 * 재고 초과 판매 방지, 판매자별 주문 분리, 결제 실패 시 재고 복구, 레퍼럴 수익률 우선순위,
 * 구매 확정 시 정산 원장 적립, 취소·반품 환불, 발주서·송장 일괄 등록
 */

const ADDR = { recipient: '홍길동', phone: '010-1234-5678', zipcode: '06236', address1: '서울특별시 강남구 테헤란로 123', address2: '101동 202호' };
const ADMIN = { type: 'ADMIN' as const, userId: 'admin-shop' };

let fx: Fixture;
let buyer: { id: string; name: string | null };
let supplierId: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  const u = await prisma.user.create({ data: { id: newId(), email: `b-${newId()}@test.kr`, name: '구매자', role: 'DONOR' } });
  buyer = { id: u.id, name: u.name };
  supplierId = newId();
  await prisma.supplier.create({ data: { id: supplierId, name: '공급처A' } });
});

async function adminProduct(price = 10000n, stock = 3, opts: { rate?: string; ship?: bigint; freeOver?: bigint | null } = {}) {
  const fd = new FormData();
  fd.set('name', `관리자상품${newId().slice(-4)}`);
  fd.set('price', price.toString());
  fd.set('supplyPrice', '6000');
  fd.set('shippingFee', (opts.ship ?? 3000n).toString());
  if (opts.freeOver) fd.set('freeShippingOver', opts.freeOver.toString());
  fd.set('referralRate', opts.rate ?? '5');
  fd.set('status', 'ON_SALE');
  fd.set('supplierId', supplierId);
  fd.set('variants', `빨강 | 0 | ${stock}\n파랑 | 1000 | ${stock}`);
  const id = await saveProduct(parseProductForm(fd, { forAdmin: true }), { type: 'ADMIN' });
  await prisma.creatorProduct.create({ data: { id: newId(), creatorId: fx.creatorId, productId: id } });
  const variants = await prisma.productVariant.findMany({ where: { productId: id }, orderBy: { sortOrder: 'asc' } });
  return { id, variants };
}

async function cartIds() {
  return (await prisma.cartItem.findMany({ where: { userId: buyer.id } })).map((c) => c.id);
}

describe('순수 계산', () => {
  it('요율·옵션·배송비', () => {
    expect(percentToRate('5')).toBe('0.050000');
    expect(percentToRate('7.5')).toBe('0.075000');
    expect(percentToRate('120')).toBeNull();
    expect(applyRate(10000n, '0.05')).toBe(500n);
    expect(applyRate(9999n, '0.075')).toBe(749n);
    expect(parseVariantLines('S | 0 | 10 | SKU1\nM | 1,000 | 5')).toEqual([
      { name: 'S', extraPrice: 0n, stock: 10, sku: 'SKU1' },
      { name: 'M', extraPrice: 1000n, stock: 5, sku: null },
    ]);
    expect(() => parseVariantLines('S|0|1\nS|0|1')).toThrow(/겹칩니다/);
    expect(groupShippingFee([{ amount: 20000n, shippingFee: 3000n, freeShippingOver: 30000n }, { amount: 5000n, shippingFee: 2500n, freeShippingOver: null }])).toBe(3000n);
    expect(groupShippingFee([{ amount: 30000n, shippingFee: 3000n, freeShippingOver: 30000n }])).toBe(0n);
    expect(parseCsvLine('a,"서울시, 강남구","x""y"')).toEqual(['a', '서울시, 강남구', 'x"y']);
  });
});

describe('레퍼럴 수익률 우선순위', () => {
  it('크리에이터×상품 > 크리에이터 > 상품 기본', async () => {
    const p = await adminProduct();
    const product = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect((await resolveReferralRate(fx.creatorId, product)).rate).toBe('0.05');
    await prisma.creatorCommission.create({ data: { id: newId(), creatorId: fx.creatorId, rate: '0.07' } });
    expect(await resolveReferralRate(fx.creatorId, product)).toEqual({ rate: '0.07', source: 'CREATOR' });
    await prisma.creatorProductCommission.create({ data: { id: newId(), creatorId: fx.creatorId, productId: p.id, rate: '0.1' } });
    expect(await resolveReferralRate(fx.creatorId, product)).toEqual({ rate: '0.1', source: 'CREATOR_PRODUCT' });
  });
});

describe('주문·결제', () => {
  it('결제 성공: 재고 차감·레퍼럴 대기·장바구니 비움, 재고 초과는 담기지 않음', async () => {
    const p = await adminProduct(10000n, 3);
    await expect(addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 4)).rejects.toThrow(/재고가 부족/);
    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 2);
    const r = await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    expect(r.ok, r.message).toBe(true);
    const order = await prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id }, include: { items: true } });
    expect(order).toMatchObject({ status: 'PAID', sellerType: 'DONAIDO', itemsAmount: 20000n, shippingFee: 3000n, totalAmount: 23000n });
    expect(order.recipientMasked).toBe('홍*동');
    expect(order.addressEnc).not.toContain('테헤란로');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variants[0].id } })).stock).toBe(1);
    const ref = await prisma.referralCommission.findFirstOrThrow({ where: { creatorId: fx.creatorId } });
    expect(ref).toMatchObject({ amount: 1000n, status: 'PENDING' });
    expect(await prisma.cartItem.count({ where: { userId: buyer.id } })).toBe(0);
    expect(await prisma.settlementLedger.count({ where: { shopOrderId: order.id } })).toBe(0); // 확정 전에는 원장에 없다
  });

  it('결제 실패: 주문 취소 + 재고 복구', async () => {
    const p = await adminProduct(9999n - 3000n, 5, { ship: 3000n }); // 합계 9,999원 → mock 승인 실패
    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 1);
    const r = await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    expect(r.ok).toBe(false);
    expect((await prisma.shopPayment.findFirstOrThrow({ where: { userId: buyer.id } })).status).toBe('FAILED');
    expect((await prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id } })).status).toBe('CANCELLED');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variants[0].id } })).stock).toBe(5);
  });

  it('마지막 재고를 두 명이 동시에 주문하면 한 명만 성공한다', async () => {
    const p = await adminProduct(10000n, 1);
    const other = await prisma.user.create({ data: { id: newId(), email: `o-${newId()}@test.kr`, name: '다른구매자', role: 'DONOR' } });
    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 1);
    await addToCart(other.id, fx.creatorId, p.id, p.variants[0].id, 1);
    const otherCart = (await prisma.cartItem.findMany({ where: { userId: other.id } })).map((c) => c.id);
    const [a, b] = await Promise.all([
      placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR }),
      placeOrder({ id: other.id, name: other.name }, { cartItemIds: otherCart, address: ADDR }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variants[0].id } })).stock).toBe(0);
  });

  it('관리자 상품 + 크리에이터 직접 상품을 함께 사면 판매자별로 주문이 나뉜다', async () => {
    const a = await adminProduct(10000n, 5);
    const fd = new FormData();
    fd.set('name', '내 굿즈');
    fd.set('price', '15000');
    fd.set('shippingFee', '2500');
    fd.set('status', 'ON_SALE');
    fd.set('stock', '10');
    const ownId = await saveProduct(parseProductForm(fd, { forAdmin: false }), { type: 'CREATOR', creatorId: fx.creatorId });
    const own = await prisma.product.findUniqueOrThrow({ where: { id: ownId }, include: { variants: true } });
    expect(own.reviewStatus).toBe('PENDING');
    await expect(addToCart(buyer.id, fx.creatorId, ownId, own.variants[0].id, 1)).rejects.toThrow(/판매하지 않는/); // 검수 전
    await prisma.product.update({ where: { id: ownId }, data: { reviewStatus: 'APPROVED' } });
    await addToCart(buyer.id, fx.creatorId, ownId, own.variants[0].id, 1);
    await addToCart(buyer.id, fx.creatorId, a.id, a.variants[1].id, 1);
    const r = await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    expect(r.ok, r.message).toBe(true);
    const orders = await prisma.shopOrder.findMany({ where: { userId: buyer.id }, orderBy: { sellerType: 'asc' } });
    expect(orders.map((o) => o.sellerType)).toEqual(['CREATOR', 'DONAIDO']);
    expect(orders[0]).toMatchObject({ sellerCreatorId: fx.creatorId, totalAmount: 17500n });
    expect(orders[1]).toMatchObject({ totalAmount: 14000n }); // 11,000 + 3,000
    const pay = await prisma.shopPayment.findFirstOrThrow({ where: { userId: buyer.id } });
    expect(pay.amount).toBe(31500n);

    // 발송 → 구매 확정 → 원장
    for (const o of orders) await markShipped(o.id, ADMIN, 'CJ대한통운', '123456789012');
    for (const o of orders) await confirmOrder(o.id, { type: 'BUYER', userId: buyer.id });
    const ledger = await prisma.settlementLedger.findMany({ where: { creatorId: fx.creatorId, shopOrderId: { not: null } }, orderBy: { entryType: 'asc' } });
    const byType = Object.fromEntries(ledger.map((l) => [l.entryType, l.amount]));
    expect(byType.REFERRAL_COMMISSION).toBe(550n); // 11,000 × 5%
    expect(byType.SALES_PROCEEDS).toBe(17500n);
    expect(byType.BROKER_FEE).toBe(-1500n); // 15,000 × 10%
    await expect(confirmOrder(orders[0].id, { type: 'BUYER', userId: buyer.id })).rejects.toThrow();
  });
});

describe('취소·반품', () => {
  it('발주 전 취소는 바로 환불·재고 복구·레퍼럴 취소, 발송 후 반품은 승인 후 환불', async () => {
    const p = await adminProduct(10000n, 5);
    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 2);
    await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    const order = await prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id } });
    const res = await requestClaim(buyer.id, order.id, 'CANCEL', '단순 변심');
    expect(res.autoApproved).toBe(true);
    expect((await prisma.shopOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variants[0].id } })).stock).toBe(5);
    expect((await prisma.referralCommission.findFirstOrThrow()).status).toBe('CANCELLED');
    expect((await prisma.shopPayment.findFirstOrThrow({ where: { userId: buyer.id } })).status).toBe('CANCELLED');

    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 1);
    await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    const o2 = await prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id, status: 'PAID' } });
    await markShipped(o2.id, ADMIN, '한진택배', 'ABC1234567');
    await expect(requestClaim(buyer.id, o2.id, 'CANCEL', '취소')).rejects.toThrow(/반품/);
    await requestClaim(buyer.id, o2.id, 'RETURN', '파손');
    await expect(confirmOrder(o2.id, { type: 'BUYER', userId: buyer.id })).rejects.toThrow(/처리 중/);
    const claim = await prisma.orderClaim.findFirstOrThrow({ where: { orderId: o2.id } });
    await processClaim(claim.id, ADMIN, true);
    await expect(processClaim(claim.id, ADMIN, true)).rejects.toThrow(/이미 처리/);
    expect((await prisma.shopOrder.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('RETURNED');
    expect((await prisma.orderClaim.findUniqueOrThrow({ where: { id: claim.id } })).refundAmount).toBe(13000n);
  });

  it('크리에이터는 다른 판매자의 주문을 처리할 수 없다', async () => {
    const p = await adminProduct();
    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 1);
    await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    const o = await prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id } });
    await expect(markShipped(o.id, { type: 'CREATOR', creatorId: fx.creatorId, userId: fx.creatorUserId }, 'CJ', '1234567890')).rejects.toThrow(/직접 판매/);
  });
});

describe('발주서·송장·자동 확정', () => {
  it('공급처별 발주서 → CSV(복호화·BOM) → 송장 일괄 등록 → 자동 구매 확정', async () => {
    const p = await adminProduct(10000n, 5);
    await addToCart(buyer.id, fx.creatorId, p.id, p.variants[0].id, 1);
    await placeOrder(buyer, { cartItemIds: await cartIds(), address: ADDR });
    const [poId] = await createPurchaseOrders('admin-shop');
    const order = await prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id } });
    expect(order.status).toBe('PREPARING');
    await expect(createPurchaseOrders('admin-shop')).rejects.toThrow(/발주할 항목이 없/);
    const csv = await purchaseOrderCsv(poId);
    expect(csv.body.startsWith('﻿')).toBe(true);
    expect(csv.body).toContain('홍길동');
    expect(csv.body).toContain('"서울특별시 강남구 테헤란로 123, 101동 202호"');

    // 발주서 CSV 의 택배사·송장번호 칸을 채워 그대로 업로드
    const filled = csv.body.split('\r\n').map((line, i) => (i === 0 ? line : line.replace(/,,$/, ',CJ대한통운,987654321098'))).join('\r\n');
    const results = await applyTrackingCsv(ADMIN, filled);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const shipped = await prisma.shopOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(shipped).toMatchObject({ status: 'SHIPPED', courier: 'CJ대한통운', trackingNo: '987654321098' });

    expect(await autoConfirmOrders(new Date())).toBe(0);
    expect(await autoConfirmOrders(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect((await prisma.shopOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CONFIRMED');
  });
});
