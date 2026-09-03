import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getYouTubeAdapter } from '@/server/adapters/youtube';
import { findActiveRound } from '@/server/services/game-state';
import { reserveYouTubeQuota, releaseYouTubeQuota } from '@/server/services/youtube-quota';
import { ensureYouTubeAccessToken, resolveActiveBroadcast } from '@/server/services/youtube-connection';
import { getPublicBaseUrl } from '@/server/public-base-url';
import { consumeRateLimit } from '@/server/rate-limit';
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
  CHAT_DISABLED: '이 방송은 실시간 채팅이 꺼져 있습니다. 유튜브에서 채팅을 켜 주세요.',
  QUOTA_EXCEEDED: '오늘 쓸 수 있는 유튜브 전송 한도를 모두 썼습니다. 내일 다시 시도해 주세요.',
  TOO_OFTEN: '참여 링크는 잠시 뒤에 다시 올릴 수 있습니다. (도배 방지)',
  SEND_FAILED: '유튜브 채팅에 올리지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};

/**
 * 같은 크리에이터가 이 버튼을 연타하지 못하게 막는다.
 *
 * 이 전송은 후원 알림과 **같은 일일 예산**을 쓴다. 제한이 없으면 크리에이터 한 명이
 * 버튼을 수백 번 눌러 그날 예산을 전부 소진시키고, 그때부터 모든 채널의 후원 채팅이
 * 실패한다(결제는 정상 완료되므로 후원자만 손해를 본다).
 */
const SHARE_LIMIT_COUNT = 3;
const SHARE_LIMIT_WINDOW_SEC = 300;

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

  const limited = await consumeRateLimit('yt-share', creatorId, SHARE_LIMIT_COUNT, SHARE_LIMIT_WINDOW_SEC, {
    failClosed: true,
  });
  if (!limited.ok) return fail('TOO_OFTEN');

  // 터널·사내망 미리보기에서 localhost 주소가 채팅에 올라가면 아무도 열 수 없다.
  // 후원 페이지 공유 URL 과 같은 기준(요청 호스트 반영)을 쓴다.
  const baseUrl = await getPublicBaseUrl().catch(() => env.baseUrl);
  const joinUrl = `${baseUrl}/play/${round.joinCode}`;
  const text = buildGameShareText(round.game.title, joinUrl, round.joinCode);

  const conn = await prisma.youTubeConnection.findUnique({ where: { creatorId } });
  const adapter = getYouTubeAdapter();

  const token = await ensureYouTubeAccessToken(conn, adapter);
  if (!token.ok) {
    return fail(token.reason === 'NO_CONNECTION' ? 'NO_CONNECTION' : 'TOKEN_REFRESH_FAILED');
  }

  const live = await resolveActiveBroadcast(creatorId, token.accessToken, adapter);
  if (!live.ok) return fail(live.reason);

  const quota = { cost: env.youtube.insertQuotaCost, creatorId, purpose: 'share' as const };
  if (!(await reserveYouTubeQuota(quota))) {
    logger.warn('게임 참여 링크 — 유튜브 할당량 초과', { creatorId });
    return fail('QUOTA_EXCEEDED');
  }

  const res = await adapter.insertChatMessage(token.accessToken, live.broadcast.liveChatId!, text);
  if (!res.ok) {
    // 보내지 못한 만큼은 예산을 되돌린다.
    await releaseYouTubeQuota(quota);
    logger.warn('게임 참여 링크 — 채팅 전송 실패', { creatorId, code: res.code ?? null });
    return fail('SEND_FAILED');
  }

  const mockNote = adapter.info().mode === 'mock' ? ' (mock 어댑터라 실제 채팅에는 올라가지 않습니다)' : '';
  return { ok: true, message: `유튜브 라이브 채팅에 참여 링크를 올렸습니다.${mockNote}` };
}
