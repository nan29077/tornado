import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-29 4차 점검 — 결제·MO 수정(PAY-1 ~ PAY-4, P2-1 ~ P2-7)의 회귀 테스트.
 * 항목 번호는 4차 전체 점검 보고서를 따른다. 웹훅 라우트(P2-6)는 round4-mo-webhook.test.ts 에 있다.
 */

// 한도 예약 시각(P2-3)을 확인하려고 commitCounters 를 감싼다(동작은 원본 그대로).
vi.mock('@/server/services/limits', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/server/services/limits')>();
  return { ...orig, commitCounters: vi.fn(orig.commitCounters) };
});

import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { generateToken, tokenHash } from '@/lib/crypto';
import { scrub } from '@/lib/logger';
import { env } from '@/lib/env';
import { mockMoAdapter } from '@/server/adapters/mo';
import { mockMtAdapter } from '@/server/adapters/mt';
import {
  getPaymentAdapter,
  mockPaymentAdapter,
  MockPaymentTimeout,
} from '@/server/adapters/payment';
import { executePayment, handleMoInbound } from '@/server/services/donation-flow';
import { commitCounters, resolvePolicy } from '@/server/services/limits';
import { completePinAuthorization } from '@/server/services/pin-authorization';
import { expireStaleConfirmations, loadConfirmContext } from '@/server/services/donation-confirm';
import { issueSecureLink } from '@/server/services/secure-link';
import { MT_TEMPLATE } from '@/server/services/mt-templates';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

afterEach(() => {
  vi.restoreAllMocks();
});

async function dayAmount(donorId: string, creatorId: string, at = new Date()) {
  const row = await prisma.donationCounter.findUnique({
    where: { donorId_creatorId_periodType_periodKey: { donorId, creatorId, periodType: 'DAY', periodKey: kstDateKey(at) } },
  });
  return row?.amount ?? 0n;
}

async function velocityCount(donorId: string, creatorId: string, at: Date) {
  const policy = await resolvePolicy(creatorId, donorId);
  const key = `velocity:${donorId}:${Math.floor(at.getTime() / (policy.velocityWindowSec * 1000))}`;
  return Number((await kv.get(key)) ?? 0);
}

async function failedSmsCount(donationId: string) {
  return prisma.mtOutboundMessage.count({ where: { donationId, templateCode: MT_TEMPLATE.DONATION_FAILED } });
}

/** 승인 요청까지 나간 뒤 멈춘 결제(REQUESTED/TIMEOUT 등). 한도 예약도 해 둔다. */
async function stuckPayment(status: 'REQUESTED' | 'TIMEOUT' | 'UNKNOWN' = 'REQUESTED') {
  const donor = await seedRegisteredDonor(fx.donorPhone);
  const res = await inbound(moPayload({ to: fx.moNumber }));
  const donationId = res.donationId!;
  const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
  const orderNo = `ORD${newId()}`;
  const txn = await prisma.paymentTransaction.create({
    data: { id: newId(), donationId, orderNo, provider: 'mock', amount: d.amount, status },
  });
  await commitCounters(donor.id, fx.creatorId, d.amount, txn.requestedAt);
  await prisma.donation.update({
    where: { id: donationId },
    data: { status: 'PENDING_PAYMENT', updatedAt: new Date(Date.now() - 10 * 60_000) },
  });
  return { donor, donationId, orderNo, amount: d.amount, txnId: txn.id };
}

// ───────────────────── PAY-1 ─────────────────────

describe('PAY-1 결제수단을 해지해도 진행 중인 결제는 미등록으로 덮지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  const revokeAll = (donorId: string) =>
    prisma.paymentMethodToken.updateMany({ where: { donorId }, data: { status: 'REVOKED', revokedAt: new Date() } });

  it('REQUESTED + PG 는 이미 승인 → 빌키 없이 조회로 승인을 확정한다', async () => {
    const s = await stuckPayment('REQUESTED');
    await mockPaymentAdapter.approve({ orderNo: s.orderNo, amount: s.amount, billKey: 'x', productName: 't' });
    await revokeAll(s.donor.id);
    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');

    const out = await executePayment(s.donationId);
    expect(out.ok).toBe(true);
    expect(approveSpy).not.toHaveBeenCalled();
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: s.txnId } })).status).toBe('APPROVED');
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: s.donationId } })).status).not.toBe('UNREGISTERED');
  });

  it('REQUESTED + PG 에 기록 없음 → 승인을 다시 보내지 않고 실패로 닫으며 예약 한도를 되돌린다', async () => {
    const s = await stuckPayment('REQUESTED');
    await revokeAll(s.donor.id);
    expect(await dayAmount(s.donor.id, fx.creatorId)).toBe(s.amount);
    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');

    const out = await executePayment(s.donationId);
    expect(out.status).toBe('PAYMENT_FAILED');
    expect(approveSpy).not.toHaveBeenCalled();
    const txn = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: s.txnId } });
    expect(txn.status).toBe('FAILED');
    expect(txn.resultCode).toBe('TOKEN_REVOKED');
    expect(await dayAmount(s.donor.id, fx.creatorId)).toBe(0n);
  });

  it('TIMEOUT 거래 + 결제수단 해지 → PENDING_PAYMENT(대사 대기)로 남는다', async () => {
    const s = await stuckPayment('TIMEOUT');
    await revokeAll(s.donor.id);
    const out = await executePayment(s.donationId);
    expect(out.status).toBe('PENDING_PAYMENT');
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: s.donationId } })).status).toBe('PENDING_PAYMENT');
    // 예약은 그대로 둔다(실제로 출금됐을 수 있다).
    expect(await dayAmount(s.donor.id, fx.creatorId)).toBe(s.amount);
  });

  it('진행 중인 거래가 없으면 기존대로 미등록으로 바꾸고 이력을 남긴다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    await revokeAll(donor.id);
    const out = await executePayment(res.donationId!);
    expect(out.status).toBe('UNREGISTERED');
    expect(await prisma.donationStatusLog.count({ where: { donationId: res.donationId!, toStatus: 'UNREGISTERED' } })).toBe(1);
  });
});

// ───────────────────── PAY-2 ─────────────────────

describe('PAY-2 관리자가 취소한 거래에 늦은 결과가 와도 되돌림·실패 문자를 반복하지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  async function cancelDuringApprove(lateInquiry: 'FAILED' | 'PENDING') {
    const s = await stuckPayment('REQUESTED');
    vi.spyOn(mockPaymentAdapter, 'inquire')
      .mockResolvedValueOnce({ ok: true, data: { status: 'NOT_FOUND' } }) // 재시도 전 조회
      .mockResolvedValueOnce({ ok: true, data: { status: lateInquiry } }); // 타임아웃 뒤 조회
    vi.spyOn(mockPaymentAdapter, 'approve').mockImplementationOnce(async () => {
      // 응답을 기다리는 사이 관리자가 수동 대사로 취소를 확정했다.
      await prisma.paymentTransaction.update({ where: { id: s.txnId }, data: { status: 'CANCELED' } });
      throw new MockPaymentTimeout(s.orderNo);
    });
    const out = await executePayment(s.donationId);
    return { s, out };
  }

  it('늦은 FAILED: 거래는 CANCELED 그대로, 한도 되돌림·실패 문자 없음', async () => {
    const { s, out } = await cancelDuringApprove('FAILED');
    expect(out.ok).toBe(false);
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: s.txnId } })).status).toBe('CANCELED');
    expect(await dayAmount(s.donor.id, fx.creatorId)).toBe(s.amount);
    expect(await failedSmsCount(s.donationId)).toBe(0);
  });

  it('늦은 미확인: 거래를 UNKNOWN 으로 되돌리지 않고 경보도 만들지 않는다', async () => {
    const { s } = await cancelDuringApprove('PENDING');
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: s.txnId } })).status).toBe('CANCELED');
    expect(await prisma.riskDetection.count({ where: { donationId: s.donationId, type: 'PAYMENT_UNKNOWN' } })).toBe(0);
  });

  it('정상 경로의 실패(999)는 여전히 한 번 되돌리고 실패 문자를 한 번 보낸다', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 3999n } });
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    await prisma.donation.update({ where: { id: res.donationId! }, data: { status: 'PENDING_CONFIRM' } });
    const out = await executePayment(res.donationId!);
    expect(out.status).toBe('PAYMENT_FAILED');
    expect(await dayAmount(donor.id, fx.creatorId)).toBe(0n);
    expect(await failedSmsCount(res.donationId!)).toBe(1);
  });
});

// ───────────────────── P2-1 / P2-4 ─────────────────────

describe('P2-1 PIN 단계 실패는 접수 때 소진한 속도 카운터를 되돌린다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  async function intake() {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    return { donor, res, d };
  }

  it('PIN 링크 발급 실패(555)', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 3555n } });
    const { donor, d } = await intake();
    expect(d.status).toBe('PAYMENT_FAILED');
    expect(await velocityCount(donor.id, fx.creatorId, d.createdAt)).toBe(0);
  });

  it('카드 PIN 미지원(PIN_NOT_SUPPORTED)', async () => {
    vi.spyOn(mockPaymentAdapter, 'requestPinLink').mockResolvedValueOnce({
      ok: false, code: 'PIN_NOT_SUPPORTED', message: '카드는 PIN 이 없습니다.',
    });
    const { donor, d } = await intake();
    expect(d.status).toBe('PAYMENT_FAILED');
    expect(await velocityCount(donor.id, fx.creatorId, d.createdAt)).toBe(0);
  });

  it('PIN 안내 문자 발송 실패', async () => {
    const realSend = mockMtAdapter.send.bind(mockMtAdapter);
    vi.spyOn(mockMtAdapter, 'send').mockImplementation(async (req) =>
      req.templateCode === MT_TEMPLATE.PIN_REQUEST ? { ok: false, code: 'E', message: '발송 실패' } : realSend(req),
    );
    const { donor, d } = await intake();
    expect(d.status).toBe('PAYMENT_FAILED');
    expect(await velocityCount(donor.id, fx.creatorId, d.createdAt)).toBe(0);
  });

  it('P2-4 세션 저장이 유니크 충돌이 아닌 오류로 실패하면 PENDING_PIN 에 남기지 않는다', async () => {
    vi.spyOn(prisma.paymentPinSession, 'create').mockRejectedValueOnce(new Error('connection reset'));
    const { donor, d } = await intake();
    expect(d.status).toBe('PAYMENT_FAILED');
    expect(await velocityCount(donor.id, fx.creatorId, d.createdAt)).toBe(0);
    expect(await prisma.mtOutboundMessage.count({ where: { donationId: d.id, templateCode: MT_TEMPLATE.PIN_REQUEST } })).toBe(0);
  });

  it('P2-4 유니크 충돌(P2002)은 경합으로 보고 상태를 바꾸지 않는다', async () => {
    vi.spyOn(prisma.paymentPinSession, 'create').mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const { d } = await intake();
    expect(d.status).toBe('PENDING_PIN');
  });
});

// ───────────────────── P2-2 ─────────────────────

describe('P2-2 만료 처리는 조건부 전이로, 한 번만 한다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('만료 콜백이 늦게 와도 이미 결제로 넘어간 후원을 실패로 덮지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    await prisma.paymentPinSession.update({ where: { donationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // 앞서 읽은 상태(PENDING_PIN)가 오래된 상황: 그 사이 결제가 시작됐다.
    const realFind = prisma.donation.findUnique.bind(prisma.donation);
    vi.spyOn(prisma.donation, 'findUnique').mockImplementationOnce((async (args: Parameters<typeof realFind>[0]) => {
      const row = await realFind(args);
      await prisma.donation.update({ where: { id: donationId }, data: { status: 'PENDING_PAYMENT' } });
      return row;
    }) as never);

    const out = await completePinAuthorization({ donationId });
    expect(out.code).toBe('EXPIRED');
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('PENDING_PAYMENT');
    expect(await prisma.donationStatusLog.count({ where: { donationId, toStatus: 'PAYMENT_FAILED' } })).toBe(0);
  });

  it('만료 콜백이 두 번 와도 상태 이력과 속도 카운터 되돌림은 한 번', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    const policy = await resolvePolicy(fx.creatorId, donor.id);
    const key = `velocity:${donor.id}:${Math.floor(d.createdAt.getTime() / (policy.velocityWindowSec * 1000))}`;
    await kv.set(key, '2', 3600); // 이중 되돌림을 드러내려고 2 로 둔다.
    await prisma.paymentPinSession.update({ where: { donationId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await Promise.all([completePinAuthorization({ donationId }), completePinAuthorization({ donationId })]);
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('PAYMENT_FAILED');
    expect(await prisma.donationStatusLog.count({ where: { donationId, toStatus: 'PAYMENT_FAILED' } })).toBe(1);
    expect(Number(await kv.get(key))).toBe(1);
  });

  it('확인 링크 만료: 열람 시 한 번 취소하고 카운터를 되돌리며, 배치가 다시 덮지 않는다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    await prisma.donation.update({ where: { id: donationId }, data: { status: 'PENDING_CONFIRM' } });
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    const link = await issueSecureLink({ purpose: 'CONFIRM_PAYMENT', phoneHash: donor.phoneHash, creatorId: fx.creatorId, donationId });
    const raw = generateToken(16);
    await prisma.secureLink.update({
      where: { id: link.id },
      data: { tokenHash: tokenHash(raw), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await velocityCount(donor.id, fx.creatorId, d.createdAt)).toBe(1);

    const loaded = await loadConfirmContext(raw);
    expect(loaded.ok).toBe(false);
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('PAYMENT_FAILED');
    expect(await velocityCount(donor.id, fx.creatorId, d.createdAt)).toBe(0);

    expect(await expireStaleConfirmations()).toBe(0);
    expect(await prisma.donationStatusLog.count({ where: { donationId, toStatus: 'PAYMENT_FAILED' } })).toBe(1);
  });

  it('확인 대기에서 결제로 넘어간 건은 만료 배치가 덮지 않는다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    await prisma.donation.update({ where: { id: donationId }, data: { status: 'PENDING_PAYMENT' } });
    await issueSecureLink({ purpose: 'CONFIRM_PAYMENT', phoneHash: donor.phoneHash, creatorId: fx.creatorId, donationId, ttlSec: -10 });
    expect(await expireStaleConfirmations()).toBe(0);
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('PENDING_PAYMENT');
  });
});

// ───────────────────── P2-3 ─────────────────────

describe('P2-3 결제 거래 생성 시각은 한도 예약 시각과 같다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('requestedAt === commitCounters 의 예약 시각', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    await prisma.donation.update({ where: { id: res.donationId! }, data: { status: 'PENDING_CONFIRM' } });
    const spy = vi.mocked(commitCounters);
    spy.mockClear();
    const out = await executePayment(res.donationId!);
    expect(out.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const reservedAt = spy.mock.calls[0][3] as Date;
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { donationId: res.donationId! } });
    expect(txn.requestedAt.getTime()).toBe(reservedAt.getTime());
  });
});

// ───────────────────── P2-5 ─────────────────────

describe('P2-5 로그 마스킹은 하이픈·밑줄 키 이름도 잡는다', () => {
  it('x-api-key / api_key / cookie / set-cookie / authorization', () => {
    const out = scrub({
      'x-api-key': 'live-secret-key-123456',
      api_key: 'another-secret-value-99',
      cookie: 'sid=abcdef',
      'set-cookie': 'sid=abcdef; HttpOnly',
      Authorization: 'Bearer abc.def.ghi',
      'proxy-authorization': 'Basic Zm9vOmJhcg==',
      'content-length': '120',
      orderNo: 'ORD-1',
    }) as Record<string, string>;
    expect(out['x-api-key']).not.toContain('secret');
    expect(out.api_key).not.toContain('secret');
    expect(out.cookie).not.toContain('abcdef');
    expect(out['set-cookie']).not.toContain('abcdef');
    expect(out.Authorization).not.toContain('abc.def');
    expect(out['proxy-authorization']).not.toContain('Zm9v');
    expect(out.orderNo).toBe('ORD-1');
  });
});

// ───────────────────── P2-7 ─────────────────────

describe('P2-7 결제 어댑터는 거래·빌키의 결제사 기준으로 고른다', () => {
  it('provider 이름을 받아 대소문자와 무관하게 고르고, 생략하면 현재 설정을 쓴다', () => {
    const prevSafe = env.safety.safeMode;
    (env.safety as { safeMode: boolean }).safeMode = false;
    try {
      expect(getPaymentAdapter('mock')).toBe(mockPaymentAdapter);
      expect(getPaymentAdapter(null)).toBe(mockPaymentAdapter); // 현재 설정(테스트: mock)
      // 키가 없는 실결제사는 mock 으로 대체하지 않고 실패한다(거래를 만든 결제사로 가야 한다).
      expect(() => getPaymentAdapter('HECTO')).toThrow();
    } finally {
      (env.safety as { safeMode: boolean }).safeMode = prevSafe;
    }
  });

  it('새 결제 거래는 빌키의 결제사로 기록되고, 그 결제사 어댑터로 승인한다', async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    await prisma.donation.update({ where: { id: res.donationId! }, data: { status: 'PENDING_CONFIRM' } });
    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');
    const out = await executePayment(res.donationId!);
    expect(out.ok).toBe(true);
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { donationId: res.donationId! } });
    expect(txn.provider).toBe('mock');
    // PAY-3: 승인 요청에는 닉네임이 아니라 고정 후원자 ID 가 실린다.
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    expect(approveSpy.mock.calls[0][0].partnerUserId).toBe(d.donorId);
    expect(approveSpy.mock.calls[0][0].donationId).toBe(d.id);
  });
});
