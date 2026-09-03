import type { DonationStatus } from '@/generated/prisma/enums';

/**
 * 크리에이터 관리자 공용 상수/헬퍼.
 * (공용 lib 을 수정하지 않기 위해 studio 전용으로 분리한다)
 */

/** 결제가 승인되어 정산 대상이 되는 후원 상태 */
export const PAID_STATUSES: DonationStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

/**
 * **표시용** 집계에 쓰는 상태 집합.
 *
 * `PAID_STATUSES` 는 "돈이 들어온 상태"라서 환불 요청 중(REFUND_REQUESTED)을 뺀다. 그런데
 * 화면 숫자에까지 그대로 쓰면, 후원자가 환불을 **요청만** 해도(승인 전) 오늘 후원금이 줄었다가
 * 관리자가 반려하면 다시 늘어난다. 원장 기반 카드와 반대로 움직여 크리에이터를 혼란스럽게 한다.
 * 환불이 실제로 확정될 때까지는 집계에 남긴다.
 */
export const DISPLAY_PAID_STATUSES: DonationStatus[] = [...PAID_STATUSES, 'REFUND_REQUESTED'];

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

export function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** 쿼리스트링을 유지하면서 일부 값만 바꾼다 */
export function buildQuery(base: Record<string, string>, patch: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v) sp.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') sp.delete(k);
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
