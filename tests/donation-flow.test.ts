import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { mockMoAdapter } from '@/server/adapters/mo';
import { readMockOutbox } from '@/server/adapters/mt';
import { setMockLive } from '@/server/adapters/youtube';
import { handleMoInbound, resolveConfirmChannel, resolvePaymentMode } from '@/server/services/donation-flow';
import { loadConfirmContext, confirmDonation, expireStaleConfirmations } from '@/server/services/donation-confirm';
import { startRegistration, completeRegistration } from '@/server/services/donor-registration';
import { requestRefund, approveRefund } from '@/server/services/refund';
import {
  getSettlementSummary,
  createSettlementRequest,
  markSettlementPaid,
  assertPayable,
} from '@/server/services/settlement';
import { issueSecureLink } from '@/server/services/secure-link';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { generateToken, tokenHash, phoneHash } from '@/lib/crypto';

let fx: Fixture;

async function inbound(payload: Record<string, unknown>) {
  return handleMoInbound(mockMoAdapter.parse(payload));
}

describe('MO 수신 → 후원 → 결제 → 방송 흐름', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('[1] 미등록 번호의 최초 MO 는 결제되지 않고 계좌 등록 안내만 발송한다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber, text: '첫 후원입니다' }));

    expect(res.result).toBe('UNREGISTERED_DONOR');
    expect(await prisma.donation.count()).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);

    const mt = readMockOutbox(1)[0];
    expect(mt.text).toContain('최초 문자는 후원 처리되지 않았습니다');

    const link = await prisma.secureLink.findFirst({ where: { purpose: 'REGISTER_ACCOUNT' } });
    expect(link).not.toBeNull();
  });

  it('[2] 만료된 등록 링크는 사용할 수 없다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'REGISTER_ACCOUNT' } });
    await prisma.secureLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    // 실제 토큰 원문은 알 수 없으므로 새 토큰으로 만료 링크를 재현한다
    const raw = generateToken(16);
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });

    await expect(startRegistration({ token: raw, consents: [] })).rejects.toThrow(/만료/);
  });

  it('[3] 계좌 등록: 필수 동의 누락은 실패하고, 동의 후에는 빌키가 저장된다', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const donor = await prisma.donorProfile.findFirstOrThrow();

    const raw = generateToken(16);
    const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'REGISTER_ACCOUNT' } });
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });

    await expect(startRegistration({ token: raw, consents: [] })).rejects.toThrow(/필수 동의/);

    const consents = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map(
      (type) => ({ type, agreed: true }),
    );
    const started = await startRegistration({ token: raw, consents });
    expect(started.redirectUrl).toContain('/mock/pg/register');

    const done = await completeRegistration({
      token: raw,
      registrationId: started.registrationId,
      providerPayload: { tid: 'MOCKREG1', bankCode: '004', bankName: 'KB국민은행', account: '11122233344455' },
    });
    expect(done.accountTail4).toBe('4455');

    const token = await prisma.paymentMethodToken.findFirstOrThrow({ where: { donorId: donor.id } });
    expect(token.status).toBe('ACTIVE');
    // 계좌 원문은 저장하지 않는다
    expect(JSON.stringify(token)).not.toContain('11122233344455');

    // 1회용 링크는 재사용 불가
    await expect(
      completeRegistration({ token: raw, registrationId: started.registrationId, providerPayload: {} }),
    ).rejects.toThrow();
  });

  it('[4] 등록 사용자의 MO 는 후원 거래를 생성하고 결제 후 방송에 노출된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber, text: '오늘 방송 재미있어요!' }));

    expect(res.result).toBe('ROUTED');
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.amount).toBe(3000n);
    expect(['BROADCASTED', 'PARTIAL_DELIVERY_FAILED']).toContain(donation.status);
    expect(donation.paidAt).not.toBeNull();
    expect(donation.youtubeStatus).toBe('SENT');
    expect(donation.overlayStatus).toBe('SENT');

    // 수수료와 정산 원장
    expect(donation.pgFee).toBe(54n); // 3000 * 1.8%
    expect(donation.platformFee).toBe(450n); // 3000 * 15%
    const summary = await getSettlementSummary(fx.creatorId);
    expect(summary.totalGross).toBe(3000n);
    expect(summary.balance).toBe(2496n);

    const success = readMockOutbox(10).find((m) => m.text.includes('후원되었습니다'));
    expect(success).toBeDefined();
  });

  it('[4-1] 본문에 "N원" 표기가 있어도 크리에이터 고정 금액으로만 결제된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber, text: '10000원 화이팅' }));

    expect(res.result).toBe('ROUTED');
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    // 파싱된 10000원이 아니라 크리에이터가 설정한 3000원이 청구된다.
    expect(donation.amount).toBe(3000n);
    // 금액 표기를 잘라내지 않고 본문 전체를 후원 메시지로 사용한다.
    expect(donation.message).toBe('10000원 화이팅');
    expect(donation.paidAt).not.toBeNull();

    const tx = await prisma.paymentTransaction.findFirstOrThrow({ where: { donationId: donation.id } });
    expect(tx.amount).toBe(3000n);
  });

  it('[4-2] 금액 표기가 없는 일반 문자도 같은 고정 금액으로 결제된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber, text: '오늘도 응원합니다' }));

    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.amount).toBe(3000n);
    expect(donation.message).toBe('오늘도 응원합니다');
  });

  it('[4-3] 크리에이터가 고정 금액을 바꾸면 바뀐 금액으로 결제된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 5000n } });

    const res = await inbound(moPayload({ to: fx.moNumber, text: '1,000원 응원' }));
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.amount).toBe(5000n);
  });

  it('[5] 동일 MO Webhook 이 재전송되어도 결제가 중복되지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const payload = moPayload({ to: fx.moNumber, messageId: 'MO-DUP-001' });

    const first = await inbound(payload);
    const second = await inbound(payload);
    const third = await inbound(payload);

    expect(first.result).toBe('ROUTED');
    expect(second.result).toBe('DUPLICATE');
    expect(third.result).toBe('DUPLICATE');

    expect(await prisma.donation.count()).toBe(1);
    expect(await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } })).toBe(1);
    expect(await prisma.moInboundMessage.count()).toBe(1);
  });

  it('[6] 짧은 시간 연속 후원은 속도 제한에 걸린다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await inbound(moPayload({ to: fx.moNumber, text: `연속 ${i}` })));
    }
    const blocked = results.filter((r) => r.status === 'LIMIT_BLOCKED');
    expect(blocked.length).toBeGreaterThan(0);

    const approved = await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } });
    expect(approved).toBeLessThanOrEqual(3);
  });

  it('[7] 일일 한도를 초과하면 결제하지 않고 안내 문자를 보낸다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    await prisma.donorProfile.update({ where: { id: donor.id }, data: { dailyLimit: 2000n } });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);

    const mt = readMockOutbox(5).find((m) => m.text.includes('후원이 제한'));
    expect(mt).toBeDefined();
  });

  it('[8] 결제 API 타임아웃 시 거래결과조회로 최종 상태를 확정한다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    // 금액 끝 888 → 타임아웃 후 조회 시 승인 확정
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 3888n } });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.paidAt).not.toBeNull();

    const attempts = await prisma.paymentAttempt.findMany({ where: {}, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((a) => a.operation)).toContain('INQUIRE');

    // 끝 777 → 타임아웃 후 조회 시 실패 확정
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 3777n } });
    const res2 = await inbound(moPayload({ to: fx.moNumber, messageId: 'MO-TIMEOUT-777' }));
    const d2 = await prisma.donation.findFirstOrThrow({ where: { id: res2.donationId } });
    expect(d2.status).toBe('PAYMENT_FAILED');
  });

  it('[9] 결제 실패 시 방송에 노출되지 않고 실패 안내가 발송된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 2999n } });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });

    expect(donation.status).toBe('PAYMENT_FAILED');
    expect(await prisma.overlayEvent.count()).toBe(0);
    expect(await prisma.youTubeChatDelivery.count()).toBe(0);

    const mt = readMockOutbox(5).find((m) => m.text.includes('완료되지 않았습니다'));
    expect(mt).toBeDefined();
  });

  it('[10] 유튜브 전송이 실패해도 결제 결과는 유지된다 (연결 없음)', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.youTubeConnection.deleteMany({ where: { creatorId: fx.creatorId } });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });

    expect(donation.paidAt).not.toBeNull();
    expect(donation.youtubeStatus).toBe('SKIPPED');
    expect(donation.overlayStatus).toBe('SENT');
    const delivery = await prisma.youTubeChatDelivery.findFirstOrThrow();
    expect(delivery.errorCode).toBe('NO_CONNECTION');
  });

  it('[11] 방송이 종료된 상태에서도 결제는 성공하고 유튜브 전송만 건너뛴다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    setMockLive(false);

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.paidAt).not.toBeNull();
    expect(donation.youtubeStatus).toBe('SKIPPED');

    const delivery = await prisma.youTubeChatDelivery.findFirstOrThrow();
    expect(delivery.errorCode).toBe('NO_ACTIVE_BROADCAST');
  });

  it('[12] 금칙어가 포함된 문자는 차단되고 결제되지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.bannedWord.create({ data: { id: newId(), word: '도박', action: 'BLOCK', scope: 'GLOBAL' } });

    const res = await inbound(moPayload({ to: fx.moNumber, text: '도박 사이트 추천' }));
    expect(res.status).toBe('CONTENT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.overlayEvent.count()).toBe(0);
  });

  it('[13] 개인정보가 포함된 문자는 마스킹되어 방송에 노출된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(
      moPayload({ to: fx.moNumber, text: '연락주세요 010-9876-5432 abc@test.com' }),
    );
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.message).not.toContain('010-9876-5432');
    expect(donation.message).not.toContain('abc@test.com');
    expect(donation.messageRawEnc).not.toBeNull();
  });

  it('[14] 크리에이터가 차단한 후원자는 결제되지 않는다', async () => {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    await prisma.blockedDonor.create({
      data: { id: newId(), creatorId: fx.creatorId, donorId: donor.id, reason: '테스트 차단' },
    });

    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('[15] 환불하면 정산 원장에 반대 분개가 쌓이고 잔액이 차감된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const before = await getSettlementSummary(fx.creatorId);
    expect(before.balance).toBe(2496n);

    const refund = await requestRefund({ donationId: res.donationId!, reason: '고객 요청' });
    await approveRefund(refund.id, 'admin-test');

    const after = await getSettlementSummary(fx.creatorId);
    // 총액 -3000, 플랫폼수수료 환입 +450 → 2496 - 3000 + 450 = -54 (PG 수수료는 환입되지 않음)
    expect(after.balance).toBe(-54n);

    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.status).toBe('REFUNDED');

    // 원장은 수정되지 않고 분개만 추가된다
    const entries = await prisma.settlementLedger.findMany({ where: { creatorId: fx.creatorId } });
    expect(entries.length).toBe(5);
  });

  it('[16] 정산 원장은 UPDATE/DELETE 가 불가능하다 (append-only)', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await inbound(moPayload({ to: fx.moNumber }));
    const entry = await prisma.settlementLedger.findFirstOrThrow();

    await expect(
      prisma.settlementLedger.update({ where: { id: entry.id }, data: { amount: 1n } }),
    ).rejects.toThrow();
    await expect(prisma.settlementLedger.delete({ where: { id: entry.id } })).rejects.toThrow();
  });

  it('[17] 정산 요청은 가능 금액을 초과할 수 없고, 지급 시 원장에 반영된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await inbound(moPayload({ to: fx.moNumber }));

    await expect(createSettlementRequest(fx.creatorId, 999999n)).rejects.toThrow(/초과/);

    const req = await createSettlementRequest(fx.creatorId, 2000n);
    // 소액부징수: 소득세 2,000 × 3% = 60원 < 1,000원 이므로 원천징수하지 않는다.
    expect(req.withholding).toBe(0n);
    expect(req.incomeTax).toBe(0n);
    expect(req.payoutAmount).toBe(2000n);

    const afterRequest = await getSettlementSummary(fx.creatorId);
    expect(afterRequest.pending).toBe(2000n);
    expect(afterRequest.available).toBe(496n);

    // 승인(APPROVED) 을 거치지 않은 요청은 지급할 수 없다.
    await expect(markSettlementPaid(req.id, 'admin-test')).rejects.toThrow(/APPROVED/);

    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });

    // 계좌 인증 해제는 **이체 전** 사전검증(assertPayable)에서 걸러야 한다.
    // markSettlementPaid 는 이미 돈이 나간 뒤에 불리므로, 여기서 막으면(throw)
    // 원장에 지급 분개가 남지 않아 잔액이 그대로 남고 재신청 시 이중 지급이 된다.
    await prisma.settlementAccount.update({ where: { creatorId: fx.creatorId }, data: { verified: false } });
    const notPayable = await assertPayable(req.id);
    expect(notPayable.ok).toBe(false);
    await prisma.settlementAccount.update({ where: { creatorId: fx.creatorId }, data: { verified: true } });
    expect((await assertPayable(req.id)).ok).toBe(true);

    await markSettlementPaid(req.id, 'admin-test');
    const afterPaid = await getSettlementSummary(fx.creatorId);
    expect(afterPaid.balance).toBe(496n);
  });

  it('[18] 알 수 없는 수신번호는 결제하지 않고 안내한다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: '15889999' }));
    expect(res.result).toBe('UNKNOWN_ROUTE');
    expect(await prisma.donation.count()).toBe(0);
    const mt = readMockOutbox(3).find((m) => m.text.includes('찾을 수 없습니다'));
    expect(mt).toBeDefined();
  });

  it('[19] 결제 실패가 반복되면 후원자가 잠긴다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { donationAmount: 2999n } });
    await prisma.donationLimitPolicy.updateMany({ data: { velocityMaxCount: 100, cooldownAfterCount: 100 } });

    for (let i = 0; i < 3; i += 1) {
      await inbound(moPayload({ to: fx.moNumber, text: `실패 ${i}` }));
    }
    const donor = await prisma.donorProfile.findFirstOrThrow();
    expect(donor.failCount).toBeGreaterThanOrEqual(3);
    expect(donor.lockedUntil).not.toBeNull();

    const res = await inbound(moPayload({ to: fx.moNumber, text: '잠금 확인' }));
    expect(res.status).toBe('LIMIT_BLOCKED');
  });

  it('[20] 유튜브 할당량이 소진되면 전송을 보류하되 결제는 유지된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const { kv } = await import('@/server/redis');
    // 유튜브 일일 할당량은 **태평양시 자정**에 초기화된다(구글 규격). KST 기준으로 세면
    // 하루 중 16~17시간 동안 카운터와 실제 잔량이 어긋난다. 카운터 키도 PT 날짜를 쓴다.
    const { ptDateKey } = await import('@/lib/datetime');
    await kv.set(`yt:quota:${ptDateKey()}`, '10000', 3600);

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.paidAt).not.toBeNull();
    expect(donation.youtubeStatus).toBe('FAILED');
    expect(donation.status).toBe('PARTIAL_DELIVERY_FAILED');

    const delivery = await prisma.youTubeChatDelivery.findFirstOrThrow();
    expect(delivery.errorCode).toBe('QUOTA_EXCEEDED');
    await kv.del(`yt:quota:${ptDateKey()}`);
  });
});

describe('CONFIRM_LINK + 구(舊) 확인 링크 (ALLOW_LEGACY_CONFIRM_LINK=true)', () => {
  beforeEach(async () => {
    await resetDb();
    // 되돌림용으로 남겨 둔 경로다. 이 블록에서만 켠다.
    process.env.ALLOW_LEGACY_CONFIRM_LINK = 'true';
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  afterEach(() => {
    delete process.env.ALLOW_LEGACY_CONFIRM_LINK;
  });

  it('MO 수신만으로는 결제되지 않고 확인 링크가 발송된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));

    expect(res.status).toBe('PENDING_CONFIRM');
    expect(await prisma.paymentTransaction.count()).toBe(0);

    const mt = readMockOutbox(3).find((m) => m.text.includes('확인'));
    expect(mt).toBeDefined();
  });

  it('확인 링크를 눌러야 결제가 실행되고, 두 번 눌러도 1회만 결제된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));

    const raw = generateToken(16);
    const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'CONFIRM_PAYMENT' } });
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });

    const ctx = await loadConfirmContext(raw);
    expect(ctx.ok).toBe(true);

    const paid = await confirmDonation(raw);
    expect(paid.ok).toBe(true);
    await expect(confirmDonation(raw)).rejects.toThrow(/이미 처리/);

    expect(await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } })).toBe(1);
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.paidAt).not.toBeNull();
  });

  it('확인 시간이 지나면 자동 취소된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));

    await prisma.secureLink.updateMany({
      where: { purpose: 'CONFIRM_PAYMENT' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await expireStaleConfirmations();
    expect(expired).toBe(1);

    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.status).toBe('PAYMENT_FAILED');
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('플래그를 켜야만 구 확인 링크 경로를 탄다', () => {
    expect(resolveConfirmChannel(true)).toBe('LEGACY_LINK');
    expect(resolveConfirmChannel(false)).toBe('PIN');
  });

  it('ALLOW_DIRECT_TRIGGER=false 이면 DIRECT_TRIGGER 설정도 CONFIRM_LINK 로 강등된다', () => {
    // 금융사 서면승인이 등록되지 않은 상태에서는 어떤 크리에이터 설정으로도 즉시 결제가 열리지 않는다
    expect(resolvePaymentMode('DIRECT_TRIGGER', false)).toBe('CONFIRM_LINK');
    expect(resolvePaymentMode('CONFIRM_LINK', false)).toBe('CONFIRM_LINK');
    expect(resolvePaymentMode(null, true)).toBe('CONFIRM_LINK');
    expect(resolvePaymentMode('DIRECT_TRIGGER', true)).toBe('DIRECT_TRIGGER');
  });
});

describe('대표번호 + 키워드 라우팅', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
    await prisma.creatorMoNumber.create({
      data: {
        id: newId(), phoneNumber: '15889000', keyword: 'TOR3QP7', mode: 'SHARED_PREFIX',
        status: 'ASSIGNED', creatorId: fx.creatorId, providerId: 'mock', assignedAt: new Date(),
      },
    });
  });

  it('키워드로 크리에이터를 식별하고 키워드는 메시지에서 제거된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: '15889000', text: 'TOR3QP7 응원합니다' }));

    expect(res.result).toBe('ROUTED');
    const donation = await prisma.donation.findFirstOrThrow({ where: { id: res.donationId } });
    expect(donation.message).toBe('응원합니다');
    expect(donation.creatorId).toBe(fx.creatorId);
  });

  it('키워드가 없으면 라우팅되지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: '15889000', text: '응원합니다' }));
    expect(res.result).toBe('UNKNOWN_ROUTE');
  });
});

describe('보안 링크', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('토큰 원문은 저장되지 않고 해시로만 조회된다', async () => {
    const issued = await issueSecureLink({
      purpose: 'REGISTER_ACCOUNT',
      phoneHash: phoneHash('01012345678'),
      creatorId: fx.creatorId,
    });
    const row = await prisma.secureLink.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.tokenHash).not.toBe(issued.token);
    expect(row.tokenHash).toBe(tokenHash(issued.token));
  });
});
