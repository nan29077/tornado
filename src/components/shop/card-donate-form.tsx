'use client';

import * as React from 'react';
import { CreditCard } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { donateCardAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';

/**
 * 도네이도 샵 [후원하기] 탭 · 신용카드 후원 (2026-11-17).
 * PG 결제(지금은 테스트 결제). 결제가 승인된 후원만 방송 오버레이 · 유튜브 채팅 · 샵 실시간 후원에 표시된다.
 */
export function CardDonateForm({
  creatorId,
  creatorName,
  presets,
  minAmount,
  maxAmount,
  defaultNickname,
  paymentMock,
  limitNote,
}: {
  creatorId: string;
  creatorName: string;
  presets: string[];
  minAmount: string;
  maxAmount: string;
  defaultNickname: string;
  paymentMock: boolean;
  /** 후원 한도 안내 (하루·크리에이터별) */
  limitNote?: string;
}) {
  const [amount, setAmount] = React.useState(presets[1] ?? presets[0] ?? minAmount);
  return (
    <section className="rounded-[1.5rem] border border-brand-200 bg-brand-50/70 p-4 text-left">
      <p className="flex items-center gap-1.5 text-[14px] font-extrabold text-ink-900">
        <CreditCard size={17} strokeWidth={1.9} className="text-brand-700" />
        신용카드로 {creatorName} 님에게 후원
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
        결제가 끝난 후원은 방송 오버레이와 유튜브 라이브 채팅, 샵 실시간 후원에 표시됩니다.
      </p>
      <ShopActionForm action={donateCardAction} className="mt-3 space-y-2.5">
        {(pending) => (
          <>
            <input type="hidden" name="creatorId" value={creatorId} />
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  className={cx('h-9 rounded-xl px-3 text-[13px] font-extrabold', amount === p ? 'bg-ink-900 text-white' : 'border border-warm-300 bg-white text-ink-800')}
                >
                  {Number(p).toLocaleString('ko-KR')}원
                </button>
              ))}
            </div>
            <input
              name="amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
              className="h-11 w-full rounded-xl border border-warm-300 bg-white px-3 text-[15px] font-extrabold text-ink-900"
              aria-label="후원 금액(원)"
            />
            <p className="text-[11.5px] text-ink-400">
              {Number(minAmount).toLocaleString('ko-KR')}원 ~ {Number(maxAmount).toLocaleString('ko-KR')}원
              {limitNote ? <span className="block">{limitNote}</span> : null}
            </p>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input name="nickname" maxLength={20} defaultValue={defaultNickname} placeholder="방송에 표시할 이름" className="h-11 rounded-xl border border-warm-300 bg-white px-3 text-[14px]" aria-label="닉네임" />
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-600">
                <input type="checkbox" name="anonymous" />
                익명
              </label>
            </div>
            <textarea name="message" rows={2} maxLength={200} placeholder="응원 메시지 (방송에 표시돼요)" className="w-full rounded-xl border border-warm-300 bg-white px-3 py-2 text-[14px]" aria-label="응원 메시지" />
            <button type="submit" disabled={pending} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] disabled:opacity-50">
              <CreditCard size={17} strokeWidth={1.8} />
              {pending ? '결제 중' : `${Number(amount || 0).toLocaleString('ko-KR')}원 카드로 후원하기`}
            </button>
            {paymentMock ? (
              <p className="text-center text-[11.5px] font-semibold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않습니다. (PG 계약 후 실제 카드 결제창으로 바뀝니다)</p>
            ) : null}
          </>
        )}
      </ShopActionForm>
    </section>
  );
}
