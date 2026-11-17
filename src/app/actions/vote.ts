'use server';

/**
 * 투표 · 투표권 충전 — 회원 서버 액션 (2026-11-17)
 */
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { clientIpFromHeaders, consumeRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { castVote } from '@/server/services/vote/cast';
import { getBalance } from '@/server/services/vote/wallet';
import { parsePayMethod, purchaseTickets, refundTicketOrder } from '@/server/services/vote/purchase';
import { completeMockMission } from '@/server/services/vote/offerwall';

export interface VoteActionState {
  ok: boolean;
  message?: string;
  /** 처리 후 남은 투표권 */
  balance?: number;
  /** 화면을 다시 그릴 때 쓰는 증가값 */
  nonce?: number;
}

const initialFail = (message: string): VoteActionState => ({ ok: false, message, nonce: Date.now() });

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function friendly(e: unknown, scope: string): VoteActionState {
  const message = (e as Error)?.message ?? '';
  if (/[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return initialFail(message);
  logger.error(`${scope} 오류`, { message });
  return initialFail('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
}

export async function castVoteAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return initialFail('로그인 후 투표할 수 있어요.');
  const ip = await clientIpFromHeaders();
  const rl = await consumeRateLimit('vote:cast', user.id, 30, 60);
  if (!rl.ok) return initialFail('잠시 후 다시 투표해 주세요. (1분에 30번까지)');
  try {
    const r = await castVote(user, { creatorId: text(fd, 'creatorId'), votes: Number(text(fd, 'votes')), roundId: text(fd, 'roundId') || null, ip });
    const balance = (await getBalance(user.id)).total;
    if (r.ok) {
      revalidatePath('/vote');
      revalidatePath('/my/votes');
    }
    return { ok: r.ok, message: r.message, balance, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '투표');
  }
}

export async function purchaseTicketsAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return initialFail('로그인 후 충전할 수 있어요.');
  const method = parsePayMethod(text(fd, 'method'));
  if (!method) return initialFail('결제 수단을 골라 주세요.');
  if (text(fd, 'agree') !== 'on') return initialFail('투표권 이용 안내에 동의해 주세요.');
  const rl = await consumeRateLimit('vote:purchase', user.id, 10, 60);
  if (!rl.ok) return initialFail('잠시 후 다시 시도해 주세요.');
  try {
    const r = await purchaseTickets(user, text(fd, 'productId'), method);
    const balance = (await getBalance(user.id)).total;
    if (r.ok) revalidatePath('/my/votes');
    return { ok: r.ok, message: r.message, balance, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '투표권 충전');
  }
}

export async function refundTicketOrderAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return initialFail('로그인이 필요합니다.');
  try {
    const r = await refundTicketOrder(text(fd, 'orderId'), { type: 'USER', userId: user.id }, '회원 환불 요청');
    if (r.ok) revalidatePath('/my/votes');
    return { ok: r.ok, message: r.message, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '투표권 환불');
  }
}

export async function completeMockMissionAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return initialFail('로그인 후 받을 수 있어요.');
  const answerRaw = text(fd, 'answer');
  const answer = answerRaw === '' ? null : Number(answerRaw);
  try {
    const r = await completeMockMission(user.id, text(fd, 'missionId'), Number.isFinite(answer) ? answer : null);
    const balance = (await getBalance(user.id)).total;
    if (!r.ok) return { ok: false, message: r.reason, balance, nonce: Date.now() };
    revalidatePath('/vote/charge');
    return { ok: true, message: r.duplicate ? '오늘은 이미 받은 광고예요. 내일 다시 참여해 주세요.' : `투표권 ${r.tickets.toLocaleString('ko-KR')}개를 받았어요.`, balance, nonce: Date.now() };
  } catch (e) {
    return friendly(e, '무료 충전');
  }
}
