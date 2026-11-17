'use server';

/**
 * 크리에이터 관리자 > 팬 소통(소통 관리 · 1:1 채팅) 서버 액션 (2026-11-17).
 * 모든 액션은 requireCreator() 후 본인 creatorId 범위에서만 변경한다.
 * 가격은 최고관리자가 "크리에이터가 정함(CREATOR)" 권한을 준 경우에만, 관리자가 정한 범위 안에서 바꿀 수 있다.
 */
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { requireCreator } from '@/server/auth';
import { getCreatorEngagement, getTalkConfig } from '@/server/services/engagement/config';
import {
  deleteTalkMessage, getOrCreateRoom, markCreatorRead, sendBroadcast, sendDirect, setTalkBlock, toggleHeart,
} from '@/server/services/talk/talk';
import { acceptSession, parseRuleLines, rejectSession, replaceSlotRules } from '@/server/services/talk/sessions';
import type { StudioActionState } from './studio';

type Ctx = { creatorId: string; userId: string };

async function withCreatorCtx(fn: (c: Ctx) => Promise<StudioActionState>): Promise<StudioActionState> {
  let ctx: Ctx;
  try {
    const u = await requireCreator();
    ctx = { creatorId: u.creatorId, userId: u.id };
  } catch (e) {
    return { ok: false, message: (e as Error).message || '크리에이터 권한이 필요합니다.' };
  }
  try {
    return await fn(ctx);
  } catch (e) {
    if ((e as { digest?: string })?.digest?.startsWith('NEXT_REDIRECT')) throw e;
    const message = (e as Error)?.message ?? '';
    if (!message || /prisma|invocation|ECONNREFUSED|ETIMEDOUT/i.test(message) || !/[가-힣]/.test(message)) {
      logger.error('팬 소통 관리 액션 오류', { message });
      return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    return { ok: false, message };
  }
}

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function money(fd: FormData, key: string): bigint | null {
  const raw = text(fd, key).replace(/[^\d]/g, '');
  if (!raw) return null;
  if (raw.length > 10) throw new Error('금액이 너무 큽니다.');
  return BigInt(raw);
}

function refresh() {
  revalidatePath('/studio/talk');
  revalidatePath('/studio/talk/sessions');
}

/** 소통방 설정 (열기·안내 문구·호칭·가격(허용 시)·1:1 받기·1회 시간·쉬는 날) */
export async function saveTalkRoomAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const talk = await getTalkConfig();
    const eng = await getCreatorEngagement(creatorId, prisma, { talk });
    await getOrCreateRoom(creatorId);
    const data: Record<string, unknown> = {
      open: text(fd, 'open') === 'on',
      welcomeMessage: text(fd, 'welcomeMessage').slice(0, 300) || null,
      fanTitle: text(fd, 'fanTitle').slice(0, 20) || null,
    };
    if (eng.talkSub.mode === 'CREATOR') {
      const p = money(fd, 'subPrice');
      if (p != null && (p < BigInt(eng.talkSub.min) || p > BigInt(eng.talkSub.max))) {
        throw new Error(`월 구독 가격은 ${eng.talkSub.min.toLocaleString('ko-KR')}원 ~ ${eng.talkSub.max.toLocaleString('ko-KR')}원 사이로 정해 주세요.`);
      }
      data.subPrice = p;
    }
    if (fd.has('sessionMinutes')) {
      const minutes = Number(text(fd, 'sessionMinutes'));
      if (!talk.sessionMinutesOptions.includes(minutes)) throw new Error('1회 시간을 목록에서 골라 주세요.');
      data.sessionMinutes = minutes;
      data.sessionEnabled = text(fd, 'sessionEnabled') === 'on';
      if (eng.session.mode === 'CREATOR') {
        const p = money(fd, 'sessionPrice');
        if (p != null && (p < BigInt(eng.session.min) || p > BigInt(eng.session.max))) {
          throw new Error(`1:1 채팅 가격은 ${eng.session.min.toLocaleString('ko-KR')}원 ~ ${eng.session.max.toLocaleString('ko-KR')}원 사이로 정해 주세요.`);
        }
        data.sessionPrice = p;
      }
      const dates = text(fd, 'blockedDates')
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean);
      for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`쉬는 날 "${d}" 은(는) 2026-12-25 형식으로 입력해 주세요.`);
      data.sessionBlockedDates = [...new Set(dates)].slice(0, 120);
    }
    await prisma.talkRoom.update({ where: { creatorId }, data });
    refresh();
    return { ok: true, message: '소통방 설정을 저장했습니다.' };
  });
}

export async function sendBroadcastAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const image = text(fd, 'imageUrl');
    if (image && !/^(\/|https:\/\/)/.test(image)) throw new Error('사진 주소가 올바르지 않습니다.');
    const r = await sendBroadcast(creatorId, text(fd, 'body'), image || null);
    if (r.ok) refresh();
    return { ok: r.ok, message: r.message };
  });
}

export async function sendDirectAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const r = await sendDirect(creatorId, text(fd, 'fanUserId'), text(fd, 'body'));
    if (r.ok) refresh();
    return { ok: r.ok, message: r.message };
  });
}

export async function toggleHeartAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const on = await toggleHeart(creatorId, text(fd, 'messageId'));
    refresh();
    return { ok: true, message: on ? '하트를 보냈어요.' : '하트를 거뒀어요.' };
  });
}

export async function deleteTalkMessageAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    await deleteTalkMessage(text(fd, 'messageId'), { type: 'CREATOR', creatorId });
    refresh();
    return { ok: true, message: '메시지를 지웠어요.' };
  });
}

export async function setTalkBlockAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const block = text(fd, 'block') === '1';
    await setTalkBlock(creatorId, text(fd, 'userId'), block, text(fd, 'reason'));
    refresh();
    return { ok: true, message: block ? '이 팬을 차단했어요. 메시지를 보낼 수 없습니다.' : '차단을 풀었어요.' };
  });
}

export async function markInboxReadAction(_p: StudioActionState): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    await markCreatorRead(creatorId);
    refresh();
    return { ok: true, message: '모두 읽음으로 표시했어요.' };
  });
}

export async function saveSlotRulesAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const rules = parseRuleLines(text(fd, 'rules'));
    await replaceSlotRules(creatorId, rules);
    refresh();
    return { ok: true, message: `가능 시간 ${rules.length}개를 저장했어요.` };
  });
}

export async function decideSessionAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withCreatorCtx(async ({ creatorId }) => {
    const id = text(fd, 'sessionId');
    const decision = text(fd, 'decision');
    const r = decision === 'accept' ? await acceptSession(creatorId, id) : await rejectSession(creatorId, id, text(fd, 'reason'));
    refresh();
    return { ok: r.ok, message: r.message };
  });
}
