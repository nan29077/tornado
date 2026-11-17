/**
 * 소통 채팅 — 크리에이터별 1:N 소통방, 월 구독 (2026-11-17).
 *
 * 방식(talk.config.roomMode, 최고관리자 설정)
 *  - GROUP(기본) 단체방: 크리에이터와 구독자 여러 명이 함께 대화한다. 구독자 메시지(FAN_REPLY)도 구독자 모두에게 보인다.
 *  - BUBBLE 버블형: 크리에이터 메시지는 모두에게, 구독자 메시지는 크리에이터에게만 보인다.
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
import { getShopPaymentAdapter } from '@/server/adapters/shop-payment';
import { cancelShopPayment } from '@/server/services/shop/payment-cancel';
import { appendLedger } from '@/server/services/settlement';
import { notifyUser } from '@/server/services/notifications';
import { loadBannedWords } from '@/server/services/donation-flow';
import { filterContent } from '@/server/services/content-filter';
import { getCreatorEngagement, getTalkConfig, splitFee } from '@/server/services/engagement/config';
import type { PayMethod } from '@/server/services/vote/purchase';

export const TALK_BODY_MAX_CREATOR = 1000;

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
}

export async function getSubscriptionStatus(userId: string | null | undefined, creatorId: string, now: Date = new Date()): Promise<SubscriptionStatus> {
  if (!userId) return { active: false, endsAt: null, firstStartAt: null };
  const subs = await prisma.talkSubscription.findMany({
    where: { userId, creatorId, status: 'ACTIVE' },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true, endsAt: true },
  });
  if (subs.length === 0) return { active: false, endsAt: null, firstStartAt: null };
  const active = subs.find((s) => s.startsAt <= now && s.endsAt > now);
  const latestEnd = subs.reduce<Date | null>((m, s) => (!m || s.endsAt > m ? s.endsAt : m), null);
  return { active: Boolean(active), endsAt: latestEnd, firstStartAt: subs[0].startsAt };
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
  const cfg = await getTalkConfig();
  if (!cfg.enabled) return { ok: false, message: '지금은 소통 구독을 받지 않습니다.' };
  const creator = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { id: true, status: true, displayName: true, userId: true } });
  if (!creator || creator.status !== 'APPROVED') return { ok: false, message: '구독할 수 없는 크리에이터입니다.' };
  if (creator.userId === user.id) return { ok: false, message: '내 소통방은 구독할 수 없어요.' };
  const room = await prisma.talkRoom.findUnique({ where: { creatorId } });
  if (!room?.open) return { ok: false, message: '아직 소통방을 열지 않은 크리에이터입니다.' };
  if (await isBlocked(creatorId, user.id)) return { ok: false, message: '이 크리에이터의 소통방은 이용할 수 없습니다.' };
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
    .approve({ paymentNo, amount: price, buyerName: user.name ?? '회원', itemName: `${creator.displayName} 소통 ${cfg.subPeriodDays}일 이용권` })
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
      await appendLedger([{ creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: net, memo: `소통 구독 ${paymentNo} (${price.toString()}원 - 수수료 ${fee.toString()}원) #${subId}`, occurredAt: now }], tx);
    }
    return endsAt;
  });
  if (!result) return { ok: true, message: '이미 처리된 결제입니다.' };
  await notifyUser({ userId: creator.userId, title: '새 소통 구독', body: `${user.name ?? '팬'} 님이 소통을 구독했어요.`, linkUrl: '/studio/talk' }).catch(() => undefined);
  return { ok: true, message: `${creator.displayName} 님 소통을 구독했어요. 이제 메시지를 주고받을 수 있어요.`, endsAt: result };
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
      await appendLedger([{ creatorId: sub.creatorId, entryType: 'TALK_SUBSCRIPTION_PROCEEDS', amount: -sub.netAmount, memo: `소통 구독 환불 반대분개 (관리자 ${adminUserId}: ${reason.slice(0, 60)}) #${sub.id}`, occurredAt: now }], tx);
    }
    return true;
  });
  if (!moved) return { ok: false, message: '이미 처리된 구독입니다.' };
  const done = await cancelPayment(sub.paymentId, sub.price, reason);
  return { ok: true, message: done ? '구독을 환불했습니다.' : '구독을 종료하고 정산을 되돌렸습니다. 결제사 취소는 실패해 [결제 취소 재시도] 목록에 남겼습니다.' };
}

/** 결제 취소. 실패하면 재시도 대기로 남긴다(관리자 > 결제). true = 취소 완료 */
export async function cancelPayment(paymentId: string | null, amount: bigint, reason: string): Promise<boolean> {
  return (await cancelShopPayment(paymentId, amount, reason)).done;
}

// ---------------------------------------------------------------------- 메시지

async function cleanBody(creatorId: string, body: string, maxLength: number, mask: boolean): Promise<{ ok: true; text: string; masked: boolean } | { ok: false; message: string }> {
  const raw = body.replace(/\r\n/g, '\n').trim();
  if (!raw) return { ok: false, message: '메시지를 입력해 주세요.' };
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

/** 크리에이터 → 구독자 전체 */
export async function sendBroadcast(creatorId: string, body: string, imageUrl?: string | null): Promise<TalkResult> {
  const cfg = await getTalkConfig();
  if (!cfg.enabled) return { ok: false, message: '소통 기능이 꺼져 있습니다.' };
  const c = await cleanBody(creatorId, body, TALK_BODY_MAX_CREATOR, false);
  if (!c.ok) return c;
  await getOrCreateRoom(creatorId);
  await prisma.talkMessage.create({ data: { id: newId(), creatorId, kind: 'BROADCAST', body: c.text, imageUrl: imageUrl || null } });
  return { ok: true, message: '구독 중인 팬 모두에게 보냈어요.' };
}

/** 크리에이터 → 팬 한 명 */
export async function sendDirect(creatorId: string, fanUserId: string, body: string): Promise<TalkResult> {
  const sub = await prisma.talkSubscription.findFirst({ where: { creatorId, userId: fanUserId }, select: { id: true } });
  if (!sub) return { ok: false, message: '구독한 적이 없는 회원에게는 보낼 수 없어요.' };
  const c = await cleanBody(creatorId, body, TALK_BODY_MAX_CREATOR, false);
  if (!c.ok) return c;
  await prisma.talkMessage.create({ data: { id: newId(), creatorId, kind: 'DIRECT', fanUserId, body: c.text } });
  return { ok: true, message: '이 팬에게만 답장했어요.' };
}

/** 팬 → 크리에이터 */
export async function sendFanReply(user: { id: string }, creatorId: string, body: string, now: Date = new Date()): Promise<TalkResult & { masked?: boolean }> {
  const cfg = await getTalkConfig();
  if (!cfg.enabled) return { ok: false, message: '소통 기능이 꺼져 있습니다.' };
  const status = await getSubscriptionStatus(user.id, creatorId, now);
  if (!status.active) return { ok: false, message: '구독 중인 회원만 메시지를 보낼 수 있어요.' };
  if (await isBlocked(creatorId, user.id)) return { ok: false, message: '이 소통방에서는 메시지를 보낼 수 없습니다.' };
  if (cfg.fanReplyDailyLimit > 0) {
    const used = await prisma.talkMessage.count({ where: { creatorId, kind: 'FAN_REPLY', fanUserId: user.id, createdAt: { gte: kstStartOfDay(now) } } });
    if (used >= cfg.fanReplyDailyLimit) return { ok: false, message: `오늘은 메시지를 ${cfg.fanReplyDailyLimit}번까지 보낼 수 있어요. 내일 다시 보내 주세요.` };
  }
  const c = await cleanBody(creatorId, body, cfg.fanReplyMaxLength, true);
  if (!c.ok) return c;
  await prisma.talkMessage.create({ data: { id: newId(), creatorId, kind: 'FAN_REPLY', fanUserId: user.id, body: c.text, createdAt: now } });
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
  hearted: boolean;
  createdAt: string;
}

/** 팬이 보는 대화 (구독 중일 때만). after 가 있으면 그 이후 새 메시지만 */
export async function getFanThread(user: { id: string; name: string | null }, creatorId: string, opts: { after?: Date | null; limit?: number; now?: Date } = {}): Promise<{ allowed: boolean; messages: ThreadMessage[] }> {
  const now = opts.now ?? new Date();
  const status = await getSubscriptionStatus(user.id, creatorId, now);
  if (!status.active || !status.firstStartAt) return { allowed: false, messages: [] };
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
  const cfg = await getTalkConfig();
  const group = cfg.roomMode === 'GROUP';
  const since = new Date(status.firstStartAt.getTime() - 3 * 86_400_000);
  const blocked = group ? (await prisma.talkBlock.findMany({ where: { creatorId }, select: { userId: true } })).map((b) => b.userId) : [];
  // [5차 P2-13] 차단된 구독자는 크리에이터 메시지·자기 메시지만 본다 (다른 구독자 대화는 보지 않는다)
  const meBlocked = blocked.includes(user.id) || (!group && (await isBlocked(creatorId, user.id)));
  const rows = await prisma.talkMessage.findMany({
    where: {
      creatorId,
      deletedAt: null,
      ...(opts.after ? { createdAt: { gt: opts.after } } : {}),
      OR: [
        { kind: 'BROADCAST', createdAt: { gte: since } },
        group && !meBlocked
          ? { kind: 'FAN_REPLY', createdAt: { gte: since }, OR: [{ fanUserId: user.id }, { fanUserId: { notIn: blocked } }] }
          : { kind: 'FAN_REPLY', fanUserId: user.id },
        { kind: 'DIRECT', fanUserId: user.id },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const fanName = await fanDisplayName(user.id, user.name);
  const others = [...new Set(rows.filter((r) => r.kind === 'FAN_REPLY' && r.fanUserId && r.fanUserId !== user.id).map((r) => r.fanUserId as string))];
  const [ou, od] = others.length
    ? await Promise.all([
        prisma.user.findMany({ where: { id: { in: others } }, select: { id: true, name: true, avatarIndex: true } }),
        prisma.donorProfile.findMany({ where: { userId: { in: others } }, select: { userId: true, displayName: true } }),
      ])
    : [[], []];
  const nameOf = (id: string) => od.find((d) => d.userId === id)?.displayName ?? ou.find((u) => u.id === id)?.name ?? '팬';
  return {
    allowed: true,
    messages: rows.reverse().map((m) => ({
      id: m.id,
      kind: m.kind as ThreadMessage['kind'],
      mine: m.kind === 'FAN_REPLY' && m.fanUserId === user.id,
      authorName: m.kind === 'FAN_REPLY' && m.fanUserId !== user.id && m.fanUserId ? nameOf(m.fanUserId) : null,
      authorAvatarIndex: m.kind === 'FAN_REPLY' && m.fanUserId !== user.id && m.fanUserId ? ou.find((u) => u.id === m.fanUserId)?.avatarIndex ?? 0 : null,
      body: m.kind === 'FAN_REPLY' ? m.body : personalize(m.body, fanName),
      imageUrl: m.imageUrl,
      hearted: m.hearted,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/** 팬 이름: 후원 닉네임(방송 표시명) > 회원 이름 */
export async function fanDisplayName(userId: string, fallback: string | null): Promise<string> {
  const donor = await prisma.donorProfile.findUnique({ where: { userId }, select: { displayName: true } }).catch(() => null);
  return (donor?.displayName ?? fallback ?? '').trim() || '팬';
}

export async function markFanRead(userId: string, creatorId: string, at: Date = new Date()) {
  await prisma.talkReadState.upsert({
    where: { userId_creatorId: { userId, creatorId } },
    create: { id: newId(), userId, creatorId, lastReadAt: at },
    update: { lastReadAt: at },
  });
}

/** 팬의 소통방 목록 (마이페이지) */
export async function listMyTalkRooms(userId: string, now: Date = new Date()) {
  const subs = await prisma.talkSubscription.findMany({
    where: { userId },
    orderBy: { endsAt: 'desc' },
    include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } } } },
  });
  const byCreator = new Map<string, (typeof subs)[number] & { activeNow: boolean; latestEnd: Date }>();
  for (const s of subs) {
    const cur = byCreator.get(s.creatorId);
    const activeNow = s.status === 'ACTIVE' && s.startsAt <= now && s.endsAt > now;
    if (!cur) byCreator.set(s.creatorId, { ...s, activeNow, latestEnd: s.endsAt });
    else {
      if (activeNow) cur.activeNow = true;
      if (s.status === 'ACTIVE' && s.endsAt > cur.latestEnd) cur.latestEnd = s.endsAt;
    }
  }
  const reads = await prisma.talkReadState.findMany({ where: { userId, creatorId: { in: [...byCreator.keys()] } } });
  const rmap = new Map(reads.map((r) => [r.creatorId, r.lastReadAt]));
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const myName = await fanDisplayName(userId, me?.name ?? null);
  const out = [];
  for (const s of byCreator.values()) {
    const since = rmap.get(s.creatorId) ?? s.startsAt;
    const unread = s.activeNow
      ? await prisma.talkMessage.count({ where: { creatorId: s.creatorId, deletedAt: null, createdAt: { gt: since }, OR: [{ kind: 'BROADCAST' }, { kind: 'DIRECT', fanUserId: userId }] } })
      : 0;
    const last = await prisma.talkMessage.findFirst({ where: { creatorId: s.creatorId, kind: 'BROADCAST', deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { body: true, createdAt: true } });
    out.push({ creator: s.creator, active: s.activeNow, endsAt: s.latestEnd, unread, lastBody: last ? personalize(last.body, myName) : null, lastAt: last?.createdAt ?? null });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

// ---------------------------------------------------------------------- 크리에이터 화면

export async function getCreatorInbox(creatorId: string, opts: { filter?: 'all' | 'unread' | 'hearted'; fanUserId?: string | null; limit?: number } = {}) {
  const room = await getOrCreateRoom(creatorId);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const where = {
    creatorId,
    deletedAt: null,
    kind: 'FAN_REPLY',
    ...(opts.fanUserId ? { fanUserId: opts.fanUserId } : {}),
    ...(opts.filter === 'hearted' ? { hearted: true } : {}),
    ...(opts.filter === 'unread' && room.creatorLastReadAt ? { createdAt: { gt: room.creatorLastReadAt } } : {}),
  };
  const rows = await prisma.talkMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  const fanIds = [...new Set(rows.map((r) => r.fanUserId).filter((x): x is string => Boolean(x)))];
  const [users, donors, blocks] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: fanIds } }, select: { id: true, name: true, avatarIndex: true } }),
    prisma.donorProfile.findMany({ where: { userId: { in: fanIds } }, select: { userId: true, displayName: true } }),
    prisma.talkBlock.findMany({ where: { creatorId, userId: { in: fanIds } }, select: { userId: true } }),
  ]);
  const umap = new Map(users.map((u) => [u.id, u]));
  const dmap = new Map(donors.map((d) => [d.userId ?? '', d.displayName]));
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
        fanName: (r.fanUserId ? dmap.get(r.fanUserId) : null) ?? u?.name ?? '팬',
        avatarIndex: u?.avatarIndex ?? 0,
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
  if (by.type === 'CREATOR' && m.creatorId !== by.creatorId) throw new Error('내 소통방 메시지만 지울 수 있습니다.');
  if (by.type === 'FAN' && (m.kind !== 'FAN_REPLY' || m.fanUserId !== by.userId)) throw new Error('내가 보낸 메시지만 지울 수 있습니다.');
  await prisma.talkMessage.update({ where: { id: m.id }, data: { deletedAt: new Date(), deletedBy: `${by.type}:${by.type === 'CREATOR' ? by.creatorId : by.userId}` } });
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
   *  - 소통방: 그 방의 크리에이터, 또는 그 크리에이터를 구독한 적이 있는 회원 (남에게 간 1:1 답장은 제외)
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
