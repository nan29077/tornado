'use server';

/**
 * 팬챗 채팅 · 1:1 예약 채팅 — 회원(구독자) 서버 액션 (2026-11-17)
 */
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { parsePayMethod } from '@/server/services/vote/purchase';
import {
  deleteLetter, deleteTalkMessage, getComposerState, getFanThread, markFanRead, quoteBundle, reportTalkMessage, searchFanArchive, sendFanReply, sendLetter,
  setRoomMuted, setRoomNickname, subscribeBundle, subscribeTalk, toggleFanReaction, type BundleQuote, type ComposerState, type ThreadMessage,
} from '@/server/services/talk/talk';
import { syncFanBadges } from '@/server/services/vote/fan';
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
    return friendly(e, '팬챗 구독');
  }
}

export async function sendFanReplyAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  const rl = await consumeRateLimit('talk:reply', user.id, 20, 60);
  if (!rl.ok) return fail('너무 빠르게 보내고 있어요. 잠시 후 다시 보내 주세요.');
  try {
    const r = await sendFanReply(user, text(fd, 'creatorId'), text(fd, 'body'));
    if (r.ok) await syncFanBadges(user.id).catch(() => undefined);
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '팬챗 메시지');
  }
}

/** 대화 새로 고침 (실시간 신호 · 보충 조회). after 이후 새 메시지 + 입력창 상태(남은 답장 · 글자 수) */
export async function pollFanThreadAction(creatorId: string, afterIso: string | null): Promise<{ allowed: boolean; messages: ThreadMessage[]; composer?: ComposerState | null; removed?: string[] }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { allowed: false, messages: [] };
  const after = afterIso ? new Date(afterIso) : null;
  const r = await getFanThread(user, creatorId, { after: after && !Number.isNaN(after.getTime()) ? after : null });
  if (!r.allowed) return r;
  await markFanRead(user.id, creatorId).catch(() => undefined);
  const composer = await getComposerState(user.id, creatorId).catch(() => null);
  return { ...r, composer };
}

/** 지난 대화 더 보기 */
export async function loadOlderThreadAction(creatorId: string, beforeIso: string): Promise<{ allowed: boolean; messages: ThreadMessage[]; hasMore?: boolean }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { allowed: false, messages: [] };
  const before = new Date(beforeIso);
  if (Number.isNaN(before.getTime())) return { allowed: false, messages: [] };
  return getFanThread(user, creatorId, { before, limit: 50 });
}

/** 지금 화면에 있는 메시지 중 지워진 것 (크리에이터가 지운 메시지를 화면에서도 내린다) */
export async function checkRemovedAction(creatorId: string, ids: string[]): Promise<string[]> {
  const user = await getSessionUser().catch(() => null);
  if (!user || ids.length === 0) return [];
  const { prisma } = await import('@/server/db');
  const rows = await prisma.talkMessage.findMany({ where: { creatorId, id: { in: ids.slice(0, 200) }, deletedAt: { not: null } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function toggleFanReactionAction(messageId: string): Promise<{ ok: boolean; reacted?: boolean; message?: string }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { ok: false, message: '로그인이 필요합니다.' };
  const rl = await consumeRateLimit('talk:react', user.id, 60, 60);
  if (!rl.ok) return { ok: false, message: '잠시 후 다시 눌러 주세요.' };
  try {
    return await toggleFanReaction(user.id, messageId);
  } catch (e) {
    return friendly(e, '팬챗 하트');
  }
}

export async function setRoomNicknameAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    const r = await setRoomNickname(user.id, text(fd, 'creatorId'), text(fd, 'nickname'));
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '팬챗 닉네임');
  }
}

export async function setRoomMutedAction(creatorId: string, muted: boolean): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    const r = await setRoomMuted(user.id, creatorId, muted);
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '팬챗 알림');
  }
}

export async function searchArchiveAction(creatorId: string, q: string, media: 'all' | 'photo' | 'voice' | 'video'): Promise<{ allowed: boolean; messages: ThreadMessage[] }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { allowed: false, messages: [] };
  const m = (['all', 'photo', 'voice', 'video'] as const).includes(media) ? media : 'all';
  return searchFanArchive(user, creatorId, { q, media: m });
}

export async function sendLetterAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  const rl = await consumeRateLimit('talk:letter', user.id, 5, 60);
  if (!rl.ok) return fail('잠시 후 다시 보내 주세요.');
  try {
    const r = await sendLetter(user, text(fd, 'creatorId'), { title: text(fd, 'title'), body: text(fd, 'body'), theme: text(fd, 'theme') });
    const code = text(fd, 'code');
    if (r.ok && code) revalidatePath(`/c/${code}/talk/letters`);
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '팬레터');
  }
}

export async function deleteMyLetterAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    await deleteLetter(text(fd, 'letterId'), { type: 'FAN', userId: user.id });
    const code = text(fd, 'code');
    if (code) revalidatePath(`/c/${code}/talk/letters`);
    return { ok: true, message: '편지를 지웠어요.', nonce: Date.now() };
  } catch (e) {
    return friendly(e, '팬레터 삭제');
  }
}

export async function quoteBundleAction(creatorIds: string[]): Promise<BundleQuote> {
  const user = await getSessionUser().catch(() => null);
  return quoteBundle(user?.id ?? null, Array.isArray(creatorIds) ? creatorIds.slice(0, 20).map(String) : []);
}

export async function subscribeBundleAction(_p: TalkActionState, fd: FormData): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 구독할 수 있어요.');
  const method = parsePayMethod(text(fd, 'method'));
  if (!method) return fail('결제 수단을 골라 주세요.');
  if (text(fd, 'agree') !== 'on') return fail('이용 안내에 동의해 주세요.');
  const rl = await consumeRateLimit('talk:subscribe', user.id, 10, 60);
  if (!rl.ok) return fail('잠시 후 다시 시도해 주세요.');
  const ids = fd.getAll('creatorId').map((v) => String(v)).filter(Boolean);
  try {
    const r = await subscribeBundle(user, ids, method);
    if (r.ok) {
      revalidatePath('/talk');
      revalidatePath('/my/talk');
    }
    return { ok: r.ok, message: r.message, nonce: Date.now(), redirectTo: r.ok ? '/talk' : undefined };
  } catch (e) {
    return friendly(e, '팬챗 묶음 구독');
  }
}

export async function deleteMyTalkMessageAction(messageId: string): Promise<TalkActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    await deleteTalkMessage(messageId, { type: 'FAN', userId: user.id });
    return { ok: true, message: '지웠어요.', nonce: Date.now() };
  } catch (e) {
    return friendly(e, '팬챗 메시지 삭제');
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
