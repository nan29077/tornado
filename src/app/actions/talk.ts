'use server';

/**
 * 소통 채팅 · 1:1 예약 채팅 — 회원(구독자) 서버 액션 (2026-11-17)
 */
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { parsePayMethod } from '@/server/services/vote/purchase';
import {
  deleteTalkMessage, getFanThread, markFanRead, reportTalkMessage, sendFanReply, subscribeTalk, type ThreadMessage,
} from '@/server/services/talk/talk';
import {
  bookSession, cancelSessionByFan, getSessionForViewer, listSessionMessages, reportNoShow, sendSessionMessage, sessionPhase,
} from '@/server/services/talk/sessions';

export interface TalkActionState {
  ok: boolean;
  message?: string;
  nonce?: number;
  redirectTo?: string;
}

const fail = (message: string): TalkActionState => ({ ok: false, message, nonce: Date.now() });

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function friendly(e: unknown, scope: string): TalkActionState {
  const message = (e as Error)?.message ?? '';
  if (/[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return fail(message);
  logger.error(`${scope} 오류`, { message });
  return fail('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
}

export async function subscribeTalkAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 구독할 수 있어요.');
  const method = parsePayMethod(text(fd, 'method'));
  if (!method) return fail('결제 수단을 골라 주세요.');
  if (text(fd, 'agree') !== 'on') return fail('이용 안내에 동의해 주세요.');
  const rl = await consumeRateLimit('talk:subscribe', user.id, 10, 60);
  if (!rl.ok) return fail('잠시 후 다시 시도해 주세요.');
  try {
    const r = await subscribeTalk(user, text(fd, 'creatorId'), method);
    if (r.ok) {
      const code = text(fd, 'code');
      if (code) revalidatePath(`/c/${code}`);
      revalidatePath('/my/talk');
    }
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '소통 구독');
  }
}

export async function sendFanReplyAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  const rl = await consumeRateLimit('talk:reply', user.id, 20, 60);
  if (!rl.ok) return fail('너무 빠르게 보내고 있어요. 잠시 후 다시 보내 주세요.');
  try {
    const r = await sendFanReply(user, text(fd, 'creatorId'), text(fd, 'body'));
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '소통 메시지');
  }
}

/** 대화 새로 고침 (폴링). after 이후 새 메시지만 */
export async function pollFanThreadAction(creatorId: string, afterIso: string | null): Promise<{ allowed: boolean; messages: ThreadMessage[] }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { allowed: false, messages: [] };
  const after = afterIso ? new Date(afterIso) : null;
  const r = await getFanThread(user, creatorId, { after: after && !Number.isNaN(after.getTime()) ? after : null });
  if (r.allowed) await markFanRead(user.id, creatorId).catch(() => undefined);
  return r;
}

export async function deleteMyTalkMessageAction(messageId: string): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    await deleteTalkMessage(messageId, { type: 'FAN', userId: user.id });
    return { ok: true, message: '지웠어요.', nonce: Date.now() };
  } catch (e) {
    return friendly(e, '소통 메시지 삭제');
  }
}

export async function reportTalkAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  const target = text(fd, 'target') === 'SESSION_MESSAGE' ? 'SESSION_MESSAGE' : 'MESSAGE';
  try {
    const r = await reportTalkMessage({ target, messageId: text(fd, 'messageId'), reporterUserId: user.id, reporterRole: user.creatorId && text(fd, 'as') === 'CREATOR' ? 'CREATOR' : 'FAN', reason: text(fd, 'reason') });
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '신고');
  }
}

// ---------------------------------------------------------------------- 1:1

export async function bookSessionAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 신청할 수 있어요.');
  const method = parsePayMethod(text(fd, 'method'));
  if (!method) return fail('결제 수단을 골라 주세요.');
  if (!text(fd, 'startsAt')) return fail('시간을 골라 주세요.');
  if (text(fd, 'agree') !== 'on') return fail('취소·환불 규정에 동의해 주세요.');
  const rl = await consumeRateLimit('talk:book', user.id, 10, 60);
  if (!rl.ok) return fail('잠시 후 다시 시도해 주세요.');
  try {
    const r = await bookSession(user, text(fd, 'creatorId'), text(fd, 'startsAt'), method, text(fd, 'note'));
    if (r.ok) revalidatePath('/my/talk');
    return { ok: r.ok, message: r.message, nonce: Date.now(), redirectTo: r.sessionId ? `/my/talk/sessions/${r.sessionId}` : undefined };
  } catch (e) {
    return friendly(e, '1:1 신청');
  }
}

export async function cancelSessionAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    const id = text(fd, 'sessionId');
    const r = await cancelSessionByFan(user.id, id);
    if (r.ok) revalidatePath(`/my/talk/sessions/${id}`);
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '1:1 취소');
  }
}

export async function reportNoShowAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    const id = text(fd, 'sessionId');
    const r = await reportNoShow(user.id, id);
    if (r.ok) revalidatePath(`/my/talk/sessions/${id}`);
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '불참 신고');
  }
}

export interface SessionPoll {
  phase: 'BEFORE' | 'LIVE' | 'AFTER' | 'CLOSED';
  messages: Array<{ id: string; senderType: string; body: string; createdAt: string }>;
}

/** 1:1 대화 새로 고침 (구독자·크리에이터 공용) */
export async function pollSessionAction(sessionId: string, afterIso: string | null): Promise<SessionPoll | null> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return null;
  const found = await getSessionForViewer(sessionId, { userId: user.id, creatorId: user.creatorId ?? null });
  if (!found) return null;
  const after = afterIso ? new Date(afterIso) : null;
  const rows = await listSessionMessages(sessionId, after && !Number.isNaN(after.getTime()) ? after : null);
  return {
    phase: sessionPhase(found.session, new Date()),
    messages: rows.map((m) => ({ id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt.toISOString() })),
  };
}

export async function sendSessionMessageAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  const rl = await consumeRateLimit('talk:session-msg', user.id, 40, 60);
  if (!rl.ok) return fail('너무 빠르게 보내고 있어요.');
  try {
    const r = await sendSessionMessage(text(fd, 'sessionId'), { userId: user.id, creatorId: user.creatorId ?? null }, text(fd, 'body'));
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '1:1 메시지');
  }
}
