import { redirect } from 'next/navigation';
import { MapPin } from '@/components/brand/icons';
import { ShopActionForm } from '@/components/shop/shop-action-form';
import { addressOpAction, saveAddressAction } from '@/app/actions/shop';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

const input = 'mt-1 w-full rounded-xl border border-warm-300 bg-white px-3 py-2.5 text-[14px] outline-none focus:border-brand-400';
const label = 'block text-[12.5px] font-bold text-ink-600';

/** 마이페이지 > 내 정보 > 배송지 관리 (연락처·주소는 암호화 저장, 화면에는 일부만) */
export default async function MyAddressesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/my/addresses');
  const list = await prisma.memberAddress.findMany({ where: { userId: user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-1.5 text-[15px] font-black text-ink-900">
        <MapPin size={17} strokeWidth={2} /> 배송지 관리 <span className="text-[12px] font-bold text-ink-400">{list.length}/10</span>
      </h2>
      {list.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-warm-300 bg-white/70 px-4 py-6 text-center text-[13px] text-ink-500">저장된 배송지가 없어요. 주문할 때 저장하거나 아래에서 추가하세요.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((a) => (
            <li key={a.id} className="rounded-[1.25rem] border border-warm-300/70 bg-white p-4 shadow-card">
              <p className="text-[13.5px] font-extrabold text-ink-900">
                {a.label ?? '배송지'} {a.isDefault ? <span className="ml-1 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] text-brand-800">기본</span> : null}
              </p>
              <p className="mt-1 text-[13px] text-ink-600">
                {a.recipientMasked} · {a.phoneMasked}
              </p>
              <p className="text-[13px] text-ink-500">
                ({a.zipcode}) {a.addressMasked}
              </p>
              <div className="mt-2 flex gap-2">
                {!a.isDefault ? (
                  <ShopActionForm action={addressOpAction} hideMessage>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="op" value="default" />
                    <button className="rounded-full border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-600">기본으로</button>
                  </ShopActionForm>
                ) : null}
                <ShopActionForm action={addressOpAction} hideMessage confirm="이 배송지를 삭제할까요?">
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="op" value="delete" />
                  <button className="rounded-full px-3 py-1.5 text-[12px] font-bold text-ink-400">삭제</button>
                </ShopActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.length < 10 ? (
        <div className="rounded-[1.25rem] border border-warm-300/70 bg-white p-4 shadow-card">
          <p className="mb-3 text-[14px] font-extrabold text-ink-900">새 배송지 추가</p>
          <ShopActionForm action={saveAddressAction} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                배송지 이름
                <input name="label" maxLength={20} placeholder="집, 회사" className={input} />
              </label>
              <label className={label}>
                받는 분 *
                <input name="recipient" required maxLength={30} className={input} autoComplete="name" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                연락처 *
                <input name="phone" required inputMode="tel" className={input} autoComplete="tel" />
              </label>
              <label className={label}>
                우편번호 *
                <input name="zipcode" required inputMode="numeric" maxLength={5} pattern="\d{5}" className={input} autoComplete="postal-code" />
              </label>
            </div>
            <label className={label}>
              주소 *
              <input name="address1" required maxLength={200} className={input} autoComplete="address-line1" />
            </label>
            <label className={label}>
              상세 주소
              <input name="address2" maxLength={100} className={input} autoComplete="address-line2" />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-ink-700">
              <input type="checkbox" name="isDefault" /> 기본 배송지로
            </label>
            <button className="w-full rounded-xl bg-ink-900 py-3 text-[14px] font-extrabold text-white">저장</button>
          </ShopActionForm>
        </div>
      ) : null}
    </div>
  );
}
