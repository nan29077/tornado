/**
 * 도네이도 샵 상품 (2026-11-17).
 *
 * - 관리자 상품(ADMIN): 판매 당사자 도네이도. 크리에이터가 골라 자기 샵에 전시하면 레퍼럴 수익을 받는다.
 * - 크리에이터 직접 상품(CREATOR): 판매자 = 크리에이터, 도네이도 = 통신판매중개자. 최고관리자 검수 후 노출.
 * - 옵션은 "옵션명 | 추가금 | 재고 | SKU" 한 줄씩. 옵션이 없으면 "기본" 한 개. 재고는 옵션 단위.
 * - 이미 주문·장바구니가 참조하는 옵션은 지우지 않고 비활성화한다(주문 기록 보존).
 */
import { isOwnUploadUrl } from '@/server/uploads';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { percentToRate } from './config';

export const PRODUCT_STATUSES = ['DRAFT', 'ON_SALE', 'SOLD_OUT', 'HIDDEN'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_STATUS_LABEL: Record<string, string> = {
  DRAFT: '임시저장', ON_SALE: '판매중', SOLD_OUT: '품절', HIDDEN: '숨김',
};
export const REVIEW_STATUS_LABEL: Record<string, string> = { PENDING: '검수 대기', APPROVED: '승인', REJECTED: '반려' };

export const PRODUCT_CATEGORIES = ['패션·잡화', '뷰티', '식품', '생활·주방', '디지털·가전', '취미·굿즈', '반려동물', '스포츠·레저', '도서·문구', '기타'] as const;

export interface VariantLine {
  name: string;
  extraPrice: bigint;
  stock: number;
  sku: string | null;
}

export interface ProductInput {
  name: string;
  category: string | null;
  summary: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  images: string[];
  listPrice: bigint | null;
  price: bigint;
  supplyPrice: bigint | null;
  shippingFee: bigint;
  freeShippingOver: bigint | null;
  referralRate: string;
  status: ProductStatus;
  supplierId: string | null;
  shipFrom: string | null;
  returnAddress: string | null;
  notice: Array<{ label: string; value: string }>;
  variants: VariantLine[];
  /** 수정 화면을 열었을 때의 옵션별 재고 (없으면 입력값을 그대로 저장) */
  stockBase?: Map<string, number>;
}

function txt(fd: FormData, k: string, max: number): string | null {
  const v = String(fd.get(k) ?? '').trim();
  if (v.length > max) throw new Error(`${k} 값이 너무 깁니다 (${max}자 이내).`);
  return v || null;
}

function won(fd: FormData, k: string, label: string, required = false): bigint | null {
  const raw = String(fd.get(k) ?? '').replace(/[,\s원]/g, '');
  if (!raw) {
    if (required) throw new Error(`${label}을(를) 입력해 주세요.`);
    return null;
  }
  if (!/^\d{1,10}$/.test(raw)) throw new Error(`${label}은(는) 원 단위 숫자로 입력해 주세요.`);
  return BigInt(raw);
}

/**
 * [6차 P2-3] 외부(https) 이미지 주소는 최고관리자 상품에만 허용한다.
 * 크리에이터 상품 이미지는 모든 구매자 화면에 그대로 뜨므로, 외부 서버가 보는 사람의 IP·접속 시각을
 * 수집하는 추적 픽셀로 쓰이지 않게 [파일 업로드]로 올린 이미지만 받는다.
 */
function safeUrl(v: string | null, allowExternal: boolean): string | null {
  if (!v) return null;
  if (v.startsWith('/assets/') || isOwnUploadUrl(v)) return v;
  if (!allowExternal) throw new Error('상품 이미지는 [파일 업로드]로 올린 이미지만 쓸 수 있습니다. (외부 주소는 사용할 수 없어요)');
  if (v.startsWith('/api/media/')) return v;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseVariantLines(raw: string): VariantLine[] {
  const out: VariantLine[] = [];
  const names = new Set<string>();
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const [name, extra, stock, sku] = line.split('|').map((v) => v.trim());
    if (!name || name.length > 60) throw new Error(`옵션 ${i + 1}번째 줄: 옵션명을 확인해 주세요.`);
    if (names.has(name)) throw new Error(`옵션명이 겹칩니다: ${name}`);
    names.add(name);
    const e = (extra ?? '0').replace(/[,원\s]/g, '') || '0';
    const s = (stock ?? '0').replace(/[,개\s]/g, '') || '0';
    if (!/^-?\d{1,9}$/.test(e)) throw new Error(`옵션 '${name}': 추가금은 숫자로 입력해 주세요.`);
    if (!/^\d{1,7}$/.test(s)) throw new Error(`옵션 '${name}': 재고는 0 이상의 숫자로 입력해 주세요.`);
    out.push({ name, extraPrice: BigInt(e), stock: Number(s), sku: sku ? sku.slice(0, 60) : null });
  }
  if (out.length > 100) throw new Error('옵션은 100개까지 등록할 수 있습니다.');
  return out;
}

export function parseNoticeLines(raw: string): Array<{ label: string; value: string }> {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((l) => {
      const idx = l.indexOf(':');
      return idx > 0 ? { label: l.slice(0, idx).trim().slice(0, 40), value: l.slice(idx + 1).trim().slice(0, 300) } : { label: l.slice(0, 40), value: '' };
    });
}

/** 상품 폼 공통 파싱. 관리자 전용 필드는 forAdmin 일 때만 읽는다 */
export function parseProductForm(fd: FormData, opts: { forAdmin: boolean }): ProductInput {
  const name = txt(fd, 'name', 100);
  if (!name) throw new Error('상품명을 입력해 주세요.');
  const price = won(fd, 'price', '판매가', true)!;
  const listPrice = won(fd, 'listPrice', '정가');
  if (listPrice != null && listPrice < price) throw new Error('정가는 판매가보다 작을 수 없습니다.');
  const statusRaw = String(fd.get('status') ?? 'DRAFT');
  const status = (PRODUCT_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as ProductStatus) : 'DRAFT';
  const images = fd
    .getAll('images')
    .map((v) => safeUrl(String(v).trim() || null, opts.forAdmin))
    .filter((v): v is string => Boolean(v))
    .slice(0, 8);
  let referralRate = '0.000000';
  if (opts.forAdmin) {
    const r = String(fd.get('referralRate') ?? '').trim();
    if (r) {
      const rate = percentToRate(r, 90);
      if (rate == null) throw new Error('레퍼럴 수익률은 0~90 사이 퍼센트로 입력해 주세요. (예: 5, 7.5)');
      referralRate = rate;
    }
  }
  let variants = parseVariantLines(String(fd.get('variants') ?? ''));
  if (variants.length === 0) {
    const stockRaw = String(fd.get('stock') ?? '0').replace(/[,\s]/g, '') || '0';
    if (!/^\d{1,7}$/.test(stockRaw)) throw new Error('재고는 0 이상의 숫자로 입력해 주세요.');
    variants = [{ name: '기본', extraPrice: 0n, stock: Number(stockRaw), sku: null }];
  }
  // [6차 P2-4] 화면을 열었을 때의 재고(기준값). 저장할 때 "기준값 대비 바꾼 만큼"만 반영한다.
  const stockBase = new Map<string, number>();
  try {
    for (const b of parseVariantLines(String(fd.get('variantsBase') ?? ''))) stockBase.set(b.name, b.stock);
  } catch {
    /* 기준값이 깨졌으면 예전처럼 입력값을 그대로 쓴다 */
  }
  const singleBase = String(fd.get('stockBase') ?? '').trim();
  if (/^\d{1,7}$/.test(singleBase) && stockBase.size === 0) stockBase.set('기본', Number(singleBase));
  for (const v of variants) if (price + v.extraPrice < 0n) throw new Error(`옵션 '${v.name}' 가격이 0원보다 작아집니다.`);
  const thumb = safeUrl(txt(fd, 'thumbnailUrl', 500), opts.forAdmin);
  return {
    name,
    category: txt(fd, 'category', 40),
    summary: txt(fd, 'summary', 200),
    description: txt(fd, 'description', 10_000),
    thumbnailUrl: thumb ?? images[0] ?? null,
    images,
    listPrice,
    price,
    supplyPrice: opts.forAdmin ? won(fd, 'supplyPrice', '공급가') : null,
    shippingFee: won(fd, 'shippingFee', '배송비') ?? 0n,
    freeShippingOver: won(fd, 'freeShippingOver', '무료배송 기준 금액'),
    referralRate,
    status,
    supplierId: opts.forAdmin ? txt(fd, 'supplierId', 40) : null,
    shipFrom: txt(fd, 'shipFrom', 200),
    returnAddress: txt(fd, 'returnAddress', 200),
    notice: parseNoticeLines(String(fd.get('notice') ?? '')),
    variants,
    stockBase,
  };
}

/**
 * [6차 P2-4] 재고는 "화면을 열었을 때 값 대비 바꾼 만큼"만 반영한다.
 * 예전에는 입력값으로 그대로 덮어써, 수정 화면을 열어 둔 사이에 팔린 수량이 저장과 함께 되살아났다
 * (재고 10 → 화면 열림 → 3개 판매(7) → 설명만 고쳐 저장 → 다시 10).
 */
async function syncVariants(tx: Prisma.TransactionClient, productId: string, lines: VariantLine[], stockBase?: Map<string, number>): Promise<number> {
  const existing = await tx.productVariant.findMany({ where: { productId }, select: { id: true, name: true, stock: true } });
  const byName = new Map(existing.map((v) => [v.name, v]));
  let totalStock = 0;
  for (const [i, v] of lines.entries()) {
    const cur = byName.get(v.name);
    if (cur) {
      const base = stockBase?.get(v.name);
      const stock = base == null ? v.stock : Math.max(0, cur.stock + (v.stock - base));
      totalStock += stock;
      await tx.productVariant.update({ where: { id: cur.id }, data: { extraPrice: v.extraPrice, stock, sku: v.sku, active: true, sortOrder: i } });
      byName.delete(v.name);
    } else {
      totalStock += v.stock;
      await tx.productVariant.create({ data: { id: newId(), productId, name: v.name, extraPrice: v.extraPrice, stock: v.stock, sku: v.sku, sortOrder: i } });
    }
  }
  // 목록에서 빠진 옵션은 지우지 않고 판매 중지 (주문·장바구니 기록 보존)
  if (byName.size > 0) await tx.productVariant.updateMany({ where: { id: { in: [...byName.values()].map((v) => v.id) } }, data: { active: false } });
  return totalStock;
}

async function syncImages(tx: Prisma.TransactionClient, productId: string, images: string[]) {
  await tx.productImage.deleteMany({ where: { productId } });
  for (const [i, url] of images.entries()) await tx.productImage.create({ data: { id: newId(), productId, url, sortOrder: i } });
}

/** 저장. id 가 없으면 새로 만든다. 크리에이터 상품은 수정할 때마다 다시 검수 대기로 돌아간다 */
export async function saveProduct(
  input: ProductInput,
  owner: { type: 'ADMIN' } | { type: 'CREATOR'; creatorId: string },
  id?: string,
): Promise<string> {
  if (owner.type === 'ADMIN' && input.supplierId) {
    const sup = await prisma.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } });
    if (!sup) throw new Error('공급처를 찾을 수 없습니다.');
  }
  const base = {
    name: input.name,
    category: input.category,
    summary: input.summary,
    description: input.description,
    thumbnailUrl: input.thumbnailUrl,
    listPrice: input.listPrice,
    price: input.price,
    supplyPrice: input.supplyPrice,
    shippingFee: input.shippingFee,
    freeShippingOver: input.freeShippingOver,
    status: input.status,
    shipFrom: input.shipFrom,
    returnAddress: input.returnAddress,
    notice: input.notice as unknown as Prisma.InputJsonValue,
    ...(owner.type === 'ADMIN'
      ? { referralRate: input.referralRate, supplierId: input.supplierId, reviewStatus: 'APPROVED', rejectReason: null }
      : { reviewStatus: 'PENDING', rejectReason: null }),
  };
  return prisma.$transaction(async (tx) => {
    let productId = id;
    if (productId) {
      const where =
        owner.type === 'ADMIN'
          ? { id: productId, ownerType: 'ADMIN', deletedAt: null }
          : { id: productId, ownerType: 'CREATOR', creatorId: owner.creatorId, deletedAt: null };
      const moved = await tx.product.updateMany({ where, data: base });
      if (moved.count === 0) throw new Error('상품을 찾을 수 없습니다.');
    } else {
      productId = newId();
      await tx.product.create({
        data: {
          id: productId,
          ownerType: owner.type,
          creatorId: owner.type === 'CREATOR' ? owner.creatorId : null,
          ...base,
        },
      });
    }
    const totalStock = await syncVariants(tx, productId, input.variants, id ? input.stockBase : undefined);
    await syncImages(tx, productId, input.images);
    // 품절 자동 표시: 판매중인데 활성 옵션 재고가 모두 0 이면 품절
    if (input.status === 'ON_SALE' && totalStock <= 0) {
      await tx.product.update({ where: { id: productId }, data: { status: 'SOLD_OUT' } });
    }
    // 크리에이터 상품은 자기 샵 전시 행을 만들어 둔다(검수 승인 전에는 노출되지 않는다)
    if (owner.type === 'CREATOR') {
      await tx.creatorProduct.upsert({
        where: { creatorId_productId: { creatorId: owner.creatorId, productId } },
        create: { id: newId(), creatorId: owner.creatorId, productId },
        update: {},
      });
    }
    return productId;
  });
}

/** 샵에 노출 가능한 상품인가 (판매중·승인·삭제 안 됨) */
export const SELLABLE_PRODUCT: Prisma.ProductWhereInput = {
  deletedAt: null,
  reviewStatus: 'APPROVED',
  status: { in: ['ON_SALE', 'SOLD_OUT'] },
};

/** 크리에이터 샵 쇼핑 탭 상품 목록 */
export async function listShopProducts(creatorId: string, opts: { category?: string | null; take?: number } = {}) {
  const rows = await prisma.creatorProduct.findMany({
    where: {
      creatorId,
      active: true,
      blocked: false,
      product: {
        ...SELLABLE_PRODUCT,
        ...(opts.category ? { category: opts.category } : {}),
        // 직접 상품은 자기 샵에서만
        OR: [{ ownerType: 'ADMIN' }, { ownerType: 'CREATOR', creatorId }],
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: opts.take ?? 60,
    select: {
      product: {
        select: {
          id: true, name: true, summary: true, thumbnailUrl: true, listPrice: true, price: true, status: true,
          ownerType: true, category: true, shippingFee: true, freeShippingOver: true, soldCount: true,
        },
      },
    },
  });
  return rows.map((r) => r.product);
}

/** 상품 상세 (이 샵에서 팔 수 있는지 포함) */
export async function getShopProduct(creatorId: string, productId: string) {
  const display = await prisma.creatorProduct.findUnique({
    where: { creatorId_productId: { creatorId, productId } },
    select: { active: true, blocked: true },
  });
  if (!display || !display.active || display.blocked) return null;
  const product = await prisma.product.findFirst({
    where: { id: productId, ...SELLABLE_PRODUCT, OR: [{ ownerType: 'ADMIN' }, { ownerType: 'CREATOR', creatorId }] },
    include: {
      variants: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
      images: { orderBy: { sortOrder: 'asc' } },
      creator: {
        select: {
          displayName: true, sellerBizName: true, sellerBizNo: true, sellerMailOrderNo: true, sellerCsPhone: true, sellerReturnAddress: true,
        },
      },
    },
  });
  return product;
}

export function variantPrice(product: { price: bigint }, variant: { extraPrice: bigint }): bigint {
  return product.price + variant.extraPrice;
}

/** 직접 판매 전에 필요한 판매자 정보가 모두 있는가 (통신판매중개자 고지 의무) */
export function sellerInfoMissing(c: {
  sellerBizName: string | null;
  sellerBizNo: string | null;
  sellerCsPhone: string | null;
  sellerReturnAddress: string | null;
}): string[] {
  const missing: string[] = [];
  if (!c.sellerBizName) missing.push('상호(또는 이름)');
  if (!c.sellerBizNo) missing.push('사업자등록번호');
  if (!c.sellerCsPhone) missing.push('고객 문의 연락처');
  if (!c.sellerReturnAddress) missing.push('반품 주소');
  return missing;
}
