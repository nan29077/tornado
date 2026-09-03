import { redirect } from 'next/navigation';
import type { DonationStatus } from '@/generated/prisma/enums';

/** 결제가 실제로 승인된(=매출로 잡히는) 후원 상태 */
export const PAID_DONATION_STATUSES: DonationStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

export const PAGE_SIZE = 25;

export function parsePage(raw?: string): number {
  const n = Number.parseInt(raw ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 요청한 페이지 번호가 마지막 페이지를 넘으면 마지막 페이지로 보낸다.
 *
 * 5페이지를 보다가 필터를 걸면 결과가 1페이지로 줄어드는데 URL 의 `page=5` 는 그대로 남는다.
 * 그러면 조건에 맞는 건이 분명히 있는데도 "조건에 맞는 항목이 없습니다" 가 뜬다.
 * 관리자는 필터가 잘못됐다고 판단해 조건을 지우고 처음부터 다시 찾게 된다.
 *
 * 결과가 0건일 때(lastPage = 1, total = 0)는 진짜 빈 화면이므로 그대로 둔다.
 */
export function clampPageOrRedirect(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
  lastPage: number,
  total: number,
  pageParam = 'page',
): void {
  if (total <= 0 || page <= lastPage) return;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && k !== pageParam) qs.set(k, v);
  }
  qs.set(pageParam, String(lastPage));
  redirect(`${basePath}?${qs.toString()}`);
}
