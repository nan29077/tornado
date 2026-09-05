import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ONGI_SPEC,
  ongiPaymentAdapter,
  ongiWebhookSignature,
  verifyOngiWebhook,
} from '@/server/adapters/payment/ongi';
import {
  KOEM_SPEC,
  koemApproveHash,
  koemCancelHash,
  koemDate,
  koemPaymentAdapter,
  koemRegisterBillKey,
  koemRegisterHash,
  koemTime,
  koemUnregisterHash,
} from '@/server/adapters/payment/koem';
import { kakaoPaymentAdapter, KAKAO_SPEC } from '@/server/adapters/payment/kakao';
import { hectoPaymentAdapter } from '@/server/adapters/payment/hecto';
import { AdapterNotConfiguredError } from '@/server/adapters/types';

/**
 * 온기(REST) · 코엠(카드 빌키) 어댑터 검증.
 *
 * 계약/키가 없는 상태이므로 실제 통신은 하지 않는다.
 * 서명 공식과 fail-closed 동작, 그리고 "규격 미수령 기능을 성공으로 위장하지 않는지"를 본다.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ===========================================================================
// 온기
// ===========================================================================

describe('온기 - 결제 노티 웹훅 서명', () => {
  const secret = 'ongi-webhook-secret';

  it('서명은 sha256=HMAC-SHA256(secret, `${timestamp}.${rawBody}`) 이다', () => {
    const ts = '1757030400';
    const body = '{"orderNo":"ORD-1","status":"PAID"}';
    const got = ongiWebhookSignature(ts, body, secret);

    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(`${ts}.${body}`, 'utf8')
      .digest('hex')}`;
    expect(got).toBe(expected);
    expect(got).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('본문이 1바이트만 달라도 서명이 달라진다', () => {
    const ts = '1757030400';
    expect(ongiWebhookSignature(ts, '{"a":1}', secret)).not.toBe(
      ongiWebhookSignature(ts, '{"a":2}', secret),
    );
  });

  it('타임스탬프가 다르면 서명이 달라진다 (재생 공격 방어의 근거)', () => {
    const body = '{"a":1}';
    expect(ongiWebhookSignature('1757030400', body, secret)).not.toBe(
      ongiWebhookSignature('1757030401', body, secret),
    );
  });

  it('올바른 서명은 통과한다', () => {
    const now = new Date();
    const ts = String(Math.floor(now.getTime() / 1000));
    const body = '{"orderNo":"ORD-1"}';
    const r = verifyOngiWebhook({
      timestamp: ts,
      rawBody: body,
      signature: ongiWebhookSignature(ts, body, secret),
      secret,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it('밀리초 단위 타임스탬프도 허용한다', () => {
    const now = new Date();
    const ts = String(now.getTime());
    const body = '{"orderNo":"ORD-1"}';
    const r = verifyOngiWebhook({
      timestamp: ts,
      rawBody: body,
      signature: ongiWebhookSignature(ts, body, secret),
      secret,
      now,
    });
    expect(r.ok).toBe(true);
  });

  /**
   * 비밀이 없으면 "검증할 수 없음"이지 "통과"가 아니다.
   * 통과시키면 누구나 결제 완료 노티를 위조해 후원을 만들 수 있다.
   */
  it('비밀이 설정되지 않으면 검증을 실패시킨다 (fail-closed)', () => {
    const r = verifyOngiWebhook({
      timestamp: '1757030400',
      rawBody: '{}',
      signature: 'sha256=deadbeef',
      secret: '',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ONGI_WEBHOOK_SECRET');
  });

  it('서명·타임스탬프 헤더가 없으면 실패한다', () => {
    expect(verifyOngiWebhook({ timestamp: '1757030400', rawBody: '{}', signature: null, secret }).ok).toBe(false);
    expect(verifyOngiWebhook({ timestamp: null, rawBody: '{}', signature: 'sha256=x', secret }).ok).toBe(false);
  });

  it('서명이 틀리면 실패한다', () => {
    const now = new Date();
    const ts = String(Math.floor(now.getTime() / 1000));
    const r = verifyOngiWebhook({
      timestamp: ts,
      rawBody: '{"a":1}',
      // 본문이 다른 서명을 붙였다
      signature: ongiWebhookSignature(ts, '{"a":2}', secret),
      secret,
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('서명 불일치');
  });

  it('허용 시각을 벗어난 오래된 노티는 거절한다', () => {
    const now = new Date();
    const old = String(Math.floor(now.getTime() / 1000) - 3600);
    const body = '{"a":1}';
    const r = verifyOngiWebhook({
      timestamp: old,
      rawBody: body,
      signature: ongiWebhookSignature(old, body, secret),
      secret,
      toleranceSec: 300,
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('허용 범위');
  });

  it('길이가 다른 서명을 넣어도 예외 없이 실패로 처리한다', () => {
    const now = new Date();
    const ts = String(Math.floor(now.getTime() / 1000));
    expect(() =>
      verifyOngiWebhook({ timestamp: ts, rawBody: '{}', signature: 'short', secret, now }),
    ).not.toThrow();
    expect(verifyOngiWebhook({ timestamp: ts, rawBody: '{}', signature: 'short', secret, now }).ok).toBe(false);
  });
});

describe('온기 - 헥토 방식의 흔적이 남아 있지 않다', () => {
  it('AES/SHA256 서명 helper 를 내보내지 않는다', async () => {
    const mod = await import('@/server/adapters/payment/ongi');
    const removed = ['ongiEncrypt', 'ongiDecrypt', 'ongiApiSignature', 'ongiAuthWindowHash', 'ongiCallbackHost'];
    for (const name of removed) {
      expect(Object.hasOwn(mod, name)).toBe(false);
    }
  });

  it('SPEC 에 결제창(authWindow) 개념이 없다', () => {
    expect(Object.hasOwn(ONGI_SPEC, 'authWindowPath')).toBe(false);
    expect(Object.hasOwn(ONGI_SPEC, 'billKeyPath')).toBe(false);
    // 확인된 경로는 organization 하나뿐이다.
    expect(ONGI_SPEC.organizationPath).toBe('/api/external/integration/merchant/v1/organization');
  });

  it('결제 경로는 아직 비어 있다 (추정값을 넣지 않았다)', () => {
    expect(ONGI_SPEC.paymentCreatePath).toBe('');
    expect(ONGI_SPEC.paymentInquirePath).toBe('');
    expect(ONGI_SPEC.paymentCancelPath).toBe('');
  });
});

describe('온기 어댑터 - 설정 누락 시 fail-closed', () => {
  it('API 키가 없으면 예외를 던진다', async () => {
    const info = ongiPaymentAdapter.info();
    expect(info.provider).toBe('ongi');
    expect(info.missingCredentials).toContain('ONGI_API_KEY');
    expect(info.mode).toBe('mock');
    // 헥토 시절 변수가 섞여 들어가면 안 된다.
    expect(info.missingCredentials.some((m) => m.includes('HASH_KEY') || m.includes('AES_KEY'))).toBe(false);

    await expect(
      ongiPaymentAdapter.approve({ orderNo: 'ORD-1', amount: 3000n, billKey: 'BILL', productName: '문자후원' }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(ongiPaymentAdapter.inquire('ORD-1')).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(
      ongiPaymentAdapter.cancel({ orderNo: 'ORD-1', providerTid: 'T', amount: 3000n }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(ongiPaymentAdapter.revokeBillKey('BILL')).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(ongiPaymentAdapter.requestPinLink('DON-1', 3000n, '01012345678')).rejects.toBeInstanceOf(
      AdapterNotConfiguredError,
    );
  });
});

describe('온기 - 키가 있어도 경로 미수령 기능은 성공으로 위장하지 않는다', () => {
  async function loadConfiguredOngi() {
    const prev = { key: process.env.ONGI_API_KEY, base: process.env.ONGI_API_BASE };
    process.env.ONGI_API_KEY = 'test-api-key';
    process.env.ONGI_API_BASE = 'https://api.ongi.invalid';
    vi.resetModules();
    const mod = await import('@/server/adapters/payment/ongi');
    const restore = () => {
      if (prev.key === undefined) delete process.env.ONGI_API_KEY;
      else process.env.ONGI_API_KEY = prev.key;
      if (prev.base === undefined) delete process.env.ONGI_API_BASE;
      else process.env.ONGI_API_BASE = prev.base;
      vi.resetModules();
    };
    return { mod, restore };
  }

  it('결제 URL 경로가 없으면 통신하지 않고 ONGI_SPEC_PENDING 을 돌려준다', async () => {
    const { mod, restore } = await loadConfiguredOngi();
    try {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const r = await mod.ongiPaymentAdapter.requestPinLink('DON-1', 3000n, '01012345678');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('ONGI_SPEC_PENDING');
      expect(r.data).toBeUndefined();
      // 경로를 모르는 채 아무 데나 요청을 날리지 않는다.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('조회 경로가 없으면 FAILED 가 아니라 PENDING 으로 남긴다', async () => {
    const { mod, restore } = await loadConfiguredOngi();
    try {
      const r = await mod.ongiPaymentAdapter.inquire('ORD-1');
      // 상태를 모르는 채 FAILED 로 확정하면 결제된 건을 정산에서 누락시킨다.
      expect(r.data?.status).toBe('PENDING');
      expect(r.code).toBe('ONGI_SPEC_PENDING');
    } finally {
      restore();
    }
  });

  it('빌키 개념이 없으므로 해지는 사실대로 실패를 돌려준다', async () => {
    const { mod, restore } = await loadConfiguredOngi();
    try {
      const r = await mod.ongiPaymentAdapter.revokeBillKey('BILL');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('NO_BILLKEY');
    } finally {
      restore();
    }
  });

  /** 인증 구조가 실제로 헤더에 실리는지 확인한다. */
  it('모든 요청에 X-API-KEY 를 싣고, MID 가 있으면 X-API-MID 도 싣는다', async () => {
    const prev = {
      key: process.env.ONGI_API_KEY,
      base: process.env.ONGI_API_BASE,
      mid: process.env.ONGI_API_MID,
    };
    process.env.ONGI_API_KEY = 'test-api-key';
    process.env.ONGI_API_BASE = 'https://api.ongi.invalid';
    process.env.ONGI_API_MID = 'MID-123';
    vi.resetModules();
    try {
      const mod = await import('@/server/adapters/payment/ongi');
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      await mod.ongiPing();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://api.ongi.invalid${mod.ONGI_SPEC.organizationPath}`);
      const headers = init.headers as Record<string, string>;
      expect(headers['X-API-KEY']).toBe('test-api-key');
      expect(headers['X-API-MID']).toBe('MID-123');
      // 헥토식 서명/암호문을 본문에 싣지 않는다.
      expect(init.body).toBeUndefined();
    } finally {
      if (prev.key === undefined) delete process.env.ONGI_API_KEY;
      else process.env.ONGI_API_KEY = prev.key;
      if (prev.base === undefined) delete process.env.ONGI_API_BASE;
      else process.env.ONGI_API_BASE = prev.base;
      if (prev.mid === undefined) delete process.env.ONGI_API_MID;
      else process.env.ONGI_API_MID = prev.mid;
      vi.resetModules();
    }
  });

  it('MID 가 비어 있으면 X-API-MID 헤더를 아예 붙이지 않는다', async () => {
    const prev = {
      key: process.env.ONGI_API_KEY,
      base: process.env.ONGI_API_BASE,
      mid: process.env.ONGI_API_MID,
    };
    process.env.ONGI_API_KEY = 'test-api-key';
    process.env.ONGI_API_BASE = 'https://api.ongi.invalid';
    delete process.env.ONGI_API_MID;
    vi.resetModules();
    try {
      const mod = await import('@/server/adapters/payment/ongi');
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      await mod.ongiPing();

      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      // 빈 값을 보내면 식별 실패로 거절될 수 있다.
      expect('X-API-MID' in headers).toBe(false);
    } finally {
      if (prev.key === undefined) delete process.env.ONGI_API_KEY;
      else process.env.ONGI_API_KEY = prev.key;
      if (prev.base === undefined) delete process.env.ONGI_API_BASE;
      else process.env.ONGI_API_BASE = prev.base;
      if (prev.mid !== undefined) process.env.ONGI_API_MID = prev.mid;
      vi.resetModules();
    }
  });
});

// ===========================================================================
// 코엠
// ===========================================================================

/**
 * checkHash 는 동작마다 재료가 다르다. 하나라도 섞이면 인증 실패한다.
 * 각 공식을 독립 계산한 기대값과 대조하고, 서로 값이 겹치지 않는지도 확인한다.
 */
describe('코엠 - checkHash 4종 공식', () => {
  const apiKey = 'k'.repeat(64);
  const b64 = (msg: string) => crypto.createHmac('sha256', apiKey).update(msg, 'utf8').digest('base64');

  it('빌키 발급: mid + card_no + reqdt + reqtm', () => {
    const got = koemRegisterHash(
      { mid: 'M'.repeat(15), cardNo: '1234123412341234', reqdt: '20260905', reqtm: '153012' },
      apiKey,
    );
    expect(got).toBe(b64(`${'M'.repeat(15)}1234123412341234${'20260905'}153012`));
  });

  it('빌키 결제: mid + orderno + orderdt + ordertm + buy_reqamt + bill_key', () => {
    const got = koemApproveHash(
      {
        mid: 'M'.repeat(15),
        orderno: 'ORD-1',
        orderdt: '20260905',
        ordertm: '153012',
        buyReqamt: '3000',
        billKey: 'BILLKEY12345678',
      },
      apiKey,
    );
    expect(got).toBe(b64(`${'M'.repeat(15)}ORD-1202609051530123000BILLKEY12345678`));
  });

  it('빌키 취소: tid + mid + cancel_amt', () => {
    const got = koemCancelHash({ tid: 'TID-9', mid: 'M'.repeat(15), cancelAmt: '3000' }, apiKey);
    expect(got).toBe(b64(`TID-9${'M'.repeat(15)}3000`));
  });

  it('빌키 해지: mid + bill_key', () => {
    const got = koemUnregisterHash({ mid: 'M'.repeat(15), billKey: 'BILLKEY12345678' }, apiKey);
    expect(got).toBe(b64(`${'M'.repeat(15)}BILLKEY12345678`));
  });

  it('네 공식의 결과가 서로 다르다 (재료를 섞어 쓰지 않았다)', () => {
    const mid = 'M'.repeat(15);
    const hashes = [
      koemRegisterHash({ mid, cardNo: '1234123412341234', reqdt: '20260905', reqtm: '153012' }, apiKey),
      koemApproveHash(
        { mid, orderno: 'ORD-1', orderdt: '20260905', ordertm: '153012', buyReqamt: '3000', billKey: 'B1' },
        apiKey,
      ),
      koemCancelHash({ tid: 'TID-9', mid, cancelAmt: '3000' }, apiKey),
      koemUnregisterHash({ mid, billKey: 'B1' }, apiKey),
    ];
    expect(new Set(hashes).size).toBe(4);
  });

  it('전부 Base64 이며 hex 가 아니다', () => {
    const h = koemUnregisterHash({ mid: 'M', billKey: 'B' }, apiKey);
    expect(h).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(h).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('재료가 하나만 바뀌어도 값이 달라진다', () => {
    const base = {
      mid: 'M'.repeat(15),
      orderno: 'ORD-1',
      orderdt: '20260905',
      ordertm: '153012',
      buyReqamt: '3000',
      billKey: 'B1',
    };
    const sig = koemApproveHash(base, apiKey);
    expect(koemApproveHash({ ...base, orderno: 'ORD-2' }, apiKey)).not.toBe(sig);
    expect(koemApproveHash({ ...base, buyReqamt: '3001' }, apiKey)).not.toBe(sig);
    expect(koemApproveHash({ ...base, billKey: 'B2' }, apiKey)).not.toBe(sig);
  });

  it('키가 다르면 값이 달라진다', () => {
    const input = { mid: 'M', billKey: 'B' };
    expect(koemUnregisterHash(input, 'a'.repeat(64))).not.toBe(koemUnregisterHash(input, 'b'.repeat(64)));
  });

  it('KST 기준 날짜/시각을 만든다', () => {
    const at = new Date('2026-09-05T06:30:12.000Z');
    expect(koemDate(at)).toBe('20260905');
    expect(koemTime(at)).toBe('153012');
  });

  it('규격서 경로 4종이 모두 다르고 취소 pay_method 는 CC 다', () => {
    const paths = [
      KOEM_SPEC.billKeyRegisterPath,
      KOEM_SPEC.billKeyApprovePath,
      KOEM_SPEC.cancelPath,
      KOEM_SPEC.billKeyUnregisterPath,
    ];
    expect(new Set(paths).size).toBe(4);
    expect(KOEM_SPEC.cancelPayMethod).toBe('CC');
    expect(KOEM_SPEC.successCode).toBe('0000');
  });
});

describe('코엠 어댑터 - 설정 누락 시 fail-closed', () => {
  it('키가 없으면 예외를 던진다', async () => {
    const info = koemPaymentAdapter.info();
    expect(info.provider).toBe('koem');
    expect(info.missingCredentials).toEqual(
      expect.arrayContaining(['KOEM_MID', 'KOEM_API_KEY', 'KOEM_API_BASE']),
    );
    expect(info.mode).toBe('mock');

    await expect(
      koemPaymentAdapter.approve({ orderNo: 'ORD-1', amount: 3000n, billKey: 'BILL', productName: '문자후원' }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(koemPaymentAdapter.inquire('ORD-1')).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(
      koemPaymentAdapter.cancel({ orderNo: 'ORD-1', providerTid: 'T', amount: 3000n }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(koemPaymentAdapter.revokeBillKey('BILL')).rejects.toBeInstanceOf(AdapterNotConfiguredError);
    await expect(
      koemRegisterBillKey({ cardNo: '1234123412341234', cardYm: '2812', buyerNm: '홍길동' }),
    ).rejects.toBeInstanceOf(AdapterNotConfiguredError);
  });
});

describe('코엠 - 요청 본문과 서명 필드명', () => {
  async function loadConfiguredKoem() {
    const prev = {
      mid: process.env.KOEM_MID,
      key: process.env.KOEM_API_KEY,
      base: process.env.KOEM_API_BASE,
    };
    process.env.KOEM_MID = 'M'.repeat(15);
    process.env.KOEM_API_KEY = 'k'.repeat(64);
    process.env.KOEM_API_BASE = 'https://paycc.example.invalid';
    vi.resetModules();
    const mod = await import('@/server/adapters/payment/koem');
    const restore = () => {
      if (prev.mid === undefined) delete process.env.KOEM_MID;
      else process.env.KOEM_MID = prev.mid;
      if (prev.key === undefined) delete process.env.KOEM_API_KEY;
      else process.env.KOEM_API_KEY = prev.key;
      if (prev.base === undefined) delete process.env.KOEM_API_BASE;
      else process.env.KOEM_API_BASE = prev.base;
      vi.resetModules();
    };
    return { mod, restore };
  }

  /** 성공 응답을 흉내내는 fetch 스텁. 보낸 본문을 꺼내 볼 수 있게 기록한다. */
  function stubFetch(json: Record<string, unknown>) {
    const spy = vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    return spy;
  }
  const sentBody = (spy: ReturnType<typeof stubFetch>) =>
    JSON.parse((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;

  it('발급 요청은 대문자 checkHash 를 쓰고 pay_yn=N 이면 결제 필드를 넣지 않는다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000', bill_key: 'BILLKEY12345678', issue_name: '신한카드' });
      const r = await mod.koemRegisterBillKey({ cardNo: '1234-1234-1234-1234', cardYm: '28/12', buyerNm: '홍길동' });

      expect(r.ok).toBe(true);
      const body = sentBody(spy);
      expect(body.pay_yn).toBe('N');
      expect(body).toHaveProperty('checkHash');
      expect(body).not.toHaveProperty('checkhash');
      // pay_yn=N 이면 결제 관련 필드는 보내지 않는다.
      expect(body).not.toHaveProperty('buy_reqamt');
      expect(body).not.toHaveProperty('orderno');
      // 하이픈·슬래시는 제거되어 숫자만 전송된다.
      expect(body.card_no).toBe('1234123412341234');
      expect(body.card_ym).toBe('2812');
      // 서명은 발급 공식으로 계산된다.
      expect(body.checkHash).toBe(
        mod.koemRegisterHash({
          mid: 'M'.repeat(15),
          cardNo: '1234123412341234',
          reqdt: String(body.reqdt),
          reqtm: String(body.reqtm),
        }),
      );
    } finally {
      restore();
    }
  });

  it('pay_yn=Y 면 결제 필드를 함께 보낸다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000', bill_key: 'BILLKEY12345678' });
      const r = await mod.koemRegisterBillKey({
        cardNo: '1234123412341234',
        cardYm: '2812',
        buyerNm: '홍길동',
        payNow: true,
        orderNo: 'ORD-1',
        itemName: '문자후원',
        amount: 3000n,
      });

      expect(r.ok).toBe(true);
      const body = sentBody(spy);
      expect(body.pay_yn).toBe('Y');
      expect(body.buy_reqamt).toBe('3000');
      expect(body.buy_itemnm).toBe('문자후원');
      expect(body.orderno).toBe('ORD-1');
      expect(body.quota_months).toBe('00');
    } finally {
      restore();
    }
  });

  it('pay_yn=Y 인데 결제 항목이 빠지면 통신 전에 실패한다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000' });
      const r = await mod.koemRegisterBillKey({
        cardNo: '1234123412341234',
        cardYm: '2812',
        buyerNm: '홍길동',
        payNow: true,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('MISSING_PAYMENT_FIELDS');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('승인 요청은 대문자 checkHash + 결제 공식이다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000', tid: 'TID-1' });
      await mod.koemPaymentAdapter.approve({
        orderNo: 'ORD-1',
        amount: 3000n,
        billKey: 'BILLKEY12345678',
        productName: '문자후원',
        buyerName: '홍길동',
      });

      const body = sentBody(spy);
      expect(body).toHaveProperty('checkHash');
      expect(body.buy_reqamt).toBe('3000');
      expect(body.buyer_nm).toBe('홍길동');
      expect(body.checkHash).toBe(
        mod.koemApproveHash({
          mid: 'M'.repeat(15),
          orderno: 'ORD-1',
          orderdt: String(body.orderdt),
          ordertm: String(body.ordertm),
          buyReqamt: '3000',
          billKey: 'BILLKEY12345678',
        }),
      );
    } finally {
      restore();
    }
  });

  it('구매자명이 비면 빈 문자열 대신 기본값을 넣는다 (규격상 필수)', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000', tid: 'TID-1' });
      await mod.koemPaymentAdapter.approve({
        orderNo: 'ORD-1',
        amount: 3000n,
        billKey: 'B1',
        productName: '문자후원',
      });
      expect(sentBody(spy).buyer_nm).toBe('후원자');
    } finally {
      restore();
    }
  });

  it('취소 요청은 소문자 checkhash 를 쓴다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000' });
      await mod.koemPaymentAdapter.cancel({ orderNo: 'ORD-1', providerTid: 'TID-9', amount: 3000n });

      const body = sentBody(spy);
      // 대문자로 보내면 규격상 거절된다.
      expect(body).toHaveProperty('checkhash');
      expect(body).not.toHaveProperty('checkHash');
      expect(body.pay_method).toBe('CC');
      expect(body.cancel_amt).toBe('3000');
      expect(body.checkhash).toBe(
        mod.koemCancelHash({ tid: 'TID-9', mid: 'M'.repeat(15), cancelAmt: '3000' }),
      );
    } finally {
      restore();
    }
  });

  it('해지 요청도 소문자 checkhash 를 쓴다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const spy = stubFetch({ result_code: '0000' });
      await mod.koemPaymentAdapter.revokeBillKey('BILLKEY12345678');

      const body = sentBody(spy);
      expect(body).toHaveProperty('checkhash');
      expect(body).not.toHaveProperty('checkHash');
      expect(body.checkhash).toBe(
        mod.koemUnregisterHash({ mid: 'M'.repeat(15), billKey: 'BILLKEY12345678' }),
      );
    } finally {
      restore();
    }
  });

  /** 카드번호가 응답에 echo 되어도 감사 로그로 흘러가면 안 된다. */
  it('응답에 카드번호가 섞여 와도 raw 에서 제거한다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      stubFetch({
        result_code: '0000',
        bill_key: 'BILLKEY12345678',
        card_no: '1234123412341234',
        issue_name: '신한카드',
      });
      const r = await mod.koemRegisterBillKey({
        cardNo: '1234123412341234',
        cardYm: '2812',
        buyerNm: '홍길동',
      });

      expect(r.ok).toBe(true);
      expect(r.raw?.card_no).toBe('[제거됨]');
      expect(JSON.stringify(r.raw)).not.toContain('1234123412341234');
      // 반환값에는 끝 4자리와 발급사명만 남는다.
      expect(r.data?.cardTail4).toBe('1234');
      expect(r.data?.cardIssuer).toBe('신한카드');
      expect(JSON.stringify(r.data)).not.toContain('1234123412341234');
    } finally {
      restore();
    }
  });

  it('실패 응답은 발급사 단계 메시지까지 함께 알려 준다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      stubFetch({
        result_code: '9999',
        result_msg: '승인 거절',
        dresult_code: '051',
        dresult_msg: '한도 초과',
      });
      const r = await mod.koemPaymentAdapter.approve({
        orderNo: 'ORD-1',
        amount: 3000n,
        billKey: 'B1',
        productName: '문자후원',
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('9999');
      expect(r.message).toContain('한도 초과');
    } finally {
      restore();
    }
  });

  it('조회 API 가 없으므로 inquire 는 PENDING 을 돌려준다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const r = await mod.koemPaymentAdapter.inquire('ORD-1');
      expect(r.data?.status).toBe('PENDING');
      expect(r.code).toBe('INQUIRY_NOT_IMPLEMENTED');
    } finally {
      restore();
    }
  });

  it('결제창이 없으므로 등록 세션 발급은 실패한다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const r = await mod.koemPaymentAdapter.createRegistrationSession({
        donorRef: 'D1',
        returnUrl: 'https://x/y',
        notifyUrl: 'https://x/z',
        method: 'CARD',
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('NO_HOSTED_WINDOW');
    } finally {
      restore();
    }
  });

  it('PIN 단계가 없으므로 PIN 링크 발급은 실패한다', async () => {
    const { mod, restore } = await loadConfiguredKoem();
    try {
      const r = await mod.koemPaymentAdapter.requestPinLink('DON-1', 3000n, '01012345678');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('PIN_NOT_SUPPORTED');
    } finally {
      restore();
    }
  });
});

describe('기존 헥토 어댑터에 영향이 없다', () => {
  it('헥토 info() 는 여전히 hecto 를 가리킨다', () => {
    expect(hectoPaymentAdapter.info().provider).toBe('hecto');
  });

  it('세 어댑터의 provider 코드가 서로 다르다', () => {
    const providers = [
      hectoPaymentAdapter.info().provider,
      ongiPaymentAdapter.info().provider,
      koemPaymentAdapter.info().provider,
    ];
    expect(new Set(providers).size).toBe(3);
  });
});

// ===========================================================================
// 카카오페이
// ===========================================================================

describe('카카오페이 어댑터', () => {
  it('환경변수 미설정 시 AdapterNotConfiguredError 를 던진다', async () => {
    vi.stubEnv('KAKAO_SECRET_KEY', '');
    vi.stubEnv('KAKAO_CID', '');
    vi.resetModules();
    const mod = await import('@/server/adapters/payment/kakao');
    await expect(
      mod.kakaoPaymentAdapter.createRegistrationSession({
        donorRef: 'D1',
        returnUrl: 'https://x/return',
        notifyUrl: 'https://x/notify',
      }),
    ).rejects.toThrow(AdapterNotConfiguredError);
  });

  it('KAKAO_SECRET_KEY 만 있고 KAKAO_CID 가 없으면 AdapterNotConfiguredError 를 던진다', async () => {
    vi.stubEnv('KAKAO_SECRET_KEY', 'test-secret');
    vi.stubEnv('KAKAO_CID', '');
    vi.resetModules();
    const mod = await import('@/server/adapters/payment/kakao');
    await expect(
      mod.kakaoPaymentAdapter.approve({
        orderNo: 'ORD-1',
        amount: 5000n,
        billKey: 'SID-TEST',
        productName: '후원',
      }),
    ).rejects.toThrow(AdapterNotConfiguredError);
  });

  it('info().missingCredentials 에 누락된 환경변수 이름이 포함된다', async () => {
    vi.stubEnv('KAKAO_SECRET_KEY', '');
    vi.stubEnv('KAKAO_CID', '');
    vi.resetModules();
    const mod = await import('@/server/adapters/payment/kakao');
    const info = mod.kakaoPaymentAdapter.info();
    expect(info.missingCredentials).toContain('KAKAO_SECRET_KEY');
    expect(info.missingCredentials).toContain('KAKAO_CID');
  });

  it('환경변수가 설정된 경우 Authorization 헤더에 SECRET_KEY ${key} 형식이 포함된다', async () => {
    const secretKey = 'test-kakao-secret-key-12345';
    vi.stubEnv('KAKAO_SECRET_KEY', secretKey);
    vi.stubEnv('KAKAO_CID', 'TC0ONETIME');
    vi.resetModules();

    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return Promise.resolve({
          ok: false,
          text: () => Promise.resolve(JSON.stringify({ error_code: 'KA001', error_message: '테스트 오류' })),
        });
      }),
    );

    const mod = await import('@/server/adapters/payment/kakao');
    await mod.kakaoPaymentAdapter.approve({
      orderNo: 'ORD-1',
      amount: 5000n,
      billKey: 'SID-TEST',
      productName: '후원',
    });

    const headers = capturedHeaders as Record<string, string>;
    expect(headers['Authorization']).toBe(`SECRET_KEY ${secretKey}`);
  });

  it('KAKAO_SPEC 의 모든 경로는 open-api.kakaopay.com 도메인이다', () => {
    for (const url of Object.values(KAKAO_SPEC)) {
      expect(url).toMatch(/^https:\/\/open-api\.kakaopay\.com\//);
    }
  });

  it('provider 코드가 kakao 이다', () => {
    expect(kakaoPaymentAdapter.info().provider).toBe('kakao');
  });
});
