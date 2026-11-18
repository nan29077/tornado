import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { DEFAULT_TALK_CONFIG, saveTalkConfig } from '@/server/services/engagement/config';
import { purchaseTickets } from '@/server/services/vote/purchase';
import { grantTickets } from '@/server/services/vote/wallet';
import { donateToVideo } from '@/server/services/shop/video-donation';
import { requestRefund, approveRefund, retryRefundRecovery } from '@/server/services/refund';
import { appendLedger, computeHoldingAmount } from '@/server/services/settlement';
import { acceptSession, bookSession, getSlots, onlyPaidSessions, replaceSlotRules } from '@/server/services/talk/sessions';
import { subscribeTalk } from '@/server/services/talk/talk';
import { parseProductForm, saveProduct } from '@/server/services/shop/catalog';
import { replaceCreatorChannels, verifyCreatorChannels } from '@/server/services/creator-application';
import { cleanupMemberOnWithdraw, getWithdrawSummary } from '@/server/services/member-withdraw';
import { getShopPaymentAdapter, isShopPaymentOff, SHOP_PAYMENT_OFF_MESSAGE } from '@/server/adapters/shop-payment';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));

const session = vi.hoisted(() => ({ creator: null as null | { id: string; creatorId: string } }));
vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    requireCreator: vi.fn(async () => {
      if (!session.creator) throw new Error('크리에이터 권한이 필요합니다.');
      return { id: session.creator.id, creatorId: session.creator.creatorId, role: 'CREATOR', email: null, name: 'c', avatarIndex: 0 };
    }),
  };
});
const studio = await import('@/app/actions/studio');

/**
 * 2026-11-18 6차 점검 수정 회귀 테스트
 */

let fx: Fixture;

async function member(name = '팬') {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'DONOR' } });
  return { id: u.id, name: u.name };
}

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

async function setupRoom() {
  await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, sessionEnabled: true });
  await prisma.talkRoom.create({ data: { id: newId(), creatorId: fx.creatorId, open: true, sessionEnabled: true, sessionMinutes: 30 } });
  await replaceSlotRules(fx.creatorId, [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ weekday: wd, startMinute: 0, endMinute: 24 * 60 })));
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  session.creator = { id: fx.creatorUserId, creatorId: fx.creatorId };
});

describe('[P1-1] 샵 결제 off 모드 — 유료 결제를 "준비 중"으로 닫는다', () => {
  const saved = { APP_ENV: process.env.APP_ENV, SHOP: process.env.SHOP_PAYMENT_PROVIDER };
  afterEach(() => {
    process.env.APP_ENV = saved.APP_ENV;
    if (saved.SHOP === undefined) delete process.env.SHOP_PAYMENT_PROVIDER;
    else process.env.SHOP_PAYMENT_PROVIDER = saved.SHOP;
    vi.resetModules();
  });

  it('운영 점검: off 는 통과, mock 은 차단', async () => {
    process.env.APP_ENV = 'prod';
    process.env.SHOP_PAYMENT_PROVIDER = 'off';
    vi.resetModules();
    const { assertProductionSafety } = await import('@/lib/env');
    expect(assertProductionSafety().some((p) => p.includes('SHOP_PAYMENT_PROVIDER'))).toBe(false);
  });

  it('off 에서는 투표권·후원·소통 구독·1:1 예약이 결제 행을 만들지 않고 거절된다', async () => {
    await setupRoom();
    const pid = newId();
    await prisma.voteTicketProduct.create({ data: { id: pid, name: '팩', price: 5500n, tickets: 500, bonus: 0 } });
    const u = await member();
    const { slots } = await getSlots(fx.creatorId);
    process.env.SHOP_PAYMENT_PROVIDER = 'off';
    expect(isShopPaymentOff()).toBe(true);

    const results = [
      await purchaseTickets(u, pid, 'CARD'),
      await donateToVideo(u, { creatorId: fx.creatorId, videoRef: 'CARD', videoTitle: '카드', amount: 3000n, message: '', nickname: '팬', kind: 'CARD' }),
      await subscribeTalk(u, fx.creatorId, 'CARD'),
      await bookSession(u, fx.creatorId, slots.find((s) => s.available)!.startsAt, 'CARD', ''),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.message).toBe(SHOP_PAYMENT_OFF_MESSAGE);
    }
    expect(await prisma.shopPayment.count()).toBe(0);
    expect(await prisma.talkSession.count()).toBe(0);
    // 어댑터를 직접 불러도 승인·취소를 성공 처리하지 않는다
    const adapter = getShopPaymentAdapter();
    expect((await adapter.approve({ paymentNo: 'X', amount: 1000n, buyerName: 'a', itemName: 'b' })).ok).toBe(false);
    expect((await adapter.cancel({ paymentNo: 'X', providerTx: null, amount: 1000n, reason: 'r' })).ok).toBe(false);
  });
});

describe('[P1-2] 활동 카테고리 — 스튜디오에서 정하고 30일에 한 번 바꾼다', () => {
  it('처음 정하기는 바로, 바꾼 직후 다시 바꾸기는 거절', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { contentCategory: null, contentCategoryChangedAt: null } });
    const first = await studio.updateContentCategoryAction({ ok: false }, form({ contentCategory: 'game' }));
    expect(first.ok).toBe(true);
    const again = await studio.updateContentCategoryAction({ ok: false }, form({ contentCategory: 'music' }));
    expect(again.ok).toBe(false);
    expect(again.message).toContain('30일');
    // 31일이 지나면 다시 바꿀 수 있다
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { contentCategoryChangedAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect((await studio.updateContentCategoryAction({ ok: false }, form({ contentCategory: 'music' }))).ok).toBe(true);
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } })).contentCategory).toBe('music');
    // 목록에 없는 값은 거절
    expect((await studio.updateContentCategoryAction({ ok: false }, form({ contentCategory: 'nope' }))).ok).toBe(false);
  });
});

describe('[P1-3] 회원 탈퇴 — 진행 중인 일은 막고, 개인 데이터는 지운다', () => {
  it('진행 중 주문·예약은 탈퇴를 막고, 유료 투표권·구독은 동의 대상으로 센다', async () => {
    const u = await member();
    expect((await getWithdrawSummary(u.id)).blockers).toEqual([]);

    const payId = newId();
    await prisma.shopPayment.create({ data: { id: payId, paymentNo: `P${payId}`, userId: u.id, kind: 'ORDER', amount: 10000n, provider: 'mock', status: 'PAID' } });
    await prisma.shopOrder.create({
      data: { id: newId(), orderNo: `O${payId}`, paymentId: payId, userId: u.id, sellerType: 'ADMIN', status: 'PREPARING', itemsAmount: 10000n, shippingFee: 0n, totalAmount: 10000n, recipientMasked: '홍*동', recipientEnc: 'x', phoneMasked: '010', phoneEnc: 'x', zipcode: '06236', addressMasked: '서울', addressEnc: 'x' },
    });
    await prisma.talkSession.create({
      data: { id: newId(), sessionNo: `TC${payId}`, creatorId: fx.creatorId, userId: u.id, startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000 + 1_800_000), minutes: 30, price: 30000n, status: 'ACCEPTED', method: 'CARD', approvalDeadline: new Date(Date.now() + 3_600_000) },
    });
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'PAID', amount: 120, source: 'PURCHASE', ledgerType: 'PURCHASE', memo: '테스트' }));
    await prisma.talkSubscription.create({ data: { id: newId(), userId: u.id, creatorId: fx.creatorId, startsAt: new Date(), endsAt: new Date(Date.now() + 20 * 86_400_000), price: 4900n, method: 'CARD' } });

    const s = await getWithdrawSummary(u.id);
    expect(s.blockers).toHaveLength(2);
    expect(s.blockers.join(' ')).toContain('상품 주문');
    expect(s.blockers.join(' ')).toContain('1:1 채팅');
    expect(s.paidTickets).toBe(120);
    expect(s.activeSubs).toBe(1);
  });

  it('정리: 배송지·팔로우를 지우고, 남은 투표권은 원장에 기록하며 0 으로, 구독은 지금 끝낸다', async () => {
    const u = await member();
    await prisma.memberAddress.create({ data: { id: newId(), userId: u.id, recipientMasked: '홍*동', recipientEnc: 'x', phoneMasked: '010', phoneEnc: 'x', zipcode: '06236', addressMasked: '서울', addressEnc: 'x' } });
    await prisma.memberFollow.create({ data: { id: newId(), userId: u.id, creatorId: fx.creatorId } });
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'PAID', amount: 50, source: 'PURCHASE', ledgerType: 'PURCHASE', memo: '테스트' }));
    const subId = newId();
    await prisma.talkSubscription.create({ data: { id: subId, userId: u.id, creatorId: fx.creatorId, startsAt: new Date(), endsAt: new Date(Date.now() + 20 * 86_400_000), price: 4900n, netAmount: 3430n, method: 'CARD' } });

    await prisma.$transaction((tx) => cleanupMemberOnWithdraw(tx, u.id));

    expect(await prisma.memberAddress.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.memberFollow.count({ where: { userId: u.id } })).toBe(0);
    expect((await prisma.voteTicketLot.aggregate({ where: { userId: u.id }, _sum: { remaining: true } }))._sum.remaining).toBe(0);
    const forfeits = await prisma.voteTicketLedger.findMany({ where: { userId: u.id, type: 'WITHDRAW_FORFEIT' } });
    expect(forfeits.map((l) => l.delta)).toEqual([-50]);
    const sub = await prisma.talkSubscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.endsAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(sub.status).toBe('ACTIVE'); // 환불이 아니므로 크리에이터 수익 집계는 그대로
    const after = await getWithdrawSummary(u.id);
    expect(after.paidTickets).toBe(0);
    expect(after.activeSubs).toBe(0);
  });
});

describe('[P1-4] 채널 확인 — 새로 넣은 채널은 관리자 확인 전까지 쓰지 않는다', () => {
  const ch = (key: string, primary = false) => ({ platform: 'YOUTUBE', url: `https://www.youtube.com/@${key}`, urlKey: `youtube:${key}`, title: key, followerCount: null, isPrimary: primary, externalId: null });

  it('원래 확인된 채널은 유지, 새 채널은 확인 대기 · 대표 채널은 확인된 것만', async () => {
    await prisma.$transaction(async (tx) => {
      await replaceCreatorChannels(tx, fx.creatorId, [ch('mine', true)]);
      expect(await verifyCreatorChannels(tx, fx.creatorId)).toBe(1);
    });
    const r = await prisma.$transaction((tx) => replaceCreatorChannels(tx, fx.creatorId, [ch('mine'), ch('someone-else', true)], { keepVerified: true }));
    expect(r.pending).toBe(1);
    expect(r.cols).toMatchObject({ channelUrl: 'https://www.youtube.com/@mine' });
    const rows = await prisma.creatorChannel.findMany({ where: { creatorId: fx.creatorId }, orderBy: { urlKey: 'asc' } });
    expect(rows.map((c) => [c.urlKey, Boolean(c.verifiedAt)])).toEqual([['youtube:mine', true], ['youtube:someone-else', false]]);

    // 관리자가 확인하면 대표 채널 컬럼도 맞춰진다
    const pending = rows.find((c) => !c.verifiedAt)!;
    await prisma.$transaction((tx) => verifyCreatorChannels(tx, fx.creatorId, pending.id));
    const profile = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } });
    expect(profile.channelUrl).toBe('https://www.youtube.com/@someone-else');
  });

  it('확인된 채널이 하나도 없으면 대표 채널 컬럼을 바꾸지 않는다', async () => {
    const r = await prisma.$transaction((tx) => replaceCreatorChannels(tx, fx.creatorId, [ch('new-one', true)], { keepVerified: true }));
    expect(r.pending).toBe(1);
    expect(r.cols).toEqual({});
  });
});

describe('[P1-5] 1:1 채팅 — 결제가 끝난 신청만 수락한다', () => {
  it('결제 대기(READY) 신청은 수락 거절·목록 제외, 결제 완료 신청은 수락', async () => {
    await setupRoom();
    const u = await member();
    const { slots } = await getSlots(fx.creatorId);
    const r = await bookSession(u, fx.creatorId, slots.find((s) => s.available)!.startsAt, 'CARD', '');
    expect(r.ok).toBe(true);
    const s = await prisma.talkSession.findUniqueOrThrow({ where: { id: r.sessionId! } });

    await prisma.shopPayment.update({ where: { id: s.paymentId! }, data: { status: 'READY' } });
    expect(await onlyPaidSessions([s])).toHaveLength(0);
    const refused = await acceptSession(fx.creatorId, s.id);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('결제');
    expect((await prisma.talkSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('REQUESTED');

    await prisma.shopPayment.update({ where: { id: s.paymentId! }, data: { status: 'PAID' } });
    expect(await onlyPaidSessions([s])).toHaveLength(1);
    expect((await acceptSession(fx.creatorId, s.id)).ok).toBe(true);
  });
});

describe('[P2-1] 후원 외 수익 보류 — 환불된 건은 보류에서 빠진다', () => {
  it('3일 전 적립 + 오늘 환불 반대분개(같은 #id) → 보류 0', async () => {
    const subId = newId();
    const d3 = new Date(Date.now() - 3 * 86_400_000);
    await appendLedger([{ creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: 3430n, memo: `소통 구독 TSX (4900원 - 수수료 1470원) #${subId}`, occurredAt: d3 }]);
    expect(await computeHoldingAmount(fx.creatorId)).toBe(3430n);
    await appendLedger([{ creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: -3430n, memo: `소통 구독 환불 반대분개 (관리자 a: 테스트) #${subId}`, occurredAt: new Date() }]);
    expect(await computeHoldingAmount(fx.creatorId)).toBe(0n);
  });

  it('다른 건의 환불은 서로 상쇄하지 않는다 · 1:1 채팅 번호로도 묶인다', async () => {
    const now = new Date();
    const d2 = new Date(Date.now() - 2 * 86_400_000);
    await appendLedger([
      { creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: 3000n, memo: `소통 구독 A #${newId()}`, occurredAt: now },
      { creatorId: fx.creatorId, entryType: 'TALK_SESSION_PROCEEDS', amount: 21000n, memo: '1:1 채팅 TCABCDEFGH123456 (30000원 - 수수료 9000원)', occurredAt: d2 },
    ]);
    expect(await computeHoldingAmount(fx.creatorId)).toBe(24000n);
    await appendLedger([{ creatorId: fx.creatorId, entryType: 'TALK_SESSION_PROCEEDS', amount: -21000n, memo: '1:1 채팅 환불 반대분개 TCABCDEFGH123456', occurredAt: now }]);
    expect(await computeHoldingAmount(fx.creatorId)).toBe(3000n);
  });
});

describe('[P2-3·4] 샵 상품 — 크리에이터 외부 이미지 차단 · 재고는 바꾼 만큼만', () => {
  it('크리에이터 상품은 외부 이미지 주소를 거절, 관리자 상품은 허용', () => {
    const base = { name: '굿즈', price: '10000', status: 'ON_SALE', variants: '기본 | 0 | 5' };
    expect(() => parseProductForm(form({ ...base, thumbnailUrl: 'https://tracker.example.com/p.png' }), { forAdmin: false })).toThrow(/파일 업로드/);
    expect(parseProductForm(form({ ...base, thumbnailUrl: 'https://images.example.com/p.png' }), { forAdmin: true }).thumbnailUrl).toBe('https://images.example.com/p.png');
    const own = `/api/media/${'a'.repeat(32)}.png`;
    expect(parseProductForm(form({ ...base, thumbnailUrl: own }), { forAdmin: false }).thumbnailUrl).toBe(own);
  });

  it('수정 화면을 연 뒤 팔린 수량은 저장해도 되살아나지 않는다', async () => {
    const pid = await saveProduct(parseProductForm(form({ name: '굿즈', price: '10000', status: 'ON_SALE', variants: 'A | 0 | 10\nB | 0 | 4' }), { forAdmin: true }), { type: 'ADMIN' });
    // 화면이 열린 사이 A 가 3개 팔렸다
    await prisma.productVariant.updateMany({ where: { productId: pid, name: 'A' }, data: { stock: 7 } });
    // 설명만 고쳐 저장 (재고 칸은 열었을 때 값 그대로) + B 는 2개 더 입고
    const fd = form({ id: pid, name: '굿즈 수정', price: '10000', status: 'ON_SALE', variants: 'A | 0 | 10\nB | 0 | 6', variantsBase: 'A | 0 | 10\nB | 0 | 4' });
    await saveProduct(parseProductForm(fd, { forAdmin: true }), { type: 'ADMIN' }, pid);
    const rows = await prisma.productVariant.findMany({ where: { productId: pid }, orderBy: { name: 'asc' } });
    expect(rows.map((v) => [v.name, v.stock])).toEqual([['A', 7], ['B', 6]]);
  });
});

describe('[P2-5] 샵 후원 환불 — 통신 오류는 실패로 단정하지 않고, 반영 실패는 재시도로 잇는다', () => {
  async function refundable() {
    const u = await member();
    const r = await donateToVideo(u, { creatorId: fx.creatorId, videoRef: 'CARD', videoTitle: '카드', amount: 3000n, message: '', nickname: '팬', kind: 'CARD' });
    expect(r.ok).toBe(true);
    const donation = await prisma.donation.findFirstOrThrow({ where: { creatorId: fx.creatorId, channel: 'SHOP' } });
    return { donation, refund: await requestRefund({ donationId: donation.id, reason: '테스트 환불' }) };
  }

  it('취소 호출이 예외로 끝나면 재시도 대기, [재시도]로 환불 완료 (원장 반대분개는 한 번)', async () => {
    const { donation, refund } = await refundable();
    const spy = vi.spyOn(getShopPaymentAdapter(), 'cancel').mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(approveRefund(refund.id)).rejects.toThrow(/확인하지 못했습니다/);
    spy.mockRestore();
    const mid = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(mid.status).toBe('PENDING_RECOVERY');
    expect(mid.resultCode).toBe('SHOP_CANCEL_UNKNOWN');
    expect(await prisma.settlementLedger.count({ where: { donationId: donation.id, entryType: 'REFUND' } })).toBe(0);

    const done = await retryRefundRecovery(refund.id);
    expect(done?.status).toBe('DONE');
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: donation.id } })).status).toBe('REFUNDED');
    expect((await prisma.settlementLedger.findMany({ where: { donationId: donation.id, entryType: 'REFUND' } })).map((l) => l.amount)).toEqual([-3000n]);
  });

  it('취소는 끝났는데 반영만 실패했던 건은 결제사를 다시 부르지 않고 반영만 한다', async () => {
    const { donation, refund } = await refundable();
    await prisma.refund.update({ where: { id: refund.id }, data: { status: 'PENDING_RECOVERY', resultCode: 'SHOP_CANCEL_DONE' } });
    const spy = vi.spyOn(getShopPaymentAdapter(), 'cancel');
    const done = await retryRefundRecovery(refund.id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(done?.status).toBe('DONE');
    expect((await prisma.settlementLedger.findMany({ where: { donationId: donation.id, entryType: 'REFUND' } })).map((l) => l.amount)).toEqual([-3000n]);
  });

  it('결제사가 명확히 거절하면 실패로 확정', async () => {
    const { refund } = await refundable();
    const spy = vi.spyOn(getShopPaymentAdapter(), 'cancel').mockResolvedValueOnce({ ok: false, reason: '취소 불가' });
    await expect(approveRefund(refund.id)).rejects.toThrow(/취소에 실패/);
    spy.mockRestore();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('FAILED');
  });
});
