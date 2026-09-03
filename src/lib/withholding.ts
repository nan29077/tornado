import { applyRate } from '@/lib/money';

/**
 * 사업소득 원천징수 계산 — **순수 함수만** 모아 둔다.
 *
 * 왜 `src/lib` 에 있나
 *   같은 계산을 서버(정산 요청 확정)와 브라우저(요청 금액 입력 중 미리보기)가 함께 써야 한다.
 *   `src/server/services/settlement.ts` 는 최상단에서 prisma 를 import 하므로 클라이언트
 *   컴포넌트가 가져다 쓸 수 없다. 계산 규칙이 두 벌로 갈라지면 화면에 보이는 실지급액과
 *   실제 기록되는 금액이 어긋나므로, 규칙은 여기 한 곳에만 둔다.
 *   `settlement.ts` 는 이 파일을 re-export 하여 기존 import 경로를 유지한다.
 */

/** 원천징수율 3.3% (사업소득 기준) — 화면 안내·미리보기 표기에만 쓰는 합계 표시율. */
export const WITHHOLDING_RATE = 0.033;

/** 사업소득 원천징수 소득세율 3% */
export const INCOME_TAX_RATE = 0.03;
/** 지방소득세율 = 소득세액의 10% */
export const LOCAL_TAX_RATE = 0.1;
/**
 * 소액부징수 기준(소득세법 제86조). 산출된 소득세가 이 금액 미만이면 징수하지 않는다.
 * 사업소득 3% 기준으로 지급액 약 33,333원 미만이 여기 해당한다.
 */
export const SMALL_AMOUNT_EXEMPTION = 1_000n;

/** 국고금관리법 제47조 — 10원 미만 단수 절사 */
function truncateTo10Won(v: bigint): bigint {
  return (v / 10n) * 10n;
}

export interface WithholdingBreakdown {
  /** 소득세 (3%, 10원 미만 절사) */
  incomeTax: bigint;
  /** 지방소득세 (소득세의 10%, 10원 미만 절사) */
  localTax: bigint;
  /** 원천징수 합계 = 소득세 + 지방소득세 */
  total: bigint;
  /** 소액부징수로 전액 미징수된 경우 true */
  exempt: boolean;
}

/**
 * 사업소득 원천징수액 계산 (국내 일반 실무 방식).
 *
 * 3.3% 를 한 번에 곱해 절사하면 국세청 지급명세서 검증에서 어긋난다.
 * 실제 신고는 소득세와 지방소득세를 **각각 따로 산출하고 각각 절사**한다.
 *
 *   1) 소득세      = 지급액 × 3%        → 10원 미만 절사
 *   2) 지방소득세  = 소득세 × 10%       → 10원 미만 절사
 *   3) 합계        = 소득세 + 지방소득세
 *   4) 소액부징수  : 소득세가 1,000원 미만이면 소득세·지방소득세 모두 미징수
 *
 * 예) 지급액 333,333원
 *     - 소득세     333,333 × 3% = 9,999.99 → 9,990원
 *     - 지방소득세 9,990 × 10%  = 999      → 990원
 *     - 합계 10,980원  (3.3% 단일 절사 시 10,999원 — 19원 차이)
 *
 * 예) 지급액 33,333원 이하
 *     - 소득세가 1,000원 미만이므로 **소액부징수**, 원천징수 0원
 *     - 즉 33,334원 미만 정산은 전액 지급된다
 *
 * 최종 세액 확정은 세무 자문을 거치는 것을 권장한다.
 */
export function calculateWithholding(amount: bigint): WithholdingBreakdown {
  if (amount <= 0n) return { incomeTax: 0n, localTax: 0n, total: 0n, exempt: false };

  const rawIncomeTax = applyRate(amount, INCOME_TAX_RATE);
  const incomeTax = truncateTo10Won(rawIncomeTax);

  // 소액부징수: 산출 소득세가 1,000원 미만이면 지방소득세까지 함께 미징수한다.
  if (incomeTax < SMALL_AMOUNT_EXEMPTION) {
    return { incomeTax: 0n, localTax: 0n, total: 0n, exempt: true };
  }

  const localTax = truncateTo10Won(applyRate(incomeTax, LOCAL_TAX_RATE));
  return { incomeTax, localTax, total: incomeTax + localTax, exempt: false };
}
