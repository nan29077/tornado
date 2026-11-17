'use server';

/**
 * 최고관리자 — 도네이도 샵 (상품·공급처·수익률·주문·발주·배송·취소/반품·설정) (2026-11-17)
 * 권한: 상품·주문·발주·배송 = 운영(OPERATION) 이상 / 수익률·중개 수수료·환불 = 재무(FINANCE) 이상
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { notifyUser } from '@/server/services/notifications';
import { parseProductForm, saveProduct } from '@/server/services/shop/catalog';
import { getShopConfig, percentToRate, saveShopConfig } from '@/server/services/shop/config';
import { autoConfirmOrders, completeApprovedClaim, confirmOrder, markDelivered, markPreparing, markShipped, processClaim } from '@/server/services/shop/orders';
import { retryPendingShopCancel } from '@/server/services/shop/payment-cancel';
import { applyTrackingCsv, createPurchaseOrders, setPurchaseOrderStatus } from '@/server/services/shop/purchase-orders';
import { assertFinanceAdmin, assertOperationAdmin, run, text, type AdminActionState } from './shared';

const actor = (adminId: string) => ({ type: 'ADMIN' as const, userId: adminId });

// ------------------------------------------------------------------ 상품

export async function saveAdminProduct(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  let createdId: string | null = null;
  const r = await run(async (admin) => {
    assertOperationAdmin(admin, '상품 저장');
    const id = text(fd, 'id') || undefined;
    const input = parseProductForm(fd, { forAdmin: true });
    const savedId = await saveProduct(input, { type: 'ADMIN' }, id);
    if (!id) createdId = savedId;
    await writeAudit({ adminUserId: admin.id, action: id ? 'SHOP_PRODUCT_UPDATE' : 'SHOP_PRODUCT_CREATE', targetType: 'Product', targetId: savedId, after: { name: input.name, price: input.price.toString(), status: input.status, referralRate: input.referralRate } });
    revalidatePath('/admin/shop/products');
    return `${input.name} 상품을 저장했습니다.`;
  });
  if (r.ok && createdId) redirect(`/admin/shop/products/${createdId}?saved=1`);
  return r;
}

export async function reviewCreatorProduct(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '직접 상품 검수');
    const id = text(fd, 'id');
    const approve = text(fd, 'decision') === 'APPROVED';
    const reason = text(fd, 'reason');
    if (!approve && !reason) throw new Error('반려 사유를 입력해 주세요. 크리에이터에게 그대로 전달됩니다.');
    const p = await prisma.product.findFirst({ where: { id, ownerType: 'CREATOR', deletedAt: null }, include: { creator: { select: { userId: true } } } });
    if (!p) throw new Error('상품을 찾을 수 없습니다.');
    await prisma.product.update({ where: { id }, data: approve ? { reviewStatus: 'APPROVED', rejectReason: null } : { reviewStatus: 'REJECTED', rejectReason: reason.slice(0, 300) } });
    if (p.creator) {
      await notifyUser({ userId: p.creator.userId, title: approve ? '상품 검수가 승인되었습니다' : '상품 검수가 반려되었습니다', body: approve ? `${p.name} 상품이 내 샵에 노출됩니다.` : `${p.name} · 사유: ${reason}`, linkUrl: '/studio/shop/products' }).catch(() => undefined);
    }
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_PRODUCT_REVIEW', targetType: 'Product', targetId: id, after: { approve, reason } });
    revalidatePath('/admin/shop/products');
    return approve ? '승인했습니다. 크리에이터 샵에 노출됩니다.' : '반려했습니다.';
  });
}

export async function deleteAdminProduct(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '상품 삭제');
    const id = text(fd, 'id');
    // 주문 기록 보존을 위해 지우지 않고 숨김 + 삭제 표시
    const moved = await prisma.product.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), status: 'HIDDEN' } });
    if (moved.count === 0) throw new Error('상품을 찾을 수 없습니다.');
    await prisma.cartItem.deleteMany({ where: { productId: id } });
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_PRODUCT_DELETE', targetType: 'Product', targetId: id });
    revalidatePath('/admin/shop/products');
    return '상품을 삭제(판매 중지)했습니다. 지난 주문 기록은 그대로 남습니다.';
  });
}

export async function setDisplayBlocked(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '샵 전시 차단');
    const id = text(fd, 'displayId');
    const blocked = text(fd, 'blocked') === '1';
    await prisma.creatorProduct.update({ where: { id }, data: { blocked } });
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_DISPLAY_BLOCK', targetType: 'CreatorProduct', targetId: id, after: { blocked } });
    revalidatePath('/admin/shop/products');
    return blocked ? '이 샵에서 판매를 막았습니다.' : '이 샵에서 다시 판매합니다.';
  });
}

// ------------------------------------------------------------------ 공급처 · 수익률 · 설정

export async function saveSupplier(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '공급처 저장');
    const id = text(fd, 'id');
    const name = text(fd, 'name');
    if (!name || name.length > 60) throw new Error('공급처 이름을 입력해 주세요.');
    const data = {
      name,
      contactName: text(fd, 'contactName').slice(0, 40) || null,
      phone: text(fd, 'phone').slice(0, 30) || null,
      email: text(fd, 'email').slice(0, 120) || null,
      memo: text(fd, 'memo').slice(0, 300) || null,
      active: text(fd, 'active') === 'on',
    };
    if (id) await prisma.supplier.update({ where: { id }, data });
    else await prisma.supplier.create({ data: { id: newId(), ...data } });
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_SUPPLIER_SAVE', targetType: 'Supplier', targetId: id || undefined, after: data });
    revalidatePath('/admin/shop/settings');
    return `${name} 공급처를 저장했습니다.`;
  });
}

async function creatorByCode(code: string) {
  const c = await prisma.creatorProfile.findUnique({ where: { code: code.trim().toUpperCase() }, select: { id: true, displayName: true } });
  if (!c) throw new Error('크리에이터 코드를 찾을 수 없습니다.');
  return c;
}

export async function saveCreatorCommission(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '크리에이터 수익률 변경');
    const c = await creatorByCode(text(fd, 'creatorCode'));
    const productId = text(fd, 'productId');
    const raw = text(fd, 'rate');
    if (!raw) {
      if (productId) await prisma.creatorProductCommission.deleteMany({ where: { creatorId: c.id, productId } });
      else await prisma.creatorCommission.deleteMany({ where: { creatorId: c.id } });
      await writeAudit({ adminUserId: admin.id, action: 'SHOP_COMMISSION_CLEAR', targetType: 'CreatorProfile', targetId: c.id, after: { productId: productId || null } });
      revalidatePath('/admin/shop/settings');
      return `${c.displayName} 님의 개별 수익률을 지웠습니다. (상위 기준을 따릅니다)`;
    }
    const rate = percentToRate(raw, 90);
    if (rate == null) throw new Error('수익률은 0~90 사이 퍼센트로 입력해 주세요.');
    if (productId) {
      const p = await prisma.product.findFirst({ where: { id: productId, ownerType: 'ADMIN' }, select: { id: true } });
      if (!p) throw new Error('관리자 상품만 개별 수익률을 지정할 수 있습니다.');
      await prisma.creatorProductCommission.upsert({ where: { creatorId_productId: { creatorId: c.id, productId } }, create: { id: newId(), creatorId: c.id, productId, rate }, update: { rate } });
    } else {
      await prisma.creatorCommission.upsert({ where: { creatorId: c.id }, create: { id: newId(), creatorId: c.id, rate }, update: { rate } });
    }
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_COMMISSION_SAVE', targetType: 'CreatorProfile', targetId: c.id, after: { productId: productId || null, rate } });
    revalidatePath('/admin/shop/settings');
    return `${c.displayName} 님 수익률을 ${raw}% 로 저장했습니다. 이후 주문부터 적용됩니다.`;
  });
}

export async function saveShopSettings(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '샵 설정 변경');
    const rate = percentToRate(text(fd, 'brokerFeeRate'), 50);
    if (rate == null) throw new Error('중개 수수료율은 0~50 사이 퍼센트로 입력해 주세요.');
    const days = Number.parseInt(text(fd, 'autoConfirmDays'), 10);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('자동 구매 확정은 1~30일로 입력해 주세요.');
    const before = await getShopConfig();
    const next = { brokerFeeRate: Number(rate), autoConfirmDays: days };
    await saveShopConfig(next);
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_CONFIG_SAVE', targetType: 'SystemSetting', targetId: 'shop.config', before, after: next });
    revalidatePath('/admin/shop/settings');
    return '샵 설정을 저장했습니다. 이후 주문부터 적용됩니다.';
  });
}

// ------------------------------------------------------------------ 주문 · 발주 · 배송

export async function adminOrderOp(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '주문 처리');
    const id = text(fd, 'orderId');
    const op = text(fd, 'op');
    if (op === 'preparing') await markPreparing(id, actor(admin.id));
    else if (op === 'ship') await markShipped(id, actor(admin.id), text(fd, 'courier'), text(fd, 'trackingNo'));
    else if (op === 'delivered') await markDelivered(id, actor(admin.id));
    else if (op === 'confirm') await confirmOrder(id, actor(admin.id));
    else throw new Error('알 수 없는 처리입니다.');
    await writeAudit({ adminUserId: admin.id, action: `SHOP_ORDER_${op.toUpperCase()}`, targetType: 'ShopOrder', targetId: id });
    revalidatePath('/admin/shop/orders');
    return '처리했습니다.';
  });
}

export async function createPurchaseOrdersAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '발주서 생성');
    const ids = fd.getAll('supplierId').map(String).filter(Boolean);
    const created = await createPurchaseOrders(admin.id, ids.length ? ids : undefined);
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_PO_CREATE', targetType: 'PurchaseOrder', after: { count: created.length } });
    revalidatePath('/admin/shop/purchase-orders');
    return `발주서 ${created.length}건을 만들었습니다. 내려받아 공급처에 전달해 주세요.`;
  });
}

export async function purchaseOrderStatusAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '발주서 상태 변경');
    const status = text(fd, 'status') as 'SENT' | 'SHIPPED' | 'DONE' | 'CANCELLED';
    if (!['SENT', 'SHIPPED', 'DONE', 'CANCELLED'].includes(status)) throw new Error('상태 값이 올바르지 않습니다.');
    await setPurchaseOrderStatus(text(fd, 'poId'), status);
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_PO_STATUS', targetType: 'PurchaseOrder', targetId: text(fd, 'poId'), after: { status } });
    revalidatePath('/admin/shop/purchase-orders');
    return '발주서 상태를 바꿨습니다.';
  });
}

export async function uploadTrackingAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '송장 일괄 등록');
    const file = fd.get('file');
    let body = text(fd, 'csv');
    if (file instanceof File && file.size > 0) {
      if (file.size > 2 * 1024 * 1024) throw new Error('파일은 2MB 이하만 올릴 수 있습니다.');
      body = await file.text();
    }
    if (!body) throw new Error('CSV 파일을 고르거나 내용을 붙여 넣어 주세요.');
    const results = await applyTrackingCsv(actor(admin.id), body);
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok);
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_TRACKING_UPLOAD', targetType: 'ShopOrder', after: { ok, fail: fail.length } });
    revalidatePath('/admin/shop/purchase-orders');
    revalidatePath('/admin/shop/orders');
    return {
      message: `발송 처리 ${ok}건${fail.length ? `, 실패 ${fail.length}건` : ''}`,
      detail: Object.fromEntries(fail.slice(0, 20).map((f) => [`${f.line}행 ${f.orderNo}`, f.message])),
    };
  });
}

export async function runAutoConfirmAction(): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '자동 구매 확정');
    const n = await autoConfirmOrders();
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_AUTO_CONFIRM', targetType: 'ShopOrder', after: { confirmed: n } });
    revalidatePath('/admin/shop/orders');
    return `기간이 지난 주문 ${n}건을 구매 확정했습니다.`;
  });
}

export async function adminClaimAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '취소·반품 처리(환불)');
    const id = text(fd, 'claimId');
    const approve = text(fd, 'decision') === 'APPROVE';
    await processClaim(id, actor(admin.id), approve, text(fd, 'reason'));
    await writeAudit({ adminUserId: admin.id, action: approve ? 'SHOP_CLAIM_APPROVE' : 'SHOP_CLAIM_REJECT', targetType: 'OrderClaim', targetId: id, after: { reason: text(fd, 'reason') || null } });
    revalidatePath('/admin/shop/claims');
    revalidatePath('/admin/shop/orders');
    return approve ? '승인하고 환불했습니다.' : '거절했습니다.';
  });
}

/** 결제 취소는 끝났는데 주문 반영이 멈춘 취소·반품 요청을 마무리한다 (5차 P2-5) */
export async function resumeClaimAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '취소·반품 재처리');
    const id = text(fd, 'claimId');
    const done = await completeApprovedClaim(id);
    if (!done) throw new Error('재처리할 요청이 아닙니다. 새로고침해 주세요.');
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_CLAIM_RESUME', targetType: 'OrderClaim', targetId: id });
    revalidatePath('/admin/shop/claims');
    revalidatePath('/admin/shop/orders');
    return '재고·결제 반영을 마쳤습니다.';
  });
}

/** 결제사 취소가 실패해 남은 샵 결제 취소를 다시 보낸다 (5차 P2-2) */
export async function retryShopCancelAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '결제 취소 재시도');
    const id = text(fd, 'paymentId');
    const r = await retryPendingShopCancel(id);
    await writeAudit({ adminUserId: admin.id, action: 'SHOP_PAYMENT_CANCEL_RETRY', targetType: 'ShopPayment', targetId: id, after: { ok: r.ok } });
    if (!r.ok) throw new Error(r.message);
    revalidatePath('/admin/payments');
    return r.message;
  });
}

