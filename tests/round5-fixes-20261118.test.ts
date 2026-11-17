import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { DEFAULT_TALK_CONFIG, saveTalkConfig } from '@/server/services/engagement/config';
import { castVote } from '@/server/services/vote/cast';
import { checkTicketRefund, purchaseTickets, refundTicketOrder } from '@/server/services/vote/purchase';
import { expireLots } from '@/server/services/vote/wallet';
import { getCategoryLeaders, getCreatorRanks, getRanking } from '@/server/services/vote/ranking';
import { donateToVideo } from '@/server/services/shop/video-donation';
import { requestRefund, approveRefund } from '@/server/services/refund';
import { appendLedger, computeHoldingAmount } from '@/server/services/settlement';
import { acceptSession, bookSession, getSlots, parseRuleLines, replaceSlotRules, sendSessionMessage, sweepSessions } from '@/server/services/talk/sessions';
import { reportTalkMessage, sendBroadcast, getFanThread, setTalkBlock, sendFanReply, subscribeTalk } from '@/server/services/talk/talk';
import { reconcileStaleShopPayments } from '@/server/services/shop/reconcile';
import { cancelShopPayment, retryPendingShopCancel } from '@/server/services/shop/payment-cancel';
import { isOwnUploadUrl } from '@/server/uploads';
import { csvRow } from '@/lib/csv';
import { getShopPaymentAdapter } from '@/server/adapters/shop-payment';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 2026-11-18 5차 점검 수정 + 카테고리별 투표 회귀 테스트
 */

let fx: Fixture;

async function member(name = '팬') {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'DONOR' } });
  return { id: u.id, name: u.name };
}

async function creator(name: string, category: string | null) {
  const u = await prisma.user.create({ data: { id: newId(), email: `c-${newId()}@test.kr`, name, role: 'CREATOR' } });
  const c = await prisma.creatorProfile.create({ data: { id: newId(), userId: u.id, code: `TOR-${newId().slice(-5)}`, displayName: name, status: 'APPROVED', contentCategory: category } });
  return c.id;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

describe('[P0-1] 운영에서 샵 결제 mock 이면 기동을 막는다', () => {
  const saved = { APP_ENV: process.env.APP_ENV, SHOP: process.env.SHOP_PAYMENT_PROVIDER };
  afterEach(() => {
    process.env.APP_ENV = saved.APP_ENV;
    if (saved.SHOP === undefined) delete process.env.SHOP_PAYMENT_PROVIDER;
    else process.env.SHOP_PAYMENT_PROVIDER = saved.SHOP;
    vi.resetModules();
  });
  it('SHOP_PAYMENT_PROVIDER=mock → 운영 점검 실패 사유에 포함', async () => {
    process.env.APP_ENV = 'prod';
    process.env.SHOP_PAYMENT_PROVIDER = 'mock';
    vi.resetModules();
    const { assertProductionSafety } = await import('@/lib/env');
    expect(assertProductionSafety().some((p) => p.includes('SHOP_PAYMENT_PROVIDER'))).toBe(true);
  });
});

describe('[PAY-B] 투표권 보너스를 쓰면 환불할 수 없다', () => {
  it('보너스만 써도 환불 거절, 아무것도 안 쓰면 환불, 보너스가 만료로 사라진 것은 사용이 아니다', async () => {
    const pid = newId();
    await prisma.voteTicketProduct.create({ data: { id: pid, name: '팩', price: 5500n, tickets: 500, bonus: 30 } });
    const u = await member();
    const b = await purchaseTickets(u, pid, 'CARD');
    expect(b.ok).toBe(true);
    // 기본 사용 순서(무료 → 보너스 → 유료): 보너스 10개만 쓴다
    expect((await castVote(u, { creatorId: fx.creatorId, votes: 10 })).ok).toBe(true);
    const order = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: u.id } });
    const chk = await checkTicketRefund(order.id);
    expect(chk.refundable).toBe(false);
    expect(chk.reason).toContain('보너스');
    expect((await refundTicketOrder(order.id, { type: 'USER', userId: u.id }, '테스트')).ok).toBe(false);

    const u2 = await member();
    await purchaseTickets(u2, pid, 'CARD');
    const o2 = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: u2.id } });
    // 보너스 묶음을 만료시킨다 (사용 아님)
    await prisma.voteTicketLot.update({ where: { id: o2.bonusLotId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireLots();
    expect((await checkTicketRefund(o2.id)).refundable).toBe(true);
    const r = await refundTicketOrder(o2.id, { type: 'USER', userId: u2.id }, '테스트');
    expect(r.ok).toBe(true);
  });
});

describe('[PAY-A·C] 영상·카드 후원: 자기 후원 차단 · 한도 · 환불', () => {
  it('내 채널 후원은 거절', async () => {
    const owner = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId }, select: { userId: true } });
    const r = await donateToVideo({ id: owner.userId, name: '본인' }, { creatorId: fx.creatorId, videoRef: 'CARD', videoTitle: '카드', amount: 3000n, message: '', nickname: '본인', kind: 'CARD' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('내 채널');
  });

  it('하루 한도를 넘으면 거절 (후원 한도 정책 값 사용)', async () => {
    await prisma.donationLimitPolicy.updateMany({ where: { scope: 'GLOBAL' }, data: { donorDailyLimit: 5000n } });
    const u = await member();
    const input = { creatorId: fx.creatorId, videoRef: 'CARD', videoTitle: '카드', amount: 3000n, message: '', nickname: '팬', kind: 'CARD' as const };
    expect((await donateToVideo(u, input)).ok).toBe(true);
    const second = await donateToVideo(u, input);
    expect(second.ok).toBe(false);
    expect(second.message).toContain('하루 후원 한도');
  });

  it('관리자 환불: 샵 결제를 취소하고 원장 반대분개, 후원은 환불 완료', async () => {
    const u = await member();
    const r = await donateToVideo(u, { creatorId: fx.creatorId, videoRef: 'CARD', videoTitle: '카드', amount: 3000n, message: '고마워요', nickname: '팬', kind: 'CARD' });
    expect(r.ok).toBe(true);
    const donation = await prisma.donation.findFirstOrThrow({ where: { creatorId: fx.creatorId, channel: 'SHOP' } });
    const pay = await prisma.shopPayment.findFirstOrThrow({ where: { donationId: donation.id } });
    expect(pay.creatorId).toBe(fx.creatorId);
    const refund = await requestRefund({ donationId: donation.id, reason: '테스트 환불' });
    const done = await approveRefund(refund.id);
    expect(done?.status).toBe('DONE');
    expect((await prisma.donation.findUniqueOrThrow({ where: { id: donation.id } })).status).toBe('REFUNDED');
    expect((await prisma.shopPayment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe('CANCELLED');
    const refundLedger = await prisma.settlementLedger.findMany({ where: { donationId: donation.id, entryType: 'REFUND' } });
    expect(refundLedger.map((l) => l.amount)).toEqual([-3000n]);
  });
});

describe('[SET-A] 후원이 아닌 수익도 정산 보류 기간을 지킨다', () => {
  it('오늘 적립한 소통 구독 정산은 보류, 40일 전 적립은 출금 가능', async () => {
    await appendLedger([{ creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: 3430n, memo: '테스트', occurredAt: new Date() }]);
    expect(await computeHoldingAmount(fx.creatorId)).toBe(3430n);
    await resetDb();
    fx = await seedBasics();
    await appendLedger([{ creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: 3430n, memo: '테스트', occurredAt: new Date(Date.now() - 30 * 86_400_000) }]);
    expect(await computeHoldingAmount(fx.creatorId)).toBe(0n);
  });
});

describe('[TALK-A·B · P2-10] 1:1 채팅', () => {
  async function setupRoom() {
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, sessionEnabled: true });
    await prisma.talkRoom.create({ data: { id: newId(), creatorId: fx.creatorId, open: true, sessionEnabled: true, sessionMinutes: 30 } });
    await replaceSlotRules(fx.creatorId, [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ weekday: wd, startMinute: 0, endMinute: 24 * 60 })));
  }

  it('크리에이터가 한 마디도 안 하면 종료 후 정산 없이 전액 환불(불참)', async () => {
    await setupRoom();
    const u = await member();
    const { slots } = await getSlots(fx.creatorId);
    const r = await bookSession(u, fx.creatorId, slots.find((s) => s.available)!.startsAt, 'CARD', '');
    expect(r.ok).toBe(true);
    await acceptSession(fx.creatorId, r.sessionId!);
    const s = await prisma.talkSession.findUniqueOrThrow({ where: { id: r.sessionId! } });
    await sendSessionMessage(s.id, { userId: u.id }, '계세요?', new Date(s.startsAt.getTime() + 60_000));
    const sw = await sweepSessions(new Date(s.endsAt.getTime() + 1000));
    expect(sw.completed).toBe(0);
    const after = await prisma.talkSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe('NO_SHOW');
    expect(after.refundAmount).toBe(30000n);
    expect(await prisma.settlementLedger.count({ where: { creatorId: fx.creatorId, entryType: 'TALK_SESSION_PROCEEDS' } })).toBe(0);
  });

  it('겹치는 가능 시간 입력은 거절', () => {
    expect(() => parseRuleLines('월 20:00-23:00\n월 22:00-23:30')).toThrow(/겹칩니다/);
    expect(parseRuleLines('월 20:00-22:00\n월 22:00-23:00')).toHaveLength(2);
  });

  it('가격이 0원이면 신청할 수 없다', async () => {
    await setupRoom();
    await prisma.creatorEngagementPolicy.create({ data: { id: newId(), creatorId: fx.creatorId, sessionPrice: 0n } });
    const u = await member();
    const { slots } = await getSlots(fx.creatorId);
    const r = await bookSession(u, fx.creatorId, slots.find((s) => s.available)!.startsAt, 'CARD', '');
    expect(r.ok).toBe(false);
  });
});

describe('[P2-13] 소통 신고 권한 · 차단된 구독자', () => {
  it('구독한 적 없는 회원은 신고할 수 없고, 차단된 구독자는 다른 구독자 메시지를 보지 않는다', async () => {
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG });
    await prisma.talkRoom.create({ data: { id: newId(), creatorId: fx.creatorId, open: true } });
    const a = await member('가');
    const b = await member('나');
    expect((await subscribeTalk(a, fx.creatorId, 'CARD')).ok).toBe(true);
    expect((await subscribeTalk(b, fx.creatorId, 'CARD')).ok).toBe(true);
    await sendBroadcast(fx.creatorId, '안녕하세요');
    await sendFanReply(a, fx.creatorId, '가의 메시지');
    const msg = await prisma.talkMessage.findFirstOrThrow({ where: { kind: 'FAN_REPLY' } });
    const stranger = await member('외부');
    expect((await reportTalkMessage({ target: 'MESSAGE', messageId: msg.id, reporterUserId: stranger.id, reporterRole: 'FAN', reason: '스팸' })).ok).toBe(false);
    expect((await reportTalkMessage({ target: 'MESSAGE', messageId: msg.id, reporterUserId: b.id, reporterRole: 'FAN', reason: '스팸' })).ok).toBe(true);

    await setTalkBlock(fx.creatorId, b.id, true);
    const t = await getFanThread(b, fx.creatorId);
    expect(t.allowed).toBe(true);
    expect(t.messages.some((m) => m.kind === 'BROADCAST')).toBe(true);
    expect(t.messages.some((m) => m.kind === 'FAN_REPLY' && !m.mine)).toBe(false);
  });
});

describe('[P2-1·2·3] 멈춘 결제 정리 · 취소 재시도', () => {
  it('30분 넘은 READY 결제는 실패로 정리된다 (mock)', async () => {
    const u = await member();
    const pid = newId();
    await prisma.shopPayment.create({ data: { id: pid, paymentNo: `SHP${newId()}`, userId: u.id, kind: 'VOTE_TICKET', amount: 1100n, provider: 'mock', createdAt: new Date(Date.now() - 40 * 60_000) } });
    const r = await reconcileStaleShopPayments();
    expect(r.failed).toBe(1);
    expect((await prisma.shopPayment.findUniqueOrThrow({ where: { id: pid } })).status).toBe('FAILED');
  });

  it('결제사 취소가 실패하면 대기 금액으로 남고, 재시도로 비운다', async () => {
    const u = await member();
    const pid = newId();
    await prisma.shopPayment.create({ data: { id: pid, paymentNo: `TS${newId()}`, userId: u.id, kind: 'TALK_SUBSCRIPTION', amount: 4900n, provider: 'mock', status: 'PAID' } });
    const adapter = getShopPaymentAdapter();
    const spy = vi.spyOn(adapter, 'cancel').mockResolvedValueOnce({ ok: false, reason: '결제사 점검' });
    const out = await cancelShopPayment(pid, 4900n, '테스트');
    expect(out.done).toBe(false);
    expect((await prisma.shopPayment.findUniqueOrThrow({ where: { id: pid } })).cancelPendingAmount).toBe(4900n);
    spy.mockRestore();
    const again = await retryPendingShopCancel(pid);
    expect(again.ok).toBe(true);
    const p = await prisma.shopPayment.findUniqueOrThrow({ where: { id: pid } });
    expect(p.cancelPendingAmount).toBe(0n);
    expect(p.status).toBe('CANCELLED');
  });
});

describe('[P2-7·12] 발주서 CSV 텍스트 열 · 소통 사진 주소', () => {
  it('연락처·우편번호는 앞자리 0 을 지킨다', () => {
    expect(csvRow(['010-1234-5678', '04524'], ['text', 'text'])).toBe('"=""010-1234-5678""","=""04524"""');
  });
  it('업로드 저장소 주소만 허용', () => {
    expect(isOwnUploadUrl(`/api/media/${'a'.repeat(32)}.png`)).toBe(true);
    expect(isOwnUploadUrl('https://evil.example/pixel.png')).toBe(false);
    expect(isOwnUploadUrl('//evil.example/x.png')).toBe(false);
    expect(isOwnUploadUrl('/api/media/../secret.png')).toBe(false);
  });
});

describe('카테고리별 투표 · 랭킹 (2026-11-18)', () => {
  it('한 표가 전체·카테고리 랭킹에 함께 들어가고, 카테고리 순위는 카테고리 안에서 매긴다', async () => {
    const g1 = await creator('게임1', 'game');
    const g2 = await creator('게임2', 'game');
    const m1 = await creator('먹방1', 'mukbang');
    const u = await member();
    await prisma.voteTicketLot.create({ data: { id: newId(), userId: u.id, bucket: 'FREE', amount: 1000, remaining: 1000, source: 'ADMIN' } });
    expect((await castVote(u, { creatorId: m1, votes: 50 })).ok).toBe(true);
    expect((await castVote(u, { creatorId: g1, votes: 30 })).ok).toBe(true);
    expect((await castVote(u, { creatorId: g2, votes: 10 })).ok).toBe(true);

    const all = await getRanking('live');
    expect(all.rows.map((r) => r.creatorId)).toEqual([m1, g1, g2]);
    const game = await getRanking('live', { category: 'game' });
    expect(game.rows.map((r) => [r.creatorId, r.rank])).toEqual([[g1, 1], [g2, 2]]);
    expect(game.title).toContain('게임');

    const ranks = await getCreatorRanks(g1, new Date(), 'game');
    expect(ranks.live.rank).toBe(1);
    expect((await getCreatorRanks(g1)).live.rank).toBe(2);

    const leaders = await getCategoryLeaders('live', { perCategory: 3 });
    expect(leaders.map((l) => l.category)).toEqual(['mukbang', 'game']);
    expect(leaders[1]).toMatchObject({ totalVotes: 40, creators: 2 });
  });
});
