/**
 * 도네이도 샵 결제 어댑터 (2026-11-17).
 *
 * PG 계약 전이므로 mock 만 있다. CLAUDE.md 규칙 2: 실제 계약이 없는 외부 연동을 성공 처리하지 않는다 —
 * 화면에는 항상 "테스트 결제"로 표시하고(isShopPaymentMock), 알 수 없는 사업자는 예외를 던진다.
 *
 * mock 시나리오(기존 결제 mock 과 같은 규칙): 금액 끝자리 999 = 승인 실패
 *
 * [6차 P1-1] off 모드: 실 PG 계약 전에 운영을 먼저 열 수 있게 한다. 유료 결제(샵 주문·영상/카드 후원·
 * 투표권 구매·소통 구독·1:1 채팅)는 화면에서 "준비 중"으로 닫히고, 서비스도 결제 행을 만들기 전에 거절한다.
 * 문자 후원·무료 투표권·무료 기능은 그대로 동작한다.
 */
export interface ShopPaymentAdapter {
  readonly provider: string;
  /** 결제 승인. paymentNo 는 멱등키 (같은 번호로 다시 불러도 한 번만 승인) */
  approve(input: { paymentNo: string; amount: bigint; buyerName: string; itemName: string }): Promise<
    { ok: true; providerTx: string } | { ok: false; reason: string }
  >;
  /** 전액/부분 취소 */
  cancel(input: { paymentNo: string; providerTx: string | null; amount: bigint; reason: string }): Promise<
    { ok: true } | { ok: false; reason: string }
  >;
}

const approved = new Map<string, string>();

const mockAdapter: ShopPaymentAdapter = {
  provider: 'mock',
  async approve({ paymentNo, amount }) {
    const prev = approved.get(paymentNo);
    if (prev) return { ok: true, providerTx: prev };
    if (amount % 1000n === 999n) return { ok: false, reason: '테스트 결제 승인 실패 (금액 끝자리 999)' };
    const tx = `MOCK-${paymentNo}`;
    approved.set(paymentNo, tx);
    return { ok: true, providerTx: tx };
  },
  async cancel() {
    return { ok: true };
  },
};

export const SHOP_PAYMENT_OFF_MESSAGE = '카드·간편결제는 준비 중입니다. 곧 이용하실 수 있어요.';

/** 결제를 받지 않는 어댑터 — 승인도 취소도 성공 처리하지 않는다. */
const offAdapter: ShopPaymentAdapter = {
  provider: 'off',
  async approve() {
    return { ok: false, reason: SHOP_PAYMENT_OFF_MESSAGE };
  },
  async cancel() {
    return { ok: false, reason: '결제 연동 전이라 결제사 취소를 진행할 수 없습니다.' };
  },
};

export function shopPaymentProvider(): string {
  return (process.env.SHOP_PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock';
}

export function isShopPaymentMock(): boolean {
  return shopPaymentProvider() === 'mock';
}

/** 유료 결제를 닫아 둔 상태(off)인가 */
export function isShopPaymentOff(): boolean {
  return shopPaymentProvider() === 'off';
}

/** 결제를 받을 수 없으면 안내 문구를, 받을 수 있으면 null 을 돌려준다. 결제 행을 만들기 전에 확인한다. */
export function shopPaymentClosedMessage(): string | null {
  return isShopPaymentOff() ? SHOP_PAYMENT_OFF_MESSAGE : null;
}

export function getShopPaymentAdapter(): ShopPaymentAdapter {
  const p = shopPaymentProvider();
  if (p === 'mock') return mockAdapter;
  if (p === 'off') return offAdapter;
  // 미구현 사업자를 mock 으로 조용히 대체하지 않는다.
  throw new Error(`도네이도 샵 결제 사업자 '${p}' 는 아직 연동되지 않았습니다.`);
}
