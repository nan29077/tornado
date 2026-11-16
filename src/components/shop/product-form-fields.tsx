import { ImageUploadField } from '@/components/studio/image-upload-field';
import { PRODUCT_CATEGORIES, PRODUCT_STATUS_LABEL, PRODUCT_STATUSES } from '@/server/services/shop/catalog';

export interface ProductFormValues {
  id?: string;
  name?: string;
  category?: string | null;
  summary?: string | null;
  description?: string | null;
  thumbnailUrl?: string | null;
  images?: string[];
  listPrice?: string;
  price?: string;
  supplyPrice?: string;
  shippingFee?: string;
  freeShippingOver?: string;
  referralRatePercent?: string;
  status?: string;
  supplierId?: string | null;
  shipFrom?: string | null;
  returnAddress?: string | null;
  noticeText?: string;
  variantsText?: string;
  stock?: string;
}

const input = 'h-10 w-full rounded-xl border border-ink-200 bg-white px-3 text-[13.5px] text-ink-900';
const label = 'block text-[12.5px] font-bold text-ink-700';
const hint = 'mt-1 block text-[11.5px] font-normal text-ink-400';

/** 상품 등록·수정 입력 (최고관리자·크리에이터 공용). 관리자 전용 필드는 isAdmin 일 때만 */
export function ProductFormFields({ v, isAdmin, suppliers = [] }: { v: ProductFormValues; isAdmin: boolean; suppliers?: Array<{ id: string; name: string }> }) {
  const extra = [...(v.images ?? []), '', '', '', ''].slice(0, 4);
  return (
    <div className="space-y-4">
      {v.id ? <input type="hidden" name="id" value={v.id} /> : null}
      <label className={label}>
        상품명 *
        <input name="name" required maxLength={100} defaultValue={v.name ?? ''} className={`mt-1 ${input}`} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          카테고리
          <select name="category" defaultValue={v.category ?? ''} className={`mt-1 ${input}`}>
            <option value="">선택 안 함</option>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          판매 상태
          <select name="status" defaultValue={v.status ?? 'DRAFT'} className={`mt-1 ${input}`}>
            {PRODUCT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PRODUCT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={label}>
        한 줄 소개
        <input name="summary" maxLength={200} defaultValue={v.summary ?? ''} className={`mt-1 ${input}`} />
      </label>
      <ImageUploadField name="thumbnailUrl" label="대표 이미지" defaultValue={v.thumbnailUrl ?? ''} aspect="square" hint="정사각형 권장. JPG/PNG/WEBP 5MB 이하" />
      <div className="grid grid-cols-2 gap-3">
        {extra.map((url, i) => (
          <ImageUploadField key={i} name="images" label={`추가 이미지 ${i + 1}`} defaultValue={url} aspect="square" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>
          판매가(원) *
          <input name="price" required inputMode="numeric" defaultValue={v.price ?? ''} className={`mt-1 ${input}`} />
        </label>
        <label className={label}>
          정가(원)
          <input name="listPrice" inputMode="numeric" defaultValue={v.listPrice ?? ''} className={`mt-1 ${input}`} />
          <span className={hint}>할인 표시용. 비우면 판매가만</span>
        </label>
        {isAdmin ? (
          <label className={label}>
            공급가(원)
            <input name="supplyPrice" inputMode="numeric" defaultValue={v.supplyPrice ?? ''} className={`mt-1 ${input}`} />
            <span className={hint}>발주서 금액</span>
          </label>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>
          배송비(원)
          <input name="shippingFee" inputMode="numeric" defaultValue={v.shippingFee ?? '0'} className={`mt-1 ${input}`} />
        </label>
        <label className={label}>
          무료배송 기준(원)
          <input name="freeShippingOver" inputMode="numeric" defaultValue={v.freeShippingOver ?? ''} className={`mt-1 ${input}`} />
          <span className={hint}>같은 판매자 묶음 금액 기준</span>
        </label>
        {isAdmin ? (
          <label className={label}>
            레퍼럴 수익률(%)
            <input name="referralRate" inputMode="decimal" defaultValue={v.referralRatePercent ?? ''} placeholder="예: 5" className={`mt-1 ${input}`} />
            <span className={hint}>상품 기본값. 크리에이터별·개별 지정이 우선</span>
          </label>
        ) : null}
      </div>
      {isAdmin ? (
        <label className={label}>
          공급처
          <select name="supplierId" defaultValue={v.supplierId ?? ''} className={`mt-1 ${input}`}>
            <option value="">지정 안 함 (발주서 대상 아님)</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={label}>
        옵션 · 재고
        <textarea name="variants" rows={4} defaultValue={v.variantsText ?? ''} placeholder={'옵션명 | 추가금 | 재고 | SKU (한 줄에 하나)\n빨강/S | 0 | 20\n빨강/M | 1000 | 15'} className="mt-1 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 font-mono text-[12.5px]" />
        <span className={hint}>옵션이 없으면 비우고 아래 재고만 입력하세요. 목록에서 뺀 옵션은 판매 중지됩니다(주문 기록 보존).</span>
      </label>
      <label className={label}>
        재고 (옵션이 없을 때)
        <input name="stock" inputMode="numeric" defaultValue={v.stock ?? '0'} className={`mt-1 w-40 ${input}`} />
      </label>
      <label className={label}>
        상세 설명
        <textarea name="description" rows={6} maxLength={10000} defaultValue={v.description ?? ''} className="mt-1 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-[13.5px]" />
      </label>
      <label className={label}>
        상품정보 제공고시
        <textarea name="notice" rows={4} defaultValue={v.noticeText ?? ''} placeholder={'항목: 내용 (한 줄에 하나)\n제조국: 대한민국\n제조사: ○○'} className="mt-1 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-[12.5px]" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          출고지
          <input name="shipFrom" maxLength={200} defaultValue={v.shipFrom ?? ''} className={`mt-1 ${input}`} />
        </label>
        <label className={label}>
          반품지
          <input name="returnAddress" maxLength={200} defaultValue={v.returnAddress ?? ''} className={`mt-1 ${input}`} />
        </label>
      </div>
    </div>
  );
}

/** DB 상품 → 폼 값 */
export function productToFormValues(p: {
  id: string;
  name: string;
  category: string | null;
  summary: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  listPrice: bigint | null;
  price: bigint;
  supplyPrice: bigint | null;
  shippingFee: bigint;
  freeShippingOver: bigint | null;
  referralRate: { toString(): string };
  status: string;
  supplierId: string | null;
  shipFrom: string | null;
  returnAddress: string | null;
  notice: unknown;
  images: Array<{ url: string }>;
  variants: Array<{ name: string; extraPrice: bigint; stock: number; sku: string | null; active: boolean }>;
}): ProductFormValues {
  const notice = Array.isArray(p.notice) ? (p.notice as Array<{ label: string; value: string }>) : [];
  const active = p.variants.filter((x) => x.active);
  const simple = active.length === 1 && active[0].name === '기본' && active[0].extraPrice === 0n && !active[0].sku;
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    summary: p.summary,
    description: p.description,
    thumbnailUrl: p.thumbnailUrl,
    images: p.images.map((i) => i.url),
    listPrice: p.listPrice?.toString() ?? '',
    price: p.price.toString(),
    supplyPrice: p.supplyPrice?.toString() ?? '',
    shippingFee: p.shippingFee.toString(),
    freeShippingOver: p.freeShippingOver?.toString() ?? '',
    referralRatePercent: (Number(p.referralRate.toString()) * 100).toString().replace(/\.?0+$/, '') || '0',
    status: p.status,
    supplierId: p.supplierId,
    shipFrom: p.shipFrom,
    returnAddress: p.returnAddress,
    noticeText: notice.map((n) => `${n.label}: ${n.value}`).join('\n'),
    stock: simple ? String(active[0].stock) : '0',
    variantsText: simple ? '' : active.map((x) => [x.name, x.extraPrice.toString(), String(x.stock), x.sku ?? ''].join(' | ').replace(/ \| $/, '')).join('\n'),
  };
}
