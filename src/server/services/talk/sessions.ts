/**
 * 1:1 예약 채팅 (2026-11-17).
 *
 * ★ 전역 스위치(talk.config.sessionEnabled) 가 꺼져 있으면 모든 화면에서 사라지고, 이 파일의 모든 쓰기 동작이 거절된다.
 *   크리에이터별로도 막을 수 있다(최고관리자 지정 sessionAllowed=false, 또는 크리에이터가 신청을 받지 않음).
 *
 * 흐름
 *  크리에이터: 요일·시간대 등록(+ 쉬는 날) → 1회 시간(분)·가격(허용 시)
 *  구독자: 일정표에서 빈 시간 선택 → 결제 → REQUESTED(승인 대기)
 *  크리에이터: 수락 → ACCEPTED / 거절 → REJECTED(전액 환불)
 *  승인 기한(신청 후 N시간, 시작 1시간 전 중 이른 시각)까지 응답이 없으면 → EXPIRED(전액 환불)
 *  시작 시각 ~ 종료 시각에만 대화 가능 → 종료 시각이 지나면 COMPLETED, 정산 원장 TALK_SESSION_PROCEEDS 적립
 *  구독자 취소: 승인 전 전액 / 승인 후 시작 N시간 전까지 전액 / 그 이후 설정 비율 / 시작 후 불가
 *  크리에이터 취소(승인 후): 전액 환불
 *  크리에이터 불참: 시작 후 N분 동안 크리에이터 메시지가 없으면 구독자가 [불참 신고] → NO_SHOW(전액 환불)
 * 같은 크리에이터·같은 시작 시각에 살아 있는 예약은 DB 부분 유니크 인덱스로 하나만 허용한다.
 */
import { prisma, withAdvisoryLock } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { maskContacts } from '@/lib/contact-mask';
import { getShopPaymentAdapter } from '@/server/adapters/shop-payment';
import { appendLedger } from '@/server/services/settlement';
import { notifyUser } from '@/server/services/notifications';
import { getCreatorEngagement, getTalkConfig, rateOf, splitFee, type TalkConfig } from '@/server/services/engagement/config';
import { cancelPayment, getOrCreateRoom } from './talk';
import type { PayMethod } from '@/server/services/vote/purchase';

const KST = 9 * 3600_000;
const MIN = 60_000;

export const SESSION_STATUS_LABEL: Record<string, { text: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  REQUESTED: { text: '승인 대기', tone: 'warning' },
  ACCEPTED: { text: '예약 확정', tone: 'brand' },
  COMPLETED: { text: '완료', tone: 'success' },
  REJECTED: { text: '거절 · 환불', tone: 'neutral' },
  EXPIRED: { text: '기한 만료 · 환불', tone: 'neutral' },
  CANCELLED: { text: '취소', tone: 'neutral' },
  NO_SHOW: { text: '크리에이터 불참 · 환불', tone: 'danger' },
};

export const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

/** 이 크리에이터가 지금 1:1 신청을 받을 수 있는가 (전역 스위치 → 관리자 크리에이터별 → 크리에이터 설정) */
export async function sessionAvailability(creatorId: string, cfg?: TalkConfig): Promise<{ available: boolean; reason?: string; globalOn: boolean }> {
  const talk = cfg ?? (await getTalkConfig());
  if (!talk.enabled || !talk.sessionEnabled) return { available: false, reason: '1:1 채팅이 꺼져 있습니다.', globalOn: false };
  const [eng, room] = await Promise.all([getCreatorEngagement(creatorId, prisma, { talk }), prisma.talkRoom.findUnique({ where: { creatorId } })]);
  if (!eng.session.allowed) return { available: false, reason: '이 크리에이터는 1:1 채팅을 받을 수 없습니다.', globalOn: true };
  if (!room?.sessionEnabled) return { available: false, reason: '이 크리에이터는 지금 1:1 채팅 신청을 받지 않습니다.', globalOn: true };
  return { available: true, globalOn: true };
}

async function assertGlobalOn(cfg?: TalkConfig) {
  const talk = cfg ?? (await getTalkConfig());
  if (!talk.enabled || !talk.sessionEnabled) throw new Error('1:1 채팅이 꺼져 있습니다.');
  return talk;
}

// ---------------------------------------------------------------------- 일정표

export interface Slot {
  startsAt: string;
  endsAt: string;
  /** KST YYYY-MM-DD */
  date: string;
  /** HH:MM (KST) */
  time: string;
  available: boolean;
}

function kstDateParts(d: Date) {
  const k = new Date(d.getTime() + KST);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth(), d: k.getUTCDate(), wd: k.getUTCDay() };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 앞으로 N일 동안의 신청 가능 시간 */
export async function getSlots(creatorId: string, now: Date = new Date()): Promise<{ minutes: number; slots: Slot[] }> {
  const talk = await getTalkConfig();
  const room = await getOrCreateRoom(creatorId);
  const rules = await prisma.talkSlotRule.findMany({ where: { creatorId, active: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] });
  const minutes = room.sessionMinutes;
  const blocked = new Set(room.sessionBlockedDates ?? []);
  const earliest = now.getTime() + talk.sessionLeadHours * 3600_000;
  const horizon = now.getTime() + talk.sessionBookDays * 86_400_000;
  const taken = await prisma.talkSession.findMany({
    where: { creatorId, status: { in: ['REQUESTED', 'ACCEPTED', 'COMPLETED'] }, startsAt: { gte: new Date(now.getTime() - 86_400_000), lte: new Date(horizon + 86_400_000) } },
    select: { startsAt: true, endsAt: true },
  });
  const slots: Slot[] = [];
  const today = kstDateParts(now);
  for (let i = 0; i <= talk.sessionBookDays; i++) {
    const dayStartUtc = Date.UTC(today.y, today.m, today.d + i) - KST;
    const date = kstDateKey(new Date(dayStartUtc + 3600_000));
    const wd = new Date(dayStartUtc + KST).getUTCDay();
    if (blocked.has(date)) continue;
    for (const r of rules.filter((x) => x.weekday === wd)) {
      for (let t = r.startMinute; t + minutes <= r.endMinute; t += minutes) {
        const s = dayStartUtc + t * MIN;
        const e = s + minutes * MIN;
        if (s < earliest || s > horizon) continue;
        const overlap = taken.some((x) => x.startsAt.getTime() < e && x.endsAt.getTime() > s);
        slots.push({ startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), date, time: hhmm(t), available: !overlap });
      }
    }
  }
  return { minutes, slots };
}

export function parseRuleLines(input: string): Array<{ weekday: number; startMinute: number; endMinute: number }> {
  // "월 20:00-23:00" 형식 한 줄에 하나
  const out: Array<{ weekday: number; startMinute: number; endMinute: number }> = [];
  for (const line of input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^([일월화수목금토])\s*(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})$/.exec(line);
    if (!m) throw new Error(`"${line}" 형식이 올바르지 않습니다. 예) 월 20:00-23:00`);
    const weekday = WEEKDAY_LABEL.indexOf(m[1]);
    const startMinute = Number(m[2]) * 60 + Number(m[3]);
    const endMinute = Number(m[4]) * 60 + Number(m[5]);
    if (startMinute >= endMinute || endMinute > 24 * 60) throw new Error(`"${line}" 시간 범위가 올바르지 않습니다.`);
    out.push({ weekday, startMinute, endMinute });
  }
  if (out.length > 40) throw new Error('시간대는 40개까지 등록할 수 있습니다.');
  // [5차 P2-10] 같은 요일에 겹치는 시간대는 받지 않는다 (겹친 시간에 예약이 두 건 잡히는 것을 막는다)
  const sorted = [...out].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.weekday === b.weekday && b.startMinute < a.endMinute) {
      throw new Error(`${formatRule(a)} 와 ${formatRule(b)} 시간이 겹칩니다. 겹치지 않게 나눠 적어 주세요.`);
    }
  }
  return out;
}

export function formatRule(r: { weekday: number; startMinute: number; endMinute: number }) {
  return `${WEEKDAY_LABEL[r.weekday]} ${hhmm(r.startMinute)}-${hhmm(r.endMinute)}`;
}

export async function replaceSlotRules(creatorId: string, rules: Array<{ weekday: number; startMinute: number; endMinute: number }>) {
  await prisma.$transaction([
    prisma.talkSlotRule.deleteMany({ where: { creatorId } }),
    prisma.talkSlotRule.createMany({ data: rules.map((r) => ({ id: newId(), creatorId, ...r })) }),
  ]);
}

// ---------------------------------------------------------------------- 신청 (구독자)

export interface SessionResult {
  ok: boolean;
  message: string;
  sessionId?: string;
}

export async function bookSession(user: { id: string; name: string | null }, creatorId: string, startsAtIso: string, method: PayMethod, note: string, now: Date = new Date()): Promise<SessionResult> {
  let talk: TalkConfig;
  try {
    talk = await assertGlobalOn();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const avail = await sessionAvailability(creatorId, talk);
  if (!avail.available) return { ok: false, message: avail.reason ?? '1:1 채팅을 신청할 수 없습니다.' };
  const [creator, account] = await Promise.all([
    prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { id: true, status: true, displayName: true, userId: true } }),
    prisma.user.findUnique({ where: { id: user.id }, select: { status: true, ageVerified: true } }),
  ]);
  if (!creator || creator.status !== 'APPROVED') return { ok: false, message: '신청할 수 없는 크리에이터입니다.' };
  if (creator.userId === user.id) return { ok: false, message: '내 채널에는 신청할 수 없어요.' };
  if (!account || account.status !== 'ACTIVE') return { ok: false, message: '신청할 수 없는 계정입니다.' };
  if (talk.sessionRequireAdult && !account.ageVerified) return { ok: false, message: '1:1 채팅은 성인 인증을 마친 회원만 신청할 수 있어요.' };
  const blocked = await prisma.talkBlock.findUnique({ where: { creatorId_userId: { creatorId, userId: user.id } }, select: { id: true } });
  if (blocked) return { ok: false, message: '이 크리에이터에게는 신청할 수 없습니다.' };

  const { slots, minutes } = await getSlots(creatorId, now);
  const slot = slots.find((s) => s.startsAt === startsAtIso);
  if (!slot) return { ok: false, message: '신청할 수 없는 시간입니다. 일정표를 새로 고쳐 주세요.' };
  if (!slot.available) return { ok: false, message: '이미 예약된 시간이에요. 다른 시간을 골라 주세요.' };

  const terms = (await getCreatorEngagement(creatorId, prisma, { talk })).session;
  const price = BigInt(terms.price);
  if (price <= 0n) return { ok: false, message: '1:1 채팅 가격이 정해지지 않았습니다.' };
  const { fee, net } = splitFee(price, terms.feeRate);
  const startsAt = new Date(slot.startsAt);
  const endsAt = new Date(slot.endsAt);
  const deadline = new Date(Math.min(now.getTime() + talk.sessionApprovalHours * 3600_000, startsAt.getTime() - 3600_000));
  const sessionId = newId();
  const sessionNo = `TC${Date.now().toString(36).toUpperCase()}${sessionId.slice(-6)}`;
  const paymentId = newId();
  const cleanNote = maskContacts(note.trim().slice(0, 300)).text;

  // 1) 자리 먼저 잡기 — 크리에이터 단위 잠금 안에서 겹치는 예약을 다시 확인한다
  //    (부분 유니크 인덱스는 같은 시작 시각만 막으므로, 시간이 겹치는 다른 시작 시각도 여기서 막는다)
  try {
    const clash = await prisma.$transaction((tx) =>
      withAdvisoryLock(tx, `talk-session:creator:${creatorId}`, async () => {
        const overlap = await tx.talkSession.findFirst({
          where: { creatorId, status: { in: ['REQUESTED', 'ACCEPTED'] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
          select: { id: true },
        });
        if (overlap) return true;
        await tx.shopPayment.create({ data: { id: paymentId, paymentNo: sessionNo, userId: user.id, kind: 'TALK_SESSION', method, amount: price, provider: getShopPaymentAdapter().provider, creatorId } });
        await tx.talkSession.create({
        data: {
          id: sessionId,
          sessionNo,
          creatorId,
          userId: user.id,
          startsAt,
          endsAt,
          minutes,
          price,
          feeRate: terms.feeRate.toFixed(6),
          feeAmount: fee,
          netAmount: net,
          status: 'REQUESTED',
          requestNote: cleanNote || null,
          method,
          paymentId,
          approvalDeadline: deadline,
          createdAt: now,
        },
      });
        return false;
      }),
    );
    if (clash) return { ok: false, message: '방금 다른 분이 겹치는 시간을 예약했어요. 다른 시간을 골라 주세요.' };
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return { ok: false, message: '방금 다른 분이 이 시간을 예약했어요. 다른 시간을 골라 주세요.' };
    throw e;
  }

  // 2) 결제
  const approved = await getShopPaymentAdapter()
    .approve({ paymentNo: sessionNo, amount: price, buyerName: user.name ?? '회원', itemName: `${creator.displayName} 1:1 채팅 ${minutes}분` })
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : '결제 오류' }));
  if (!approved.ok) {
    await prisma.$transaction([
      prisma.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'FAILED', failReason: approved.reason.slice(0, 200) } }),
      // 자리를 다시 연다
      prisma.talkSession.updateMany({ where: { id: sessionId, status: 'REQUESTED' }, data: { status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: '결제 실패' } }),
    ]);
    return { ok: false, message: `결제에 실패했습니다: ${approved.reason}` };
  }
  await prisma.shopPayment.updateMany({ where: { id: paymentId, status: 'READY' }, data: { status: 'PAID', providerTx: approved.providerTx, paidAt: now } });
  await notifyUser({ userId: creator.userId, title: '1:1 채팅 신청', body: `${user.name ?? '팬'} 님이 ${formatKstShort(startsAt)} 1:1 채팅을 신청했어요. 승인해 주세요.`, linkUrl: '/studio/talk/sessions' }).catch(() => undefined);
  return { ok: true, message: '신청했어요. 크리에이터가 수락하면 예약이 확정돼요.', sessionId };
}

export function formatKstShort(d: Date): string {
  const k = new Date(d.getTime() + KST);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${WEEKDAY_LABEL[k.getUTCDay()]}) ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------- 상태 변경

async function refundSession(
  sessionId: string,
  status: string,
  refund: bigint,
  by: string,
  reason: string,
  now: Date,
  extra?: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], s: NonNullable<Awaited<ReturnType<typeof prisma.talkSession.findUnique>>>) => Promise<void>,
): Promise<boolean> {
  const s = await prisma.talkSession.findUnique({ where: { id: sessionId } });
  if (!s) return false;
  // 상태 변경과 (있다면) 정산 적립을 한 트랜잭션으로 묶는다 (5차 P2-11)
  const moved = await prisma.$transaction(async (tx) => {
    const m = await tx.talkSession.updateMany({
      where: { id: sessionId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
      data: { status, refundAmount: refund, refundedAt: refund > 0n ? now : null, cancelledBy: by, cancelReason: reason.slice(0, 200), decidedAt: now },
    });
    if (m.count === 0) return false;
    if (extra) await extra(tx, s);
    return true;
  });
  if (!moved) return false;
  if (refund > 0n) await cancelPayment(s.paymentId, refund, reason);
  return true;
}

export async function acceptSession(creatorId: string, sessionId: string, now: Date = new Date()): Promise<SessionResult> {
  await assertGlobalOn();
  const s = await prisma.talkSession.findFirst({ where: { id: sessionId, creatorId } });
  if (!s) return { ok: false, message: '신청을 찾을 수 없습니다.' };
  if (s.status !== 'REQUESTED') return { ok: false, message: '승인 대기 중인 신청이 아닙니다.' };
  if (s.approvalDeadline <= now) {
    await refundSession(s.id, 'EXPIRED', s.price, 'SYSTEM', '승인 기한 초과', now);
    return { ok: false, message: '승인 기한이 지나 자동 취소·환불되었습니다.' };
  }
  const moved = await prisma.talkSession.updateMany({ where: { id: s.id, status: 'REQUESTED' }, data: { status: 'ACCEPTED', decidedAt: now } });
  if (moved.count === 0) return { ok: false, message: '이미 처리된 신청입니다.' };
  await notifyUser({ userId: s.userId, title: '1:1 채팅 예약 확정', body: `${formatKstShort(s.startsAt)} 1:1 채팅이 확정되었어요.`, linkUrl: `/my/talk/sessions/${s.id}` }).catch(() => undefined);
  return { ok: true, message: '수락했어요. 예약이 확정되었습니다.' };
}

export async function rejectSession(creatorId: string, sessionId: string, reason: string, now: Date = new Date()): Promise<SessionResult> {
  const s = await prisma.talkSession.findFirst({ where: { id: sessionId, creatorId } });
  if (!s) return { ok: false, message: '신청을 찾을 수 없습니다.' };
  if (s.status === 'REQUESTED') {
    const ok = await refundSession(s.id, 'REJECTED', s.price, 'CREATOR', reason || '크리에이터 거절', now);
    if (!ok) return { ok: false, message: '이미 처리된 신청입니다.' };
    await notifyUser({ userId: s.userId, title: '1:1 채팅 신청이 거절되었어요', body: `${formatKstShort(s.startsAt)} 신청이 거절되어 전액 환불됩니다.${reason ? ` 사유: ${reason}` : ''}`, linkUrl: '/my/talk' }).catch(() => undefined);
    return { ok: true, message: '거절했어요. 결제 금액은 전액 환불됩니다.' };
  }
  if (s.status === 'ACCEPTED') {
    if (s.startsAt <= now) return { ok: false, message: '이미 시작된 1:1 채팅은 취소할 수 없습니다.' };
    const ok = await refundSession(s.id, 'CANCELLED', s.price, 'CREATOR', reason || '크리에이터 취소', now);
    if (!ok) return { ok: false, message: '이미 처리된 예약입니다.' };
    await notifyUser({ userId: s.userId, title: '1:1 채팅 예약이 취소되었어요', body: `크리에이터 사정으로 ${formatKstShort(s.startsAt)} 예약이 취소되어 전액 환불됩니다.`, linkUrl: '/my/talk' }).catch(() => undefined);
    return { ok: true, message: '예약을 취소했어요. 전액 환불됩니다.' };
  }
  return { ok: false, message: '취소할 수 없는 상태입니다.' };
}

/** 구독자 취소 — 환불 금액 계산 규칙 */
export function fanCancelRefund(s: { status: string; startsAt: Date; price: bigint }, talk: TalkConfig, now: Date): { allowed: boolean; refund: bigint; reason?: string } {
  if (s.status === 'REQUESTED') return { allowed: true, refund: s.price };
  if (s.status !== 'ACCEPTED') return { allowed: false, refund: 0n, reason: '취소할 수 없는 상태입니다.' };
  if (s.startsAt <= now) return { allowed: false, refund: 0n, reason: '이미 시작된 1:1 채팅은 취소할 수 없습니다.' };
  const hoursLeft = (s.startsAt.getTime() - now.getTime()) / 3600_000;
  if (hoursLeft >= talk.sessionFullRefundHours) return { allowed: true, refund: s.price };
  return { allowed: true, refund: rateOf(s.price, talk.sessionLateRefundRate) };
}

export async function cancelSessionByFan(userId: string, sessionId: string, now: Date = new Date()): Promise<SessionResult> {
  const talk = await getTalkConfig();
  const s = await prisma.talkSession.findFirst({ where: { id: sessionId, userId } });
  if (!s) return { ok: false, message: '신청을 찾을 수 없습니다.' };
  const r = fanCancelRefund(s, talk, now);
  if (!r.allowed) return { ok: false, message: r.reason ?? '취소할 수 없습니다.' };
  // 일부만 환불한 경우 남은 금액은 크리에이터 정산 (예약 시간에 대한 보상) — 상태 변경과 같은 트랜잭션
  const kept = s.price - r.refund;
  const keptNet = kept > 0n ? splitFee(kept, Number(s.feeRate)).net : 0n;
  const ok = await refundSession(s.id, 'CANCELLED', r.refund, 'FAN', '구독자 취소', now, keptNet > 0n
    ? async (tx) => {
        await appendLedger([{ creatorId: s.creatorId, entryType: 'TALK_SESSION_PROCEEDS', amount: keptNet, memo: `1:1 채팅 늦은 취소 정산 ${s.sessionNo} (${kept.toString()}원 중 수수료 차감)`, occurredAt: now }], tx);
        await tx.talkSession.update({ where: { id: s.id }, data: { settledAt: now } });
      }
    : undefined);
  if (!ok) return { ok: false, message: '이미 처리된 신청입니다.' };
  const creator = await prisma.creatorProfile.findUnique({ where: { id: s.creatorId }, select: { userId: true } });
  if (creator) await notifyUser({ userId: creator.userId, title: '1:1 채팅이 취소되었어요', body: `${formatKstShort(s.startsAt)} 예약을 구독자가 취소했어요.`, linkUrl: '/studio/talk/sessions' }).catch(() => undefined);
  return { ok: true, message: r.refund === s.price ? '취소했어요. 전액 환불됩니다.' : `취소했어요. ${r.refund.toLocaleString('ko-KR')}원이 환불됩니다.` };
}

/** 크리에이터 불참 신고 — 시작 후 N분 동안 크리에이터 메시지가 없으면 전액 환불 */
export async function reportNoShow(userId: string, sessionId: string, now: Date = new Date()): Promise<SessionResult> {
  const talk = await getTalkConfig();
  const s = await prisma.talkSession.findFirst({ where: { id: sessionId, userId } });
  if (!s || s.status !== 'ACCEPTED') return { ok: false, message: '진행 중인 예약이 아닙니다.' };
  if (now.getTime() < s.startsAt.getTime() + talk.sessionNoShowMinutes * MIN) return { ok: false, message: `시작 후 ${talk.sessionNoShowMinutes}분이 지나야 신고할 수 있어요.` };
  const creatorMsgs = await prisma.talkSessionMessage.count({ where: { sessionId: s.id, senderType: 'CREATOR' } });
  if (creatorMsgs > 0) return { ok: false, message: '크리에이터가 대화에 참여했어요. 문제가 있으면 신고 버튼으로 알려 주세요.' };
  const ok = await refundSession(s.id, 'NO_SHOW', s.price, 'FAN', '크리에이터 불참', now);
  if (!ok) return { ok: false, message: '이미 처리된 예약입니다.' };
  return { ok: true, message: '크리에이터 불참으로 처리했어요. 전액 환불됩니다.' };
}

/**
 * 기한 정리: 승인 기한이 지난 신청은 만료·환불, 종료 시각이 지난 확정 예약은 완료·정산.
 * 화면을 열 때 호출한다(배치가 없어도 빠짐없이 처리된다). 처리 건수를 돌려준다.
 */
export async function sweepSessions(now: Date = new Date(), scope?: { creatorId?: string; userId?: string }): Promise<{ expired: number; completed: number }> {
  const where = { ...(scope?.creatorId ? { creatorId: scope.creatorId } : {}), ...(scope?.userId ? { userId: scope.userId } : {}) };
  const expiring = await prisma.talkSession.findMany({ where: { ...where, status: 'REQUESTED', approvalDeadline: { lte: now } }, take: 200 });
  let expired = 0;
  for (const s of expiring) {
    if (await refundSession(s.id, 'EXPIRED', s.price, 'SYSTEM', '승인 기한 초과', now)) {
      expired++;
      await notifyUser({ userId: s.userId, title: '1:1 채팅 신청이 만료되었어요', body: `크리에이터가 기한 안에 응답하지 않아 ${formatKstShort(s.startsAt)} 신청이 취소되고 전액 환불됩니다.`, linkUrl: '/my/talk' }).catch(() => undefined);
    }
  }
  const finishing = await prisma.talkSession.findMany({ where: { ...where, status: 'ACCEPTED', endsAt: { lte: now } }, take: 200 });
  let completed = 0;
  const talk = finishing.length > 0 ? await getTalkConfig() : null;
  const switchOn = Boolean(talk?.enabled && talk?.sessionEnabled);
  for (const s of finishing) {
    /**
     * [5차 TALK-A·B] 크리에이터가 한 마디도 하지 않은 예약은 정산하지 않고 전액 환불한다.
     *  - 크리에이터 불참: 10분짜리 예약은 불참 신고 가능 시각이 곧 종료 시각이라 구독자가 신고할 틈이 없었다.
     *  - 1:1 스위치가 꺼진 동안에는 메시지를 보낼 수 없으므로, 대화가 없었던 예약은 진행 불가로 환불한다.
     */
    const creatorMsgs = await prisma.talkSessionMessage.count({ where: { sessionId: s.id, senderType: 'CREATOR' } });
    if (creatorMsgs === 0) {
      const reason = switchOn ? '크리에이터 불참 (자동 확인)' : '1:1 채팅 서비스 중지로 진행 불가';
      if (await refundSession(s.id, 'NO_SHOW', s.price, 'SYSTEM', reason, now)) {
        await notifyUser({ userId: s.userId, title: '1:1 채팅이 진행되지 않아 환불돼요', body: `${formatKstShort(s.startsAt)} 1:1 채팅이 진행되지 않아 전액 환불됩니다. (${reason})`, linkUrl: `/my/talk/sessions/${s.id}` }).catch(() => undefined);
      }
      continue;
    }
    const done = await prisma.$transaction(async (tx) => {
      const m = await tx.talkSession.updateMany({ where: { id: s.id, status: 'ACCEPTED' }, data: { status: 'COMPLETED', completedAt: now, settledAt: s.netAmount > 0n ? now : null } });
      if (m.count === 0) return false;
      if (s.netAmount > 0n) {
        await appendLedger([{ creatorId: s.creatorId, entryType: 'TALK_SESSION_PROCEEDS', amount: s.netAmount, memo: `1:1 채팅 ${s.sessionNo} (${s.price.toString()}원 - 수수료 ${s.feeAmount.toString()}원)`, occurredAt: now }], tx);
      }
      return true;
    });
    if (done) completed++;
  }
  return { expired, completed };
}

/** 관리자: 완료된 예약까지 포함해 강제 환불 (완료 후 환불이면 정산 반대분개) */
export async function adminRefundSession(sessionId: string, adminUserId: string, reason: string, now: Date = new Date()): Promise<SessionResult> {
  const s = await prisma.talkSession.findUnique({ where: { id: sessionId } });
  if (!s) return { ok: false, message: '예약을 찾을 수 없습니다.' };
  if (s.status === 'REQUESTED' || s.status === 'ACCEPTED') {
    const ok = await refundSession(s.id, 'CANCELLED', s.price, `ADMIN:${adminUserId}`, reason || '관리자 취소', now);
    return ok ? { ok: true, message: '취소하고 전액 환불했습니다.' } : { ok: false, message: '이미 처리된 예약입니다.' };
  }
  if (s.status === 'COMPLETED' && s.refundAmount === 0n) {
    const moved = await prisma.$transaction(async (tx) => {
      const m = await tx.talkSession.updateMany({ where: { id: s.id, status: 'COMPLETED', refundAmount: 0n }, data: { refundAmount: s.price, refundedAt: now, cancelReason: `관리자 환불: ${reason}`.slice(0, 200) } });
      if (m.count === 0) return false;
      if (s.settledAt && s.netAmount > 0n) {
        await appendLedger([{ creatorId: s.creatorId, entryType: 'TALK_SESSION_PROCEEDS', amount: -s.netAmount, memo: `1:1 채팅 환불 반대분개 ${s.sessionNo}`, occurredAt: now }], tx);
      }
      return true;
    });
    if (!moved) return { ok: false, message: '이미 환불된 예약입니다.' };
    await cancelPayment(s.paymentId, s.price, reason);
    return { ok: true, message: '완료된 예약을 환불하고 정산액을 반대분개했습니다.' };
  }
  return { ok: false, message: '환불할 수 있는 상태가 아닙니다.' };
}

/** 전역 스위치를 끌 때 남은 예약 정리. mode=keep 이면 그대로 진행, cancel 이면 시작 전 예약 전부 취소·환불 */
export async function closeAllPendingSessions(adminUserId: string, now: Date = new Date()): Promise<number> {
  const rows = await prisma.talkSession.findMany({ where: { status: { in: ['REQUESTED', 'ACCEPTED'] }, startsAt: { gt: now } }, select: { id: true, userId: true, startsAt: true } });
  let n = 0;
  for (const r of rows) {
    const s = await prisma.talkSession.findUnique({ where: { id: r.id } });
    if (!s) continue;
    if (await refundSession(s.id, 'CANCELLED', s.price, `ADMIN:${adminUserId}`, '1:1 채팅 서비스 중지', now)) {
      n++;
      await notifyUser({ userId: s.userId, title: '1:1 채팅 예약이 취소되었어요', body: `서비스 운영 사정으로 ${formatKstShort(s.startsAt)} 예약이 취소되고 전액 환불됩니다.`, linkUrl: '/my/talk' }).catch(() => undefined);
    }
  }
  return n;
}

// ---------------------------------------------------------------------- 대화

export type SessionPhase = 'BEFORE' | 'LIVE' | 'AFTER' | 'CLOSED';

export function sessionPhase(s: { status: string; startsAt: Date; endsAt: Date }, now: Date): SessionPhase {
  if (s.status !== 'ACCEPTED' && s.status !== 'COMPLETED') return 'CLOSED';
  if (now < s.startsAt) return 'BEFORE';
  if (now < s.endsAt && s.status === 'ACCEPTED') return 'LIVE';
  return 'AFTER';
}

export async function getSessionForViewer(sessionId: string, viewer: { userId: string; creatorId?: string | null }) {
  const s = await prisma.talkSession.findUnique({
    where: { id: sessionId },
    include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, userId: true, user: { select: { avatarIndex: true } } } }, user: { select: { id: true, name: true, avatarIndex: true } } },
  });
  if (!s) return null;
  const role = s.userId === viewer.userId ? 'FAN' : viewer.creatorId && s.creatorId === viewer.creatorId ? 'CREATOR' : null;
  if (!role) return null;
  return { session: s, role: role as 'FAN' | 'CREATOR' };
}

export async function listSessionMessages(sessionId: string, after?: Date | null) {
  return prisma.talkSessionMessage.findMany({ where: { sessionId, ...(after ? { createdAt: { gt: after } } : {}) }, orderBy: { createdAt: 'asc' }, take: 500 });
}

export async function sendSessionMessage(sessionId: string, viewer: { userId: string; creatorId?: string | null }, body: string, now: Date = new Date()): Promise<SessionResult & { masked?: boolean }> {
  try {
    await assertGlobalOn();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const found = await getSessionForViewer(sessionId, viewer);
  if (!found) return { ok: false, message: '대화방을 찾을 수 없습니다.' };
  const phase = sessionPhase(found.session, now);
  if (phase === 'BEFORE') return { ok: false, message: '예약 시간이 되면 대화를 시작할 수 있어요.' };
  if (phase !== 'LIVE') return { ok: false, message: '대화 시간이 끝났어요.' };
  const raw = body.replace(/\r\n/g, '\n').trim();
  if (!raw) return { ok: false, message: '메시지를 입력해 주세요.' };
  if (raw.length > 500) return { ok: false, message: '메시지는 500자까지 보낼 수 있어요.' };
  const m = maskContacts(raw);
  await prisma.talkSessionMessage.create({ data: { id: newId(), sessionId, senderType: found.role, body: m.text, createdAt: now } });
  return { ok: true, message: m.masked ? '연락처·링크는 가려서 전달돼요.' : '', masked: m.masked };
}
