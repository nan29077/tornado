'use client';

import * as React from 'react';
import { confirmOrderAction, requestClaimAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';

/** 구매자 주문 동작: 구매 확정 / 취소 요청 / 반품 요청 */
export function OrderActions({ orderId, status, hasOpenClaim }: { orderId: string; status: string; hasOpenClaim: boolean }) {
  const [claim, setClaim] = React.useState<null | 'CANCEL' | 'RETURN'>(null);
  if (hasOpenClaim) return <p className="text-[12px] font-semibold text-warning-600">취소·반품 요청을 처리하고 있어요.</p>;
  const canCancel = status === 'PAID' || status === 'PREPARING';
  const canReturn = status === 'SHIPPED' || status === 'DELIVERED';
  const canConfirm = canReturn;
  if (!canCancel && !canReturn) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {canConfirm ? (
          <ShopActionForm action={confirmOrderAction} confirm="구매를 확정할까요? 확정 후에는 반품을 신청할 수 없습니다.">
            {(pending) => (
              <>
                <input type="hidden" name="orderId" value={orderId} />
                <button type="submit" disabled={pending} className="h-9 rounded-xl bg-ink-900 px-3.5 text-[12.5px] font-extrabold text-white disabled:opacity-50">
                  구매 확정
                </button>
              </>
            )}
          </ShopActionForm>
        ) : null}
        {canCancel ? (
          <button type="button" onClick={() => setClaim(claim === 'CANCEL' ? null : 'CANCEL')} className="h-9 rounded-xl border border-ink-200 bg-white px-3.5 text-[12.5px] font-bold text-ink-700">
            주문 취소
          </button>
        ) : null}
        {canReturn ? (
          <button type="button" onClick={() => setClaim(claim === 'RETURN' ? null : 'RETURN')} className="h-9 rounded-xl border border-ink-200 bg-white px-3.5 text-[12.5px] font-bold text-ink-700">
            반품 신청
          </button>
        ) : null}
      </div>
      {claim ? (
        <ShopActionForm action={requestClaimAction} className="rounded-xl bg-warm-50 p-3">
          {(pending) => (
            <>
              <input type="hidden" name="orderId" value={orderId} />
              <input type="hidden" name="type" value={claim} />
              <textarea name="reason" required minLength={2} maxLength={300} rows={2} placeholder={claim === 'CANCEL' ? '취소 사유' : '반품 사유 (예: 상품 파손)'} className="w-full rounded-lg border border-warm-300 bg-white px-3 py-2 text-[13px]" aria-label="사유" />
              <p className="mt-1 text-[11.5px] text-ink-400">
                {claim === 'CANCEL' && status === 'PAID' ? '아직 상품 준비 전이라 바로 취소·환불됩니다.' : '판매자 확인 후 환불됩니다.'}
              </p>
              <button type="submit" disabled={pending} className="mt-2 h-9 rounded-xl bg-danger-500 px-3.5 text-[12.5px] font-extrabold text-white disabled:opacity-50">
                {claim === 'CANCEL' ? '취소 요청' : '반품 신청'}
              </button>
            </>
          )}
        </ShopActionForm>
      ) : null}
    </div>
  );
}
