'use client';

import * as React from 'react';
import { Field, Input } from '@/components/ui';
import { formatWon } from '@/lib/money';
import { calculateWithholding } from '@/lib/withholding';

/**
 * 정산 요청 금액 입력 + 원천징수 미리보기.
 *
 * 왜 클라이언트 컴포넌트인가
 *   기존 화면은 원천징수/실지급 예상을 **정산 가능금 전액 기준**으로 한 번 계산해 고정 표시했다.
 *   그런데 요청 금액은 크리에이터가 직접 입력한다. 가능금 1,000,000원 중 50,000원만 요청하면
 *   화면은 "원천징수 33,000원 / 실지급 967,000원" 을 보여 주는데 실제 기록은
 *   "원천징수 0원(소액부징수) / 실지급 50,000원" 이 된다. 숫자가 통째로 어긋난다.
 *   입력한 금액에 맞춰 그 자리에서 다시 계산해 보여 준다.
 *
 * 계산은 서버 확정 로직과 **같은 함수**(`@/lib/withholding`)를 쓴다. 규칙을 두 벌로 두지 않는다.
 */
export function SettlementAmountField({
  available,
  minAmount,
}: {
  available: string;
  /** 최소 요청 금액(원, 문자열). '0' 이면 하한 없음. */
  minAmount: string;
}) {
  const availableWon = BigInt(available);
  const minWon = BigInt(minAmount);
  const [raw, setRaw] = React.useState(available);

  const parsed = React.useMemo(() => {
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return null;
    try {
      return BigInt(digits);
    } catch {
      return null;
    }
  }, [raw]);

  const over = parsed != null && parsed > availableWon;
  const under = parsed != null && parsed > 0n && minWon > 0n && parsed < minWon;
  const valid = parsed != null && parsed > 0n && !over && !under;
  const target = valid ? parsed : 0n;
  const wh = calculateWithholding(target);

  return (
    <>
      <Field
        label="요청 금액 (원)"
        hint={
          minWon > 0n
            ? `${formatWon(minWon)} 이상, 정산 가능금 ${formatWon(availableWon)} 이하로 입력해 주세요.`
            : `정산 가능금 ${formatWon(availableWon)} 이하로 입력해 주세요.`
        }
        error={
          over
            ? '정산 가능금보다 큰 금액은 요청할 수 없습니다.'
            : under
              ? `최소 정산 요청 금액은 ${formatWon(minWon)}입니다.`
              : parsed != null && parsed <= 0n
                ? '0원보다 큰 금액을 입력해 주세요.'
                : undefined
        }
      >
        <Input
          name="amount"
          inputMode="numeric"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="tabular-nums"
        />
      </Field>

      <div className="-mt-1 rounded-2xl border border-ink-100 bg-ink-50/60 px-4 py-3">
        <p className="text-[12px] font-extrabold text-ink-900">이 금액으로 요청하면</p>
        <dl className="mt-2 space-y-1.5">
          <PreviewRow label="소득세 (3%)" value={formatWon(wh.incomeTax)} />
          <PreviewRow label="지방소득세 (소득세의 10%)" value={formatWon(wh.localTax)} />
          <PreviewRow
            label="원천징수 합계"
            value={wh.exempt ? '0원 (소액부징수)' : formatWon(wh.total)}
          />
          <PreviewRow label="실지급 예상" value={formatWon(target - wh.total)} strong />
        </dl>
        {!valid ? (
          <p className="mt-2 text-[11.5px] text-ink-400">
            요청 금액을 입력하면 그 금액 기준으로 다시 계산합니다.
          </p>
        ) : null}
      </div>
    </>
  );
}

function PreviewRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12.5px] text-ink-500">{label}</dt>
      <dd
        className={
          strong
            ? 'text-[14px] font-extrabold tabular-nums text-ink-900'
            : 'text-[13px] font-semibold tabular-nums text-ink-700'
        }
      >
        {value}
      </dd>
    </div>
  );
}
