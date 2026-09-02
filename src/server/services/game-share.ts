import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { decrypt, encrypt } from '@/lib/crypto';
import { getYouTubeAdapter } from '@/server/adapters/youtube';
import { findActiveRound } from '@/server/services/game-state';
import { reserveYouTubeQuota } from '@/server/services/broadcast-dispatch';
import { usesEntries } from '@/lib/game-catalog';

/**
 * 진행 중인 게임의 참여 링크를 유튜브 라이브 채팅에 올린다.
 *
 * 왜 필요한가
 *  - 지금까지 시청자가 참여하는 길은 방송 화면의 QR 을 휴대폰으로 찍는 것뿐이었다.
 *    QR 을 놓친 시청자, 휴대폰으로 방송을 보는 시청자에게는 들어올 방법이 없다.
 *  - 후원 알림은 이미 라이브 채팅에 올라간다. 같은 어댑터를 게임에도 쓴다.
 *
 * 원칙
 *  - 크리에이터가 버튼을 눌렀을 때만 보낸다. 자동으로 도배하지 않는다.
 *  - 실패해도 게임 진행에는 아무 영향이 없다. 사유를 문구로 돌려줄 뿐이다.
 *  - 할당량은 후원 알림과 같은 카운터를 쓴다(같은 API 를 소비하므로).
 */

export interface GameShareResult {
  ok: boolean;
  message: string;
}

/** 실패 사유를 크리에이터가 무엇을 해야 할지 알 수 있는 문구로 바꾼다. */
const REASON_TEXT: Record<string, string> = {
  NO_ROUND: '지금 방송에 올라가 있는 게임이 없습니다.',
  NO_JOIN_URL: '이 게임은 링크로 참여하는 방식이 아닙니다.',
  NO_CONNECTION: '유튜브 채널이 연결돼 있지 않습니다. [유튜브 연동]에서 먼저 연결해 주세요.',
  TOKEN_REFRESH_FAILED: '유튜브 연결이 만료됐습니다. [유튜브 연동]에서 다시 연결해 주세요.',
  BROADCAST_LOOKUP_FAILED: '유튜브 라이브 방송 정보를 가져오지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  NO_ACTIVE_BROADCAST: '진행 중인 유튜브 라이브 방송을 찾지 못했습니다. 방송을 시작한 뒤 눌러 주세요.',
  QUOTA_EXCEEDED: '오늘 쓸 수 있는 유튜브 전송 한도를 모두 썼습니다. 내일 다시 시도해 주세요.',
  SEND_FAILED: '유튜브 채팅에 올리지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};

function fail(reason: string): GameShareResult {
  return { ok: false, message: REASON_TEXT[reason] ?? REASON_TEXT.SEND_FAILED };
}

/** 채팅에 올릴 문장. 200자 제한(유튜브)에 넉넉히 들어가도록 짧게 만든다. */
export function buildGameShareText(title: string, joinUrl: string, joinCode: string | null): string {
  const code = joinCode ? ` (참여 코드 ${joinCode})` : '';
  return `[${title}] 참여하기 → ${joinUrl}${code}`.slice(0, 190);
}

export async function shareGameLinkToChat(creatorId: string): Promise<GameShareResult> {
  const round = await findActiveRound(creatorId);
  if (!round) return fail('NO_ROUND');

  // 후원 자동 참여만 쓰는 게임에는 시청자가 들어올 링크 자체가 없다.
  const entryByLink = round.game.entryMode !== 'DONATION' && usesEntries(round.game.type);
  if (!entryByLink) return fail('NO_JOIN_URL');

  const joinUrl = `${env.baseUrl}/play/${round.joinCode}`;
  const text = buildGameShareText(round.game.title, joinUrl, round.joinCode);

  const conn = await prisma.youTubeConnection.findUnique({ where: { creatorId } });
  // EXPIRED 는 "이전 갱신이 한 번 실패했다"는 뜻일 뿐 영구 실패가 아니다.
  if (!conn || (conn.status !== 'CONNECTED' && conn.status !== 'EXPIRED')) return fail('NO_CONNECTION');

  const adapter = getYouTubeAdapter();

  let accessToken = decrypt(conn.accessTokenEnc);
  if (conn.status === 'EXPIRED' || conn.expiresAt.getTime() < Date.now() + 60_000) {
    const refreshed = await adapter.refresh(decrypt(conn.refreshTokenEnc));
    if (!refreshed.ok || !refreshed.data) {
      await prisma.youTubeConnection.update({
        where: { id: conn.id },
        data: { status: 'EXPIRED', lastError: refreshed.message ?? 'refresh 실패' },
      });
      return fail('TOKEN_REFRESH_FAILED');
    }
    accessToken = refreshed.data.accessToken;
    await prisma.youTubeConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: encrypt(refreshed.data.accessToken),
        expiresAt: refreshed.data.expiresAt,
        status: 'CONNECTED',
        lastError: null,
      },
    });
  }

  const live = await adapter.findActiveBroadcast(accessToken);
  if (!live.ok) {
    logger.warn('게임 참여 링크 — 라이브 방송 조회 실패', {
      creatorId,
      code: live.code ?? null,
      message: live.message ?? null,
    });
    return fail('BROADCAST_LOOKUP_FAILED');
  }
  if (!live.data || !live.data.liveChatId) return fail('NO_ACTIVE_BROADCAST');

  if (!(await reserveYouTubeQuota(env.youtube.insertQuotaCost))) {
    logger.warn('게임 참여 링크 — 유튜브 할당량 초과', { creatorId });
    return fail('QUOTA_EXCEEDED');
  }

  const res = await adapter.insertChatMessage(accessToken, live.data.liveChatId, text);
  if (!res.ok) {
    logger.warn('게임 참여 링크 — 채팅 전송 실패', { creatorId, code: res.code ?? null });
    return fail('SEND_FAILED');
  }

  return { ok: true, message: '유튜브 라이브 채팅에 참여 링크를 올렸습니다.' };
}
