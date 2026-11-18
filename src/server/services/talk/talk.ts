/**
 * 팬챗 채팅 — 크리에이터별 1:N 팬챗방, 월 구독 (2026-11-17).
 *
 * 방식(talk.config.roomMode, 최고관리자 설정)
 *  - BUBBLE(기본, 2026-11-18) 버블형: 크리에이터 메시지는 구독자 모두에게 1:1 대화처럼, 구독자 메시지는 크리에이터에게만 보인다.
 *  - GROUP 단체방: 크리에이터와 구독자 여러 명이 함께 대화한다. 구독자 메시지(FAN_REPLY)도 구독자 모두에게 보인다.
 *
 * 버블형 고도화 (2026-11-18)
 *  - 답장 제한: 크리에이터 메시지 1개에 팬이 보낼 수 있는 답장 수(replyPerMessage). 새 메시지가 오면 다시 채워진다.
 *  - 글자 수: 구독 일수(D+)가 늘수록 답장 글자 수가 늘어난다(replyLengthTiers).
 *  - 사진 · 음성 · 영상 메시지, 예약 발송(공개 시각 = createdAt, 그 전에는 팬에게 보이지 않는다).
 *  - 팬은 크리에이터 메시지에 하트를 누를 수 있고, 팬챗방에서 불릴 닉네임을 정하고, 알림을 끌 수 있다.
 *  - 팬레터(긴 편지), 여러 크리에이터 묶음 구독(할인).
 *  - 실시간: 새 메시지가 생기면 팬챗 버스로 신호만 보내고 화면이 다시 조회한다(본문은 버스에 싣지 않는다).
 * - 크리에이터 메시지(BROADCAST) 본문의 {닉네임} 은 받는 팬마다 그 팬의 이름으로 바뀐다.
 * - 크리에이터는 팬 한 명에게만 따로 답할 수 있다(DIRECT).
 * - 구독은 월 단위 결제. 가격·플랫폼 수수료율은 "크리에이터별 지정 > 전역" (engagement/config).
 *   결제가 승인되면 크리에이터 정산액(수수료 차감 후)을 정산 원장 TALK_SUBSCRIPTION_PROCEEDS 로 적립한다.
 * - 결제는 도네이도 샵 결제 모듈(지금은 테스트 결제 mock).
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstStartOfDay } from '@/lib/datetime';
import { maskContacts, personalize } from '@/lib/contact-mask';
import { getShopPaymentAdapter, shopPaymentClosedMessage } from '@/server/adapters/shop-payment';
import { cancelShopPayment } from '@/server/services/shop/payment-cancel';
import { appendLedger } from '@/server/services/settlement';
import { notifyUser } from '@/server/services/notifications';
import { loadBannedWords } from '@/server/services/donation-flow';
import { filterContent } from '@/server/services/content-filter';
import { getCreatorEngagement, getTalkConfig, getVoteConfig, splitFee } from '@/server/services/engagement/config';
import type { PayMethod } from '@/server/services/vote/purchase';
import { publishTalkSignal } from './bus';

export const TALK_BODY_MAX_CREATOR = 1000;
const DAY_MS = 86_400_000;

export async function getOrCreateRoom(creatorId: string) {
  const room = await prisma.talkRoom.findUnique({ where: { creatorId } });
  if (room) return room;
  return prisma.talkRoom.upsert({ where: { creatorId }, create: { id: newId(), creatorId }, update: {} });
}

export interface SubscriptionStatus {
  active: boolean;
  endsAt: Date | null;
  /** 처음 구독을 시작한 시각 — 이 시각 이후의 크리에이터 메시지를 볼 수 있다 */
  firstStartAt: Date | null;
  /** 구독한 날 수 (D+N). 구독 기간을 모두 더한 값이라 중간에 끊겼다 다시 구독해도 이어진다. 구독 첫날 = 1 */
  days: number;
}

/** 구독 기간(겹치지 않게 이어 붙인 기간들)의 합으로 D+N 을 센다 */
export function subscribedDays(subs: Array<{ startsAt: Date; endsAt: Date }>, now: Date): number {
  let ms = 0;
  for (const s of subs) {
    const end = s.endsAt < now ? s.endsAt : now;
    if (end > s.startsAt) ms += end.getTime() - s.startsAt.getTime();
  }
  if (ms <= 0) return subs.some((s) => s.startsAt <= now) ? 1 : 0;
  return Math.floor(ms / DAY_MS) + 1;
}

export async function getSubscriptionStatus(userId: string | null | undefined, creatorId: string, now: Date = new Date()): Promise<SubscriptionStatus> {
  if (!userId) return { active: false, endsAt: null, firstStartAt: null, days: 0 };
  const subs = await prisma.talkSubscription.findMany({
    where: { userId, creatorId, status: 'ACTIVE' },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true, endsAt: true },
  });
  if (subs.length === 0) return { active: false, endsAt: null, firstStartAt: null, days: 0 };
  const active = subs.find((s) => s.startsAt <= now && s.endsAt > now);
  const latestEnd = subs.reduce<Date | null>((m, s) => (!m || s.endsAt > m ? s.endsAt : m), null);
  return { active: Boolean(active), endsAt: latestEnd, firstStartAt: subs[0].startsAt, days: subscribedDays(subs, now) };
}

/** D+N 에 맞는 답장 글자 수 (관리자 최대 글자 수를 넘지 않는다) */
export function replyLengthFor(days: number, tiers: Array<{ days: number; length: number }>, cap: number): { length: number; next: { days: number; length: number } | null } {
  let length = tiers.length > 0 ? tiers[0].length : cap;
  let next: { days: number; length: number } | null = null;
  for (const t of tiers) {
    if (days >= t.days) length = t.length;
    else {
      next = t;
      break;
    }
  }
  return { length: Math.min(length, cap), next: next ? { days: next.days, length: Math.min(next.length, cap) } : null };
}

async function isBlocked(creatorId: string, userId: string) {
  return Boolean(await prisma.talkBlock.findUnique({ where: { creatorId_userId: { creatorId, userId } }, select: { id: true } }));
}

export interface TalkResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------- 구독

export async function subscribeTalk(user: { id: string; name: string | null }, creatorId: string, method: PayMethod, now: Date = new Date()): Promise<TalkResult & { endsAt?: Date }> {
  const closed = shopPaymentClosedMessage();
  if (closed) return { ok: false, message: closed };
  const cfg = await getTalkConfig();
  if (!cfg.enabled) return { ok: false, message: '지금은 팬챗 구독을 받지 않습니다.' };
  const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { id: true, status: true, displayName: true, userId: true } });
  if (!creator || creator.status !== 'APPROVED') return { ok: false, message: '구독할 수 없는 크리에이터입니다.' };
  if (creator.userId === user.id) return { ok: false, message: '내 팬챗방은 구독할 수 없어요.' };
  const room = await prisma.talkRoom.findUnique({ where: { creatorId } });
  if (!room?.open) return { ok: false, message: '아직 팬챗방을 열지 않은 크리에이터입니다.' };
  if (await isBlocked(creatorId, user.id)) return { ok: false, message: '이 크리에이터의 팬챗방은 이용할 수 없습니다.' };
  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true } });
  if (!account || account.status !== 'ACTIVE') return { ok: false, message: '결제할 수 없는 계정입니다.' };

  const terms = (await getCreatorEngagement(creatorId, prisma, { talk: cfg })).talkSub;
  const price = BigInt(terms.price);
  if (price <= 0n) return { ok: false, message: '구독 가격이 정해지지 않았습니다.' };
  const { fee, net } = splitFee(price, terms.feeRate);

  const adapter = getShopPaymentAdapter();
  const paymentId = newId();
  const paymentNo = `TS${Date.now().toString(36).toUpperCase()}${paymentId.slice(-6)}`;
  await prisma.shopPayment.create({ data: { id: paymentId, paymentNo, userId: user.id, kind: 'TALK_SUBSCRIPTION', method, amount: price, provider: adapter.provider } });
  const approved = await adapter
    .approve({ paymentNo, amount: price, buyerName: user.name ?? '회원', itemName: `${creator.displayName} 팬챗 ${cfg.subPeriodDays}일 이용권` })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '결제 오류' }));
  if (!approved.ok) {
    await prisma.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'FAILED', failReason: approved.reason.slice(0, 200) } });
    return { ok: false, message: `결제에 실패했습니다: ${approved.reason}` };
  }

  const subId = newId();
  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'PAID', providerTx: approved.providerTx, paidAt: now } });
    if (moved.count === 0) return null;
    const latest = await tx.talkSubscription.findFirst({ where: { userId: user.id, creatorId, status: 'ACTIVE', endsAt: { gt: now } }, orderBy: { endsAt: 'desc' }, select: { endsAt: true } });
    const startsAt = latest ? latest.endsAt : now;
    const endsAt = new Date(startsAt.getTime() + cfg.subPeriodDays * 86_400_000);
    await tx.talkSubscription.create({
      data: { id: subId, userId: user.id, creatorId, startsAt, endsAt, price, feeRate: terms.feeRate.toFixed(6), feeAmount: fee, netAmount: net, method, paymentId, createdAt: now },
    });
    if (net > 0n) {
      await appendLedger([{ creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: net, memo: `팬챗 구독 ${paymentNo} (${price.toString()}원 - 수수료 ${fee.toString()}원) #${subId}`, occurredAt: now }], tx);
    }
    return endsAt;
  });
  if (!result) return { ok: true, message: '이미 처리된 결제입니다.' };
  await notifyUser({ userId: creator.userId, title: '새 팬챗 구독', body: `${user.name ?? '팬'} 님이 팬챗을 구독했어요.`, linkUrl: '/studio/talk' }).catch(() => undefined);
  return { ok: true, message: `${creator.displayName} 님 팬챗을 구독했어요. 이제 메시지를 주고받을 수 있어요.`, endsAt: result };
}

/** 관리자 환불: 구독을 끝내고(지금 시각으로) 정산액을 반대분개, 결제 취소 */
export async function refundTalkSubscription(subscriptionId: string, adminUserId: string, reason: string, now: Date = new Date()): Promise<TalkResult> {
  const sub = await prisma.talkSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.status !== 'ACTIVE') return { ok: false, message: '환불할 수 있는 구독이 아닙니다.' };
  const moved = await prisma.$transaction(async (tx) => {
    const m = await tx.talkSubscription.updateMany({
      where: { id: sub.id, status: 'ACTIVE' },
      data: { status: 'REFUNDED', refundAmount: sub.price, refundedAt: now, endsAt: sub.endsAt < now ? sub.endsAt : now },
    });
    if (m.count === 0) return false;
    if (sub.netAmount > 0n) {
      await appendLedger([{ creatorId: sub.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: -sub.netAmount, memo: `팬챗 구독 환불 반대분개 (관리자 ${adminUserId}: ${reason.slice(0, 60)}) #${sub.id}`, occurredAt: now }], tx);
    }
    return true;
  });
  if (!moved) return { ok: false, message: '이미 처리된 구독입니다.' };
  // 묶음 구독은 결제 1건을 여러 구독이 나눠 쓰므로 이 구독 금액만 부분 취소한다
  const done = await cancelPayment(sub.paymentId ?? sub.bundlePaymentId, sub.price, reason);
  return { ok: true, message: done ? '구독을 환불했습니다.' : '구독을 종료하고 정산을 되돌렸습니다. 결제사 취소는 실패해 [결제 취소 재시도] 목록에 남겼습니다.' };
}

/** 결제 취소. 실패하면 재시도 대기로 남긴다(관리자 > 결제). true = 취소 완료 */
export async function cancelPayment(paymentId: string | null, amount: bigint, reason: string): Promise<boolean> {
  return (await cancelShopPayment(paymentId, amount, reason)).done;
}

// ---------------------------------------------------------------------- 메시지

async function cleanBody(creatorId: string, body: string, maxLength: number, mask: boolean, allowEmpty = false): Promise<{ ok: true; text: string; masked: boolean } | { ok: false; message: string }> {
  const raw = body.replace(/\r\n/g, '\n').trim();
  if (!raw) return allowEmpty ? { ok: true, text: '', masked: false } : { ok: false, message: '메시지를 입력해 주세요.' };
  if (raw.length > maxLength) return { ok: false, message: `메시지는 ${maxLength}자까지 보낼 수 있어요.` };
  const banned = await loadBannedWords(creatorId);
  const f = filterContent(raw, { bannedWords: banned, maxLength });
  if (f.action === 'BLOCK') return { ok: false, message: '사용할 수 없는 표현이 있습니다. 고쳐서 다시 보내 주세요.' };
  const text = f.clean || raw;
  if (!mask) return { ok: true, text, masked: false };
  const m = maskContacts(text);
  // 금칙어 필터가 먼저 개인정보(전화번호 등)를 가렸을 수도 있다
  return { ok: true, text: m.text, masked: m.masked || text !== raw };
}

export type TalkMediaType = 'VOICE' | 'VIDEO';

export interface BroadcastOptions {
  imageUrl?: string | null;
  mediaType?: TalkMediaType | null;
  mediaUrl?: string | null;
  mediaDuration?: number | null;
  /** 예약 발송 시각. 지금보다 뒤면 그 시각에 공개된다 (최대 30일 뒤) */
  scheduledAt?: Date | null;
}

/** 크리에이터 → 구독자 전체. 사진 · 음성 · 영상 중 하나를 붙일 수 있고, 예약 발송할 수 있다 */
export async function sendBroadcast(creatorId: string, body: string, imageOrOpts?: string | null | BroadcastOptions, now: Date = new Date()): Promise<TalkResult & { messageId?: string; scheduled?: boolean }> {
  const opts: BroadcastOptions = typeof imageOrOpts === 'string' || imageOrOpts == null ? { imageUrl: imageOrOpts ?? null } : imageOrOpts;
  const cfg = await getTalkConfig();
  if (!cfg.enabled) return { ok: false, message: '팬챗 기능이 꺼져 있습니다.' };
  const hasMedia = Boolean(opts.imageUrl || (opts.mediaType && opts.mediaUrl));
  const c = await cleanBody(creatorId, body, TALK_BODY_MAX_CREATOR, false, hasMedia);
  if (!c.ok) return c;
  if (opts.mediaType && !['VOICE', 'VIDEO'].includes(opts.mediaType)) return { ok: false, message: '지원하지 않는 첨부 형식입니다.' };
  if (opts.mediaType && !opts.mediaUrl) return { ok: false, message: '첨부 파일을 다시 올려 주세요.' };
  const duration = opts.mediaDuration != null && Number.isFinite(opts.mediaDuration) ? Math.max(0, Math.min(36_000, Math.round(opts.mediaDuration))) : null;
  if (opts.mediaType === 'VOICE' && duration != null && duration > cfg.voiceMaxSeconds + 1) {
    return { ok: false, message: `음성 메시지는 ${cfg.voiceMaxSeconds}초까지 보낼 수 있어요.` };
  }
  let publishAt = now;
  let scheduled = false;
  if (opts.scheduledAt) {
    const t = opts.scheduledAt.getTime();
    if (!Number.isFinite(t)) return { ok: false, message: '예약 시각이 올바르지 않습니다.' };
    if (t > now.getTime() + 60_000) {
      if (t > now.getTime() + 30 * DAY_MS) return { ok: false, message: '예약은 30일 뒤까지 할 수 있어요.' };
      publishAt = opts.scheduledAt;
      scheduled = true;
    }
  }
  await getOrCreateRoom(creatorId);
  const id = newId();
  await prisma.talkMessage.create({
    data: {
      id,
      creatorId,
      kind: 'BROADCAST',
      body: c.text,
      imageUrl: opts.mediaType ? null : opts.imageUrl || null,
      mediaType: opts.mediaType ?? null,
      mediaUrl: opts.mediaType ? opts.mediaUrl ?? null : null,
      mediaDuration: opts.mediaType ? duration : null,
      scheduledAt: scheduled ? now : null,
      createdAt: publishAt,
    },
  });
  if (!scheduled) {
    publishTalkSignal({ creatorId, kind: 'BROADCAST' });
    await dispatchDueTalkNotifications(now, { creatorId }).catch(() => undefined);
  }
  return {
    ok: true,
    messageId: id,
    scheduled,
    message: scheduled ? `${publishAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}에 보내도록 예약했어요.` : '구독 중인 팬 모두에게 보냈어요.',
  };
}

/** 크리에이터 → 팬 한 명 */
export async function sendDirect(creatorId: string, fanUserId: string, body: string): Promise<TalkResult> {
  const sub = await prisma.talkSubscription.findFirst({ where: { creatorId, userId: fanUserId }, select: { id: true } });
  if (!sub) return { ok: false, message: '구독한 적이 없는 회원에게는 보낼 수 없어요.' };
  const c = await cleanBody(creatorId, body, TALK_BODY_MAX_CREATOR, false);
  if (!c.ok) return c;
  await prisma.talkMessage.create({ data: { id: newId(), creatorId, kind: 'DIRECT', fanUserId, body: c.text, notifiedAt: new Date() } });
  publishTalkSignal({ creatorId, kind: 'DIRECT', fanUserId });
  const [creator, rs] = await Promise.all([
    prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { code: true, displayName: true } }),
    prisma.talkReadState.findUnique({ where: { userId_creatorId: { userId: fanUserId, creatorId } }, select: { muted: true } }),
  ]);
  if (creator && !rs?.muted) {
    await notifyUser({ userId: fanUserId, title: `${creator.displayName} 님의 답장`, body: '나에게만 보낸 팬챗 메시지가 도착했어요.', linkUrl: `/c/${creator.code}/talk` }).catch(() => undefined);
  }
  return { ok: true, message: '이 팬에게만 답장했어요.' };
}

/** 팬에게 보이는 마지막 크리에이터 메시지 (공개 시각이 지난 것만) */
async function latestCreatorMessageFor(userId: string, creatorId: string, since: Date, now: Date) {
  return prisma.talkMessage.findFirst({
    where: {
      creatorId,
      deletedAt: null,
      createdAt: { gte: since, lte: now },
      OR: [{ kind: 'BROADCAST' }, { kind: 'DIRECT', fanUserId: userId }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
}

export interface ComposerState {
  /** D+N */
  days: number;
  /** 지금 보낼 수 있는 답장 글자 수 */
  maxLength: number;
  /** 다음 글자 수 단계 (없으면 최고 단계) */
  nextTier: { days: number; length: number } | null;
  /** 크리에이터 메시지 1개당 답장 수 (0 = 제한 없음) */
  replyPerMessage: number;
  /** 지금 남은 답장 수 (제한 없음이면 null) */
  repliesLeft: number | null;
  /** 오늘 남은 답장 수 (하루 제한 없음이면 null) */
  dailyLeft: number | null;
  /** 오늘이 구독 기념일(D+50·100 …)이면 그 날 수 */
  milestone: number | null;
  nickname: string | null;
  muted: boolean;
  /** 이번 7일 동안 더 보낼 수 있는 팬레터 수 */
  lettersLeft: number;
  letterEnabled: boolean;
}

function windowStart(firstStartAt: Date) {
  return new Date(firstStartAt.getTime() - 3 * DAY_MS);
}

/** 팬 입력창 상태 (D+N · 글자 수 · 남은 답장 · 닉네임 · 알림) */
export async function getComposerState(userId: string, creatorId: string, now: Date = new Date()): Promise<ComposerState | null> {
  const status = await getSubscriptionStatus(userId, creatorId, now);
  if (!status.active || !status.firstStartAt) return null;
  const cfg = await getTalkConfig();
  const tier = replyLengthFor(status.days, cfg.replyLengthTiers, cfg.fanReplyMaxLength);
  const [last, rs, todayCount, lettersWeek] = await Promise.all([
    latestCreatorMessageFor(userId, creatorId, windowStart(status.firstStartAt), now),
    prisma.talkReadState.findUnique({ where: { userId_creatorId: { userId, creatorId } }, select: { nickname: true, muted: true } }),
    cfg.fanReplyDailyLimit > 0
      ? prisma.talkMessage.count({ where: { creatorId, kind: 'FAN_REPLY', fanUserId: userId, createdAt: { gte: kstStartOfDay(now) } } })
      : Promise.resolve(0),
    prisma.talkLetter.count({ where: { creatorId, userId, createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } } }),
  ]);
  let repliesLeft: number | null = null;
  if (cfg.replyPerMessage > 0) {
    const used = await prisma.talkMessage.count({
      where: last
        ? { creatorId, kind: 'FAN_REPLY', fanUserId: userId, replyToId: last.id }
        : { creatorId, kind: 'FAN_REPLY', fanUserId: userId, replyToId: null, createdAt: { gte: status.firstStartAt } },
    });
    repliesLeft = Math.max(0, cfg.replyPerMessage - used);
  }
  return {
    days: status.days,
    maxLength: tier.length,
    nextTier: tier.next,
    replyPerMessage: cfg.replyPerMessage,
    repliesLeft,
    dailyLeft: cfg.fanReplyDailyLimit > 0 ? Math.max(0, cfg.fanReplyDailyLimit - todayCount) : null,
    milestone: cfg.dayMilestones.includes(status.days) ? status.days : null,
    nickname: rs?.nickname ?? null,
    muted: rs?.muted ?? false,
    lettersLeft: Math.max(0, cfg.letterPerWeek - lettersWeek),
    letterEnabled: cfg.letterEnabled,
  };
}

/** 팬 → 크리에이터 */
export async function sendFanReply(user: { id: string }, creatorId: string, body: string, now: Date = new Date()): Promise<TalkResult & { masked?: boolean }> {
  const cfg = await getTalkConfig();
  if (!cfg.enabled) return { ok: false, message: '팬챗 기능이 꺼져 있습니다.' };
  const status = await getSubscriptionStatus(user.id, creatorId, now);
  if (!status.active || !status.firstStartAt) return { ok: false, message: '구독 중인 회원만 메시지를 보낼 수 있어요.' };
  if (await isBlocked(creatorId, user.id)) return { ok: false, message: '이 팬챗방에서는 메시지를 보낼 수 없습니다.' };
  if (cfg.fanReplyDailyLimit > 0) {
    const used = await prisma.talkMessage.count({ where: { creatorId, kind: 'FAN_REPLY', fanUserId: user.id, createdAt: { gte: kstStartOfDay(now) } } });
    if (used >= cfg.fanReplyDailyLimit) return { ok: false, message: `오늘은 메시지를 ${cfg.fanReplyDailyLimit}번까지 보낼 수 있어요. 내일 다시 보내 주세요.` };
  }
  // 버블형 답장 제한: 마지막 크리에이터 메시지 1개에 replyPerMessage 번까지 (지운 답장도 센다)
  const last = await latestCreatorMessageFor(user.id, creatorId, windowStart(status.firstStartAt), now);
  if (cfg.replyPerMessage > 0) {
    const used = await prisma.talkMessage.count({
      where: last
        ? { creatorId, kind: 'FAN_REPLY', fanUserId: user.id, replyToId: last.id }
        : { creatorId, kind: 'FAN_REPLY', fanUserId: user.id, replyToId: null, createdAt: { gte: status.firstStartAt } },
    });
    if (used >= cfg.replyPerMessage) {
      return { ok: false, message: `크리에이터 메시지 하나에 ${cfg.replyPerMessage}번까지 답장할 수 있어요. 새 메시지가 오면 다시 보낼 수 있어요.` };
    }
  }
  const tier = replyLengthFor(status.days, cfg.replyLengthTiers, cfg.fanReplyMaxLength);
  const c = await cleanBody(creatorId, body, tier.length, true);
  if (!c.ok) {
    if (c.message.includes('자까지')) {
      return { ok: false, message: `지금은 ${tier.length}자까지 보낼 수 있어요.${tier.next ? ` D+${tier.next.days}부터 ${tier.next.length}자까지 늘어나요.` : ''}` };
    }
    return c;
  }
  await prisma.talkMessage.create({ data: { id: newId(), creatorId, kind: 'FAN_REPLY', fanUserId: user.id, body: c.text, replyToId: last?.id ?? null, createdAt: now, notifiedAt: now } });
  publishTalkSignal({ creatorId, kind: 'FAN_REPLY', fanUserId: user.id });
  return { ok: true, message: c.masked ? '보냈어요. 연락처·링크는 가려서 전달돼요.' : '보냈어요.', masked: c.masked };
}

export interface ThreadMessage {
  id: string;
  kind: 'BROADCAST' | 'FAN_REPLY' | 'DIRECT';
  mine: boolean;
  /** 단체방에서 다른 구독자 메시지의 작성자 이름 */
  authorName?: string | null;
  authorAvatarIndex?: number | null;
  body: string;
  imageUrl: string | null;
  mediaType: TalkMediaType | null;
  mediaUrl: string | null;
  mediaDuration: number | null;
  hearted: boolean;
  /** 내가 이 크리에이터 메시지에 하트를 눌렀는가 */
  reacted: boolean;
  createdAt: string;
}

/** 팬이 보는 대화 (구독 중일 때만). after 가 있으면 그 이후 새 메시지만, before 가 있으면 그 이전(지난 대화 더 보기) */
export async function getFanThread(
  user: { id: string; name: string | null },
  creatorId: string,
  opts: { after?: Date | null; before?: Date | null; limit?: number; now?: Date } = {},
): Promise<{ allowed: boolean; messages: ThreadMessage[]; hasMore?: boolean }> {
  const now = opts.now ?? new Date();
  const status = await getSubscriptionStatus(user.id, creatorId, now);
  if (!status.active || !status.firstStartAt) return { allowed: false, messages: [] };
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
  const cfg = await getTalkConfig();
  const group = cfg.roomMode === 'GROUP';
  const since = windowStart(status.firstStartAt);
  const blocked = group ? (await prisma.talkBlock.findMany({ where: { creatorId }, select: { userId: true } })).map((b) => b.userId) : [];
  // [5차 P2-13] 차단된 구독자는 크리에이터 메시지·자기 메시지만 본다 (다른 구독자 대화는 보지 않는다)
  const meBlocked = blocked.includes(user.id) || (!group && (await isBlocked(creatorId, user.id)));
  const range = {
    ...(opts.after ? { gt: opts.after } : {}),
    ...(opts.before ? { lt: opts.before } : {}),
    lte: now, // 예약 메시지는 공개 시각이 지나야 보인다
  };
  const rows = await prisma.talkMessage.findMany({
    where: {
      creatorId,
      deletedAt: null,
      createdAt: range,
      OR: [
        { kind: 'BROADCAST', createdAt: { gte: since } },
        group && !meBlocked
          ? { kind: 'FAN_REPLY', createdAt: { gte: since }, OR: [{ fanUserId: user.id }, { fanUserId: { notIn: blocked } }] }
          : { kind: 'FAN_REPLY', fanUserId: user.id },
        { kind: 'DIRECT', fanUserId: user.id },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  const fanName = await roomDisplayName(user.id, creatorId, user.name);
  const others = [...new Set(rows.filter((r) => r.kind === 'FAN_REPLY' && r.fanUserId && r.fanUserId !== user.id).map((r) => r.fanUserId as string))];
  const creatorMsgIds = rows.filter((r) => r.kind !== 'FAN_REPLY').map((r) => r.id);
  const [ou, od, reacted] = await Promise.all([
    others.length ? prisma.user.findMany({ where: { id: { in: others } }, select: { id: true, name: true, avatarIndex: true } }) : Promise.resolve([]),
    others.length ? prisma.donorProfile.findMany({ where: { userId: { in: others } }, select: { userId: true, displayName: true } }) : Promise.resolve([]),
    creatorMsgIds.length ? prisma.talkReaction.findMany({ where: { userId: user.id, messageId: { in: creatorMsgIds } }, select: { messageId: true } }) : Promise.resolve([]),
  ]);
  const reactedSet = new Set(reacted.map((r) => r.messageId));
  const nameOf = (id: string) => od.find((d) => d.userId === id)?.displayName ?? ou.find((u) => u.id === id)?.name ?? '팬';
  return {
    allowed: true,
    hasMore,
    messages: rows.reverse().map((m) => ({
      id: m.id,
      kind: m.kind as ThreadMessage['kind'],
      mine: m.kind === 'FAN_REPLY' && m.fanUserId === user.id,
      authorName: m.kind === 'FAN_REPLY' && m.fanUserId !== user.id && m.fanUserId ? nameOf(m.fanUserId) : null,
      authorAvatarIndex: m.kind === 'FAN_REPLY' && m.fanUserId !== user.id && m.fanUserId ? ou.find((u) => u.id === m.fanUserId)?.avatarIndex ?? 0 : null,
      body: m.kind === 'FAN_REPLY' ? m.body : personalize(m.body, fanName),
      imageUrl: m.imageUrl,
      mediaType: (m.mediaType as TalkMediaType | null) ?? null,
      mediaUrl: m.mediaUrl,
      mediaDuration: m.mediaDuration,
      hearted: m.hearted,
      reacted: reactedSet.has(m.id),
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/** 팬 이름: 후원 닉네임(방송 표시명) > 회원 이름 */
export async function fanDisplayName(userId: string, fallback: string | null): Promise<string> {
  const donor = await prisma.donorProfile.findUnique({ where: { userId }, select: { displayName: true } }).catch(() => null);
  return (donor?.displayName ?? fallback ?? '').trim() || '팬';
}

/** 팬챗방에서 불릴 이름: 팬챗방 닉네임 > 후원 닉네임 > 회원 이름 */
export async function roomDisplayName(userId: string, creatorId: string, fallback: string | null): Promise<string> {
  const rs = await prisma.talkReadState.findUnique({ where: { userId_creatorId: { userId, creatorId } }, select: { nickname: true } }).catch(() => null);
  if (rs?.nickname?.trim()) return rs.nickname.trim();
  return fanDisplayName(userId, fallback);
}

export async function markFanRead(userId: string, creatorId: string, at: Date = new Date()) {
  await prisma.talkReadState.upsert({
    where: { userId_creatorId: { userId, creatorId } },
    create: { id: newId(), userId, creatorId, lastReadAt: at },
    update: { lastReadAt: at },
  });
}

/** 팬챗방 닉네임 정하기 (크리에이터 메시지의 {닉네임} 이 이 이름으로 바뀐다). 빈 값이면 기본 이름으로 */
export async function setRoomNickname(userId: string, creatorId: string, nickname: string, now: Date = new Date()): Promise<TalkResult> {
  const status = await getSubscriptionStatus(userId, creatorId, now);
  if (!status.active) return { ok: false, message: '구독 중일 때 닉네임을 정할 수 있어요.' };
  const raw = nickname.replace(/\s+/g, ' ').trim();
  let value: string | null = null;
  if (raw) {
    if (raw.length < 2 || raw.length > 12) return { ok: false, message: '닉네임은 2~12자로 정해 주세요.' };
    if (/[<>{}\\]/.test(raw)) return { ok: false, message: '닉네임에 쓸 수 없는 기호가 있어요.' };
    const banned = await loadBannedWords(creatorId);
    const f = filterContent(raw, { bannedWords: banned, maxLength: 12 });
    if (f.action === 'BLOCK' || (f.clean && f.clean !== raw)) return { ok: false, message: '쓸 수 없는 표현이 들어 있어요.' };
    if (maskContacts(raw).masked) return { ok: false, message: '연락처나 아이디는 닉네임으로 쓸 수 없어요.' };
    value = raw;
  }
  await prisma.talkReadState.upsert({
    where: { userId_creatorId: { userId, creatorId } },
    create: { id: newId(), userId, creatorId, lastReadAt: now, nickname: value },
    update: { nickname: value },
  });
  return { ok: true, message: value ? `이제 '${value}'(으)로 불러 드려요.` : '기본 이름으로 되돌렸어요.' };
}

export async function setRoomMuted(userId: string, creatorId: string, muted: boolean, now: Date = new Date()): Promise<TalkResult> {
  await prisma.talkReadState.upsert({
    where: { userId_creatorId: { userId, creatorId } },
    create: { id: newId(), userId, creatorId, lastReadAt: now, muted },
    update: { muted },
  });
  return { ok: true, message: muted ? '이 팬챗방 알림을 껐어요.' : '이 팬챗방 알림을 켰어요.' };
}

/** 팬 하트: 크리에이터 메시지(전체 · 나에게 온 답장)에 하트를 누르거나 취소한다 */
export async function toggleFanReaction(userId: string, messageId: string, now: Date = new Date()): Promise<TalkResult & { reacted?: boolean }> {
  const m = await prisma.talkMessage.findUnique({ where: { id: messageId }, select: { id: true, creatorId: true, kind: true, fanUserId: true, deletedAt: true, createdAt: true } });
  if (!m || m.deletedAt || m.createdAt > now || m.kind === 'FAN_REPLY' || (m.kind === 'DIRECT' && m.fanUserId !== userId)) return { ok: false, message: '메시지를 찾을 수 없습니다.' };
  const status = await getSubscriptionStatus(userId, m.creatorId, now);
  if (!status.active) return { ok: false, message: '구독 중일 때 하트를 누를 수 있어요.' };
  const existing = await prisma.talkReaction.findUnique({ where: { messageId_userId: { messageId, userId } }, select: { id: true } });
  if (existing) {
    await prisma.talkReaction.deleteMany({ where: { messageId, userId } });
    return { ok: true, message: '하트를 취소했어요.', reacted: false };
  }
  await prisma.talkReaction.createMany({ data: [{ id: newId(), messageId, creatorId: m.creatorId, userId }], skipDuplicates: true });
  publishTalkSignal({ creatorId: m.creatorId, kind: 'REACTION' });
  return { ok: true, message: '하트를 보냈어요.', reacted: true };
}

/** 팬 보관함: 크리에이터 메시지만 모아 보기 · 검색 · 사진/음성/영상 */
export async function searchFanArchive(
  user: { id: string; name: string | null },
  creatorId: string,
  opts: { q?: string | null; media?: 'all' | 'photo' | 'voice' | 'video'; limit?: number; now?: Date } = {},
): Promise<{ allowed: boolean; messages: ThreadMessage[] }> {
  const now = opts.now ?? new Date();
  const status = await getSubscriptionStatus(user.id, creatorId, now);
  if (!status.active || !status.firstStartAt) return { allowed: false, messages: [] };
  const q = (opts.q ?? '').trim().slice(0, 40);
  const media = opts.media ?? 'all';
  const rows = await prisma.talkMessage.findMany({
    where: {
      creatorId,
      deletedAt: null,
      createdAt: { gte: windowStart(status.firstStartAt), lte: now },
      OR: [{ kind: 'BROADCAST' }, { kind: 'DIRECT', fanUserId: user.id }],
      ...(q ? { body: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(media === 'photo' ? { imageUrl: { not: null } } : media === 'voice' ? { mediaType: 'VOICE' } : media === 'video' ? { mediaType: 'VIDEO' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 60, 1), 200),
  });
  const fanName = await roomDisplayName(user.id, creatorId, user.name);
  const reacted = rows.length
    ? new Set((await prisma.talkReaction.findMany({ where: { userId: user.id, messageId: { in: rows.map((r) => r.id) } }, select: { messageId: true } })).map((r) => r.messageId))
    : new Set<string>();
  return {
    allowed: true,
    messages: rows.map((m) => ({
      id: m.id,
      kind: m.kind as ThreadMessage['kind'],
      mine: false,
      body: personalize(m.body, fanName),
      imageUrl: m.imageUrl,
      mediaType: (m.mediaType as TalkMediaType | null) ?? null,
      mediaUrl: m.mediaUrl,
      mediaDuration: m.mediaDuration,
      hearted: false,
      reacted: reacted.has(m.id),
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/** 미리보기 문구 (목록 · 알림) */
export function previewOf(m: { body: string; imageUrl: string | null; mediaType: string | null }, fanName: string): string {
  const body = personalize(m.body, fanName).trim();
  if (body) return body;
  if (m.mediaType === 'VOICE') return '음성 메시지';
  if (m.mediaType === 'VIDEO') return '영상';
  if (m.imageUrl) return '사진';
  return '';
}

/** 팬의 팬챗방 목록 (마이페이지 · 하단 [팬챗]) */
export async function listMyTalkRooms(userId: string, now: Date = new Date()) {
  const subs = await prisma.talkSubscription.findMany({
    where: { userId },
    orderBy: { endsAt: 'desc' },
    include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } } } },
  });
  const byCreator = new Map<string, (typeof subs)[number] & { activeNow: boolean; latestEnd: Date; spans: Array<{ startsAt: Date; endsAt: Date }> }>();
  for (const s of subs) {
    const cur = byCreator.get(s.creatorId);
    const activeNow = s.status === 'ACTIVE' && s.startsAt <= now && s.endsAt > now;
    const span = s.status === 'ACTIVE' ? [{ startsAt: s.startsAt, endsAt: s.endsAt }] : [];
    if (!cur) byCreator.set(s.creatorId, { ...s, activeNow, latestEnd: s.endsAt, spans: span });
    else {
      if (activeNow) cur.activeNow = true;
      if (s.status === 'ACTIVE' && s.endsAt > cur.latestEnd) cur.latestEnd = s.endsAt;
      cur.spans.push(...span);
    }
  }
  const reads = await prisma.talkReadState.findMany({ where: { userId, creatorId: { in: [...byCreator.keys()] } } });
  const rmap = new Map(reads.map((r) => [r.creatorId, r]));
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const baseName = await fanDisplayName(userId, me?.name ?? null);
  const out = [];
  for (const s of byCreator.values()) {
    const rs = rmap.get(s.creatorId);
    const since = rs?.lastReadAt ?? s.startsAt;
    const unread = s.activeNow
      ? await prisma.talkMessage.count({ where: { creatorId: s.creatorId, deletedAt: null, createdAt: { gt: since, lte: now }, OR: [{ kind: 'BROADCAST' }, { kind: 'DIRECT', fanUserId: userId }] } })
      : 0;
    const last = await prisma.talkMessage.findFirst({
      where: { creatorId: s.creatorId, deletedAt: null, createdAt: { lte: now }, OR: [{ kind: 'BROADCAST' }, { kind: 'DIRECT', fanUserId: userId }] },
      orderBy: { createdAt: 'desc' },
      select: { body: true, imageUrl: true, mediaType: true, createdAt: true },
    });
    const name = rs?.nickname?.trim() || baseName;
    out.push({
      creator: s.creator,
      active: s.activeNow,
      endsAt: s.latestEnd,
      unread,
      days: subscribedDays(s.spans, now),
      muted: rs?.muted ?? false,
      lastBody: last ? previewOf(last, name) : null,
      lastAt: last?.createdAt ?? null,
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

// ---------------------------------------------------------------------- 알림 (예약 메시지 포함)

/**
 * 공개 시각이 지났는데 아직 알림을 보내지 않은 크리에이터 메시지를 구독자에게 알린다.
 * 먼저 notifiedAt 을 채워 선점하므로 여러 곳에서 동시에 불러도 한 번만 나간다.
 * 이틀이 지난 메시지는 알리지 않고 표시만 한다(오래된 소식으로 알림을 보내지 않게).
 */
export async function dispatchDueTalkNotifications(now: Date = new Date(), opts: { creatorId?: string; limit?: number } = {}): Promise<number> {
  const due = await prisma.talkMessage.findMany({
    where: { kind: 'BROADCAST', notifiedAt: null, deletedAt: null, createdAt: { lte: now }, ...(opts.creatorId ? { creatorId: opts.creatorId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 20,
    select: { id: true, creatorId: true, body: true, imageUrl: true, mediaType: true, createdAt: true, scheduledAt: true },
  });
  if (due.length === 0) return 0;
  const cfg = await getTalkConfig();
  let sent = 0;
  for (const m of due) {
    const claimed = await prisma.talkMessage.updateMany({ where: { id: m.id, notifiedAt: null }, data: { notifiedAt: now } });
    if (claimed.count === 0) continue;
    if (m.scheduledAt) publishTalkSignal({ creatorId: m.creatorId, kind: 'BROADCAST' });
    if (!cfg.notifyOnBroadcast || now.getTime() - m.createdAt.getTime() > 2 * DAY_MS) continue;
    const creator = await prisma.creatorProfile.findUnique({ where: { id: m.creatorId }, select: { code: true, displayName: true } });
    if (!creator) continue;
    const subs = await prisma.talkSubscription.findMany({ where: { creatorId: m.creatorId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } }, distinct: ['userId'], select: { userId: true } });
    if (subs.length === 0) continue;
    const muted = new Set((await prisma.talkReadState.findMany({ where: { creatorId: m.creatorId, muted: true, userId: { in: subs.map((x) => x.userId) } }, select: { userId: true } })).map((r) => r.userId));
    const targets = subs.map((x) => x.userId).filter((id) => !muted.has(id));
    const preview = previewOf(m, '팬').replace(/\s+/g, ' ').slice(0, 60);
    for (let i = 0; i < targets.length; i += 500) {
      await prisma.notification.createMany({
        data: targets.slice(i, i + 500).map((userId) => ({
          id: newId(),
          userId,
          channel: 'IN_APP' as const,
          title: `${creator.displayName} 님의 새 팬챗`.slice(0, 120),
          body: (preview || '새 메시지가 도착했어요.').slice(0, 500),
          linkUrl: `/c/${creator.code}/talk`,
        })),
      });
    }
    sent += targets.length;
  }
  return sent;
}

// ---------------------------------------------------------------------- 팬레터

export const LETTER_THEMES = ['CREAM', 'MINT', 'PINK', 'NIGHT'] as const;
export type LetterTheme = (typeof LETTER_THEMES)[number];

export async function sendLetter(user: { id: string; name: string | null }, creatorId: string, input: { title?: string; body: string; theme?: string }, now: Date = new Date()): Promise<TalkResult> {
  const cfg = await getTalkConfig();
  if (!cfg.enabled || !cfg.letterEnabled) return { ok: false, message: '지금은 팬레터를 받지 않아요.' };
  const status = await getSubscriptionStatus(user.id, creatorId, now);
  if (!status.active) return { ok: false, message: '구독 중인 회원만 팬레터를 보낼 수 있어요.' };
  if (await isBlocked(creatorId, user.id)) return { ok: false, message: '이 크리에이터에게는 팬레터를 보낼 수 없습니다.' };
  const week = await prisma.talkLetter.count({ where: { creatorId, userId: user.id, createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } } });
  if (week >= cfg.letterPerWeek) return { ok: false, message: `팬레터는 7일에 ${cfg.letterPerWeek}통까지 보낼 수 있어요.` };
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (body.length < 10) return { ok: false, message: '편지는 10자 이상 써 주세요.' };
  const c = await cleanBody(creatorId, body, cfg.letterMaxLength, true);
  if (!c.ok) return c;
  const titleRaw = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const t = titleRaw ? await cleanBody(creatorId, titleRaw, 40, true) : null;
  if (t && !t.ok) return t;
  const theme = (LETTER_THEMES as readonly string[]).includes(input.theme ?? '') ? (input.theme as LetterTheme) : 'CREAM';
  await prisma.talkLetter.create({ data: { id: newId(), creatorId, userId: user.id, theme, title: t && t.ok ? t.text || null : null, body: c.text, createdAt: now } });
  publishTalkSignal({ creatorId, kind: 'LETTER', fanUserId: user.id });
  const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { userId: true } });
  if (creator) await notifyUser({ userId: creator.userId, title: '새 팬레터', body: `${await roomDisplayName(user.id, creatorId, user.name)} 님이 팬레터를 보냈어요.`, linkUrl: '/studio/talk/letters' }).catch(() => undefined);
  return { ok: true, message: c.masked ? '팬레터를 보냈어요. 연락처·링크는 가려서 전달돼요.' : '팬레터를 보냈어요.' };
}

export async function listMyLetters(userId: string, creatorId: string, limit = 30) {
  return prisma.talkLetter.findMany({ where: { userId, creatorId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: limit });
}

export async function listCreatorLetters(creatorId: string, opts: { filter?: 'all' | 'unread' | 'hearted'; limit?: number } = {}) {
  const rows = await prisma.talkLetter.findMany({
    where: { creatorId, deletedAt: null, ...(opts.filter === 'unread' ? { readAt: null } : opts.filter === 'hearted' ? { hearted: true } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
  const ids = [...new Set(rows.map((r) => r.userId))];
  const [users, reads] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatarIndex: true } }),
    prisma.talkReadState.findMany({ where: { creatorId, userId: { in: ids } }, select: { userId: true, nickname: true } }),
  ]);
  const donors = await prisma.donorProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, displayName: true } });
  const unread = await prisma.talkLetter.count({ where: { creatorId, deletedAt: null, readAt: null } });
  return {
    unread,
    letters: rows.map((r) => {
      const u = users.find((x) => x.id === r.userId);
      const name = reads.find((x) => x.userId === r.userId)?.nickname || donors.find((x) => x.userId === r.userId)?.displayName || u?.name || '팬';
      return { ...r, fanName: name, avatarIndex: u?.avatarIndex ?? 0 };
    }),
  };
}

export async function markLetterRead(creatorId: string, letterId: string, now: Date = new Date()) {
  await prisma.talkLetter.updateMany({ where: { id: letterId, creatorId, readAt: null }, data: { readAt: now } });
}

export async function toggleLetterHeart(creatorId: string, letterId: string): Promise<boolean> {
  const l = await prisma.talkLetter.findFirst({ where: { id: letterId, creatorId, deletedAt: null }, select: { id: true, hearted: true } });
  if (!l) throw new Error('편지를 찾을 수 없습니다.');
  await prisma.talkLetter.update({ where: { id: l.id }, data: { hearted: !l.hearted, readAt: new Date() } });
  return !l.hearted;
}

export async function replyLetter(creatorId: string, letterId: string, body: string, now: Date = new Date()): Promise<TalkResult> {
  const l = await prisma.talkLetter.findFirst({ where: { id: letterId, creatorId, deletedAt: null } });
  if (!l) return { ok: false, message: '편지를 찾을 수 없습니다.' };
  const c = await cleanBody(creatorId, body, TALK_BODY_MAX_CREATOR, false);
  if (!c.ok) return c;
  await prisma.talkLetter.update({ where: { id: l.id }, data: { replyBody: c.text, repliedAt: now, readAt: l.readAt ?? now } });
  const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { code: true, displayName: true } });
  if (creator) await notifyUser({ userId: l.userId, title: `${creator.displayName} 님이 팬레터에 답장했어요`, body: c.text.slice(0, 80), linkUrl: `/c/${creator.code}/talk/letters` }).catch(() => undefined);
  publishTalkSignal({ creatorId, kind: 'LETTER', fanUserId: l.userId });
  return { ok: true, message: '답장을 보냈어요. 이 팬에게만 보여요.' };
}

export async function deleteLetter(letterId: string, by: { type: 'CREATOR'; creatorId: string } | { type: 'FAN'; userId: string } | { type: 'ADMIN'; userId: string }) {
  const l = await prisma.talkLetter.findUnique({ where: { id: letterId } });
  if (!l || l.deletedAt) throw new Error('편지를 찾을 수 없습니다.');
  if (by.type === 'CREATOR' && l.creatorId !== by.creatorId) throw new Error('내게 온 편지만 지울 수 있습니다.');
  if (by.type === 'FAN' && l.userId !== by.userId) throw new Error('내가 보낸 편지만 지울 수 있습니다.');
  await prisma.talkLetter.update({ where: { id: l.id }, data: { deletedAt: new Date() } });
}

// ---------------------------------------------------------------------- 묶음 구독

export interface BundleQuoteLine {
  creatorId: string;
  code: string;
  name: string;
  listPrice: number;
  price: number;
}

export interface BundleQuote {
  ok: boolean;
  message?: string;
  lines: BundleQuoteLine[];
  listPrice: number;
  discountRate: number;
  price: number;
}

/** 묶음 할인율: 함께 구독하는 수 이상인 구간 중 가장 큰 할인 하나 */
export function bundleRateFor(count: number, tiers: Array<{ count: number; rate: number }>): number {
  let rate = 0;
  for (const t of tiers) if (count >= t.count && t.rate > rate) rate = t.rate;
  return rate;
}

/** 할인 금액을 크리에이터별로 나눈다 (원 단위 절사, 남는 원은 마지막 줄이 흡수 — 합계가 결제 금액과 같다) */
export function splitBundle(listPrices: number[], rate: number): number[] {
  const total = listPrices.reduce((a, b) => a + b, 0);
  const pay = Math.round(total * (1 - rate));
  const parts = listPrices.map((p) => Math.floor((p * pay) / Math.max(total, 1)));
  const diff = pay - parts.reduce((a, b) => a + b, 0);
  if (parts.length > 0) parts[parts.length - 1] += diff;
  return parts;
}

export async function quoteBundle(userId: string | null, creatorIds: string[]): Promise<BundleQuote> {
  const cfg = await getTalkConfig();
  const ids = [...new Set(creatorIds.filter(Boolean))].slice(0, 20);
  const empty = { lines: [], listPrice: 0, discountRate: 0, price: 0 };
  if (!cfg.enabled || !cfg.bundleEnabled) return { ok: false, message: '지금은 묶음 구독을 받지 않아요.', ...empty };
  if (ids.length < 2) return { ok: false, message: '크리에이터를 2명 이상 골라 주세요.', ...empty };
  const creators = await prisma.creatorProfile.findMany({ where: { id: { in: ids }, status: 'APPROVED' }, select: { id: true, code: true, displayName: true, userId: true } });
  const rooms = await prisma.talkRoom.findMany({ where: { creatorId: { in: ids }, open: true }, select: { creatorId: true } });
  const openSet = new Set(rooms.map((r) => r.creatorId));
  const blocks = userId ? new Set((await prisma.talkBlock.findMany({ where: { userId, creatorId: { in: ids } }, select: { creatorId: true } })).map((b) => b.creatorId)) : new Set<string>();
  const voteCfg = await getVoteConfig();
  const lines: BundleQuoteLine[] = [];
  for (const id of ids) {
    const c = creators.find((x) => x.id === id);
    if (!c || !openSet.has(id)) return { ok: false, message: '팬챗방을 열지 않은 크리에이터가 들어 있어요.', ...empty };
    if (userId && c.userId === userId) return { ok: false, message: '내 팬챗방은 구독할 수 없어요.', ...empty };
    if (blocks.has(id)) return { ok: false, message: `${c.displayName} 님 팬챗방은 이용할 수 없어요.`, ...empty };
    const terms = (await getCreatorEngagement(id, prisma, { talk: cfg, vote: voteCfg })).talkSub;
    if (terms.price <= 0) return { ok: false, message: `${c.displayName} 님 구독 가격이 정해지지 않았어요.`, ...empty };
    lines.push({ creatorId: id, code: c.code, name: c.displayName, listPrice: terms.price, price: terms.price });
  }
  const rate = bundleRateFor(lines.length, cfg.bundleDiscounts);
  const parts = splitBundle(lines.map((l) => l.listPrice), rate);
  lines.forEach((l, i) => (l.price = parts[i]));
  const listPrice = lines.reduce((a, l) => a + l.listPrice, 0);
  return { ok: true, lines, listPrice, discountRate: rate, price: parts.reduce((a, b) => a + b, 0) };
}

/** 묶음 구독 결제: 결제 1건 → 크리에이터별 구독 · 정산 적립 */
export async function subscribeBundle(user: { id: string; name: string | null }, creatorIds: string[], method: PayMethod, now: Date = new Date()): Promise<TalkResult & { orderId?: string }> {
  const closed = shopPaymentClosedMessage();
  if (closed) return { ok: false, message: closed };
  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true } });
  if (!account || account.status !== 'ACTIVE') return { ok: false, message: '결제할 수 없는 계정입니다.' };
  const quote = await quoteBundle(user.id, creatorIds);
  if (!quote.ok) return { ok: false, message: quote.message ?? '묶음 구독을 할 수 없어요.' };
  const cfg = await getTalkConfig();
  const adapter = getShopPaymentAdapter();
  const paymentId = newId();
  const orderId = newId();
  const paymentNo = `TB${Date.now().toString(36).toUpperCase()}${paymentId.slice(-6)}`;
  const price = BigInt(quote.price);
  await prisma.talkBundleOrder.create({
    data: { id: orderId, orderNo: paymentNo, userId: user.id, creatorIds: quote.lines.map((l) => l.creatorId), listPrice: BigInt(quote.listPrice), discountRate: quote.discountRate.toFixed(6), price, method, paymentId },
  });
  await prisma.shopPayment.create({ data: { id: paymentId, paymentNo, userId: user.id, kind: 'TALK_SUBSCRIPTION', method, amount: price, provider: adapter.provider } });
  const approved = await adapter
    .approve({ paymentNo, amount: price, buyerName: user.name ?? '회원', itemName: `팬챗 묶음 ${quote.lines.length}명 ${cfg.subPeriodDays}일 이용권` })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '결제 오류' }));
  if (!approved.ok) {
    await prisma.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'FAILED', failReason: approved.reason.slice(0, 200) } });
    await prisma.talkBundleOrder.update({ where: { id: orderId }, data: { status: 'FAILED' } });
    return { ok: false, message: `결제에 실패했습니다: ${approved.reason}` };
  }
  // 수수료율은 트랜잭션 밖에서 미리 읽는다 (트랜잭션을 짧게 — 설정 조회가 트랜잭션 연결을 붙잡지 않게)
  const vote = await getVoteConfig();
  const feeRates = new Map<string, number>();
  for (const line of quote.lines) feeRates.set(line.creatorId, (await getCreatorEngagement(line.creatorId, prisma, { talk: cfg, vote })).talkSub.feeRate);
  const done = await prisma.$transaction(async (tx) => {
    const moved = await tx.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'PAID', providerTx: approved.providerTx, paidAt: now } });
    if (moved.count === 0) return false;
    await tx.talkBundleOrder.update({ where: { id: orderId }, data: { status: 'PAID' } });
    for (const line of quote.lines) {
      const terms = { feeRate: feeRates.get(line.creatorId) ?? cfg.subFeeRate };
      const linePrice = BigInt(line.price);
      const { fee, net } = splitFee(linePrice, terms.feeRate);
      const latest = await tx.talkSubscription.findFirst({ where: { userId: user.id, creatorId: line.creatorId, status: 'ACTIVE', endsAt: { gt: now } }, orderBy: { endsAt: 'desc' }, select: { endsAt: true } });
      const startsAt = latest ? latest.endsAt : now;
      const endsAt = new Date(startsAt.getTime() + cfg.subPeriodDays * DAY_MS);
      const subId = newId();
      await tx.talkSubscription.create({
        data: { id: subId, userId: user.id, creatorId: line.creatorId, startsAt, endsAt, price: linePrice, feeRate: terms.feeRate.toFixed(6), feeAmount: fee, netAmount: net, method, bundleOrderId: orderId, bundlePaymentId: paymentId, createdAt: now },
      });
      if (net > 0n) {
        await appendLedger([{ creatorId: line.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: net, memo: `팬챗 묶음 구독 ${paymentNo} (${linePrice.toString()}원 - 수수료 ${fee.toString()}원) #${subId}`, occurredAt: now }], tx);
      }
    }
    return true;
  });
  if (!done) return { ok: true, message: '이미 처리된 결제입니다.', orderId };
  const owners = await prisma.creatorProfile.findMany({ where: { id: { in: quote.lines.map((l) => l.creatorId) } }, select: { userId: true } });
  for (const o of owners) {
    await notifyUser({ userId: o.userId, title: '새 팬챗 구독', body: `${user.name ?? '팬'} 님이 팬챗을 구독했어요.`, linkUrl: '/studio/talk' }).catch(() => undefined);
  }
  return { ok: true, orderId, message: `${quote.lines.length}명 팬챗을 함께 구독했어요. (${Math.round(quote.discountRate * 100)}% 할인)` };
}

// ---------------------------------------------------------------------- 크리에이터 화면

export async function getCreatorInbox(creatorId: string, opts: { filter?: 'all' | 'unread' | 'hearted'; fanUserId?: string | null; replyToId?: string | null; q?: string | null; limit?: number } = {}) {
  const room = await getOrCreateRoom(creatorId);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const q = (opts.q ?? '').trim().slice(0, 40);
  const where = {
    creatorId,
    deletedAt: null,
    kind: 'FAN_REPLY',
    ...(opts.fanUserId ? { fanUserId: opts.fanUserId } : {}),
    ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
    ...(q ? { body: { contains: q, mode: 'insensitive' as const } } : {}),
    ...(opts.filter === 'hearted' ? { hearted: true } : {}),
    ...(opts.filter === 'unread' && room.creatorLastReadAt ? { createdAt: { gt: room.creatorLastReadAt } } : {}),
  };
  const rows = await prisma.talkMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  const fanIds = [...new Set(rows.map((r) => r.fanUserId).filter((x): x is string => Boolean(x)))];
  const [users, donors, blocks, nicks, subs] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: fanIds } }, select: { id: true, name: true, avatarIndex: true } }),
    prisma.donorProfile.findMany({ where: { userId: { in: fanIds } }, select: { userId: true, displayName: true } }),
    prisma.talkBlock.findMany({ where: { creatorId, userId: { in: fanIds } }, select: { userId: true } }),
    prisma.talkReadState.findMany({ where: { creatorId, userId: { in: fanIds }, nickname: { not: null } }, select: { userId: true, nickname: true } }),
    prisma.talkSubscription.findMany({ where: { creatorId, userId: { in: fanIds }, status: 'ACTIVE' }, select: { userId: true, startsAt: true, endsAt: true } }),
  ]);
  const umap = new Map(users.map((u) => [u.id, u]));
  const dmap = new Map(donors.map((d) => [d.userId ?? '', d.displayName]));
  const nmap = new Map(nicks.map((n) => [n.userId, n.nickname as string]));
  const now = new Date();
  const daysOf = (uid: string) => subscribedDays(subs.filter((x) => x.userId === uid), now);
  const bset = new Set(blocks.map((b) => b.userId));
  const unread = room.creatorLastReadAt
    ? await prisma.talkMessage.count({ where: { creatorId, kind: 'FAN_REPLY', deletedAt: null, createdAt: { gt: room.creatorLastReadAt } } })
    : await prisma.talkMessage.count({ where: { creatorId, kind: 'FAN_REPLY', deletedAt: null } });
  return {
    room,
    unread,
    messages: rows.map((r) => {
      const u = r.fanUserId ? umap.get(r.fanUserId) : null;
      return {
        id: r.id,
        fanUserId: r.fanUserId,
        fanName: (r.fanUserId ? nmap.get(r.fanUserId) ?? dmap.get(r.fanUserId) : null) ?? u?.name ?? '팬',
        avatarIndex: u?.avatarIndex ?? 0,
        days: r.fanUserId ? daysOf(r.fanUserId) : 0,
        replyToId: r.replyToId,
        body: r.body,
        hearted: r.hearted,
        blocked: r.fanUserId ? bset.has(r.fanUserId) : false,
        createdAt: r.createdAt,
        isNew: room.creatorLastReadAt ? r.createdAt > room.creatorLastReadAt : true,
      };
    }),
  };
}

export async function markCreatorRead(creatorId: string, at: Date = new Date()) {
  await getOrCreateRoom(creatorId);
  await prisma.talkRoom.update({ where: { creatorId }, data: { creatorLastReadAt: at } });
}

export async function getCreatorTalkStats(creatorId: string, now: Date = new Date()) {
  const monthStart = new Date(now.getTime() - 30 * 86_400_000);
  const [activeSubs, newSubs, revenue, sent] = await Promise.all([
    prisma.talkSubscription.findMany({ where: { creatorId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } }, distinct: ['userId'], select: { userId: true } }),
    prisma.talkSubscription.count({ where: { creatorId, status: 'ACTIVE', createdAt: { gte: monthStart } } }),
    prisma.talkSubscription.aggregate({ where: { creatorId, status: 'ACTIVE', createdAt: { gte: monthStart } }, _sum: { netAmount: true } }),
    prisma.talkMessage.count({ where: { creatorId, kind: 'BROADCAST', deletedAt: null, createdAt: { gte: monthStart } } }),
  ]);
  return { subscribers: activeSubs.length, newSubs30d: newSubs, net30d: revenue._sum.netAmount ?? 0n, sent30d: sent };
}

export async function listBroadcasts(creatorId: string, limit = 20) {
  return prisma.talkMessage.findMany({ where: { creatorId, kind: { in: ['BROADCAST', 'DIRECT'] }, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: limit });
}

/** 크리에이터가 보낸 메시지 목록 + 읽은 팬 수 · 답장 수 · 하트 수 (예약 메시지는 따로) */
export async function getCreatorTimeline(creatorId: string, opts: { limit?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [sent, scheduled, activeSubs] = await Promise.all([
    prisma.talkMessage.findMany({ where: { creatorId, kind: { in: ['BROADCAST', 'DIRECT'] }, deletedAt: null, createdAt: { lte: now } }, orderBy: { createdAt: 'desc' }, take: Math.min(opts.limit ?? 15, 100) }),
    prisma.talkMessage.findMany({ where: { creatorId, kind: 'BROADCAST', deletedAt: null, createdAt: { gt: now } }, orderBy: { createdAt: 'asc' }, take: 50 }),
    prisma.talkSubscription.findMany({ where: { creatorId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } }, distinct: ['userId'], select: { userId: true } }),
  ]);
  const ids = sent.map((m) => m.id);
  const [replies, hearts] = ids.length
    ? await Promise.all([
        prisma.talkMessage.groupBy({ by: ['replyToId'], where: { creatorId, kind: 'FAN_REPLY', replyToId: { in: ids } }, _count: { _all: true } }),
        prisma.talkReaction.groupBy({ by: ['messageId'], where: { messageId: { in: ids } }, _count: { _all: true } }),
      ])
    : [[], []];
  const subIds = activeSubs.map((x) => x.userId);
  const reads = subIds.length ? await prisma.talkReadState.findMany({ where: { creatorId, userId: { in: subIds } }, select: { lastReadAt: true } }) : [];
  return {
    subscribers: subIds.length,
    scheduled,
    sent: sent.map((m) => ({
      ...m,
      readCount: m.kind === 'BROADCAST' ? reads.filter((r) => r.lastReadAt >= m.createdAt).length : null,
      replyCount: replies.find((r) => r.replyToId === m.id)?._count._all ?? 0,
      heartCount: hearts.find((h) => h.messageId === m.id)?._count._all ?? 0,
    })),
  };
}

export async function toggleHeart(creatorId: string, messageId: string): Promise<boolean> {
  const m = await prisma.talkMessage.findFirst({ where: { id: messageId, creatorId, kind: 'FAN_REPLY' } });
  if (!m) throw new Error('메시지를 찾을 수 없습니다.');
  await prisma.talkMessage.update({ where: { id: m.id }, data: { hearted: !m.hearted } });
  return !m.hearted;
}

/** 삭제: 크리에이터는 자기 방의 모든 메시지, 팬은 자기 답장만 */
export async function deleteTalkMessage(messageId: string, by: { type: 'CREATOR'; creatorId: string } | { type: 'FAN'; userId: string } | { type: 'ADMIN'; userId: string }) {
  const m = await prisma.talkMessage.findUnique({ where: { id: messageId } });
  if (!m || m.deletedAt) throw new Error('메시지를 찾을 수 없습니다.');
  if (by.type === 'CREATOR' && m.creatorId !== by.creatorId) throw new Error('내 팬챗방 메시지만 지울 수 있습니다.');
  if (by.type === 'FAN' && (m.kind !== 'FAN_REPLY' || m.fanUserId !== by.userId)) throw new Error('내가 보낸 메시지만 지울 수 있습니다.');
  await prisma.talkMessage.update({ where: { id: m.id }, data: { deletedAt: new Date(), deletedBy: `${by.type}:${by.type === 'CREATOR' ? by.creatorId : by.userId}` } });
  publishTalkSignal({ creatorId: m.creatorId, kind: 'DELETE' });
}

export async function setTalkBlock(creatorId: string, userId: string, block: boolean, reason?: string) {
  if (block) {
    await prisma.talkBlock.upsert({ where: { creatorId_userId: { creatorId, userId } }, create: { id: newId(), creatorId, userId, reason: reason?.slice(0, 200) ?? null }, update: { reason: reason?.slice(0, 200) ?? null } });
  } else {
    await prisma.talkBlock.deleteMany({ where: { creatorId, userId } });
  }
}

export async function reportTalkMessage(input: { target: 'MESSAGE' | 'SESSION_MESSAGE'; messageId: string; reporterUserId: string; reporterRole: 'FAN' | 'CREATOR'; reason: string }): Promise<TalkResult> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, message: '신고 사유를 입력해 주세요.' };
  let creatorId: string | null = null;
  /**
   * [5차 P2-13] 신고는 그 메시지를 볼 수 있는 사람만 한다.
   *  - 팬챗방: 그 방의 크리에이터, 또는 그 크리에이터를 구독한 적이 있는 회원 (남에게 간 1:1 답장은 제외)
   *  - 1:1 대화: 그 예약의 구독자 또는 크리에이터
   * (아무 메시지 ID 로나 신고해 관리자 열람 대상으로 만드는 것을 막는다)
   */
  if (input.target === 'MESSAGE') {
    const m = await prisma.talkMessage.findUnique({ where: { id: input.messageId }, select: { creatorId: true, kind: true, fanUserId: true, creator: { select: { userId: true } } } });
    if (m) {
      const isCreator = m.creator.userId === input.reporterUserId;
      const subscribed = isCreator ? true : Boolean(await prisma.talkSubscription.findFirst({ where: { creatorId: m.creatorId, userId: input.reporterUserId }, select: { id: true } }));
      const visible = isCreator || (subscribed && (m.kind !== 'DIRECT' || m.fanUserId === input.reporterUserId));
      creatorId = visible ? m.creatorId : null;
    }
  } else {
    const m = await prisma.talkSessionMessage.findUnique({ where: { id: input.messageId }, select: { session: { select: { creatorId: true, userId: true, creator: { select: { userId: true } } } } } });
    if (m && (m.session.userId === input.reporterUserId || m.session.creator.userId === input.reporterUserId)) creatorId = m.session.creatorId;
  }
  if (!creatorId) return { ok: false, message: '메시지를 찾을 수 없습니다.' };
  const dup = await prisma.talkReport.findFirst({ where: { messageId: input.messageId, reporterUserId: input.reporterUserId, status: 'OPEN' }, select: { id: true } });
  if (dup) return { ok: true, message: '이미 신고한 메시지입니다. 운영팀이 확인 중이에요.' };
  await prisma.talkReport.create({ data: { id: newId(), target: input.target, messageId: input.messageId, creatorId, reporterUserId: input.reporterUserId, reporterRole: input.reporterRole, reason } });
  return { ok: true, message: '신고했어요. 운영팀이 확인 후 조치합니다.' };
}
