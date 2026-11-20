import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstMonthKey } from '@/lib/datetime';
import { donationSourceLabel, donationSourceOf, isShopDonationChannel } from '@/lib/labels';
import { isMailDeliveryIntegrated } from '@/lib/env';
import { mockMoAdapter } from '@/server/adapters/mo';
import { resetMockPaymentState } from '@/server/adapters/payment';
import { getMailAdapter } from '@/server/adapters/mail';
import { handleMoInbound } from '@/server/services/donation-flow';
import { requestRefund, approveRefund } from '@/server/services/refund';
import { donationSources } from '@/server/services/donation-source';
import { listMyCreatorMessages, replyNotifyTarget, saveDonationReply } from '@/server/services/donation-replies';
import { appendLedger } from '@/server/services/settlement';
import { getLedgerTotals, getOtherRevenueTotals, splitVat } from '@/server/services/tax';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/**
 * 8차 기능 점검 수정 (2026-11-20)
 *  P1 세무 매출 범위 · P2 후원 경로 표시 · P2 모의 결제 환불 · P2 답글 알림 / 내 후원 내역
 *  P3 메일 발송 연동 조건
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

describe('후원 경로 라벨', () => {
  it('채널과 샵 결제 종류로 경로를 구분한다', () => {
    expect(donationSourceOf('MO')).toBe('MO');
    expect(donationSourceOf('WEB')).toBe('WEB');
    expect(donationSourceOf('SHOP', 'CARD_DONATION')).toBe('CARD');
    expect(donationSourceOf('SHOP', 'VIDEO_DONATION')).toBe('VIDEO');
    expect(donationSourceOf('SHOP')).toBe('SHOP');
    expect(donationSourceLabel.CARD.short).toBe('신용카드');
    expect(isShopDonationChannel('SHOP')).toBe(true);
    expect(isShopDonationChannel('MO')).toBe(false);
  });

  it('donationSources 는 샵 후원만 결제 기록을 보고 신용카드 · 영상을 가른다', async () => {
    const user = await prisma.user.create({ data: { id: newId(), email: `r8-${newId()}@test.kr`, name: '팬', role: 'DONOR' } });
    const mk = async (channel: string) =>
      prisma.donation.create({
        data: {
          id: newId(), creatorId: fx.creatorId, channel, amount: 5000n, status: 'SETTLEMENT_PENDING',
          paymentMode: 'CONFIRM_LINK', receivedAt: new Date(), transactionNo: `T-${newId()}`, displayName: '팬', message: '응원',
          ...(channel === 'SHOP' ? { mtStatus: 'SKIPPED' } : {}),
        },
      });
    const card = await mk('SHOP');
    const video = await mk('SHOP');
    const mo = await mk('MO');
    for (const [d, kind] of [[card, 'CARD_DONATION'], [video, 'VIDEO_DONATION']] as const) {
      await prisma.shopPayment.create({
        data: { id: newId(), paymentNo: `P-${newId()}`, userId: user.id, kind, amount: 5000n, status: 'PAID', provider: 'mock', donationId: d.id, creatorId: fx.creatorId },
      });
    }
    const map = await donationSources([card, video, mo]);
    expect(map.get(card.id)).toBe('CARD');
    expect(map.get(video.id)).toBe('VIDEO');
    expect(map.get(mo.id)).toBe('MO');
  });
});

describe('모의 결제 환불: 서버 재시작 뒤에도 취소된다', () => {
  it('메모리 승인 기록이 사라져도 DB 거래 기록으로 환불이 끝난다 (M0404 아님)', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.donationId).toBeTruthy();
    // 서버를 다시 켠 것처럼 모의 결제사의 메모리를 비운다
    resetMockPaymentState();
    const refund = await requestRefund({ donationId: res.donationId!, reason: '재시작 후 환불' });
    await approveRefund(refund.id, 'admin-test');
    const donation = await prisma.donation.findUniqueOrThrow({ where: { id: res.donationId! } });
    expect(donation.status).toBe('REFUNDED');
  });
});

describe('답글 알림 · 내 후원 내역', () => {
  async function linkedDonor() {
    const user = await prisma.user.create({ data: { id: newId(), email: `r8-${newId()}@test.kr`, name: '후원자', role: 'DONOR' } });
    const donor = await seedRegisteredDonor(fx.donorPhone);
    await prisma.donorProfile.update({ where: { id: donor.id }, data: { userId: user.id } });
    return { user, donor };
  }

  it('처음 단 답글만 알림 대상이고, 고친 답글은 다시 알리지 않는다', async () => {
    const { user, donor } = await linkedDonor();
    const d = await prisma.donation.create({
      data: { id: newId(), creatorId: fx.creatorId, donorId: donor.id, channel: 'WEB', amount: 3000n, status: 'SETTLEMENT_PENDING', paymentMode: 'CONFIRM_LINK', receivedAt: new Date(), transactionNo: `T-${newId()}`, displayName: '팬', message: '응원' },
    });
    await saveDonationReply(fx.creatorUserId, d.id, '고마워요');
    const first = await replyNotifyTarget(d.id);
    expect(first?.userId).toBe(user.id);
    expect(first?.creatorCode).toBe(fx.creatorCode);

    // 2초 뒤 수정한 것처럼 만든다
    await prisma.donationReply.update({ where: { donationId: d.id }, data: { createdAt: new Date(Date.now() - 5000) } });
    await saveDonationReply(fx.creatorUserId, d.id, '정말 고마워요');
    expect(await replyNotifyTarget(d.id)).toBeNull();
  });

  it('내 후원 내역은 문자뿐 아니라 간편계좌이체 · 샵 후원도 함께 보여 준다', async () => {
    const { user, donor } = await linkedDonor();
    for (const channel of ['MO', 'WEB', 'SHOP']) {
      await prisma.donation.create({
        data: { id: newId(), creatorId: fx.creatorId, donorId: donor.id, channel, amount: 1000n, status: 'SETTLEMENT_PENDING', paymentMode: 'CONFIRM_LINK', receivedAt: new Date(), transactionNo: `T-${newId()}`, displayName: '팬', message: '응원' },
      });
    }
    const list = await listMyCreatorMessages(user.id, fx.creatorId);
    expect(list.total).toBe(3);
    expect(new Set(list.rows.map((r) => r.channel))).toEqual(new Set(['MO', 'WEB', 'SHOP']));
  });
});

describe('P1 세무: 샵 · 팬챗 · 팬투표 매출', () => {
  it('중개 수수료 · 도네이도 상품 · 팬챗 · 1:1 · 팬투표권을 기준 시각으로 세고, 환불은 뺀다', async () => {
    const now = new Date();
    const ym = kstMonthKey(now);
    const user = await prisma.user.create({ data: { id: newId(), email: `r8-${newId()}@test.kr`, name: '팬', role: 'DONOR' } });

    // 직접상품 중개 수수료 1,000원
    await appendLedger([{ creatorId: fx.creatorId, entryType: 'BROKER_FEE', amount: -1000n, memo: 'r8', occurredAt: now }]);

    // 도네이도 상품 판매 22,000원 중 2,000원 환불 → 20,000원
    const pay = await prisma.shopPayment.create({
      data: { id: newId(), paymentNo: `P-${newId()}`, userId: user.id, kind: 'ORDER', amount: 22000n, status: 'PAID', provider: 'mock' },
    });
    await prisma.shopOrder.create({
      data: {
        id: newId(), orderNo: `O-${newId()}`, paymentId: pay.id, userId: user.id, sellerType: 'DONAIDO', status: 'CONFIRMED',
        itemsAmount: 19000n, shippingFee: 3000n, totalAmount: 22000n, refundedAmount: 2000n,
        recipientMasked: '홍*동', recipientEnc: 'x', phoneMasked: '010-****-0000', phoneEnc: 'x', zipcode: '00000', addressMasked: '서울 *', addressEnc: 'x',
        paidAt: now, confirmedAt: now,
      },
    });
    // 구매확정 전 주문은 아직 매출이 아니다
    await prisma.shopOrder.create({
      data: {
        id: newId(), orderNo: `O-${newId()}`, paymentId: pay.id, userId: user.id, sellerType: 'DONAIDO', status: 'SHIPPED',
        itemsAmount: 50000n, shippingFee: 0n, totalAmount: 50000n,
        recipientMasked: '홍*동', recipientEnc: 'x', phoneMasked: '010-****-0000', phoneEnc: 'x', zipcode: '00000', addressMasked: '서울 *', addressEnc: 'x',
        paidAt: now,
      },
    });

    // 팬챗 구독: 수수료 600원 + 환불된 구독 수수료 400원(같은 달 결제·환불 → 0)
    const sub = (fee: bigint, refunded: boolean) =>
      prisma.talkSubscription.create({
        data: {
          id: newId(), userId: user.id, creatorId: fx.creatorId, startsAt: now, endsAt: new Date(now.getTime() + 86_400_000),
          price: 3000n, feeAmount: fee, netAmount: 3000n - fee, method: 'CARD', createdAt: now,
          ...(refunded ? { status: 'REFUNDED', refundAmount: 3000n, refundedAt: now } : {}),
        },
      });
    await sub(600n, false);
    await sub(400n, true);

    // 1:1 채팅: 완료 1건 수수료 1,000원 + 늦은 취소 1건 (10,000원 중 5,000원 남김, 수수료율 20% → 1,000원)
    const session = (data: Record<string, unknown>) =>
      prisma.talkSession.create({
        data: {
          id: newId(), sessionNo: `S-${newId()}`, creatorId: fx.creatorId, userId: user.id, startsAt: now, endsAt: now, minutes: 30,
          price: 10000n, feeRate: '0.2', feeAmount: 2000n, netAmount: 8000n, method: 'CARD', approvalDeadline: now,
          ...data,
        } as never,
      });
    await session({ status: 'COMPLETED', completedAt: now, feeAmount: 1000n, netAmount: 9000n, feeRate: '0.1' });
    await session({ status: 'CANCELLED', refundAmount: 5000n, refundedAt: now, settledAt: now });

    // 팬투표권: 5,000원 결제 + 3,000원 결제 후 환불 → 5,000원
    const vote = (price: bigint, refunded: boolean) =>
      prisma.voteTicketOrder.create({
        data: {
          id: newId(), orderNo: `V-${newId()}`, userId: user.id, productName: '투표권', method: 'CARD', price, tickets: 10,
          status: refunded ? 'REFUNDED' : 'PAID', paidAt: now, ...(refunded ? { refundedAt: now } : {}),
        },
      });
    await vote(5000n, false);
    await vote(3000n, true);

    const other = await getOtherRevenueTotals(ym);
    expect(other.brokerFee).toBe(1000n);
    expect(other.shopSales).toBe(20000n);
    expect(other.talkSubscriptionFee).toBe(600n);
    expect(other.talkSessionFee).toBe(2000n);
    expect(other.voteTicketSales).toBe(5000n);
    expect(other.total).toBe(28600n);
    const split = splitVat(28600n);
    expect(other.supply).toBe(split.supply);
    expect(other.vat).toBe(split.vat);
    expect(other.supply + other.vat).toBe(28600n);

    // 기존 후원 수수료 집계는 그대로다 (샵 매출이 섞이지 않는다)
    const ledger = await getLedgerTotals(ym, true);
    expect(ledger.platformFee).toBe(0n);
  });

  it('다른 달에 환불된 팬투표권은 환불 달에 음수(감액)로 잡힌다', async () => {
    const user = await prisma.user.create({ data: { id: newId(), email: `r8-${newId()}@test.kr`, name: '팬', role: 'DONOR' } });
    const now = new Date();
    const lastMonth = new Date(now.getTime() - 40 * 86_400_000);
    await prisma.voteTicketOrder.create({
      data: { id: newId(), orderNo: `V-${newId()}`, userId: user.id, productName: '투표권', method: 'CARD', price: 1100n, tickets: 1, status: 'REFUNDED', paidAt: lastMonth, refundedAt: now },
    });
    const other = await getOtherRevenueTotals(kstMonthKey(now));
    expect(other.voteTicketSales).toBe(-1100n);
    expect(other.supply).toBe(-1000n);
    expect(other.vat).toBe(-100n);
    const prev = await getOtherRevenueTotals(kstMonthKey(lastMonth));
    expect(prev.voteTicketSales).toBe(1100n);
  });
});

describe('P3 비밀번호 재설정 메일 연동 조건', () => {
  const saved = { p: process.env.MAIL_PROVIDER, f: process.env.MAIL_FROM };
  afterEach(() => {
    if (saved.p === undefined) delete process.env.MAIL_PROVIDER; else process.env.MAIL_PROVIDER = saved.p;
    if (saved.f === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = saved.f;
  });

  it('MAIL_PROVIDER=ses 와 MAIL_FROM 이 모두 있어야 연동으로 본다', () => {
    delete process.env.MAIL_PROVIDER;
    delete process.env.MAIL_FROM;
    expect(isMailDeliveryIntegrated()).toBe(false);
    process.env.MAIL_PROVIDER = 'ses';
    expect(isMailDeliveryIntegrated()).toBe(false);
    process.env.MAIL_FROM = 'no-reply@donaido.kr';
    expect(isMailDeliveryIntegrated()).toBe(true);
  });

  it('모의 메일 어댑터는 발송 성공으로 처리하지 않는다', async () => {
    delete process.env.MAIL_PROVIDER;
    const r = await getMailAdapter().send({ to: 'a@test.kr', subject: 's', text: 't' });
    expect(r.ok).toBe(false);
  });
});
