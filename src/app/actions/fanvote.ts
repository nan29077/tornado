'use server';

/**
 * 팬투표 팬 활동 — 회원 서버 액션 (2026-11-18)
 * 출석 체크 · 일일 미션 · 친구 초대 · 응원 댓글 · 공유 기록 · 대표 배지 · 서포트 참여
 */
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { logger } from '@/lib/logger';
import { getBalance } from '@/server/services/vote/wallet';
import { checkAttendance, claimMission, deleteCheer, logShare, postCheer, redeemReferralCode, setFeaturedBadge } from '@/server/services/vote/fan';
import { contributeSupport } from '@/server/services/vote/support';
import type { VoteActionState } from './vote';

const fail = (message: string): VoteActionState => ({ ok: false, message, nonce: Date.now() });

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function friendly(e: unknown, scope: string): VoteActionState {
  const message = (e as Error)?.message ?? '';
  if (/[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return fail(message);
  logger.error(`${scope} 오류`, { message });
  return fail('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
}

async function done(userId: string, r: { ok: boolean; message: string }, paths: string[] = []): Promise<VoteActionState> {
  if (r.ok) for (const p of paths) revalidatePath(p);
  const balance = (await getBalance(userId).catch(() => null))?.total;
  return { ok: r.ok, message: r.message, balance, nonce: Date.now() };
}

export async function checkAttendanceAction(_p: VoteActionState, _fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 출석할 수 있어요.');
  const rl = await consumeRateLimit('fanvote:attend', user.id, 10, 60);
  if (!rl.ok) return fail('잠시 후 다시 눌러 주세요.');
  try {
    return await done(user.id, await checkAttendance(user.id), ['/vote/charge', '/vote']);
  } catch (e) {
    return friendly(e, '출석 체크');
  }
}

export async function claimMissionAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 보상을 받을 수 있어요.');
  const rl = await consumeRateLimit('fanvote:mission', user.id, 20, 60);
  if (!rl.ok) return fail('잠시 후 다시 눌러 주세요.');
  try {
    return await done(user.id, await claimMission(user.id, text(fd, 'mission')), ['/vote/charge']);
  } catch (e) {
    return friendly(e, '미션 보상');
  }
}

export async function redeemReferralAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  const rl = await consumeRateLimit('fanvote:referral', user.id, 5, 60);
  if (!rl.ok) return fail('잠시 후 다시 입력해 주세요.');
  try {
    return await done(user.id, await redeemReferralCode(user.id, text(fd, 'code')), ['/vote/charge', '/my/votes']);
  } catch (e) {
    return friendly(e, '초대 코드');
  }
}

export async function postCheerAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 응원할 수 있어요.');
  const rl = await consumeRateLimit('fanvote:cheer', user.id, 6, 60);
  if (!rl.ok) return fail('잠시 후 다시 남겨 주세요.');
  try {
    const r = await postCheer(user.id, { creatorId: text(fd, 'creatorId'), body: text(fd, 'body'), roundId: text(fd, 'roundId') || null });
    const back = text(fd, 'path');
    return await done(user.id, r, back.startsWith('/vote') ? [back] : []);
  } catch (e) {
    return friendly(e, '응원 댓글');
  }
}

export async function deleteCheerAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    const r = await deleteCheer(text(fd, 'cheerId'), { type: 'USER', userId: user.id });
    const back = text(fd, 'path');
    return await done(user.id, r, back.startsWith('/vote') ? [back] : []);
  } catch (e) {
    return friendly(e, '응원 댓글 삭제');
  }
}

/** 팬투표 인증 카드 저장 · 공유 기록 (공유 미션 확인용) */
export async function logShareAction(creatorId: string | null, channel: string): Promise<{ ok: boolean }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { ok: false };
  try {
    await logShare(user.id, creatorId, channel);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function setFeaturedBadgeAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인이 필요합니다.');
  try {
    return await done(user.id, await setFeaturedBadge(user.id, text(fd, 'badge') || null), ['/my/votes']);
  } catch (e) {
    return friendly(e, '대표 배지');
  }
}

export async function contributeSupportAction(_p: VoteActionState, fd: FormData): Promise<VoteActionState> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return fail('로그인 후 참여할 수 있어요.');
  const rl = await consumeRateLimit('fanvote:support', user.id, 20, 60);
  if (!rl.ok) return fail('잠시 후 다시 참여해 주세요.');
  try {
    const id = text(fd, 'supportId');
    const r = await contributeSupport(user.id, id, Number(text(fd, 'tickets')));
    return await done(user.id, r, [`/vote/support/${id}`, '/vote/support']);
  } catch (e) {
    return friendly(e, '서포트 참여');
  }
}
