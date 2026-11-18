'use client';

import * as React from 'react';
import { AlertTriangle } from '@/components/brand/icons';
import { Button, Card, Input, Notice } from '@/components/ui';
import { withdrawAccount, type DonorActionState } from '@/app/actions/donor';

const initial: DonorActionState = { ok: false };

/**
 * 회원 탈퇴.
 * 실수로 누르는 것을 막기 위해 두 단계(열기 → 확인 문구 입력)로 진행한다.
 */
export function WithdrawForm({ blockers = [], paidTickets = 0, activeSubs = 0 }: { blockers?: string[]; paidTickets?: number; activeSubs?: number }) {
  const [state, formAction, pending] = React.useActionState(withdrawAccount, initial);
  const [open, setOpen] = React.useState(false);
  const forfeit = paidTickets > 0 || activeSubs > 0;

  return (
    <Card className="border-danger-500/25">
      <div className="flex gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger-50 text-danger-600">
          <AlertTriangle size={18} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold text-ink-900">회원 탈퇴</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
            탈퇴하면 계정 정보가 삭제되고 다시 로그인할 수 없습니다. 등록된 자동출금 수단은 즉시 해지되어 이후
            문자후원이 접수되지 않습니다. 배송지·장바구니·찜·팔로우와 남은 투표권도 함께 삭제됩니다. 다만 이미 발생한 결제·정산 기록은 관계 법령에 따라 보관됩니다.
          </p>

          {blockers.length > 0 ? (
            <div className="mt-3">
              <Notice tone="warning" title="지금은 탈퇴할 수 없습니다">
                {blockers.map((b) => (
                  <span key={b} className="block">{b}</span>
                ))}
              </Notice>
            </div>
          ) : !open ? (
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
              회원 탈퇴 진행
            </Button>
          ) : (
            <form action={formAction} className="mt-3 space-y-2.5">
              <p className="text-[12.5px] font-semibold text-ink-700">
                확인을 위해 <span className="font-mono text-danger-600">탈퇴합니다</span> 를 입력해 주세요.
              </p>
              <Input name="confirm" placeholder="탈퇴합니다" autoComplete="off" required />
              {forfeit ? (
                <label className="flex items-start gap-2 rounded-xl bg-danger-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-800">
                  <input type="checkbox" name="forfeit" className="mt-0.5 shrink-0" required />
                  <span>
                    {[paidTickets > 0 ? `남은 유료 투표권 ${paidTickets.toLocaleString('ko-KR')}장` : '', activeSubs > 0 ? `이용 중인 소통 구독 ${activeSubs}건` : ''].filter(Boolean).join(', ')}
                    이(가) 환불 없이 사라지는 것에 동의합니다. 환불을 원하면 탈퇴 전에 고객센터로 먼저 문의해 주세요.
                  </span>
                </label>
              ) : null}
              {state.message ? <Notice tone="danger">{state.message}</Notice> : null}
              <div className="flex gap-2">
                <Button type="submit" variant="danger" size="sm" disabled={pending}>
                  {pending ? '처리 중' : '탈퇴하기'}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                  취소
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}
