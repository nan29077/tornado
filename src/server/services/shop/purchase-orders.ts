/**
 * 발주서 (관리자 상품 주문 → 공급처) (2026-11-17).
 * 1차는 공급처 로그인 없이 최고관리자가 발주서(CSV, 엑셀에서 열림)를 내려받아 전달한다.
 * 받는 분 연락처·주소는 이 파일을 만들 때만 복호화한다.
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { csvCell as encodeCell } from '@/lib/csv';

/** 공용 CSV 인코더(음수 숫자 보존 + 수식 주입 방지) */
const csvCell = (v: unknown) => encodeCell(v == null ? '' : String(v));
import { openAddress } from './address';
import { markShipped, type Actor } from './orders';

export const PO_STATUS_LABEL: Record<string, string> = { DRAFT: '작성', SENT: '발주 완료', SHIPPED: '출고', DONE: '완료', CANCELLED: '취소' };

/** 발주 대기 항목 (도네이도 판매 · 결제 완료/준비중 · 아직 발주서에 없음), 공급처별 */
export async function pendingPurchaseItems() {
  const items = await prisma.shopOrderItem.findMany({
    where: { purchaseOrderItem: null, order: { sellerType: 'DONAIDO', status: { in: ['PAID', 'PREPARING'] } } },
    orderBy: { createdAt: 'asc' },
    include: { order: { select: { id: true, orderNo: true, status: true, paidAt: true } } },
    take: 2000,
  });
  const supplierIds = [...new Set(items.map((i) => i.supplierId).filter((v): v is string => Boolean(v)))];
  const suppliers = await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } });
  const nameOf = new Map(suppliers.map((s) => [s.id, s.name]));
  const groups = new Map<string, { supplierId: string | null; supplierName: string; items: typeof items }>();
  for (const it of items) {
    const key = it.supplierId ?? '__none__';
    const g = groups.get(key) ?? { supplierId: it.supplierId, supplierName: it.supplierId ? nameOf.get(it.supplierId) ?? '(삭제된 공급처)' : '공급처 미지정', items: [] as typeof items };
    g.items.push(it);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** 공급처별 발주서 생성. 해당 주문은 '상품 준비중'으로 */
export async function createPurchaseOrders(adminUserId: string, supplierIds?: string[]): Promise<string[]> {
  const groups = (await pendingPurchaseItems()).filter((g) => g.supplierId && (!supplierIds || supplierIds.includes(g.supplierId)));
  if (groups.length === 0) throw new Error('발주할 항목이 없습니다. (공급처가 지정된 상품만 발주서를 만들 수 있습니다)');
  const created: string[] = [];
  for (const g of groups) {
    const poId = newId();
    const kst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(2, 10).replace(/-/g, '');
    await prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.create({ data: { id: poId, poNo: `PO${kst}-${newId().slice(-6)}`, supplierId: g.supplierId!, createdBy: adminUserId } });
      for (const it of g.items) {
        await tx.purchaseOrderItem.create({ data: { id: newId(), purchaseOrderId: poId, orderItemId: it.id, quantity: it.quantity, supplyPrice: it.supplyPrice } });
      }
      await tx.shopOrder.updateMany({ where: { id: { in: [...new Set(g.items.map((i) => i.order.id))] }, status: 'PAID' }, data: { status: 'PREPARING' } });
    });
    created.push(poId);
  }
  return created;
}

export async function setPurchaseOrderStatus(poId: string, status: 'SENT' | 'SHIPPED' | 'DONE' | 'CANCELLED') {
  const data = status === 'SENT' ? { status, sentAt: new Date() } : { status };
  const moved = await prisma.purchaseOrder.updateMany({ where: { id: poId, status: { not: 'CANCELLED' } }, data });
  if (moved.count === 0) throw new Error('발주서를 찾을 수 없거나 취소된 발주서입니다.');
  if (status === 'CANCELLED') {
    // 취소된 발주서의 항목은 다시 발주 대기로 돌아간다
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: poId } });
  }
}

/** 발주서 CSV (UTF-8 BOM — 엑셀에서 한글이 깨지지 않는다) */
export async function purchaseOrderCsv(poId: string): Promise<{ filename: string; body: string }> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: { select: { name: true } },
      items: { include: { orderItem: { include: { order: true } } } },
    },
  });
  if (!po) throw new Error('발주서를 찾을 수 없습니다.');
  const header = ['발주번호', '공급처', '주문번호', '상품명', '옵션', '수량', '공급가(단가)', '공급가 합계', '받는 분', '연락처', '우편번호', '주소', '배송 메모', '택배사', '송장번호'];
  const rows = po.items.map((pi) => {
    const o = pi.orderItem.order;
    const a = openAddress(o);
    const unit = pi.supplyPrice ?? null;
    return [
      po.poNo, po.supplier.name, o.orderNo, pi.orderItem.productName, pi.orderItem.variantName, pi.quantity,
      unit?.toString() ?? '', unit != null ? (unit * BigInt(pi.quantity)).toString() : '', a.recipient, a.phone, a.zipcode, a.address, o.memo ?? '', o.courier ?? '', o.trackingNo ?? '',
    ];
  });
  const body = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return { filename: `${po.poNo}.csv`, body };
}

/**
 * 송장 일괄 등록. 한 줄에 "주문번호,택배사,송장번호" (발주서 CSV 에 택배사·송장번호를 채워 그대로 올려도 된다)
 * 결과를 줄 단위로 돌려준다.
 */
export async function applyTrackingCsv(actor: Actor, text: string) {
  const results: Array<{ line: number; orderNo: string; ok: boolean; message: string }> = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  for (const [idx, raw] of lines.entries()) {
    const cols = parseCsvLine(raw).map((c) => c.trim().replace(/^'/, ''));
    // 발주서 CSV 형식이면 주문번호=3열, 택배사=14열, 송장=15열
    const [orderNo, courier, tracking] = cols.length >= 15 ? [cols[2], cols[13], cols[14]] : [cols[0], cols[1], cols[2]];
    if (!orderNo || orderNo === '주문번호') continue;
    if (!courier || !tracking) {
      results.push({ line: idx + 1, orderNo, ok: false, message: '택배사·송장번호가 비어 있습니다' });
      continue;
    }
    try {
      const order = await prisma.shopOrder.findUnique({ where: { orderNo }, select: { id: true } });
      if (!order) throw new Error('주문번호를 찾을 수 없습니다');
      await markShipped(order.id, actor, courier, tracking);
      results.push({ line: idx + 1, orderNo, ok: true, message: '발송 처리' });
    } catch (e) {
      results.push({ line: idx + 1, orderNo, ok: false, message: (e as Error).message });
    }
  }
  return results;
}

/** CSV 한 줄 파싱 (큰따옴표 안의 쉼표·"" 이스케이프 처리) */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
