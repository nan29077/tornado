import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { isoWeekOf, periodKey, periodLabel, periodRange, periodStartFromKey, previousPeriodKey } from '@/lib/vote-period';
import { maskContacts, personalize } from '@/lib/contact-mask';
import {
  DEFAULT_TALK_CONFIG, DEFAULT_VOTE_CONFIG, getCreatorEngagement, normalizeTalkConfig, resolveEngagement, saveTalkConfig, saveVoteConfig, splitFee,
} from '@/server/services/engagement/config';
import { getBalance, grantTickets, expireLots, sortLotsForSpend } from '@/server/services/vote/wallet';
import { castVote, voidVoteCast } from '@/server/services/vote/cast';
import { checkTicketRefund, purchaseTickets, refundTicketOrder } from '@/server/services/vote/purchase';
import { completeMockMission, grantOfferwallReward, revokeOfferwallReward } from '@/server/services/vote/offerwall';
import { finalizePeriod, getCreatorRanks, getRanking, rankTally } from '@/server/services/vote/ranking';
import { createRound } from '@/server/services/vote/rounds';
import { getFanThread, sendBroadcast, sendFanReply, subscribeTalk, refundTalkSubscription } from '@/server/services/talk/talk';
import {
  acceptSession, bookSession, cancelSessionByFan, fanCancelRefund, getSlots, parseRuleLines, rejectSession, replaceSlotRules, sendSessionMessage, sweepSessions,
} from '@/server/services/talk/sessions';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 투표·투표권·소통·1:1 (2026-11-17)
 * 투표권 초과 사용 방지, 무료→유료 사용 순서, 한도, 크리에이터별 요율 우선, 미사용 환불, 오퍼월 중복 지급 방지,
 * 랭킹·마감 확정·동점 규칙, 무효 처리, 소통 구독 정산·팬 답장 권한·연락처 가림, 1:1 전역 스위치·중복 예약 방지·환불 규칙
 */

let fx: Fixture;

async function member(name = '팬') {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'DONOR' } });
  return { id: u.id, name: u.name };
}

async function product(price = 1100n, tickets = 100, bonus = 10) {
  const id = newId();
  await prisma.voteTicketProduct.create({ data: { id, name: `투표권 ${tickets}`, price, tickets, bonus } });
  return id;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

describe('기간 키 (KST)', () => {
  it('일·주·월 키와 범위', () => {
    const at = new Date('2026-11-17T03:00:00Z'); // KST 12:00 화요일
    expect(periodKey('DAY', at)).toBe('2026-11-17');
    expect(periodKey('MONTH', at)).toBe('2026-11');
    expect(periodKey('WEEK', at)).toBe('2026-W47');
    const w = periodRange('WEEK', at);
    expect(w.start.toISOString()).toBe('2026-11-15T15:00:00.000Z'); // 월요일 00:00 KST
    expect(w.end.getTime() - w.start.getTime()).toBe(7 * 86_400_000);
    expect(previousPeriodKey('DAY', at)).toBe('2026-11-16');
    expect(previousPeriodKey('WEEK', at)).toBe('2026-W46');
    expect(previousPeriodKey('MONTH', new Date('2026-01-05T00:00:00Z'))).toBe('2025-12');
    // KST 자정 직전/직후
    expect(periodKey('DAY', new Date('2026-11-17T14:59:59Z'))).toBe('2026-11-17');
    expect(periodKey('DAY', new Date('2026-11-17T15:00:00Z'))).toBe('2026-11-18');
    expect(isoWeekOf(2027, 1, 1)).toEqual({ year: 2026, week: 53 });
    expect(periodStartFromKey('WEEK', '2026-W47')?.toISOString()).toBe('2026-11-15T15:00:00.000Z');
    expect(periodLabel('WEEK', '2026-W47')).toContain('47주차');
  });
});

describe('연락처 가림 · 닉네임', () => {
  it('전화·이메일·링크·메신저 아이디를 가린다', () => {
    const r = maskContacts('연락주세요 010-1234-5678 / a@b.co / https://x.io 카톡 id: abc123');
    expect(r.masked).toBe(true);
    expect(r.text).not.toMatch(/010|a@b|https|abc123/);
    expect(maskContacts('오늘 방송 너무 재밌었어요').masked).toBe(false);
    expect(personalize('{닉네임}님 안녕', '민수')).toBe('민수님 안녕');
  });
});

describe('설정 우선순위 (크리에이터별 지정 > 전역)', () => {
  it('비율·가격·권한', () => {
    const none = resolveEngagement(DEFAULT_VOTE_CONFIG, DEFAULT_TALK_CONFIG, null, null);
    expect(none.voteShareRate).toBe(0);
    expect(none.talkSub.price).toBe(DEFAULT_TALK_CONFIG.subPrice);
    expect(none.session.allowed).toBe(true);
    const policy = {
      voteShareRate: '0.1' as never, talkSubFeeRate: '0.2' as never, talkSubPriceMode: 'CREATOR', talkSubPrice: null, talkSubPriceMin: 3000n, talkSubPriceMax: 9000n,
      sessionFeeRate: null, sessionPriceMode: null, sessionPrice: 50000n, sessionPriceMin: null, sessionPriceMax: null, sessionAllowed: false,
    };
    const e = resolveEngagement(DEFAULT_VOTE_CONFIG, DEFAULT_TALK_CONFIG, policy, { subPrice: 20000n, sessionPrice: 1n });
    expect(e.voteShareRate).toBe(0.1);
    expect(e.voteShareSource).toBe('CREATOR');
    expect(e.talkSub.mode).toBe('CREATOR');
    expect(e.talkSub.price).toBe(9000); // 크리에이터 2만원 → 최대 9천원으로 제한
    expect(e.talkSub.feeRate).toBe(0.2);
    expect(e.session.mode).toBe('FIXED');
    expect(e.session.price).toBe(50000); // FIXED 면 크리에이터 가격 무시, 관리자 크리에이터별 가격
    expect(e.session.allowed).toBe(false);
    expect(splitFee(10000n, 0.3)).toEqual({ fee: 3000n, net: 7000n });
    expect(normalizeTalkConfig({ subPriceMin: 5000, subPriceMax: 1000 }).subPriceMax).toBe(5000);
  });
});

describe('투표권 지갑 · 충전 · 투표', () => {
  it('충전 → 무료부터 사용 → 잔액 부족 거절, 묶음 잔량은 음수가 되지 않는다', async () => {
    const u = await member();
    const pid = await product(1100n, 100, 10);
    const bought = await purchaseTickets(u, pid, 'CARD');
    expect(bought.ok).toBe(true);
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'FREE', amount: 30, source: 'OFFERWALL', ledgerType: 'OFFERWALL_EARN' }));
    expect(await getBalance(u.id)).toMatchObject({ total: 140, free: 30, paid: 100, bonus: 10 });

    const r1 = await castVote(u, { creatorId: fx.creatorId, votes: 35 });
    expect(r1.ok).toBe(true);
    const cast = await prisma.voteCast.findFirstOrThrow({ where: { userId: u.id } });
    expect([cast.fromFree, cast.fromBonus, cast.fromPaid]).toEqual([30, 5, 0]);
    const r2 = await castVote(u, { creatorId: fx.creatorId, votes: 200 });
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('부족');
    expect((await getBalance(u.id)).total).toBe(105);
  });

  it('동시에 여러 번 투표해도 보유량을 넘지 않는다', async () => {
    const u = await member();
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'FREE', amount: 3, source: 'ADMIN', ledgerType: 'ADMIN_GRANT' }));
    const results = await Promise.all(Array.from({ length: 6 }, () => castVote(u, { creatorId: fx.creatorId, votes: 1 })));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect((await getBalance(u.id)).total).toBe(0);
    const tally = await prisma.voteTally.findFirstOrThrow({ where: { periodType: 'ALL', creatorId: fx.creatorId } });
    expect(tally.votes).toBe(3n);
  });

  it('하루 한도와 1표당 소진 비율', async () => {
    await saveVoteConfig({ ...DEFAULT_VOTE_CONFIG, ticketsPerVote: 10, dailyMaxVotesPerCreator: 5 });
    const u = await member();
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'BONUS', amount: 1000, source: 'ADMIN', ledgerType: 'ADMIN_GRANT' }));
    expect((await castVote(u, { creatorId: fx.creatorId, votes: 4 })).ok).toBe(true);
    expect((await getBalance(u.id)).total).toBe(960);
    const over = await castVote(u, { creatorId: fx.creatorId, votes: 2 });
    expect(over.ok).toBe(false);
    expect(over.message).toContain('1표까지');
  });

  it('유료분 크리에이터 몫: 전역 0% 면 원장 없음, 크리에이터별 10% 지정이 우선', async () => {
    const u = await member();
    const pid = await product(10000n, 100, 0); // 1장 = 100원
    await purchaseTickets(u, pid, 'TRANSFER');
    await castVote(u, { creatorId: fx.creatorId, votes: 10 });
    expect(await prisma.settlementLedger.count({ where: { creatorId: fx.creatorId, entryType: 'VOTE_REVENUE_SHARE' } })).toBe(0);

    await prisma.creatorEngagementPolicy.create({ data: { id: newId(), creatorId: fx.creatorId, voteShareRate: '0.100000' } });
    await castVote(u, { creatorId: fx.creatorId, votes: 20 }); // 유료 20장 = 2,000원 × 10% = 200원
    const led = await prisma.settlementLedger.findMany({ where: { creatorId: fx.creatorId, entryType: 'VOTE_REVENUE_SHARE' } });
    expect(led.map((l) => l.amount)).toEqual([200n]);

    const cast = await prisma.voteCast.findFirstOrThrow({ where: { shareAmount: 200n } });
    await voidVoteCast(cast.id, 'admin', '부정 투표');
    const after = await prisma.settlementLedger.aggregate({ where: { creatorId: fx.creatorId, entryType: 'VOTE_REVENUE_SHARE' }, _sum: { amount: true } });
    expect(after._sum.amount).toBe(0n);
    const tally = await prisma.voteTally.findFirstOrThrow({ where: { periodType: 'ALL', creatorId: fx.creatorId } });
    expect(tally.votes).toBe(10n);
  });

  it('미사용 결제만 환불, 보너스도 회수', async () => {
    const u = await member();
    const pid = await product(5500n, 500, 30);
    await purchaseTickets(u, pid, 'CARD');
    const order = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: u.id } });
    expect((await checkTicketRefund(order.id)).refundable).toBe(true);
    const r = await refundTicketOrder(order.id, { type: 'USER', userId: u.id }, '단순 변심');
    expect(r.ok).toBe(true);
    expect((await getBalance(u.id)).total).toBe(0);
    expect((await prisma.shopPayment.findUniqueOrThrow({ where: { id: order.paymentId! } })).status).toBe('CANCELLED');

    await purchaseTickets(u, pid, 'CARD');
    await saveVoteConfig({ ...DEFAULT_VOTE_CONFIG, spendOrder: 'PAID_FIRST' });
    await castVote(u, { creatorId: fx.creatorId, votes: 1 });
    const order2 = await prisma.voteTicketOrder.findFirstOrThrow({ where: { userId: u.id, status: 'PAID' } });
    const r2 = await refundTicketOrder(order2.id, { type: 'USER', userId: u.id }, '변심');
    expect(r2.ok).toBe(false);
  });

  it('결제 실패(끝자리 999)면 투표권이 생기지 않는다', async () => {
    const u = await member();
    const pid = await product(1999n, 100, 0);
    const r = await purchaseTickets(u, pid, 'CARD');
    expect(r.ok).toBe(false);
    expect((await getBalance(u.id)).total).toBe(0);
  });

  it('유효기간이 지난 무료 투표권은 쓸 수 없고 만료 처리된다', async () => {
    const u = await member();
    const past = new Date(Date.now() - 100 * 86_400_000);
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'FREE', amount: 5, source: 'OFFERWALL', ledgerType: 'OFFERWALL_EARN', expiresInDays: 90 }, past));
    expect((await getBalance(u.id)).total).toBe(0);
    expect(await expireLots()).toBe(1);
    expect(await prisma.voteTicketLedger.count({ where: { userId: u.id, type: 'EXPIRE' } })).toBe(1);
    const sorted = sortLotsForSpend([{ bucket: 'PAID', expires_at: null }, { bucket: 'FREE', expires_at: null }], 'FREE_FIRST');
    expect(sorted[0].bucket).toBe('FREE');
  });

  it('내 채널에는 투표할 수 없다', async () => {
    const creatorUser = await prisma.user.findUniqueOrThrow({ where: { id: fx.creatorUserId } });
    const r = await castVote({ id: creatorUser.id }, { creatorId: fx.creatorId, votes: 1 });
    expect(r.ok).toBe(false);
  });
});

describe('오퍼월', () => {
  it('같은 거래 고유값은 한 번만 지급, 취소 시 남은 만큼 회수', async () => {
    const u = await member();
    const a = await grantOfferwallReward({ provider: 'mock', rewardKey: 'tx-1', userId: u.id, points: 20 });
    const b = await grantOfferwallReward({ provider: 'mock', rewardKey: 'tx-1', userId: u.id, points: 20 });
    expect(a).toMatchObject({ ok: true, duplicate: false, tickets: 20 });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect((await getBalance(u.id)).free).toBe(20);
    await castVote(u, { creatorId: fx.creatorId, votes: 5 });
    const rv = await revokeOfferwallReward('mock', 'tx-1', '부정 참여');
    expect(rv.revoked).toBe(15);
    expect((await getBalance(u.id)).total).toBe(0);
    // 계약 전 광고사는 꺼져 있다
    expect((await grantOfferwallReward({ provider: 'buzzvil', rewardKey: 'x', userId: u.id, points: 10 })).ok).toBe(false);
  });

  it('테스트 광고: 퀴즈 오답 거절, 하루 한 번', async () => {
    const u = await member();
    expect((await completeMockMission(u.id, 'mock-quiz-1', 0)).ok).toBe(false);
    expect(await completeMockMission(u.id, 'mock-quiz-1', 1)).toMatchObject({ ok: true, duplicate: false });
    expect(await completeMockMission(u.id, 'mock-quiz-1', 1)).toMatchObject({ ok: true, duplicate: true });
    expect((await getBalance(u.id)).free).toBe(15);
  });
});

describe('랭킹 · 마감 확정', () => {
  it('표 수 순, 동점이면 먼저 도달한 쪽이 위. 지난 기간은 확정 기록', async () => {
    const c2user = await prisma.user.create({ data: { id: newId(), email: `c2-${newId()}@t.kr`, role: 'CREATOR', name: '둘째' } });
    const c2 = await prisma.creatorProfile.create({ data: { id: newId(), userId: c2user.id, code: `TOR-${newId().slice(-4)}`, displayName: '둘째', status: 'APPROVED' } });
    const u = await member();
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'BONUS', amount: 100, source: 'ADMIN', ledgerType: 'ADMIN_GRANT' }));
    const yesterday = new Date(Date.now() - 86_400_000);
    await castVote(u, { creatorId: c2.id, votes: 5 }, yesterday);
    await castVote(u, { creatorId: fx.creatorId, votes: 5 }, new Date(yesterday.getTime() + 1000));
    const { rows } = await rankTally('DAY', periodKey('DAY', yesterday));
    expect(rows.map((r) => r.creator_id)).toEqual([c2.id, fx.creatorId]);
    expect(await finalizePeriod('DAY', periodKey('DAY', yesterday))).toBe(2);
    expect(await finalizePeriod('DAY', periodKey('DAY', yesterday))).toBe(0);

    await castVote(u, { creatorId: fx.creatorId, votes: 3 });
    const live = await getRanking('live');
    expect(live.rows[0]).toMatchObject({ creatorId: fx.creatorId, votes: 3, prevRank: 2 });
    const day = await getRanking('day');
    expect(day.rows.map((r) => r.votes)).toEqual([5, 5]);
    const ranks = await getCreatorRanks(fx.creatorId);
    expect(ranks.all).toEqual({ rank: 1, votes: 8 });
  });

  it('왕중왕전 회차 투표는 회차 집계에만 들어간다', async () => {
    const c2user = await prisma.user.create({ data: { id: newId(), email: `c3-${newId()}@t.kr`, role: 'CREATOR', name: '셋째' } });
    const c2 = await prisma.creatorProfile.create({ data: { id: newId(), userId: c2user.id, code: `TOR-${newId().slice(-4)}`, displayName: '셋째', status: 'APPROVED' } });
    const roundId = await createRound({ kind: 'CHAMPION', title: '11월 왕중왕전', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86_400_000), creatorIds: [fx.creatorId, c2.id], status: 'OPEN' }, 'admin');
    const u = await member();
    await prisma.$transaction((tx) => grantTickets(tx, { userId: u.id, bucket: 'FREE', amount: 10, source: 'ADMIN', ledgerType: 'ADMIN_GRANT' }));
    expect((await castVote(u, { creatorId: c2.id, votes: 4, roundId })).ok).toBe(true);
    const champ = await getRanking('champion');
    expect(champ.rows[0]).toMatchObject({ creatorId: c2.id, votes: 4 });
    expect(champ.rows[1]).toMatchObject({ creatorId: fx.creatorId, votes: 0 });
    expect(await prisma.voteTally.count({ where: { periodType: 'ALL' } })).toBe(0);
  });
});

describe('소통 (버블형 월 구독)', () => {
  async function openRoom() {
    await prisma.talkRoom.create({ data: { id: newId(), creatorId: fx.creatorId, open: true } });
  }

  it('구독 → 정산 원장(수수료 차감 후) · 팬 답장 권한 · 연락처 가림 · 닉네임 치환 · 환불 반대분개', async () => {
    const u = await member('민수');
    expect((await sendFanReply(u, fx.creatorId, '안녕')).ok).toBe(false);
    expect((await subscribeTalk(u, fx.creatorId, 'CARD')).ok).toBe(false); // 소통방이 닫혀 있다
    await openRoom();
    const sub = await subscribeTalk(u, fx.creatorId, 'CARD');
    expect(sub.ok).toBe(true);
    const led = await prisma.settlementLedger.findMany({ where: { creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS' } });
    expect(led.map((l) => l.amount)).toEqual([3430n]); // 4,900 - 30%(1,470)

    await sendBroadcast(fx.creatorId, '{닉네임}님 오늘도 고마워요');
    const reply = await sendFanReply(u, fx.creatorId, '제 번호 010-1111-2222 로 연락주세요');
    expect(reply.ok).toBe(true);
    expect(reply.masked).toBe(true);
    const thread = await getFanThread(u, fx.creatorId);
    expect(thread.allowed).toBe(true);
    expect(thread.messages.find((m) => m.kind === 'BROADCAST')?.body).toBe('민수님 오늘도 고마워요');
    expect(thread.messages.find((m) => m.mine)?.body).not.toContain('010');

    // 단체방(기본): 다른 구독자도 내 메시지를 작성자 이름과 함께 본다
    const other = await member('지수');
    await subscribeTalk(other, fx.creatorId, 'TRANSFER');
    const t2 = await getFanThread(other, fx.creatorId);
    const seen = t2.messages.find((m) => m.kind === 'FAN_REPLY');
    expect(seen?.mine).toBe(false);
    expect(seen?.authorName).toBe('민수');
    // 버블형: 다른 구독자에게는 보이지 않는다
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, roomMode: 'BUBBLE' });
    const t3 = await getFanThread(other, fx.creatorId);
    expect(t3.messages.some((m) => m.kind === 'FAN_REPLY')).toBe(false);

    const s = await prisma.talkSubscription.findFirstOrThrow({ where: { userId: u.id } });
    expect((await refundTalkSubscription(s.id, 'admin', '오류')).ok).toBe(true);
    const sum = await prisma.settlementLedger.aggregate({ where: { creatorId: fx.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS' }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(3430n); // 두 번째 팬 몫만 남는다
    expect((await sendFanReply(u, fx.creatorId, '또 왔어요')).ok).toBe(false);
  });

  it('이어서 결제하면 기존 만료일 뒤로 붙고, 하루 답장 한도가 지켜진다', async () => {
    await openRoom();
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, fanReplyDailyLimit: 2 });
    const u = await member();
    await subscribeTalk(u, fx.creatorId, 'CARD');
    await subscribeTalk(u, fx.creatorId, 'CARD');
    const subs = await prisma.talkSubscription.findMany({ where: { userId: u.id }, orderBy: { startsAt: 'asc' } });
    expect(subs[1].startsAt.getTime()).toBe(subs[0].endsAt.getTime());
    expect((await sendFanReply(u, fx.creatorId, '1')).ok).toBe(true);
    expect((await sendFanReply(u, fx.creatorId, '2')).ok).toBe(true);
    expect((await sendFanReply(u, fx.creatorId, '3')).ok).toBe(false);
  });

  it('크리에이터가 가격을 정할 권한이 있으면 그 가격(범위 안)으로 결제', async () => {
    await prisma.talkRoom.create({ data: { id: newId(), creatorId: fx.creatorId, open: true, subPrice: 9900n } });
    await prisma.creatorEngagementPolicy.create({ data: { id: newId(), creatorId: fx.creatorId, talkSubPriceMode: 'CREATOR', talkSubFeeRate: '0.100000' } });
    const eng = await getCreatorEngagement(fx.creatorId);
    expect(eng.talkSub.price).toBe(9900);
    const u = await member();
    await subscribeTalk(u, fx.creatorId, 'CARD');
    const s = await prisma.talkSubscription.findFirstOrThrow({ where: { userId: u.id } });
    expect([s.price, s.feeAmount, s.netAmount]).toEqual([9900n, 990n, 8910n]);
  });
});

describe('1:1 예약 채팅', () => {
  async function setupRoom() {
    await prisma.talkRoom.create({ data: { id: newId(), creatorId: fx.creatorId, open: true, sessionEnabled: true, sessionMinutes: 30 } });
    const rules = [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ weekday: wd, startMinute: 0, endMinute: 24 * 60 }));
    await replaceSlotRules(fx.creatorId, rules);
  }

  it('기본값은 켜짐이고, 전역 스위치를 끄면 신청할 수 없다', async () => {
    expect(DEFAULT_TALK_CONFIG.sessionEnabled).toBe(true);
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, sessionEnabled: false });
    await setupRoom();
    const u = await member();
    const { slots } = await getSlots(fx.creatorId);
    const r = await bookSession(u, fx.creatorId, slots[0].startsAt, 'CARD', '');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('꺼져');
  });

  it('신청 → 같은 시간 중복 불가 → 수락 → 종료 후 정산, 거절은 전액 환불', async () => {
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, sessionEnabled: true });
    await setupRoom();
    const u = await member();
    const u2 = await member();
    const { slots } = await getSlots(fx.creatorId);
    const target = slots.find((s) => s.available)!;
    const r = await bookSession(u, fx.creatorId, target.startsAt, 'CARD', '연락처 01012345678');
    expect(r.ok).toBe(true);
    const dup = await bookSession(u2, fx.creatorId, target.startsAt, 'CARD', '');
    expect(dup.ok).toBe(false);
    const s = await prisma.talkSession.findUniqueOrThrow({ where: { id: r.sessionId! } });
    expect(s.requestNote).not.toContain('0101234');

    expect((await acceptSession(fx.creatorId, s.id)).ok).toBe(true);
    // 시작 전 메시지 불가
    expect((await sendSessionMessage(s.id, { userId: u.id }, '안녕')).ok).toBe(false);
    // 진행 중
    const live = new Date(s.startsAt.getTime() + 60_000);
    expect((await sendSessionMessage(s.id, { userId: u.id }, '안녕하세요', live)).ok).toBe(true);
    // 크리에이터도 대화에 참여해야 완료·정산된다 (대화가 없으면 불참 환불, 2026-11-18)
    const creatorUser = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId }, select: { userId: true } });
    expect((await sendSessionMessage(s.id, { userId: creatorUser.userId, creatorId: fx.creatorId }, '반가워요', live)).ok).toBe(true);
    // 종료 후 정산
    const done = await sweepSessions(new Date(s.endsAt.getTime() + 1000));
    expect(done.completed).toBe(1);
    const led = await prisma.settlementLedger.findMany({ where: { creatorId: fx.creatorId, entryType: 'TALK_SESSION_PROCEEDS' } });
    expect(led.map((l) => l.amount)).toEqual([21000n]); // 30,000 - 30%

    const other = slots.filter((x) => x.available && x.startsAt !== target.startsAt)[2];
    const r2 = await bookSession(u2, fx.creatorId, other.startsAt, 'TRANSFER', '');
    expect((await rejectSession(fx.creatorId, r2.sessionId!, '일정 변경')).ok).toBe(true);
    const s2 = await prisma.talkSession.findUniqueOrThrow({ where: { id: r2.sessionId! } });
    expect(s2.status).toBe('REJECTED');
    expect(s2.refundAmount).toBe(30000n);
    // 거절된 시간은 다시 열린다
    expect((await bookSession(u, fx.creatorId, other.startsAt, 'CARD', '')).ok).toBe(true);
  });

  it('승인 기한이 지나면 자동 만료·환불, 구독자 취소 환불 규칙', async () => {
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, sessionEnabled: true });
    await setupRoom();
    const u = await member();
    const { slots } = await getSlots(fx.creatorId);
    const r = await bookSession(u, fx.creatorId, slots[slots.length - 1].startsAt, 'CARD', '');
    const s = await prisma.talkSession.findUniqueOrThrow({ where: { id: r.sessionId! } });
    const sw = await sweepSessions(new Date(s.approvalDeadline.getTime() + 1000));
    expect(sw.expired).toBe(1);
    expect((await prisma.talkSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('EXPIRED');

    const now = new Date();
    const base = { status: 'ACCEPTED', price: 30000n };
    expect(fanCancelRefund({ ...base, startsAt: new Date(now.getTime() + 48 * 3600_000) }, DEFAULT_TALK_CONFIG, now).refund).toBe(30000n);
    expect(fanCancelRefund({ ...base, startsAt: new Date(now.getTime() + 2 * 3600_000) }, DEFAULT_TALK_CONFIG, now).refund).toBe(15000n);
    expect(fanCancelRefund({ ...base, startsAt: new Date(now.getTime() - 1000) }, DEFAULT_TALK_CONFIG, now).allowed).toBe(false);

    const r3 = await bookSession(u, fx.creatorId, slots[slots.length - 2].startsAt, 'CARD', '');
    const c = await cancelSessionByFan(u.id, r3.sessionId!);
    expect(c.ok).toBe(true);
    expect((await prisma.talkSession.findUniqueOrThrow({ where: { id: r3.sessionId! } })).refundAmount).toBe(30000n);
  });

  it('가능 시간 입력 형식', () => {
    expect(parseRuleLines('월 20:00-23:00\n토 10:00~12:30')).toEqual([
      { weekday: 1, startMinute: 1200, endMinute: 1380 },
      { weekday: 6, startMinute: 600, endMinute: 750 },
    ]);
    expect(() => parseRuleLines('월요일 8시')).toThrow();
  });
});
