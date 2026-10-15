import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-15 3차 점검 — 결제/후원 흐름 수정(PAY-A ~ PAY-K)의 회귀 테스트.
 * 항목 번호는 3차 전체 점검 보고서를 따른다.
 *
 * 웹 PIN 서버 액션(PAY-J)은 next/headers 쿠키 저장소를 쓰므로 메모리 저장소로 대체한다.
 */
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { generateToken, tokenHash, encrypt, decrypt } from '@/lib/crypto';
import { mockMoAdapter } from '@/server/adapters/mo';
import { mockPaymentAdapter } from '@/server/adapters/payment';
import { hectoInquiryErrorStatus, hectoInquiryStatus } from '@/server/adapters/payment/hecto';
import { ongiInquiryStatus } from '@/server/adapters/payment/ongi';
import {
  executePayment,
  handleMoInbound,
  reconcileStuckPendingPayments,
  recoverStuckMoMessages,
  revertIntakeVelocity,
} from '@/server/services/donation-flow';
import { ALL, commitCounters, resolvePolicy, rollbackVelocity } from '@/server/services/limits';
import { cancelPendingPinDonation } from '@/server/services/pin-authorization';
import { approveRefund, requestRefund } from '@/server/services/refund';
import { completeRegistration, startRegistration } from '@/server/services/donor-registration';
import { issueSecureLink } from '@/server/services/secure-link';
import { decodePinCookie, encodePinCookie } from '@/server/services/web-pin-cookie';
import { cancelWebPinDonation, checkWebPinDonationStatus } from '@/app/actions/web-donation-pin';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

afterEach(() => {
  vi.restoreAllMocks();
});

async function counterRow(donorId: string, creatorId: string, periodKey: string) {
  return prisma.donationCounter.findUnique({
    where: { donorId_creatorId_periodType_periodKey: { donorId, creatorId, periodType: 'DAY', periodKey } },
  });
}

async function velocityKeyFor(donorId: string, creatorId: string, at: Date) {
  const policy = await resolvePolicy(creatorId, donorId);
  return `velocity:${donorId}:${Math.floor(at.getTime() / (policy.velocityWindowSec * 1000))}`;
}

/**
 * 첫 시도가 "예약 + 거래 생성" 까지 하고 **승인 시도 기록을 남기기 전에** 죽은 상태.
 * (PAY-A 의 핵심: payment_attempt 가 0건)
 */
async function stuckDonationWithoutAttempts() {
  const donor = await seedRegisteredDonor(fx.donorPhone);
  const res = await inbound(moPayload({ to: fx.moNumber }));
  const donationId = res.donationId!;
  const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
  const orderNo = `ORD${newId()}`;
  const txn = await prisma.paymentTransaction.create({
    data: { id: newId(), donationId, orderNo, provider: 'mock', amount: d.amount, status: 'REQUESTED' },
  });
  await commitCounters(donor.id, fx.creatorId, d.amount, new Date());
  await prisma.donation.update({
    where: { id: donationId },
    data: { status: 'PENDING_PAYMENT', updatedAt: new Date(Date.now() - 10 * 60_000) },
  });
  return { donor, donationId, orderNo, amount: d.amount, txnId: txn.id };
}

// ───────────────────── PAY-A ─────────────────────

describe('PAY-A 재사용 거래는 시도 기록이 없어도 결과조회부터 한다', () => {
  beforeEach(async () => {
    await resetDb();
    // CONFIRM_LINK: MO 접수만으로는 결제가 나가지 않아 고착 상태를 직접 만들 수 있다.
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('승인 시도 기록 0건 + PG 는 이미 승인 → 승인을 다시 보내지 않고 조회 결과로 마무리한다', async () => {
    const { donationId, orderNo, amount } = await stuckDonationWithoutAttempts();
    // 앞선 승인 요청은 PG 에 도달해 출금까지 됐다(응답 전에 프로세스가 죽었다).
    await mockPaymentAdapter.approve({ orderNo, amount, billKey: 'x', productName: 't', buyerName: 't' });
    expect(await prisma.paymentAttempt.count()).toBe(0);

    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');
    const out = await executePayment(donationId);

    expect(out.ok).toBe(true);
    expect(approveSpy).not.toHaveBeenCalled();
    expect(await prisma.paymentAttempt.count({ where: { operation: 'APPROVE', transaction: { donationId } } })).toBe(0);
    expect(await prisma.paymentAttempt.count({ where: { operation: 'INQUIRE', transaction: { donationId } } })).toBe(1);
    expect(await prisma.settlementLedger.count({ where: { donationId, entryType: 'DONATION_GROSS' } })).toBe(1);
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { donationId } });
    expect(txn.status).toBe('APPROVED');
  });

  it('승인 시도 기록 0건 + PG 에 기록 없음(NOT_FOUND) → 같은 주문번호로 다시 승인한다', async () => {
    const { donationId, orderNo } = await stuckDonationWithoutAttempts();
    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');
    const out = await executePayment(donationId);
    expect(out.ok).toBe(true);
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy.mock.calls[0][0].orderNo).toBe(orderNo);
  });

  it('승인 시도 기록 0건 + 조회 결과가 확정되지 않음(PENDING) → 승인하지 않고 미확인(UNKNOWN)으로 넘긴다', async () => {
    const { donationId } = await stuckDonationWithoutAttempts();
    vi.spyOn(mockPaymentAdapter, 'inquire').mockResolvedValueOnce({ ok: true, data: { status: 'PENDING' } });
    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');

    const out = await executePayment(donationId);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('PENDING_PAYMENT');
    expect(approveSpy).not.toHaveBeenCalled();
    const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { donationId } });
    expect(txn.status).toBe('UNKNOWN');
  });

  it('승인 요청 전에 IN_FLIGHT 시도 행을 남기고, 응답을 받으면 같은 행을 결과로 갱신한다', async () => {
    const { donationId } = await stuckDonationWithoutAttempts();
    let seenInFlight = false;
    const realApprove = mockPaymentAdapter.approve.bind(mockPaymentAdapter);
    vi.spyOn(mockPaymentAdapter, 'approve').mockImplementationOnce(async (req) => {
      const rows = await prisma.paymentAttempt.findMany({ where: { operation: 'APPROVE', transaction: { donationId } } });
      seenInFlight = rows.length === 1 && rows[0].errorCode === 'IN_FLIGHT';
      return realApprove(req);
    });

    await executePayment(donationId);
    expect(seenInFlight).toBe(true);
    const rows = await prisma.paymentAttempt.findMany({ where: { operation: 'APPROVE', transaction: { donationId } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].errorCode).toBeNull();
  });

  it('AbortError(fetch 시간 초과)는 TIMEOUT 으로 분류한다', async () => {
    const { donationId } = await stuckDonationWithoutAttempts();
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    vi.spyOn(mockPaymentAdapter, 'approve').mockRejectedValueOnce(abort);

    await executePayment(donationId);
    const row = await prisma.paymentAttempt.findFirstOrThrow({ where: { operation: 'APPROVE', transaction: { donationId } } });
    expect(row.errorCode).toBe('TIMEOUT');
  });
});

// ───────────────────── PAY-B ─────────────────────

describe('PAY-B 계정이 정지·탈퇴된 크리에이터에게는 문자 후원이 결제되지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('MO 접수 단계에서 계정 상태(SUSPENDED)를 보고 차단한다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.user.update({ where: { id: fx.creatorUserId }, data: { status: 'SUSPENDED' } });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.result).toBe('BLOCKED');
    expect(await prisma.donation.count()).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);
    const mo = await prisma.moInboundMessage.findFirstOrThrow();
    expect(mo.resultDetail).toContain('SUSPENDED');
  });

  it('접수 뒤 결제 직전에 계정이 탈퇴(WITHDRAWN)되면 승인 없이 실패로 닫는다', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { paymentMode: 'CONFIRM_LINK' } });
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('PENDING_PIN');

    await prisma.user.update({ where: { id: fx.creatorUserId }, data: { status: 'WITHDRAWN' } });
    const approveSpy = vi.spyOn(mockPaymentAdapter, 'approve');
    const out = await executePayment(res.donationId!);

    expect(out.ok).toBe(false);
    expect(out.status).toBe('PAYMENT_FAILED');
    expect(approveSpy).not.toHaveBeenCalled();
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.settlementLedger.count()).toBe(0);
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    expect(d.status).toBe('PAYMENT_FAILED');
  });
});

// ───────────────────── PAY-C ─────────────────────

describe('PAY-C 결제수단 재등록 시 옛 빌키를 PG 에서도 해지한다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  async function reRegister(donorPhoneHash: string) {
    const link = await issueSecureLink({ purpose: 'REGISTER_ACCOUNT', phoneHash: donorPhoneHash, creatorId: fx.creatorId });
    const raw = generateToken(16);
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });
    const consents = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map(
      (type) => ({ type, agreed: true }),
    );
    const started = await startRegistration({ token: raw, consents });
    return completeRegistration({
      token: raw,
      registrationId: started.registrationId,
      providerPayload: { tid: `MOCKREG-${newId()}`, bankCode: '088', bankName: '신한은행', account: '99988877766' },
    });
  }

  it('PG 해지 실패 → 등록은 완료되고, 옛 빌키는 재시도 배치 대상(revokeFailedAt)으로 남는다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const old = await prisma.paymentMethodToken.findFirstOrThrow({ where: { donorId: donor.id } });
    const revokeSpy = vi
      .spyOn(mockPaymentAdapter, 'revokeBillKey')
      .mockResolvedValueOnce({ ok: false, code: 'E500', message: '사업자 오류' });

    const done = await reRegister(donor.phoneHash);
    expect(done.accountTail4).toBe('7766');

    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy.mock.calls[0][0]).toBe('MOCKBILL-TEST-4455');
    const after = await prisma.paymentMethodToken.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.status).toBe('REVOKED');
    expect(after.revokeFailedAt).not.toBeNull();
    expect(after.revokeAttempts).toBe(1);
    expect(after.billKeyEnc).not.toBe('');
    expect(await prisma.paymentMethodToken.count({ where: { donorId: donor.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('PG 해지 성공 → 옛 빌키 암호문을 지운다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const old = await prisma.paymentMethodToken.findFirstOrThrow({ where: { donorId: donor.id } });
    await reRegister(donor.phoneHash);
    const after = await prisma.paymentMethodToken.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.status).toBe('REVOKED');
    expect(after.billKeyEnc).toBe('');
    expect(after.revokeFailedAt).toBeNull();
  });

  it('PG 가 같은 빌키를 다시 돌려주면 해지하지 않는다(새 결제수단까지 죽지 않게)', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const old = await prisma.paymentMethodToken.findFirstOrThrow({ where: { donorId: donor.id } });
    const sameKey = decrypt(old.billKeyEnc);
    vi.spyOn(mockPaymentAdapter, 'completeRegistration').mockResolvedValueOnce({
      ok: true,
      data: { providerTid: 'T', method: 'ACCOUNT', billKey: sameKey, bankCode: '004', bankName: 'KB', accountTail4: '4455' },
    });
    const revokeSpy = vi.spyOn(mockPaymentAdapter, 'revokeBillKey');
    await reRegister(donor.phoneHash);
    expect(revokeSpy).not.toHaveBeenCalled();
  });
});

// ───────────────────── PAY-D ─────────────────────

describe('PAY-D 알 수 없는 조회 상태는 실패로 단정하지 않는다', () => {
  it('헥토: 모르는 거래상태·9999 는 PENDING(미확정), 확인된 코드만 확정 상태', () => {
    expect(hectoInquiryStatus('TS02')).toBe('APPROVED');
    expect(hectoInquiryStatus('TS03')).toBe('CANCELED');
    expect(hectoInquiryStatus('TS01')).toBe('PENDING');
    expect(hectoInquiryStatus('TS99')).toBe('PENDING');
    expect(hectoInquiryStatus('')).toBe('PENDING');
    expect(hectoInquiryErrorStatus('9999')).toBe('PENDING');
    expect(hectoInquiryErrorStatus('NOT_FOUND')).toBe('NOT_FOUND');
  });

  it('온기: 모르는 상태값은 PENDING(미확정)', () => {
    expect(ongiInquiryStatus('PAID')).toBe('APPROVED');
    expect(ongiInquiryStatus('cancelled')).toBe('CANCELED');
    expect(ongiInquiryStatus('FAILED')).toBe('FAILED');
    expect(ongiInquiryStatus('PARTIAL_CANCELED')).toBe('PENDING');
    expect(ongiInquiryStatus('')).toBe('PENDING');
  });
});

// ───────────────────── PAY-E ─────────────────────

describe('PAY-E 속도 카운터는 접수 시각 버킷에서, 음수 없이, 한 번만 되돌린다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('키가 없으면 -1 키를 만들지 않는다', async () => {
    const donorId = `nokey-${newId()}`;
    const policy = await resolvePolicy(fx.creatorId, null);
    const at = new Date();
    await rollbackVelocity(donorId, policy, at);
    const key = `velocity:${donorId}:${Math.floor(at.getTime() / (policy.velocityWindowSec * 1000))}`;
    expect(await kv.get(key)).toBeNull();
    expect(await kv.get(`streak:${donorId}`)).toBeNull();
  });

  it('PIN 취소 시 접수 시각 버킷을 1 내리고, 두 번 불려도 0 밑으로 내려가지 않는다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('PENDING_PIN');
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    const key = await velocityKeyFor(donor.id, fx.creatorId, d.createdAt);
    expect(Number(await kv.get(key))).toBe(1);

    expect(await cancelPendingPinDonation(d.id, '테스트 취소')).toBe(true);
    expect(Number(await kv.get(key))).toBe(0);

    // 이미 취소된 건을 다시 취소해도(선점 실패) 되돌리지 않는다.
    expect(await cancelPendingPinDonation(d.id, '테스트 취소')).toBe(false);
    // 직접 여러 번 불러도 음수가 되지 않는다.
    await revertIntakeVelocity(d.id);
    expect(Number(await kv.get(key))).toBe(0);
  });

  it('결제 실패 시 거래 생성 시각이 아니라 접수 시각 버킷을 되돌린다', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 3999n } });
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    const intakeKey = await velocityKeyFor(donor.id, fx.creatorId, d.createdAt);
    expect(Number(await kv.get(intakeKey))).toBe(1);

    // PIN 입력이 몇 분 뒤에 이뤄진 상황: 접수 시각을 과거로 돌리고 카운터도 그 버킷으로 옮긴다.
    const past = new Date(Date.now() - 10 * 60_000);
    await prisma.donation.update({ where: { id: d.id }, data: { createdAt: past } });
    await kv.del(intakeKey);
    const pastKey = await velocityKeyFor(donor.id, fx.creatorId, past);
    await kv.set(pastKey, '1', 3600);

    const out = await executePayment(d.id); // 끝자리 999 → 승인 실패
    expect(out.status).toBe('PAYMENT_FAILED');
    expect(Number(await kv.get(pastKey))).toBe(0);
    // 결제 시각 버킷에는 -1 키가 생기지 않는다.
    expect(await kv.get(intakeKey)).toBeNull();
  });
});

// ───────────────────── PAY-F ─────────────────────

describe('PAY-F 환불은 예약한 날짜(거래 생성 시각)의 집계를 되돌린다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('결제 완료 시각(paidAt)이 아니라 txn.requestedAt 의 일 집계를 깎는다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(d.paidAt).not.toBeNull();

    // 예약은 사흘 전(거래 생성 시각)에 됐고, 결제 완료는 오늘인 상황을 만든다.
    const reservedAt = new Date(Date.now() - 3 * 86_400_000);
    await prisma.donationCounter.deleteMany({ where: { donorId: donor.id } });
    await commitCounters(donor.id, fx.creatorId, d.amount, reservedAt);
    await prisma.paymentTransaction.updateMany({ where: { donationId }, data: { requestedAt: reservedAt } });

    const refund = await requestRefund({ donationId, reason: '고객 요청' });
    await approveRefund(refund.id, 'admin-test');

    const reservedDay = await counterRow(donor.id, ALL, kstDateKey(reservedAt));
    expect(reservedDay?.count).toBe(0);
    expect(reservedDay?.amount).toBe(0n);
    // 오늘 집계는 애초에 없었고, 되돌림도 오늘을 건드리지 않는다.
    expect(await counterRow(donor.id, ALL, kstDateKey(new Date()))).toBeNull();
  });
});

// ───────────────────── PAY-G ─────────────────────

describe('PAY-G 늦게 온 승인 결과가 관리자 취소를 덮지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('조회 중 거래가 CANCELED 로 확정되면 원장을 쓰지 않고 관리자 확인 큐에 올린다', async () => {
    const { donationId, orderNo, amount, txnId } = await stuckDonationWithoutAttempts();
    await mockPaymentAdapter.approve({ orderNo, amount, billKey: 'x', productName: 't', buyerName: 't' });
    vi.spyOn(mockPaymentAdapter, 'inquire').mockImplementationOnce(async () => {
      // 조회 응답이 오는 사이 관리자가 수동 대사로 취소를 확정했다.
      await prisma.paymentTransaction.update({ where: { id: txnId }, data: { status: 'CANCELED' } });
      return { ok: true, data: { status: 'APPROVED', providerTid: 'T', amount } };
    });

    const out = await executePayment(donationId);
    expect(out.ok).toBe(false);
    const txn = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: txnId } });
    expect(txn.status).toBe('CANCELED');
    expect(await prisma.settlementLedger.count({ where: { donationId } })).toBe(0);
    expect(await prisma.riskDetection.count({ where: { donationId, type: 'PAYMENT_UNKNOWN' } })).toBe(1);
  });
});

// ───────────────────── PAY-H ─────────────────────

describe('PAY-H 진행 중인 거래 없이 멈춘 PENDING_PAYMENT 는 실패로 닫고 예약을 한 번만 되돌린다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('마지막 거래가 FAILED 인 고아 건 → PAYMENT_FAILED + 예약 1회 되돌림(배치 재실행에도 1회)', async () => {
    const { donor, donationId, txnId, amount } = await stuckDonationWithoutAttempts();
    const reservedAt = new Date(Date.now() - 20 * 60_000);
    // 같은 날 다른 후원 1건이 더 예약되어 있다(되돌림이 두 번 일어나면 이 건까지 깎인다).
    await commitCounters(donor.id, fx.creatorId, amount, reservedAt);
    // 거래를 FAILED 로 바꾼 직후 프로세스가 죽은 상태.
    await prisma.paymentTransaction.update({
      where: { id: txnId },
      data: { status: 'FAILED', requestedAt: reservedAt, updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await prisma.donation.update({
      where: { id: donationId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const dayKey = kstDateKey(reservedAt);
    const before = await counterRow(donor.id, ALL, dayKey);
    expect(before?.count).toBe(2);

    await reconcileStuckPendingPayments();
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(d.status).toBe('PAYMENT_FAILED');
    expect((await counterRow(donor.id, ALL, dayKey))?.count).toBe(1);

    await reconcileStuckPendingPayments();
    expect((await counterRow(donor.id, ALL, dayKey))?.count).toBe(1);
  });

  it('거래가 아예 없는 고아 건은 상태만 닫는다. 최근 갱신된 건은 건드리지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const a = await inbound(moPayload({ to: fx.moNumber }));
    const b = await inbound(moPayload({ to: fx.moNumber }));
    await prisma.donation.update({
      where: { id: a.donationId! },
      data: { status: 'PENDING_PAYMENT', updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await prisma.donation.update({ where: { id: b.donationId! }, data: { status: 'PENDING_PAYMENT' } });

    await reconcileStuckPendingPayments();
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: a.donationId! } })).status).toBe('PAYMENT_FAILED');
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: b.donationId! } })).status).toBe('PENDING_PAYMENT');
  });

  it('결제 직전 한도 초과는 판정 트랜잭션 안에서 LIMIT_BLOCKED 로 확정된다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    await prisma.donorProfile.update({ where: { id: donor.id }, data: { dailyLimit: 1000n } });
    const out = await executePayment(res.donationId!);
    expect(out.status).toBe('LIMIT_BLOCKED');
    const logs = await prisma.donationStatusLog.findMany({ where: { donationId: res.donationId!, toStatus: 'LIMIT_BLOCKED' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].fromStatus).toBe('PENDING_PAYMENT');
  });
});

// ───────────────────── PAY-I ─────────────────────

describe('PAY-I 수신 로그 고착 판정은 처리 시작 시각 기준이다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  async function pendingMo(input: { receivedAt: Date; createdAt?: Date; processedAt?: Date | null }) {
    return prisma.moInboundMessage.create({
      data: {
        id: newId(),
        providerMessageId: `MO-${newId()}`,
        providerCode: 'mock',
        receivedNumber: fx.moNumber,
        phoneHash: 'h',
        phoneEnc: encrypt('01000000000'),
        phoneMasked: '010-****-0000',
        contentEnc: encrypt('x'),
        result: 'PENDING',
        receivedAt: input.receivedAt,
        createdAt: input.createdAt ?? new Date(),
        processedAt: input.processedAt ?? null,
      },
    });
  }

  it('수신은 오래됐어도 방금 처리를 시작한 행은 ERROR 로 풀지 않는다', async () => {
    const old = new Date(Date.now() - 30 * 60_000);
    const backlog = await pendingMo({ receivedAt: old }); // 적체 문자, 지금 막 처리 시작
    const reclaimed = await pendingMo({ receivedAt: old, createdAt: old, processedAt: new Date() }); // ERROR 재선점 직후
    const stuck = await pendingMo({ receivedAt: old, createdAt: old }); // 진짜로 멈춘 행

    expect(await recoverStuckMoMessages()).toBe(1);
    expect((await prisma.moInboundMessage.findUniqueOrThrow({ where: { id: backlog.id } })).result).toBe('PENDING');
    expect((await prisma.moInboundMessage.findUniqueOrThrow({ where: { id: reclaimed.id } })).result).toBe('PENDING');
    expect((await prisma.moInboundMessage.findUniqueOrThrow({ where: { id: stuck.id } })).result).toBe('ERROR');
  });

  it('ERROR 행 재처리는 조건부 선점이다 — 이미 다른 실행이 PENDING 으로 가져간 행은 다시 처리하지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const payload = moPayload({ to: fx.moNumber });
    // 앞선 처리가 후원 생성 전 예외로 끝나 ERROR 로 남은 수신 로그.
    await prisma.moInboundMessage.create({
      data: {
        id: newId(), providerMessageId: String(payload.messageId), providerCode: 'mock',
        receivedNumber: fx.moNumber, phoneHash: 'h', phoneEnc: encrypt(fx.donorPhone),
        phoneMasked: '010-****-5678', contentEnc: encrypt('x'), result: 'ERROR', receivedAt: new Date(),
      },
    });

    // 두 재전송이 동시에 들어온다.
    const [r1, r2] = await Promise.all([inbound(payload), inbound(payload)]);
    const results = [r1.result, r2.result];
    expect(results.filter((r) => r === 'DUPLICATE').length).toBeGreaterThanOrEqual(1);
    expect(await prisma.donation.count()).toBe(1);
    // 재처리를 시작한 행에는 처리 시작 시각이 남는다(고착 판정 기준).
    const row = await prisma.moInboundMessage.findFirstOrThrow({ where: { providerMessageId: String(payload.messageId) } });
    expect(row.processedAt).not.toBeNull();
  });
});

// ───────────────────── PAY-J ─────────────────────

describe('PAY-J 웹 PIN 진행 쿠키는 서명 검증을 거친다', () => {
  beforeEach(async () => {
    await resetDb();
    cookieJar.clear();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  it('서명된 값만 받아들이고, 위조·예전 형식 값은 거절한다', () => {
    const id = newId();
    const signed = encodePinCookie(id);
    expect(decodePinCookie(signed)).toBe(id);
    expect(decodePinCookie(id)).toBeNull(); // 예전 형식(원문 ID)
    expect(decodePinCookie(`${newId()}.${signed.split('.').pop()}`)).toBeNull(); // 서명 재사용
    expect(decodePinCookie(`${id}.deadbeef`)).toBeNull();
    expect(decodePinCookie(`${id}.`)).toBeNull();
    expect(decodePinCookie('')).toBeNull();
    expect(decodePinCookie(null)).toBeNull();
  });

  it('남의 후원 ID 를 쿠키에 직접 넣어도 취소·조회되지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('PENDING_PIN');

    cookieJar.set('webdon_pin', res.donationId!);
    const canceled = await cancelWebPinDonation();
    expect(canceled.canceled).toBe(false);
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    expect(d.status).toBe('PENDING_PIN');

    cookieJar.set('webdon_pin', `${res.donationId!}.0000`);
    const state = await checkWebPinDonationStatus();
    expect(state.ok).toBe(false);
    expect(state.step).toBe('phone');

    // 정상 서명 값이면 동작한다.
    cookieJar.set('webdon_pin', encodePinCookie(res.donationId!));
    const ok = await cancelWebPinDonation();
    expect(ok.canceled).toBe(true);
  });
});
