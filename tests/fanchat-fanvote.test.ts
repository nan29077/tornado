import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { periodKey, previousPeriodKey } from '@/lib/vote-period';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { DEFAULT_TALK_CONFIG, DEFAULT_VOTE_CONFIG, normalizeTalkConfig, normalizeVoteConfig, saveTalkConfig, saveVoteConfig } from '@/server/services/engagement/config';
import {
  bundleRateFor, dispatchDueTalkNotifications, getComposerState, getFanThread, quoteBundle, refundTalkSubscription, replyLengthFor, searchFanArchive, sendBroadcast,
  sendDirect, sendFanReply, sendLetter, setRoomNickname, splitBundle, subscribeBundle, subscribeTalk, subscribedDays, toggleFanReaction, deleteTalkMessage,
  getCreatorTimeline, listCreatorLetters, replyLetter,
} from '@/server/services/talk/talk';
import { publishTalkSignal, subscribeTalkSignals } from '@/server/services/talk/bus';
import { getBalance, grantTickets } from '@/server/services/vote/wallet';
import { castVote } from '@/server/services/vote/cast';
import {
  attendanceReward, checkAttendance, claimMission, getFanCard, levelOf, listMissions, logShare, postCheer, redeemReferralCode, getOrCreateFanProfile, deleteCheer,
} from '@/server/services/vote/fan';
import { cancelSupport, contributeSupport, createSupport, settleExpiredSupports } from '@/server/services/vote/support';
import { createRewardPolicy, issuePeriodRewards, listRewardGrants, updateRewardGrant } from '@/server/services/vote/rewards';
import { finalizePeriod } from '@/server/services/vote/ranking';
import { closeEndedRounds, createRound } from '@/server/services/vote/rounds';
import { monthAnniversaries, saveAnniversary } from '@/server/services/vote/anniversary';
import { sniffTalkMedia } from '@/server/talk-media';
import { isOwnTalkMediaUrl } from '@/server/uploads';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 팬챗(버블형) · 팬투표 고도화 (2026-11-18)
 */

let fx: Fixture;
const DAY = 86_400_000;

async function member(name = '팬', createdAt?: Date) {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'DONOR', ...(createdAt ? { createdAt } : {}) } });
  return { id: u.id, name: u.name };
}

async function creator(name: string) {
  const u = await prisma.user.create({ data: { id: newId(), email: `c-${newId()}@test.kr`, name, role: 'CREATOR' } });
  const c = await prisma.creatorProfile.create({ data: { id: newId(), userId: u.id, code: `TOR-${newId().slice(-5)}`, displayName: name, status: 'APPROVED' } });
  return c.id;
}

async function openRoom(creatorId: string) {
  await prisma.talkRoom.upsert({ where: { creatorId }, create: { id: newId(), creatorId, open: true }, update: { open: true } });
}

async function freeTickets(userId: string, n: number) {
  await prisma.$transaction((tx) => grantTickets(tx, { userId, bucket: 'FREE', amount: n, source: 'ADMIN', ledgerType: 'ADMIN_GRANT' }));
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

// ====================================================================== 팬챗

describe('팬챗 설정 · 계산', () => {
  it('기본은 버블형, 저장된 단체방 설정은 유지, 단계·할인 정규화', () => {
    expect(normalizeTalkConfig(undefined).roomMode).toBe('BUBBLE');
    expect(normalizeTalkConfig({ roomMode: 'GROUP' }).roomMode).toBe('GROUP');
    const c = normalizeTalkConfig({ replyLengthTiers: [{ days: 30, length: 100 }, { days: 0, length: 40 }, { days: 30, length: 999 }, { days: -1, length: 10 }], bundleDiscounts: [{ count: 3, rate: 0.9 }, { count: 2, rate: 0.05 }] });
    expect(c.replyLengthTiers).toEqual([{ days: 0, length: 40 }, { days: 30, length: 100 }]);
    expect(c.bundleDiscounts).toEqual([{ count: 2, rate: 0.05 }]); // 50% 넘는 할인은 버린다
  });

  it('D+N · 글자 수 단계 · 묶음 할인 나누기', () => {
    const now = new Date('2026-11-18T00:00:00Z');
    expect(subscribedDays([{ startsAt: now, endsAt: new Date(now.getTime() + 30 * DAY) }], now)).toBe(1);
    // 30일 구독 후 끊겼다가 다시 10일째 → D+40
    const spans = [
      { startsAt: new Date(now.getTime() - 100 * DAY), endsAt: new Date(now.getTime() - 70 * DAY) },
      { startsAt: new Date(now.getTime() - 10 * DAY), endsAt: new Date(now.getTime() + 20 * DAY) },
    ];
    expect(subscribedDays(spans, now)).toBe(41);
    const tiers = DEFAULT_TALK_CONFIG.replyLengthTiers;
    expect(replyLengthFor(1, tiers, 300)).toEqual({ length: 50, next: { days: 14, length: 80 } });
    expect(replyLengthFor(120, tiers, 150)).toEqual({ length: 150, next: { days: 200, length: 150 } });
    expect(replyLengthFor(500, tiers, 300).next).toBeNull();
    expect(bundleRateFor(1, DEFAULT_TALK_CONFIG.bundleDiscounts)).toBe(0);
    expect(bundleRateFor(4, DEFAULT_TALK_CONFIG.bundleDiscounts)).toBe(0.1);
    const parts = splitBundle([4900, 4900, 9900], 0.1);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.round(19700 * 0.9));
  });

  it('미디어 판정 · 우리 저장소 주소만 허용', () => {
    const ftyp = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0]);
    expect(sniffTalkMedia(ftyp, 'VIDEO')).toBe('mp4');
    expect(sniffTalkMedia(ftyp, 'VOICE')).toBe('m4a');
    expect(sniffTalkMedia(Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'), 'VOICE')).toBe('mp3');
    expect(sniffTalkMedia(Buffer.from('<html><body>xx</body>'), 'VOICE')).toBeNull();
    expect(isOwnTalkMediaUrl(`/api/media/${'a'.repeat(32)}.webm`, 'VOICE')).toBe(true);
    expect(isOwnTalkMediaUrl(`/api/media/${'a'.repeat(32)}.mp4`, 'VOICE')).toBe(false);
    expect(isOwnTalkMediaUrl('https://evil.example/x.mp4', 'VIDEO')).toBe(false);
  });
});

describe('팬챗 (버블형)', () => {
  it('버블형 기본: 답장은 크리에이터 메시지 1개당 3번, 새 메시지가 오면 다시 채워진다 · 다른 팬은 못 본다', async () => {
    await openRoom(fx.creatorId);
    const a = await member('민수');
    const b = await member('지수');
    expect((await subscribeTalk(a, fx.creatorId, 'CARD')).ok).toBe(true);
    expect((await subscribeTalk(b, fx.creatorId, 'CARD')).ok).toBe(true);
    await sendBroadcast(fx.creatorId, '{닉네임}님 안녕');
    for (let i = 0; i < 3; i++) expect((await sendFanReply(a, fx.creatorId, `답장 ${i}`)).ok).toBe(true);
    const fourth = await sendFanReply(a, fx.creatorId, '네 번째');
    expect(fourth.ok).toBe(false);
    expect(fourth.message).toContain('3번까지');
    expect((await getComposerState(a.id, fx.creatorId))?.repliesLeft).toBe(0);
    // 지워도 다시 채워지지 않는다
    const mine = await prisma.talkMessage.findFirstOrThrow({ where: { fanUserId: a.id } });
    await deleteTalkMessage(mine.id, { type: 'FAN', userId: a.id });
    expect((await sendFanReply(a, fx.creatorId, '지우고 다시')).ok).toBe(false);
    // 다른 팬에게는 보이지 않는다
    const tb = await getFanThread(b, fx.creatorId);
    expect(tb.messages.some((m) => m.kind === 'FAN_REPLY')).toBe(false);
    // 새 메시지 → 다시 3번
    await new Promise((r) => setTimeout(r, 5));
    await sendBroadcast(fx.creatorId, '두 번째 메시지');
    expect((await getComposerState(a.id, fx.creatorId))?.repliesLeft).toBe(3);
    expect((await sendFanReply(a, fx.creatorId, '다시 답장')).ok).toBe(true);
    const r = await prisma.talkMessage.findFirstOrThrow({ where: { fanUserId: a.id, body: '다시 답장' } });
    const second = await prisma.talkMessage.findFirstOrThrow({ where: { body: '두 번째 메시지' } });
    expect(r.replyToId).toBe(second.id);
    // 크리에이터: 메시지별 답장 수 · 읽음
    const tl = await getCreatorTimeline(fx.creatorId);
    expect(tl.sent.find((m) => m.id === second.id)?.replyCount).toBe(1);
  });

  it('구독 일수에 따라 글자 수가 늘어난다', async () => {
    await openRoom(fx.creatorId);
    const a = await member('민수');
    await subscribeTalk(a, fx.creatorId, 'CARD');
    await sendBroadcast(fx.creatorId, '안녕');
    const long = '가'.repeat(60);
    const r = await sendFanReply(a, fx.creatorId, long);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('50자');
    // 구독을 20일 전으로 당기면 D+21 → 80자
    await prisma.talkSubscription.updateMany({ where: { userId: a.id }, data: { startsAt: new Date(Date.now() - 20 * DAY) } });
    expect((await getComposerState(a.id, fx.creatorId))?.maxLength).toBe(80);
    expect((await sendFanReply(a, fx.creatorId, long)).ok).toBe(true);
  });

  it('예약 메시지는 공개 시각 전에는 보이지 않고, 지나면 보이며 알림이 한 번만 간다', async () => {
    await openRoom(fx.creatorId);
    const a = await member('민수');
    await subscribeTalk(a, fx.creatorId, 'CARD');
    const now = new Date();
    const r = await sendBroadcast(fx.creatorId, '예약 메시지', { scheduledAt: new Date(now.getTime() + 3600_000) }, now);
    expect(r.ok).toBe(true);
    expect(r.scheduled).toBe(true);
    expect((await getFanThread(a, fx.creatorId)).messages.some((m) => m.body === '예약 메시지')).toBe(false);
    const later = new Date(now.getTime() + 2 * 3600_000);
    expect((await getFanThread(a, fx.creatorId, { now: later })).messages.some((m) => m.body === '예약 메시지')).toBe(true);
    const sent = await dispatchDueTalkNotifications(later);
    expect(sent).toBe(1);
    expect(await dispatchDueTalkNotifications(later)).toBe(0);
    expect(await prisma.notification.count({ where: { userId: a.id } })).toBe(1);
    // 30일 넘는 예약은 거절
    expect((await sendBroadcast(fx.creatorId, 'x', { scheduledAt: new Date(now.getTime() + 40 * DAY) })).ok).toBe(false);
  });

  it('알림 끄기 · 닉네임 치환 · 하트 · 보관함 검색 · 음성 메시지', async () => {
    await openRoom(fx.creatorId);
    const a = await member('민수');
    await subscribeTalk(a, fx.creatorId, 'CARD');
    expect((await setRoomNickname(a.id, fx.creatorId, '꿀벌')).ok).toBe(true);
    expect((await setRoomNickname(a.id, fx.creatorId, '010-1234-5678')).ok).toBe(false);
    await prisma.talkReadState.update({ where: { userId_creatorId: { userId: a.id, creatorId: fx.creatorId } }, data: { muted: true } });
    await sendBroadcast(fx.creatorId, '{닉네임}님 사랑해요');
    expect(await prisma.notification.count({ where: { userId: a.id } })).toBe(0); // 알림 꺼짐
    const voice = await sendBroadcast(fx.creatorId, '', { mediaType: 'VOICE', mediaUrl: `/api/media/${'b'.repeat(32)}.webm`, mediaDuration: 12 });
    expect(voice.ok).toBe(true);
    expect((await sendBroadcast(fx.creatorId, '', { mediaType: 'VOICE', mediaUrl: `/api/media/${'b'.repeat(32)}.webm`, mediaDuration: 999 })).ok).toBe(false);
    const t = await getFanThread(a, fx.creatorId);
    const love = t.messages.find((m) => m.body.includes('사랑해요'))!;
    expect(love.body).toBe('꿀벌님 사랑해요');
    expect(t.messages.some((m) => m.mediaType === 'VOICE' && m.mediaDuration === 12)).toBe(true);
    expect((await toggleFanReaction(a.id, love.id)).reacted).toBe(true);
    expect((await getFanThread(a, fx.creatorId)).messages.find((m) => m.id === love.id)?.reacted).toBe(true);
    expect((await toggleFanReaction(a.id, love.id)).reacted).toBe(false);
    const arch = await searchFanArchive(a, fx.creatorId, { media: 'voice' });
    expect(arch.messages).toHaveLength(1);
    expect((await searchFanArchive(a, fx.creatorId, { q: '사랑' })).messages).toHaveLength(1);
    // 남에게 간 1:1 답장에는 하트를 누를 수 없다
    const b = await member('지수');
    await subscribeTalk(b, fx.creatorId, 'CARD');
    await sendDirect(fx.creatorId, b.id, '지수님만');
    const direct = await prisma.talkMessage.findFirstOrThrow({ where: { kind: 'DIRECT' } });
    expect((await toggleFanReaction(a.id, direct.id)).ok).toBe(false);
  });

  it('팬레터: 7일 한도 · 크리에이터 답장 · 연락처 가림', async () => {
    await openRoom(fx.creatorId);
    const a = await member('민수');
    expect((await sendLetter(a, fx.creatorId, { body: '구독 전 편지입니다 열자 이상' })).ok).toBe(false);
    await subscribeTalk(a, fx.creatorId, 'CARD');
    expect((await sendLetter(a, fx.creatorId, { body: '짧음' })).ok).toBe(false);
    expect((await sendLetter(a, fx.creatorId, { body: '항상 응원해요! 제 메일 a@b.co 로 연락 주세요', theme: 'MINT' })).ok).toBe(true);
    expect((await sendLetter(a, fx.creatorId, { body: '두 번째 편지예요 고마워요!!' })).ok).toBe(true);
    expect((await sendLetter(a, fx.creatorId, { body: '세 번째 편지예요 고마워요!!' })).ok).toBe(false);
    const { letters, unread } = await listCreatorLetters(fx.creatorId);
    expect(unread).toBe(2);
    expect(letters.find((l) => l.theme === 'MINT')?.body).not.toContain('a@b.co');
    expect((await replyLetter(fx.creatorId, letters[0].id, '고마워요')).ok).toBe(true);
    expect(await prisma.notification.count({ where: { userId: a.id } })).toBe(1);
  });

  it('묶음 구독: 할인 · 크리에이터별 정산 · 부분 환불', async () => {
    const c2 = await creator('둘째');
    await openRoom(fx.creatorId);
    await openRoom(c2);
    const a = await member('민수');
    const q = await quoteBundle(a.id, [fx.creatorId, c2]);
    expect(q.ok).toBe(true);
    expect(q.discountRate).toBe(0.05);
    expect(q.price).toBe(Math.round(9800 * 0.95));
    expect((await quoteBundle(a.id, [fx.creatorId])).ok).toBe(false);
    const r = await subscribeBundle(a, [fx.creatorId, c2], 'CARD');
    expect(r.ok).toBe(true);
    const subs = await prisma.talkSubscription.findMany({ where: { userId: a.id } });
    expect(subs).toHaveLength(2);
    expect(subs.reduce((s, x) => s + x.price, 0n)).toBe(BigInt(q.price));
    expect(subs.every((s) => s.bundleOrderId && s.bundlePaymentId && !s.paymentId)).toBe(true);
    const led = await prisma.settlementLedger.findMany({ where: { entryType: 'TALK_SUBSCRIPTION_PROCEEDS' } });
    expect(led).toHaveLength(2);
    // 한 명만 환불 → 그 금액만 부분 취소
    const one = subs[0];
    expect((await refundTalkSubscription(one.id, 'admin', '테스트')).ok).toBe(true);
    const pay = await prisma.shopPayment.findUniqueOrThrow({ where: { id: one.bundlePaymentId! } });
    expect(pay.cancelledAmount).toBe(one.price);
    expect(pay.status).toBe('PARTIAL_CANCELLED');
  });

  it('실시간 신호 버스: 본문 없이 신호만 전달된다', async () => {
    const got: string[] = [];
    const off = subscribeTalkSignals('C1', (s) => got.push(s.kind));
    publishTalkSignal({ creatorId: 'C1', kind: 'BROADCAST' });
    publishTalkSignal({ creatorId: 'C2', kind: 'BROADCAST' });
    off();
    publishTalkSignal({ creatorId: 'C1', kind: 'DIRECT' });
    expect(got).toEqual(['BROADCAST']);
  });

  it('단체방으로 바꾸면 답장 제한은 그대로, 다른 팬 메시지가 보인다', async () => {
    await saveTalkConfig({ ...DEFAULT_TALK_CONFIG, roomMode: 'GROUP' });
    await openRoom(fx.creatorId);
    const a = await member('민수');
    const b = await member('지수');
    await subscribeTalk(a, fx.creatorId, 'CARD');
    await subscribeTalk(b, fx.creatorId, 'CARD');
    await sendBroadcast(fx.creatorId, '안녕');
    await sendFanReply(a, fx.creatorId, '반가워요');
    expect((await getFanThread(b, fx.creatorId)).messages.some((m) => m.authorName === '민수')).toBe(true);
  });
});

// ====================================================================== 팬투표

describe('팬투표 활동', () => {
  it('출석: 하루 1번 · 연속 보너스 · 중복 지급 없음', async () => {
    const a = await member('민수');
    expect(attendanceReward(7, DEFAULT_VOTE_CONFIG).tickets).toBe(13);
    expect(attendanceReward(30, DEFAULT_VOTE_CONFIG).bonus).toBe(50);
    // 어제까지 6일 연속 기록
    const today = new Date();
    for (let i = 6; i >= 1; i--) {
      await prisma.voteAttendance.create({ data: { id: newId(), userId: a.id, dayKey: kstDateKey(new Date(today.getTime() - i * DAY)), streak: 7 - i, tickets: 3 } });
    }
    const r = await checkAttendance(a.id, today);
    expect(r.ok).toBe(true);
    expect(r.streak).toBe(7);
    expect(r.tickets).toBe(13);
    const again = await checkAttendance(a.id, today);
    expect(again.ok).toBe(false);
    expect((await getBalance(a.id)).free).toBe(13);
    // 동시에 눌러도 한 번만
    const b = await member('지수');
    const both = await Promise.all([checkAttendance(b.id), checkAttendance(b.id), checkAttendance(b.id)]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect((await getBalance(b.id)).total).toBe(3);
  });

  it('미션: 조건을 채워야 받고, 하루 한 번', async () => {
    const a = await member('민수');
    await freeTickets(a.id, 50);
    expect((await claimMission(a.id, 'VOTE_1')).ok).toBe(false);
    expect((await castVote(a, { creatorId: fx.creatorId, votes: 10 })).ok).toBe(true);
    const list = await listMissions(a.id);
    expect(list.missions.find((m) => m.key === 'VOTE_10')?.done).toBe(true);
    expect((await claimMission(a.id, 'VOTE_1')).tickets).toBe(3);
    expect((await claimMission(a.id, 'VOTE_10')).tickets).toBe(5);
    expect((await claimMission(a.id, 'VOTE_10')).ok).toBe(false);
    expect((await claimMission(a.id, 'SHARE')).ok).toBe(false);
    await logShare(a.id, fx.creatorId, 'download');
    expect((await claimMission(a.id, 'SHARE')).ok).toBe(true);
    expect((await claimMission(a.id, 'NOPE')).ok).toBe(false);
    // 미션을 끄면 받을 수 없다
    await saveVoteConfig(normalizeVoteConfig({ ...DEFAULT_VOTE_CONFIG, missionTickets: { ...DEFAULT_VOTE_CONFIG.missionTickets, CHEER: 0 } }));
    expect((await listMissions(a.id)).missions.some((m) => m.key === 'CHEER')).toBe(false);
  });

  it('친구 초대: 코드 1번 · 자기 코드 불가 · 첫 팬투표 때 초대한 사람 보상 · 기간 제한', async () => {
    const inviter = await member('초대자');
    const invitee = await member('친구');
    const code = (await getOrCreateFanProfile(inviter.id)).referralCode;
    expect((await redeemReferralCode(inviter.id, code)).ok).toBe(false);
    // (7차 P2-4) 휴대폰을 연결하지 않은 회원은 코드를 입력할 수 없다 (기본 켬)
    expect((await redeemReferralCode(invitee.id, code)).ok).toBe(false);
    await prisma.user.update({ where: { id: invitee.id }, data: { phoneHash: `ph-${newId()}` } });
    const r = await redeemReferralCode(invitee.id, code.toLowerCase());
    expect(r.ok).toBe(true);
    expect((await getBalance(invitee.id)).free).toBe(20);
    expect((await redeemReferralCode(invitee.id, code)).ok).toBe(false);
    // 맞초대 불가
    const back = (await getOrCreateFanProfile(invitee.id)).referralCode;
    expect((await redeemReferralCode(inviter.id, back)).ok).toBe(false);
    expect((await getBalance(inviter.id)).total).toBe(0);
    expect((await castVote(invitee, { creatorId: fx.creatorId, votes: 1 })).ok).toBe(true);
    expect((await getBalance(inviter.id)).free).toBe(30);
    // 두 번째 팬투표에는 더 주지 않는다
    await castVote(invitee, { creatorId: fx.creatorId, votes: 1 });
    expect((await getBalance(inviter.id)).free).toBe(30);
    // 가입한 지 오래된 회원은 입력 불가
    const old = await member('오래된', new Date(Date.now() - 60 * DAY));
    await prisma.user.update({ where: { id: old.id }, data: { phoneHash: `ph-${newId()}` } });
    expect((await redeemReferralCode(old.id, code)).ok).toBe(false);
  });

  it('응원 댓글: 하루 한도 · 연락처 가림 · 본인만 삭제 · 레벨/배지', async () => {
    const a = await member('민수');
    await saveVoteConfig(normalizeVoteConfig({ ...DEFAULT_VOTE_CONFIG, cheerDailyLimit: 2 }));
    expect((await postCheer(a.id, { creatorId: fx.creatorId, body: '화이팅! 010-1234-5678' })).ok).toBe(true);
    expect((await postCheer(a.id, { creatorId: fx.creatorId, body: '두 번째' })).ok).toBe(true);
    expect((await postCheer(a.id, { creatorId: fx.creatorId, body: '세 번째' })).ok).toBe(false);
    const c = await prisma.voteCheer.findFirstOrThrow({ where: { userId: a.id } });
    expect(c.body).not.toContain('010');
    const b = await member('지수');
    expect((await deleteCheer(c.id, { type: 'USER', userId: b.id })).ok).toBe(false);
    expect((await deleteCheer(c.id, { type: 'CREATOR', creatorId: fx.creatorId })).ok).toBe(true);
    const card = await getFanCard(a.id);
    expect(card.badges.find((x) => x.key === 'CHEER_FIRST')?.earnedAt).toBeTruthy();
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(1_500).level).toBe(5);
    expect(levelOf(99_999).next).toBeNull();
  });
});

describe('서포트', () => {
  it('목표를 넘지 않게 참여 · 목표 달성 시 성공 + 보상 집행 기록', async () => {
    const id = await createSupport({ creatorId: fx.creatorId, title: '생일 신문 광고', rewardType: 'NEWSPAPER', goalTickets: 100, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY) }, 'admin');
    const a = await member('민수');
    const b = await member('지수');
    await freeTickets(a.id, 80);
    await freeTickets(b.id, 80);
    expect((await contributeSupport(a.id, id, 5)).ok).toBe(false); // 최소 10
    expect((await contributeSupport(a.id, id, 70)).ok).toBe(true);
    const r = await contributeSupport(b.id, id, 50); // 남은 30 만 쓴다
    expect(r.ok).toBe(true);
    expect(r.success).toBe(true);
    expect((await getBalance(b.id)).total).toBe(50);
    const s = await prisma.voteSupport.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe('SUCCESS');
    expect(s.raisedTickets).toBe(100);
    expect(s.participantCount).toBe(2);
    const grants = await listRewardGrants({ creatorId: fx.creatorId });
    expect(grants.some((g) => g.sourceType === 'SUPPORT' && g.sourceKey === id)).toBe(true);
    expect((await contributeSupport(b.id, id, 10)).ok).toBe(false);
    // 크리에이터 본인은 참여 불가
    await freeTickets(fx.creatorUserId, 50);
    const id2 = await createSupport({ creatorId: fx.creatorId, title: '두 번째', rewardType: 'SUBWAY', goalTickets: 100, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY) }, 'admin');
    expect((await contributeSupport(fx.creatorUserId, id2, 10)).ok).toBe(false);
  });

  it('동시에 참여해도 목표를 넘지 않는다', async () => {
    const id = await createSupport({ creatorId: fx.creatorId, title: '동시성', rewardType: 'BANNER', goalTickets: 50, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY) }, 'admin');
    const fans = await Promise.all([member('a'), member('b'), member('c'), member('d')]);
    for (const f of fans) await freeTickets(f.id, 40);
    await Promise.all(fans.map((f) => contributeSupport(f.id, id, 20)));
    const s = await prisma.voteSupport.findUniqueOrThrow({ where: { id } });
    expect(s.raisedTickets).toBe(50);
    const spent = await prisma.voteSupportContribution.aggregate({ where: { supportId: id }, _sum: { tickets: true } });
    expect(spent._sum.tickets).toBe(50);
    const left = await Promise.all(fans.map((f) => getBalance(f.id).then((x) => x.total)));
    expect(left.reduce((a, b) => a + b, 0)).toBe(160 - 50);
  });

  it('기간 끝까지 못 채우면 실패 → 같은 종류로 반환 (유료분 금액 가치 유지) · 취소도 반환', async () => {
    const id = await createSupport({ creatorId: fx.creatorId, title: '실패', rewardType: 'NEWSPAPER', goalTickets: 1000, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY) }, 'admin');
    const a = await member('민수');
    await prisma.$transaction((tx) => grantTickets(tx, { userId: a.id, bucket: 'PAID', amount: 100, source: 'PURCHASE', ledgerType: 'PURCHASE', valueWon: 1000n }));
    await contributeSupport(a.id, id, 40);
    expect((await getBalance(a.id)).paid).toBe(60);
    expect(await settleExpiredSupports(new Date(Date.now() + 2 * DAY))).toBe(1);
    const b = await getBalance(a.id);
    expect(b.paid).toBe(100);
    const lot = await prisma.voteTicketLot.findFirstOrThrow({ where: { userId: a.id, source: 'SUPPORT_REFUND' } });
    expect(lot.valueWon).toBe(400n);
    expect((await prisma.voteSupport.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');

    const id2 = await createSupport({ creatorId: fx.creatorId, title: '취소', rewardType: 'NEWSPAPER', goalTickets: 1000, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY) }, 'admin');
    await contributeSupport(a.id, id2, 30);
    await cancelSupport(id2, '테스트');
    expect((await getBalance(a.id)).total).toBe(100);
    await expect(cancelSupport(id2, '다시')).rejects.toThrow();
  });
});

describe('순위 보상 · 이벤트', () => {
  it('기간 순위가 확정되면 정책에 맞는 보상 집행 기록이 한 번만 생긴다', async () => {
    await createRewardPolicy({ scope: 'PERIOD', periodType: 'MONTH', rankFrom: 1, rankTo: 1, rewardType: 'NEWSPAPER', title: '신문 광고' });
    const c2 = await creator('둘째');
    const key = previousPeriodKey('MONTH');
    await prisma.voteTally.createMany({
      data: [
        { id: newId(), periodType: 'MONTH', periodKey: key, creatorId: fx.creatorId, votes: 100n, lastVoteAt: new Date() },
        { id: newId(), periodType: 'MONTH', periodKey: key, creatorId: c2, votes: 50n, lastVoteAt: new Date() },
      ],
    });
    await finalizePeriod('MONTH', key);
    await finalizePeriod('MONTH', key);
    expect(await issuePeriodRewards('MONTH', key)).toBe(0); // 이미 생김
    const grants = await prisma.voteRewardGrant.findMany();
    expect(grants).toHaveLength(1);
    expect(grants[0].creatorId).toBe(fx.creatorId);
    expect(grants[0].rank).toBe(1);
    await updateRewardGrant(grants[0].id, { status: 'PUBLISHED', mediaName: '○○일보' }, 'admin');
    const after = await prisma.voteRewardGrant.findUniqueOrThrow({ where: { id: grants[0].id } });
    expect(after.publishedAt).toBeTruthy();
    // 크리에이터에게 알림
    expect(await prisma.notification.count({ where: { userId: fx.creatorUserId } })).toBeGreaterThanOrEqual(2);
  });

  it('이벤트: 하루 한도 · 종료 시각이 지나면 자동 종료 + 결과 보상', async () => {
    const c2 = await creator('둘째');
    await createRewardPolicy({ scope: 'ROUND', rankFrom: 1, rankTo: 1, rewardType: 'BILLBOARD', title: '전광판' });
    const roundId = await createRound({ kind: 'EVENT', title: '올해의 신인', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + DAY), creatorIds: [fx.creatorId, c2], status: 'OPEN', dailyMaxVotes: 5 }, 'admin');
    const a = await member('민수');
    await freeTickets(a.id, 100);
    expect((await castVote(a, { creatorId: c2, votes: 4, roundId })).ok).toBe(true);
    const over = await castVote(a, { creatorId: fx.creatorId, votes: 2, roundId });
    expect(over.ok).toBe(false);
    expect(over.message).toContain('1표까지');
    // 이벤트 표는 일·주·월 랭킹에 들어가지 않는다
    expect(await prisma.voteTally.count({ where: { periodType: 'DAY', periodKey: periodKey('DAY') } })).toBe(0);
    await prisma.voteRound.update({ where: { id: roundId }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect(await closeEndedRounds()).toBe(1);
    expect((await prisma.voteRound.findUniqueOrThrow({ where: { id: roundId } })).status).toBe('CLOSED');
    const g = await prisma.voteRewardGrant.findFirstOrThrow({ where: { sourceType: 'ROUND', sourceKey: roundId } });
    expect(g.creatorId).toBe(c2);
  });

  it('기념일: 날짜 확인 · 달력', async () => {
    await expect(saveAnniversary(fx.creatorId, { kind: 'BIRTHDAY', month: 2, day: 30 })).rejects.toThrow();
    await saveAnniversary(fx.creatorId, { kind: 'BIRTHDAY', month: 3, day: 14 });
    await saveAnniversary(fx.creatorId, { kind: 'BIRTHDAY', month: 3, day: 14, title: '생일!' }); // 같은 날은 덮어쓴다
    const list = await monthAnniversaries(3);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('생일!');
  });
});
