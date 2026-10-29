import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-29 4차 점검 — 카카오페이(PAY-3) · 온기(PAY-4) 어댑터 회귀 테스트.
 * 실제 통신은 하지 않는다. fetch 를 대체해 요청 본문과 응답 해석만 본다.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Call = { url: string; body: Record<string, unknown> };

function stubFetch(responses: Array<{ status: number; json: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return Promise.resolve({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: () => Promise.resolve(JSON.stringify(r.json)),
      });
    }),
  );
  return calls;
}

async function loadKakao() {
  vi.stubEnv('KAKAO_SECRET_KEY', 'test-secret');
  vi.stubEnv('KAKAO_CID', 'TCSUBSCRIP');
  vi.resetModules();
  return import('@/server/adapters/payment/kakao');
}

const approveReq = { orderNo: 'ORD-1', amount: 5000n, billKey: 'SID-1', productName: '후원', buyerName: '닉네임' };

describe('PAY-3 카카오페이', () => {
  it('(a) 빌키 발급과 승인의 partner_user_id 가 같은 고정 후원자 ID 다(닉네임 아님)', async () => {
    const mod = await loadKakao();
    const calls = stubFetch([
      { status: 200, json: { tid: 'T-REG', next_redirect_pc_url: 'https://kakao/redirect' } },
      { status: 200, json: { sid: 'SID-1' } },
      { status: 200, json: { tid: 'T-PAY', aid: 'A-1' } },
    ]);
    await mod.kakaoPaymentAdapter.createRegistrationSession({
      donorRef: 'REG-1', returnUrl: 'https://x/r', notifyUrl: 'https://x/n', donorId: 'DONOR-1',
    });
    await mod.kakaoPaymentAdapter.completeRegistration({ pg_token: 'PG', tid: 'T-REG', registrationId: 'REG-1', donorId: 'DONOR-1' });
    await mod.kakaoPaymentAdapter.approve({ ...approveReq, partnerUserId: 'DONOR-1' });
    expect(calls.map((c) => c.body.partner_user_id)).toEqual(['DONOR-1', 'DONOR-1', 'DONOR-1']);
  });

  it('(a) 고정 후원자 ID 가 없으면 승인 요청을 보내지 않는다', async () => {
    const mod = await loadKakao();
    const calls = stubFetch([{ status: 200, json: { tid: 'T-PAY' } }]);
    const r = await mod.kakaoPaymentAdapter.approve(approveReq);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_PARTNER_USER_ID');
    expect(calls).toHaveLength(0);
  });

  it('(b) HTTP 5xx 는 error_code 가 있어도 실패로 단정하지 않고 예외로 올린다', async () => {
    const mod = await loadKakao();
    stubFetch([{ status: 500, json: { error_code: -780, error_message: 'internal' } }]);
    await expect(mod.kakaoPaymentAdapter.approve({ ...approveReq, partnerUserId: 'DONOR-1' })).rejects.toThrow(/HTTP/);
  });

  it('(b) 4xx + error_code 는 확정 실패로 돌려준다', async () => {
    const mod = await loadKakao();
    stubFetch([{ status: 400, json: { error_code: -797, error_message: '한도 초과' } }]);
    const r = await mod.kakaoPaymentAdapter.approve({ ...approveReq, partnerUserId: 'DONOR-1' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('-797');
  });

  it('(c) 승인 응답의 tid 를 providerTid 로 돌려주고, 조회는 그 tid 로 한다', async () => {
    const mod = await loadKakao();
    const calls = stubFetch([
      { status: 200, json: { tid: 'T-PAY', aid: 'A-1' } },
      { status: 200, json: { tid: 'T-PAY', status: 'SUCCESS_PAYMENT', amount: { total: 5000, tax_free: 0, vat: 455 } } },
    ]);
    const ap = await mod.kakaoPaymentAdapter.approve({ ...approveReq, partnerUserId: 'DONOR-1' });
    expect(ap.data?.providerTid).toBe('T-PAY');
    const inq = await mod.kakaoPaymentAdapter.inquire('ORD-1', { providerTid: ap.data!.providerTid });
    expect(calls[1].body.tid).toBe('T-PAY');
    expect(inq.data?.status).toBe('APPROVED');
    // (d) amount 객체에서 total 을 꺼낸다.
    expect(inq.data?.amount).toBe(5000n);
  });

  it('(c) tid 가 없으면 우리 주문번호로 조회하지 않고 실패(→ 미확인)로 돌려준다', async () => {
    const mod = await loadKakao();
    const calls = stubFetch([{ status: 200, json: { status: 'SUCCESS_PAYMENT' } }]);
    const inq = await mod.kakaoPaymentAdapter.inquire('ORD-1');
    expect(inq.ok).toBe(false);
    expect(inq.code).toBe('NO_PROVIDER_TID');
    expect(calls).toHaveLength(0);
  });
});

async function loadOngi() {
  vi.stubEnv('ONGI_API_KEY', 'test-api-key');
  vi.stubEnv('ONGI_API_BASE', 'https://api.ongi.invalid');
  vi.resetModules();
  const mod = await import('@/server/adapters/payment/ongi');
  // 규격 수령 전이라 경로가 비어 있다. 테스트에서만 임시 경로를 채운다.
  const spec = mod.ONGI_SPEC as unknown as Record<string, string>;
  spec.paymentInquirePath = '/payment/inquiry';
  spec.paymentCancelPath = '/payment/cancel';
  return mod;
}

describe('PAY-4 온기', () => {
  const req = { orderNo: 'ORD-TXN-1', amount: 3000n, billKey: '', productName: '후원', donationId: 'DON-1' };

  it('승인·조회·취소는 결제 URL 을 만든 후원 ID 로 요청한다', async () => {
    const mod = await loadOngi();
    const calls = stubFetch([
      { status: 200, json: { status: 'PAID', amount: 3000, paymentId: 'P-1' } },
      { status: 200, json: { status: 'PAID', amount: 3000, paymentId: 'P-1' } },
      { status: 200, json: {} },
    ]);
    const ap = await mod.ongiPaymentAdapter.approve(req);
    expect(ap.ok).toBe(true);
    await mod.ongiPaymentAdapter.inquire('ORD-TXN-1', { donationId: 'DON-1' });
    await mod.ongiPaymentAdapter.cancel({ orderNo: 'ORD-TXN-1', providerTid: 'P-1', amount: 3000n, donationId: 'DON-1' });
    expect(calls.map((c) => c.body.orderNo)).toEqual(['DON-1', 'DON-1', 'DON-1']);
  });

  it('상태 값이 비어 있으면 승인으로 보지 않는다(불확실 → 예외)', async () => {
    const mod = await loadOngi();
    stubFetch([{ status: 200, json: { amount: 3000 } }]);
    await expect(mod.ongiPaymentAdapter.approve(req)).rejects.toThrow(/확정할 수 없습니다/);
  });

  it('실패가 명시되면 확정 실패를 돌려준다', async () => {
    const mod = await loadOngi();
    stubFetch([{ status: 200, json: { status: 'FAILED' } }]);
    const r = await mod.ongiPaymentAdapter.approve(req);
    expect(r.ok).toBe(false);
  });

  it('승인 금액이 요청 금액과 다르면(또는 없으면) 승인으로 확정하지 않는다', async () => {
    const mod = await loadOngi();
    stubFetch([{ status: 200, json: { status: 'PAID', amount: 30000 } }]);
    await expect(mod.ongiPaymentAdapter.approve(req)).rejects.toThrow(/금액/);
    stubFetch([{ status: 200, json: { status: 'PAID' } }]);
    await expect(mod.ongiPaymentAdapter.approve(req)).rejects.toThrow(/금액/);
  });
});
