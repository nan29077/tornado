'use client';

import * as React from 'react';
import { Minus, Plus, Trash2 } from '@/components/brand/icons';
import { checkoutAction, updateCartAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';
import { cx } from '@/components/ui';

export interface CartLine {
  id: string;
  shopName: string;
  productName: string;
  variantName: string;
  thumbnail: string | null;
  unitPrice: number;
  quantity: number;
  sellable: boolean;
  sellerKey: string; // DONAIDO | CREATOR:<id>
  sellerLabel: string;
  shippingFee: number;
  freeShippingOver: number | null;
}

/** 판매자 묶음 배송비 (서버 groupShippingFee 와 같은 규칙. 최종 금액은 서버가 다시 계산한다) */
function groupFee(lines: CartLine[]) {
  const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  let fee = 0;
  for (const l of lines) {
    const free = l.freeShippingOver != null && total >= l.freeShippingOver;
    if (!free && l.shippingFee > fee) fee = l.shippingFee;
  }
  return fee;
}

export function CheckoutForm({
  shopCode,
  lines,
  addresses,
  paymentMock,
}: {
  shopCode: string;
  lines: CartLine[];
  addresses: Array<{ id: string; label: string | null; recipientMasked: string; phoneMasked: string; zipcode: string; addressMasked: string; isDefault: boolean }>;
  paymentMock: boolean;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(lines.filter((l) => l.sellable).map((l) => l.id)));
  const [addressId, setAddressId] = React.useState(addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? '');
  const chosen = lines.filter((l) => selected.has(l.id) && l.sellable);
  const groups = new Map<string, CartLine[]>();
  for (const l of chosen) groups.set(l.sellerKey, [...(groups.get(l.sellerKey) ?? []), l]);
  const items = chosen.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const ship = [...groups.values()].reduce((s, g) => s + groupFee(g), 0);

  return (
    <div className="space-y-4">
      <section className="rounded-[1.5rem] border border-warm-300/70 bg-white p-4 shadow-card">
        <h2 className="text-[15px] font-black text-ink-900">장바구니 {lines.length}개</h2>
        <ul className="mt-3 divide-y divide-warm-200">
          {lines.map((l) => (
            <li key={l.id} className="flex gap-3 py-3">
              <input
                type="checkbox"
                aria-label={`${l.productName} 선택`}
                checked={selected.has(l.id) && l.sellable}
                disabled={!l.sellable}
                onChange={(e) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(l.id);
                    else n.delete(l.id);
                    return n;
                  })
                }
                className="mt-1 h-4 w-4"
              />
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-ink-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {l.thumbnail ? <img src={l.thumbnail} alt="" className="h-full w-full object-cover" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] text-ink-400">{l.shopName} 샵 · {l.sellerLabel}</p>
                <p className="line-clamp-2 text-[13.5px] font-bold text-ink-900">{l.productName}</p>
                <p className="text-[12px] text-ink-500">{l.variantName}</p>
                {!l.sellable ? <p className="text-[12px] font-bold text-danger-600">품절·판매 중지 또는 재고 부족</p> : null}
                <div className="mt-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <QtyButton id={l.id} qty={l.quantity - 1} disabled={l.quantity <= 1} label="줄이기" icon={<Minus size={13} />} />
                    <span className="w-7 text-center text-[13px] font-bold tabular-nums">{l.quantity}</span>
                    <QtyButton id={l.id} qty={l.quantity + 1} disabled={l.quantity >= 99} label="늘리기" icon={<Plus size={13} />} />
                    <ShopActionForm action={updateCartAction} hideMessage>
                      <input type="hidden" name="cartItemId" value={l.id} />
                      <input type="hidden" name="remove" value="1" />
                      <button type="submit" aria-label="삭제" className="ml-1 grid h-8 w-8 place-items-center rounded-full text-ink-400 hover:bg-ink-50">
                        <Trash2 size={14} />
                      </button>
                    </ShopActionForm>
                  </div>
                  <span className="text-[14px] font-extrabold text-ink-900">{(l.unitPrice * l.quantity).toLocaleString('ko-KR')}원</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <ShopActionForm action={checkoutAction} className="space-y-4">
        {(pending) => (
          <>
            <input type="hidden" name="shopCode" value={shopCode} />
            {chosen.map((l) => (
              <input key={l.id} type="hidden" name="cartItemId" value={l.id} />
            ))}
            <section className="rounded-[1.5rem] border border-warm-300/70 bg-white p-4 shadow-card">
              <h2 className="text-[15px] font-black text-ink-900">배송지</h2>
              {addresses.length > 0 ? (
                <div className="mt-2 space-y-1.5">
                  {addresses.map((a) => (
                    <label key={a.id} className={cx('flex cursor-pointer gap-2 rounded-xl border px-3 py-2 text-[12.5px]', addressId === a.id ? 'border-brand-400 bg-brand-50' : 'border-warm-300')}>
                      <input type="radio" name="addressId" value={a.id} checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                      <span>
                        <span className="font-bold text-ink-900">{a.label ?? a.recipientMasked}</span> {a.isDefault ? <span className="text-brand-700">기본</span> : null}
                        <br />
                        {a.recipientMasked} · {a.phoneMasked} · ({a.zipcode}) {a.addressMasked}
                      </span>
                    </label>
                  ))}
                  <label className={cx('flex cursor-pointer gap-2 rounded-xl border px-3 py-2 text-[12.5px] font-bold', addressId === '' ? 'border-brand-400 bg-brand-50' : 'border-warm-300')}>
                    <input type="radio" name="addressId" value="" checked={addressId === ''} onChange={() => setAddressId('')} />새 배송지 입력
                  </label>
                </div>
              ) : null}
              {addressId === '' ? (
                <div className="mt-3 grid gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input name="recipient" required maxLength={30} placeholder="받는 분" className="h-11 rounded-xl border border-warm-300 px-3 text-[14px]" aria-label="받는 분" />
                    <input name="phone" required inputMode="tel" maxLength={20} placeholder="연락처" className="h-11 rounded-xl border border-warm-300 px-3 text-[14px]" aria-label="연락처" />
                  </div>
                  <input name="zipcode" required inputMode="numeric" maxLength={5} placeholder="우편번호 5자리" className="h-11 w-40 rounded-xl border border-warm-300 px-3 text-[14px]" aria-label="우편번호" />
                  <input name="address1" required maxLength={200} placeholder="주소" className="h-11 rounded-xl border border-warm-300 px-3 text-[14px]" aria-label="주소" />
                  <input name="address2" maxLength={100} placeholder="상세 주소" className="h-11 rounded-xl border border-warm-300 px-3 text-[14px]" aria-label="상세 주소" />
                  <label className="flex items-center gap-2 text-[12.5px] text-ink-600">
                    <input type="checkbox" name="saveAddress" defaultChecked /> 이 배송지를 저장
                  </label>
                </div>
              ) : null}
              <input name="memo" maxLength={100} placeholder="배송 메모 (선택)" className="mt-2 h-11 w-full rounded-xl border border-warm-300 px-3 text-[14px]" aria-label="배송 메모" />
            </section>

            <section className="rounded-[1.5rem] border border-warm-300/70 bg-white p-4 shadow-card text-[13.5px]">
              <div className="flex justify-between"><span className="text-ink-500">상품 금액</span><span className="font-bold">{items.toLocaleString('ko-KR')}원</span></div>
              <div className="mt-1 flex justify-between"><span className="text-ink-500">배송비 ({groups.size}개 판매자)</span><span className="font-bold">{ship.toLocaleString('ko-KR')}원</span></div>
              <div className="mt-2 flex justify-between border-t border-warm-200 pt-2 text-[16px]"><span className="font-extrabold">결제 금액</span><span className="font-black text-brand-700">{(items + ship).toLocaleString('ko-KR')}원</span></div>
              {groups.size > 1 ? <p className="mt-2 text-[11.5px] text-ink-400">판매자가 다른 상품은 주문이 나뉘어 각각 배송됩니다. 결제는 한 번입니다.</p> : null}
              <label className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-600">
                <input type="checkbox" name="agree" required className="mt-0.5" /> 주문 상품·금액·배송지를 확인했으며 결제 진행에 동의합니다. (필수)
              </label>
              <button type="submit" disabled={pending || chosen.length === 0} className="mt-3 h-12 w-full rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 disabled:opacity-50">
                {pending ? '결제 중' : `${(items + ship).toLocaleString('ko-KR')}원 결제하기`}
              </button>
              {paymentMock ? <p className="mt-2 text-center text-[11.5px] font-semibold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않습니다.</p> : null}
            </section>
          </>
        )}
      </ShopActionForm>
    </div>
  );
}

function QtyButton({ id, qty, disabled, label, icon }: { id: string; qty: number; disabled: boolean; label: string; icon: React.ReactNode }) {
  return (
    <ShopActionForm action={updateCartAction} hideMessage>
      <input type="hidden" name="cartItemId" value={id} />
      <input type="hidden" name="quantity" value={qty} />
      <button type="submit" disabled={disabled} aria-label={`수량 ${label}`} className="grid h-8 w-8 place-items-center rounded-full border border-warm-300 bg-white disabled:opacity-40">
        {icon}
      </button>
    </ShopActionForm>
  );
}
