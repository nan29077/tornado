/**
 * 도네이도 샵 장바구니 · 주문 · 결제 · 배송 · 구매 확정 · 취소/반품 (2026-11-17).
 *
 * 핵심 규칙
 *  - 결제 1건 = 판매자별 주문 N건 (도네이도 판매분 1건 + 크리에이터 직접 판매분 크리에이터당 1건)
 *  - 재고는 주문 생성 트랜잭션에서 "남은 재고 ≥ 수량" 조건부로 차감한다(초과 판매 방지, DB CHECK 가 마지막 방어선)
 *  - 결제 실패·취소·반품 승인 시 재고를 되돌린다
 *  - 주문 항목에 가격·레퍼럴 수익률·중개 수수료율·공급처를 스냅샷으로 남긴다
 *  - 정산 원장 적립은 **구매 확정 시점**에만 한다 (확정 전 취소·반품은 원장에 흔적이 없다)
 *  - 결제 상태 전이는 updateMany(where 이전 상태) 로 원자적으로 — 승인 콜백이 두 번 와도 한 번만 처리
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma, withAdvisoryLock } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { formatWon } from '@/lib/money';
import { getShopPaymentAdapter, shopPaymentClosedMessage } from '@/server/adapters/shop-payment';
import { appendLedger } from '@/server/services/settlement';
import { notifySuperAdmins, notifyUser } from '@/server/services/notifications';
import { applyRate, getShopConfig } from './config';
import { resolveReferralRate } from './commission';
import { resolveSourceVideoKey } from './video-products';
import { getShopProduct } from './catalog';
import { sealAddress, validateAddress, type AddressInput } from './address';

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: '결제 대기',
  PAID: '결제 완료',
  PREPARING: '상품 준비중',
  SHIPPED: '배송중',
  DELIVERED: '배송 완료',
  CONFIRMED: '구매 확정',
  CANCELLED: '취소',
  RETURNED: '반품 완료',
};
export const CLAIM_TYPE_LABEL: Record<string, string> = { CANCEL: '취소', RETURN: '반품', EXCHANGE: '교환' };
export const CLAIM_STATUS_LABEL: Record<string, string> = { REQUESTED: '접수', APPROVED: '승인', REJECTED: '거절', COMPLETED: '처리 완료' };

export type Actor = { type: 'ADMIN'; userId: string } | { type: 'CREATOR'; creatorId: string; userId: string };

function stamp(prefix: string): string {
  const kst = new Date(Date.now() + 9 * 3600_000).toISOString().replace(/[-:TZ.]/g, '').slice(2, 14);
  return `${prefix}${kst}${newId().slice(-5)}`;
}

type Tx = Prisma.TransactionClient;

/** 회원의 크리에이터 프로필 ID (크리에이터가 아니면 null) */
async function buyerCreatorId(userId: string): Promise<string | null> {
  const c = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return c?.id ?? null;
}

/** [9차 P2-4] 크리에이터가 자기 샵의 직접 판매 상품을 사면 판매 대금이 본인 정산으로 들어간다 → 막는다 */
export const OWN_PRODUCT_MESSAGE = '내 샵에서 직접 판매하는 상품은 구매할 수 없어요.';
function isOwnDirectProduct(product: { ownerType: string; creatorId: string | null }, myCreatorId: string | null): boolean {
  return Boolean(myCreatorId) && product.ownerType === 'CREATOR' && product.creatorId === myCreatorId;
}

/**
 * 재고 되돌리기 (결제 실패 · 취소 · 반품 승인) — 9차 P2-3 · P3-8.
 *  - 옵션 재고를 되돌린다
 *  - unsell: 결제 완료 때 올린 판매 수량도 되돌린다 (0 아래로는 내려가지 않는다)
 *  - 재고가 0 이라 자동으로 품절이 됐던 상품은 재고가 생기면 다시 판매중으로 돌린다.
 *    재고가 남아 있는데 품절인 상품(관리자 · 크리에이터가 직접 품절로 둔 것)은 건드리지 않는다.
 */
async function restoreStock(tx: Tx, items: Array<{ productId: string; variantId: string; quantity: number }>, opts: { unsell: boolean }) {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const before = new Map<string, number>();
  for (const pid of productIds) {
    const r = await tx.productVariant.aggregate({ where: { productId: pid, active: true }, _sum: { stock: true } });
    before.set(pid, r._sum.stock ?? 0);
  }
  for (const it of items) {
    await tx.productVariant.update({ where: { id: it.variantId }, data: { stock: { increment: it.quantity } } });
    if (opts.unsell) {
      await tx.$executeRaw`UPDATE product SET sold_count = GREATEST(0, sold_count - ${it.quantity}) WHERE id = ${it.productId}`;
    }
  }
  for (const pid of productIds) {
    if ((before.get(pid) ?? 0) > 0) continue;
    const after = await tx.productVariant.aggregate({ where: { productId: pid, active: true }, _sum: { stock: true } });
    if ((after._sum.stock ?? 0) > 0) await tx.product.updateMany({ where: { id: pid, status: 'SOLD_OUT' }, data: { status: 'ON_SALE' } });
  }
}

// =========================================================================== 장바구니

export async function addToCart(
  userId: string,
  shopCreatorId: string,
  productId: string,
  variantId: string,
  quantity: number,
  opts: { sourceVideoKey?: string | null } = {},
) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('수량은 1~99개로 선택해 주세요.');
  const product = await getShopProduct(shopCreatorId, productId);
  if (!product) throw new Error('이 샵에서 판매하지 않는 상품입니다.');
  if (product.status !== 'ON_SALE') throw new Error('품절된 상품입니다.');
  if (isOwnDirectProduct(product, await buyerCreatorId(userId))) throw new Error(OWN_PRODUCT_MESSAGE);
  const variant = product.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error('옵션을 선택해 주세요.');
  const existing = await prisma.cartItem.findUnique({ where: { userId_shopCreatorId_variantId: { userId, shopCreatorId, variantId } } });
  const next = Math.min(99, (existing?.quantity ?? 0) + quantity);
  if (next > variant.stock) throw new Error(`재고가 부족합니다. (남은 수량 ${variant.stock}개)`);
  // 영상 상품 스티커로 담았으면 그 영상을 기록한다(마지막으로 담은 영상 기준). 검증되지 않은 값은 버린다
  const sourceVideoKey = opts.sourceVideoKey ? await resolveSourceVideoKey(shopCreatorId, productId, opts.sourceVideoKey) : null;
  if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: next, ...(sourceVideoKey ? { sourceVideoKey } : {}) } });
  else {
    const count = await prisma.cartItem.count({ where: { userId } });
    if (count >= 50) throw new Error('장바구니에는 50개까지 담을 수 있습니다.');
    await prisma.cartItem.create({ data: { id: newId(), userId, shopCreatorId, productId, variantId, quantity: next, sourceVideoKey } });
  }
}

export async function updateCartQuantity(userId: string, cartItemId: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('수량은 1~99개로 선택해 주세요.');
  const moved = await prisma.cartItem.updateMany({ where: { id: cartItemId, userId }, data: { quantity } });
  if (moved.count === 0) throw new Error('장바구니 항목을 찾을 수 없습니다.');
}

export async function removeCartItems(userId: string, ids: string[]) {
  await prisma.cartItem.deleteMany({ where: { userId, id: { in: ids } } });
}

export async function listCart(userId: string) {
  const items = await prisma.cartItem.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      product: { select: { id: true, name: true, thumbnailUrl: true, price: true, status: true, ownerType: true, creatorId: true, deletedAt: true, reviewStatus: true, shippingFee: true, freeShippingOver: true } },
      variant: { select: { id: true, name: true, extraPrice: true, stock: true, active: true } },
    },
  });
  const shopIds = [...new Set(items.map((i) => i.shopCreatorId))];
  const shops = await prisma.creatorProfile.findMany({ where: { id: { in: shopIds } }, select: { id: true, code: true, displayName: true } });
  const shopMap = new Map(shops.map((s) => [s.id, s]));
  return items.map((i) => {
    const unit = i.product.price + i.variant.extraPrice;
    const sellable =
      !i.product.deletedAt && i.product.reviewStatus === 'APPROVED' && i.product.status === 'ON_SALE' && i.variant.active && i.variant.stock >= i.quantity;
    return { ...i, unitPrice: unit, amount: unit * BigInt(i.quantity), sellable, shop: shopMap.get(i.shopCreatorId) ?? null };
  });
}

// =========================================================================== 주문 생성 · 결제

interface Line {
  cartItemId: string;
  shopCreatorId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  unitPrice: bigint;
  quantity: number;
  amount: bigint;
  ownerType: string;
  sellerCreatorId: string | null;
  supplierId: string | null;
  supplyPrice: bigint | null;
  referralRate: string;
  shippingFee: bigint;
  freeShippingOver: bigint | null;
  sourceVideoKey: string | null;
}

/** 판매자 묶음의 배송비: 묶음 금액이 상품의 무료배송 기준 이상이면 0, 아니면 상품 배송비 중 최댓값 */
export function groupShippingFee(lines: Array<{ amount: bigint; shippingFee: bigint; freeShippingOver: bigint | null }>): bigint {
  const total = lines.reduce((s, l) => s + l.amount, 0n);
  let fee = 0n;
  for (const l of lines) {
    const free = l.freeShippingOver != null && total >= l.freeShippingOver;
    if (!free && l.shippingFee > fee) fee = l.shippingFee;
  }
  return fee;
}

export interface PlaceOrderResult {
  ok: boolean;
  message?: string;
  paymentNo?: string;
  orderNos?: string[];
}

export async function placeOrder(
  user: { id: string; name: string | null },
  input: { cartItemIds: string[]; address: AddressInput; memo?: string | null },
): Promise<PlaceOrderResult> {
  const closed = shopPaymentClosedMessage();
  if (closed) return { ok: false, message: closed };
  if (input.cartItemIds.length === 0) return { ok: false, message: '주문할 상품을 선택해 주세요.' };
  const addrErr = validateAddress(input.address);
  if (addrErr) return { ok: false, message: addrErr };
  const memo = (input.memo ?? '').trim().slice(0, 100) || null;

  const cart = await prisma.cartItem.findMany({
    where: { userId: user.id, id: { in: input.cartItemIds } },
    include: { variant: true },
  });
  if (cart.length !== input.cartItemIds.length) return { ok: false, message: '장바구니가 바뀌었습니다. 새로고침 후 다시 주문해 주세요.' };

  const cfg = await getShopConfig();
  const myCreatorId = await buyerCreatorId(user.id);
  const lines: Line[] = [];
  for (const c of cart) {
    const product = await getShopProduct(c.shopCreatorId, c.productId);
    if (!product || product.status !== 'ON_SALE') return { ok: false, message: '판매가 중지되었거나 품절된 상품이 있습니다. 장바구니를 확인해 주세요.' };
    if (isOwnDirectProduct(product, myCreatorId)) return { ok: false, message: `${product.name}: ${OWN_PRODUCT_MESSAGE}` };
    const variant = product.variants.find((v) => v.id === c.variantId);
    if (!variant) return { ok: false, message: `${product.name}: 선택한 옵션이 판매 중지되었습니다.` };
    if (variant.stock < c.quantity) return { ok: false, message: `${product.name} (${variant.name}) 재고가 부족합니다. 남은 수량 ${variant.stock}개` };
    const unit = product.price + variant.extraPrice;
    // [9차 P2-4] 자기 샵에서 도네이도 상품을 사는 것은 허용하되, 레퍼럴 수익은 주지 않는다 (본인 할인이 되지 않게)
    const ownShop = myCreatorId != null && c.shopCreatorId === myCreatorId;
    const rate = product.ownerType === 'ADMIN' && !ownShop ? (await resolveReferralRate(c.shopCreatorId, product)).rate : '0';
    lines.push({
      cartItemId: c.id,
      shopCreatorId: c.shopCreatorId,
      productId: product.id,
      variantId: variant.id,
      productName: product.name,
      variantName: variant.name,
      unitPrice: unit,
      quantity: c.quantity,
      amount: unit * BigInt(c.quantity),
      ownerType: product.ownerType,
      sellerCreatorId: product.ownerType === 'CREATOR' ? product.creatorId : null,
      supplierId: product.supplierId,
      supplyPrice: product.supplyPrice,
      referralRate: rate,
      shippingFee: product.shippingFee,
      freeShippingOver: product.freeShippingOver,
      sourceVideoKey: c.sourceVideoKey ?? null,
    });
  }

  // 판매자별 묶음
  const groups = new Map<string, Line[]>();
  for (const l of lines) {
    const key = l.ownerType === 'ADMIN' ? 'DONAIDO' : `CREATOR:${l.sellerCreatorId}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const sealed = sealAddress(input.address);
  const paymentNo = stamp('SHP');
  let total = 0n;
  const plan = [...groups.entries()].map(([key, ls]) => {
    const items = ls.reduce((s, l) => s + l.amount, 0n);
    const ship = groupShippingFee(ls);
    total += items + ship;
    return { key, lines: ls, items, ship, orderNo: stamp('ORD') };
  });
  if (total <= 0n) return { ok: false, message: '결제 금액이 0원입니다.' };

  let paymentId: string;
  try {
    paymentId = await prisma.$transaction(async (tx) => {
      const pid = newId();
      await tx.shopPayment.create({
        data: { id: pid, paymentNo, userId: user.id, kind: 'ORDER', amount: total, provider: getShopPaymentAdapter().provider },
      });
      for (const g of plan) {
        const orderId = newId();
        await tx.shopOrder.create({
          data: {
            id: orderId,
            orderNo: g.orderNo,
            paymentId: pid,
            userId: user.id,
            sellerType: g.key === 'DONAIDO' ? 'DONAIDO' : 'CREATOR',
            sellerCreatorId: g.key === 'DONAIDO' ? null : g.key.slice('CREATOR:'.length),
            itemsAmount: g.items,
            shippingFee: g.ship,
            totalAmount: g.items + g.ship,
            ...sealed,
            memo,
          },
        });
        for (const l of g.lines) {
          // 조건부 차감: 남은 재고가 모자라면 0건 → 전체 롤백
          const dec = await tx.productVariant.updateMany({
            where: { id: l.variantId, stock: { gte: l.quantity }, active: true },
            data: { stock: { decrement: l.quantity } },
          });
          if (dec.count === 0) throw new Error(`${l.productName} (${l.variantName}) 재고가 방금 소진되었습니다.`);
          await tx.shopOrderItem.create({
            data: {
              id: newId(),
              orderId,
              productId: l.productId,
              variantId: l.variantId,
              productName: l.productName,
              variantName: l.variantName,
              unitPrice: l.unitPrice,
              quantity: l.quantity,
              amount: l.amount,
              shopCreatorId: l.shopCreatorId,
              supplierId: l.supplierId,
              supplyPrice: l.supplyPrice,
              referralRate: l.referralRate,
              referralAmount: l.ownerType === 'ADMIN' ? applyRate(l.amount, l.referralRate) : 0n,
              brokerFeeRate: l.ownerType === 'CREATOR' ? cfg.brokerFeeRate.toFixed(6) : '0',
              sourceVideoKey: l.sourceVideoKey,
            },
          });
        }
      }
      return pid;
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '주문을 만들지 못했습니다.' };
  }

  // 결제 승인 (mock 은 즉시)
  let result: Awaited<ReturnType<ReturnType<typeof getShopPaymentAdapter>['approve']>>;
  try {
    result = await getShopPaymentAdapter().approve({
      paymentNo,
      amount: total,
      buyerName: user.name ?? '회원',
      itemName: lines.length > 1 ? `${lines[0].productName} 외 ${lines.length - 1}건` : lines[0].productName,
    });
  } catch (e) {
    result = { ok: false, reason: e instanceof Error ? e.message : '결제 오류' };
  }
  await finalizeOrderPayment(paymentId, result);
  return result.ok
    ? { ok: true, paymentNo, orderNos: plan.map((p) => p.orderNo) }
    : { ok: false, paymentNo, message: `결제에 실패했습니다: ${result.reason}` };
}

/** 결제 결과 반영 (중복 호출 안전) */
export async function finalizeOrderPayment(paymentId: string, result: { ok: true; providerTx: string } | { ok: false; reason: string }) {
  const now = new Date();
  if (result.ok) {
    const done = await prisma.$transaction(async (tx) => {
      const moved = await tx.shopPayment.updateMany({
        where: { id: paymentId, status: 'READY' },
        data: { status: 'PAID', providerTx: result.providerTx, paidAt: now },
      });
      if (moved.count === 0) return null;
      const payment = await tx.shopPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { userId: true } });
      const orders = await tx.shopOrder.findMany({ where: { paymentId }, include: { items: true } });
      await tx.shopOrder.updateMany({ where: { paymentId, status: 'PENDING_PAYMENT' }, data: { status: 'PAID', paidAt: now } });
      for (const o of orders) {
        for (const it of o.items) {
          await tx.product.update({ where: { id: it.productId }, data: { soldCount: { increment: it.quantity } } });
          if (o.sellerType === 'DONAIDO' && it.referralAmount > 0n) {
            await tx.referralCommission.create({ data: { id: newId(), orderItemId: it.id, creatorId: it.shopCreatorId, amount: it.referralAmount } });
          }
        }
      }
      // 결제된 상품은 장바구니에서 뺀다 — (샵, 옵션) 단위로. [9차 P3-6] 예전에는 옵션만 봐서
      // 같은 상품을 다른 샵 장바구니에 담아 둔 것까지 함께 지워졌다
      const paidLines = orders.flatMap((o) => o.items.map((i) => ({ shopCreatorId: i.shopCreatorId, variantId: i.variantId })));
      if (paidLines.length > 0) await tx.cartItem.deleteMany({ where: { userId: payment.userId, OR: paidLines } });
      // 재고가 0 이 된 판매중 상품은 품절로
      const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))];
      for (const pid of productIds) {
        const left = await tx.productVariant.aggregate({ where: { productId: pid, active: true }, _sum: { stock: true } });
        if ((left._sum.stock ?? 0) <= 0) await tx.product.updateMany({ where: { id: pid, status: 'ON_SALE' }, data: { status: 'SOLD_OUT' } });
      }
      return orders;
    });
    if (done) {
      // 판매자 알림 (실패해도 결제는 그대로)
      for (const o of done) {
        try {
          if (o.sellerType === 'DONAIDO') {
            await notifySuperAdmins({ title: '도네이도 샵 새 주문', body: `${o.orderNo} · ${o.totalAmount.toString()}원`, linkUrl: '/admin/shop/orders' });
          } else if (o.sellerCreatorId) {
            const c = await prisma.creatorProfile.findUnique({ where: { id: o.sellerCreatorId }, select: { userId: true } });
            if (c) await notifyUser({ userId: c.userId, title: '내 샵 상품이 주문되었습니다', body: `${o.orderNo} · 송장을 등록해 주세요`, linkUrl: '/studio/shop/orders' });
          }
        } catch (e) {
          logger.warn('shop: 주문 알림 실패', { orderNo: o.orderNo, error: (e as Error).message });
        }
      }
    }
    return;
  }
  // 실패: 결제 실패 처리 + 주문 취소 + 재고 복구
  await prisma.$transaction(async (tx) => {
    const moved = await tx.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'FAILED', failReason: result.reason.slice(0, 200) } });
    if (moved.count === 0) return;
    const orders = await tx.shopOrder.findMany({ where: { paymentId }, include: { items: true } });
    await tx.shopOrder.updateMany({ where: { paymentId, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED', cancelledAt: now } });
    // 결제 전이라 판매 수량은 오르지 않았다. 그 사이 다른 주문 때문에 자동 품절이 됐다면 다시 판매중으로 돌린다
    await restoreStock(tx, orders.flatMap((o) => o.items), { unsell: false });
  });
}

// =========================================================================== 배송 · 구매 확정

async function loadOrderForActor(orderId: string, actor: Actor) {
  const order = await prisma.shopOrder.findUnique({ where: { id: orderId }, include: { items: true, claims: true } });
  if (!order) throw new Error('주문을 찾을 수 없습니다.');
  if (actor.type === 'CREATOR' && !(order.sellerType === 'CREATOR' && order.sellerCreatorId === actor.creatorId)) {
    throw new Error('내 샵에서 직접 판매한 주문만 처리할 수 있습니다.');
  }
  return order;
}

async function transition(orderId: string, from: string[], data: Record<string, unknown>) {
  const moved = await prisma.shopOrder.updateMany({ where: { id: orderId, status: { in: from } }, data });
  if (moved.count === 0) throw new Error('주문 상태가 방금 바뀌었습니다. 새로고침 후 다시 확인해 주세요.');
}

export async function markPreparing(orderId: string, actor: Actor) {
  await loadOrderForActor(orderId, actor);
  await transition(orderId, ['PAID'], { status: 'PREPARING' });
}

export async function markShipped(orderId: string, actor: Actor, courier: string, trackingNo: string) {
  const order = await loadOrderForActor(orderId, actor);
  const c = courier.trim().slice(0, 30);
  const t = trackingNo.trim().replace(/\s/g, '').slice(0, 40);
  if (!c || !/^[A-Za-z0-9-]{6,40}$/.test(t)) throw new Error('택배사와 송장번호(영문·숫자 6자 이상)를 입력해 주세요.');
  if (order.claims.some((x) => x.status === 'REQUESTED' && x.type === 'CANCEL')) throw new Error('취소 요청이 접수된 주문입니다. 먼저 취소 요청을 처리해 주세요.');
  await transition(orderId, ['PAID', 'PREPARING', 'SHIPPED'], { status: 'SHIPPED', courier: c, trackingNo: t, shippedAt: order.shippedAt ?? new Date() });
  await notifyUser({ userId: order.userId, title: '주문하신 상품이 발송되었습니다', body: `${order.orderNo} · ${c} ${t}`, linkUrl: `/my/orders/${order.id}` }).catch(() => undefined);
}

export async function markDelivered(orderId: string, actor: Actor) {
  await loadOrderForActor(orderId, actor);
  await transition(orderId, ['SHIPPED'], { status: 'DELIVERED', deliveredAt: new Date() });
}

/**
 * 구매 확정 → 정산 원장 적립.
 *  - 도네이도 판매분: 항목별 레퍼럴 수익(+)을 샵 크리에이터에게 (REFERRAL_COMMISSION)
 *  - 크리에이터 직접 판매분: 판매 대금(상품+배송비, +) SALES_PROCEEDS, 중개 수수료(상품 금액 × 요율, -) BROKER_FEE
 */
export async function confirmOrder(orderId: string, by: { type: 'BUYER'; userId: string } | { type: 'SYSTEM' } | Actor) {
  const order = await prisma.shopOrder.findUnique({ where: { id: orderId }, include: { items: true, claims: true } });
  if (!order) throw new Error('주문을 찾을 수 없습니다.');
  if (by.type === 'BUYER' && order.userId !== by.userId) throw new Error('본인 주문만 확정할 수 있습니다.');
  if (by.type === 'CREATOR') throw new Error('구매 확정은 구매자 또는 최고관리자만 할 수 있습니다.');
  if (order.claims.some((c) => c.status === 'REQUESTED')) throw new Error('처리 중인 취소·반품 요청이 있어 확정할 수 없습니다.');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const moved = await tx.shopOrder.updateMany({ where: { id: orderId, status: { in: ['SHIPPED', 'DELIVERED'] } }, data: { status: 'CONFIRMED', confirmedAt: now } });
    if (moved.count === 0) throw new Error('배송이 시작된 주문만 구매 확정할 수 있습니다.');
    if (order.sellerType === 'DONAIDO') {
      for (const it of order.items) {
        if (it.referralAmount <= 0n) continue;
        const ref = await tx.referralCommission.updateMany({ where: { orderItemId: it.id, status: 'PENDING' }, data: { status: 'CONFIRMED', confirmedAt: now } });
        if (ref.count === 0) continue;
        await appendLedger(
          [{ creatorId: it.shopCreatorId, entryType: 'REFERRAL_COMMISSION', amount: it.referralAmount, shopOrderId: order.id, memo: `샵 레퍼럴 ${order.orderNo} ${it.productName}`, occurredAt: now }],
          tx,
        );
      }
    } else if (order.sellerCreatorId) {
      const proceeds = order.totalAmount - order.refundedAmount;
      const fee = order.items.reduce((s, it) => s + applyRate(it.amount, it.brokerFeeRate), 0n);
      await appendLedger(
        [
          { creatorId: order.sellerCreatorId, entryType: 'SALES_PROCEEDS', amount: proceeds, shopOrderId: order.id, memo: `샵 판매 대금 ${order.orderNo}`, occurredAt: now },
          ...(fee > 0n
            ? [{ creatorId: order.sellerCreatorId, entryType: 'BROKER_FEE' as const, amount: -fee, shopOrderId: order.id, memo: `샵 중개 수수료 ${order.orderNo}`, occurredAt: now }]
            : []),
        ],
        tx,
      );
    }
  });
}

/** 발송 후 N일 지난 주문 자동 구매 확정 (처리 중인 클레임이 있으면 건너뜀) */
export async function autoConfirmOrders(now = new Date()): Promise<number> {
  const { autoConfirmDays } = await getShopConfig();
  const cutoff = new Date(now.getTime() - autoConfirmDays * 86_400_000);
  const due = await prisma.shopOrder.findMany({
    where: { status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { lte: cutoff }, claims: { none: { status: 'REQUESTED' } } },
    select: { id: true },
    take: 500,
  });
  let n = 0;
  for (const o of due) {
    try {
      await confirmOrder(o.id, { type: 'SYSTEM' });
      n++;
    } catch (e) {
      logger.warn('shop: 자동 구매 확정 실패', { orderId: o.id, error: (e as Error).message });
    }
  }
  return n;
}

// =========================================================================== 취소 · 반품

export async function requestClaim(userId: string, orderId: string, type: 'CANCEL' | 'RETURN', reason: string) {
  const r = reason.trim();
  if (r.length < 2 || r.length > 300) throw new Error('사유를 2~300자로 입력해 주세요.');
  const order = await prisma.shopOrder.findFirst({ where: { id: orderId, userId } });
  if (!order) throw new Error('주문을 찾을 수 없습니다.');
  const claimId = newId();
  /**
   * [9차 P3-7] 확인과 접수를 주문 단위 잠금 안에서 한다.
   * 예전에는 [취소]를 두 번 빠르게 누르면 요청이 2건 접수되고, 하나를 승인하면 나머지가 '접수'로 남아
   * 관리자가 직접 거절해야 했다(그동안 회원 탈퇴도 막혔다).
   */
  await prisma.$transaction((tx) =>
    withAdvisoryLock(tx, `shop-claim:order:${orderId}`, async () => {
      const [current, open] = await Promise.all([
        tx.shopOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
        tx.orderClaim.count({ where: { orderId, status: { in: ['REQUESTED', 'APPROVED'] } } }),
      ]);
      if (open > 0) throw new Error('이미 처리 중인 요청이 있습니다.');
      if (type === 'CANCEL' && !['PAID', 'PREPARING'].includes(current.status)) throw new Error('발송 전 주문만 취소할 수 있습니다. 발송 후에는 반품을 신청해 주세요.');
      if (type === 'RETURN' && !['SHIPPED', 'DELIVERED'].includes(current.status)) throw new Error('배송이 시작된 주문만 반품을 신청할 수 있습니다.');
      await tx.orderClaim.create({ data: { id: claimId, orderId, type, reason: r, requestedBy: userId } });
    }),
  );
  // 발주·준비 전(결제 완료 상태)의 취소는 판매자 확인 없이 바로 처리한다
  if (type === 'CANCEL' && order.status === 'PAID') {
    try {
      await processClaim(claimId, { type: 'SYSTEM' }, true);
      return { autoApproved: true };
    } catch (e) {
      // 그 사이 판매자가 준비·발송했거나 결제 취소가 실패한 경우: 요청은 그대로 두고 판매자 확인으로 넘긴다
      logger.warn('shop: 자동 취소 실패 — 판매자 확인으로 전환', { orderId, error: (e as Error).message });
    }
  }
  if (order.sellerType === 'DONAIDO') {
    await notifySuperAdmins({ title: `도네이도 샵 ${type === 'CANCEL' ? '취소' : '반품'} 요청`, body: `${order.orderNo} · ${r}`, linkUrl: '/admin/shop/claims' }).catch(() => undefined);
  } else if (order.sellerCreatorId) {
    const c = await prisma.creatorProfile.findUnique({ where: { id: order.sellerCreatorId }, select: { userId: true } });
    if (c) await notifyUser({ userId: c.userId, title: `내 샵 주문 ${type === 'CANCEL' ? '취소' : '반품'} 요청`, body: `${order.orderNo} · ${r}`, linkUrl: '/studio/shop/orders' }).catch(() => undefined);
  }
  return { autoApproved: false };
}

/** 승인 = 전액 환불 + 재고 복구 + 레퍼럴 취소. 거절 = 사유와 함께 종료 */
export async function processClaim(claimId: string, actor: Actor | { type: 'SYSTEM' }, approve: boolean, rejectReason?: string) {
  const claim = await prisma.orderClaim.findUnique({ where: { id: claimId }, include: { order: { include: { items: true, payment: true } } } });
  if (!claim) throw new Error('요청을 찾을 수 없습니다.');
  if (claim.status !== 'REQUESTED') throw new Error('이미 처리된 요청입니다.');
  const order = claim.order;
  if (actor.type === 'CREATOR' && !(order.sellerType === 'CREATOR' && order.sellerCreatorId === actor.creatorId)) throw new Error('내 샵 주문만 처리할 수 있습니다.');
  const processedBy = actor.type === 'SYSTEM' ? 'SYSTEM' : actor.userId;
  const now = new Date();
  if (!approve) {
    const r = (rejectReason ?? '').trim();
    if (!r) throw new Error('거절 사유를 입력해 주세요.');
    await prisma.orderClaim.updateMany({ where: { id: claimId, status: 'REQUESTED' }, data: { status: 'REJECTED', rejectReason: r.slice(0, 300), processedBy, processedAt: now } });
    await notifyUser({ userId: order.userId, title: `${CLAIM_TYPE_LABEL[claim.type]} 요청이 거절되었습니다`, body: `${order.orderNo} · ${r}`, linkUrl: `/my/orders/${order.id}` }).catch(() => undefined);
    return;
  }
  if (order.status === 'CONFIRMED') throw new Error('구매 확정된 주문은 이 화면에서 환불할 수 없습니다.');
  const refund = order.totalAmount - order.refundedAmount;
  const fromStatuses = claim.type === 'CANCEL' ? ['PAID', 'PREPARING'] : ['SHIPPED', 'DELIVERED'];
  const toStatus = claim.type === 'CANCEL' ? 'CANCELLED' : 'RETURNED';
  // 1) 요청 선점 (같은 요청을 두 번 승인해도 환불은 한 번)
  const lock = await prisma.orderClaim.updateMany({ where: { id: claimId, status: 'REQUESTED' }, data: { status: 'APPROVED', processedBy, processedAt: now } });
  if (lock.count === 0) throw new Error('이미 처리된 요청입니다.');
  /**
   * 2) 주문 상태도 먼저 선점한다 (5차 P2-4).
   * 예전에는 결제 취소 뒤에 상태를 조건 없이 바꿔서, 결제 직후 자동 취소와 판매자 [발송]이 겹치면
   * 이미 발송된 주문이 취소·환불됐다. 이제는 취소 가능한 상태일 때만 선점하고, 선점한 뒤에는 발송·구매 확정이 막힌다.
   */
  const orderLock = await prisma.shopOrder.updateMany({ where: { id: order.id, status: { in: fromStatuses } }, data: { status: toStatus, cancelledAt: now } });
  if (orderLock.count === 0) {
    await prisma.orderClaim.updateMany({ where: { id: claimId, status: 'APPROVED' }, data: { status: 'REQUESTED', processedBy: null, processedAt: null } });
    throw new Error(claim.type === 'CANCEL' ? '주문이 이미 발송되었거나 상태가 바뀌어 취소할 수 없습니다. 반품으로 진행해 주세요.' : '주문 상태가 바뀌어 반품을 처리할 수 없습니다. 새로고침해 주세요.');
  }
  // 3) 결제 취소
  const cancel = await getShopPaymentAdapter()
    .cancel({ paymentNo: order.payment.paymentNo, providerTx: order.payment.providerTx, amount: refund, reason: claim.reason })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '취소 오류' }));
  if (!cancel.ok) {
    await prisma.shopOrder.updateMany({ where: { id: order.id, status: toStatus }, data: { status: order.status, cancelledAt: order.cancelledAt } });
    await prisma.orderClaim.update({ where: { id: claimId }, data: { status: 'REQUESTED', processedBy: null, processedAt: null } });
    throw new Error(`결제 취소에 실패했습니다: ${cancel.reason}`);
  }
  // 결제사 취소가 끝났다는 표시 (뒤 단계가 실패해도 [재처리]로 마무리할 수 있게, 5차 P2-5)
  await prisma.orderClaim.update({ where: { id: claimId }, data: { refundAmount: refund } });
  // 4) 재고·레퍼럴·결제·주문 금액 반영
  try {
    await completeApprovedClaim(claimId);
  } catch (e) {
    logger.error('shop: 결제 취소 후 주문 반영 실패 — 재처리 필요', { claimId, orderNo: order.orderNo, error: (e as Error).message });
    await notifySuperAdmins({ title: '취소·반품 반영 실패 (재처리 필요)', body: `${order.orderNo} · 결제 취소는 완료됨. 취소·반품 관리에서 [재처리]를 눌러 주세요.`, linkUrl: '/admin/shop/claims' }).catch(() => undefined);
    throw new Error('결제는 취소되었지만 주문 반영 중 오류가 났습니다. 관리자 화면에서 [재처리]로 마무리됩니다.');
  }
  await notifyUser({ userId: order.userId, title: `${CLAIM_TYPE_LABEL[claim.type]} 처리가 완료되었습니다`, body: `${order.orderNo} · ${formatWon(refund)} 환불`, linkUrl: `/my/orders/${order.id}` }).catch(() => undefined);
}

/**
 * 결제 취소가 끝난(APPROVED + refundAmount 기록) 요청을 마무리한다. 두 번 불러도 한 번만 반영된다.
 * 관리자 [재처리] 버튼과 processClaim 이 함께 쓴다 (5차 P2-5).
 */
export async function completeApprovedClaim(claimId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.orderClaim.findUnique({ where: { id: claimId }, include: { order: { include: { items: true } } } });
    if (!claim || claim.status !== 'APPROVED' || claim.refundAmount == null) return false;
    const done = await tx.orderClaim.updateMany({ where: { id: claimId, status: 'APPROVED' }, data: { status: 'COMPLETED' } });
    if (done.count === 0) return false;
    const order = claim.order;
    const refund = claim.refundAmount;
    await tx.shopOrder.update({ where: { id: order.id }, data: { refundedAmount: order.refundedAmount + refund } });
    // 재고 · 판매 수량 되돌리기 + 자동 품절 해제 (9차 P2-3 · P3-8)
    await restoreStock(tx, order.items, { unsell: true });
    for (const it of order.items) {
      await tx.referralCommission.updateMany({ where: { orderItemId: it.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    }
    const pay = await tx.shopPayment.update({ where: { id: order.paymentId }, data: { cancelledAmount: { increment: refund } } });
    await tx.shopPayment.update({ where: { id: order.paymentId }, data: { status: pay.cancelledAmount >= pay.amount ? 'CANCELLED' : 'PARTIAL_CANCELLED' } });
    return true;
  });
}

/** 결제 취소까지 끝났는데 반영이 멈춘 요청 (관리자 재처리 대상) */
export async function listStuckClaims() {
  return prisma.orderClaim.findMany({ where: { status: 'APPROVED', refundAmount: { not: null } }, include: { order: { select: { id: true, orderNo: true } } }, orderBy: { processedAt: 'asc' }, take: 50 });
}

