import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { requireCreator } from '@/server/auth';
import { getYouTubeAdapter } from '@/server/adapters/youtube';
import { consumeYouTubeOAuthState, hasRequiredScope } from '@/server/services/youtube-connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 유튜브 OAuth 콜백.
 *
 * 보안
 *  - state 에 creatorId 를 담고, 세션의 크리에이터와 일치하는지 반드시 검증한다(CSRF 방지).
 *  - state 가 서명된 형태(`creatorId.signature`)면 서명도 함께 확인한다.
 *  - access/refresh 토큰은 평문 저장하지 않고 암호화해 보관하며 로그에 남기지 않는다.
 *
 * 현재는 mock 어댑터가 동작하며, 실제 구글 연동은 OAuth 클라이언트 승인 후 어댑터 교체로 전환된다.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (query: string) => Response.redirect(new URL(`/studio/youtube?${query}`, url.origin), 302);

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';

  if (error) return back('youtube=denied');
  if (!code) return back('youtube=invalid');

  // getSessionUser() 로는 심사 대기·반려·정지 채널이 그대로 통과한다.
  // 스튜디오 레이아웃이 막는 상태를 이 API 로 우회하지 못하도록 requireCreator() 를 쓴다.
  let sessionCreatorId: string;
  try {
    const creator = await requireCreator();
    sessionCreatorId = creator.creatorId;
  } catch {
    return Response.redirect(new URL('/login?next=/studio/youtube', url.origin), 302);
  }

  // state 는 1회성이다. 서명 + 세션 일치 + 미사용 여부를 모두 확인하고 소비한다.
  const stateResult = await consumeYouTubeOAuthState(state, sessionCreatorId);
  if (!stateResult.ok) {
    return back(stateResult.reason === 'USED_OR_EXPIRED' ? 'youtube=state_expired' : 'youtube=state_mismatch');
  }
  const creatorId = stateResult.creatorId;

  try {
    const adapter = getYouTubeAdapter();

    const exchanged = await adapter.exchangeCode(code);
    if (!exchanged.ok || !exchanged.data) {
      return back(`youtube=token_failed&code=${encodeURIComponent(exchanged.code ?? '')}`);
    }
    const tokens = exchanged.data;

    // 동의 화면에서 채팅 권한 체크를 해제하면 연결은 되지만 전송이 전건 실패한다.
    // 그 사실을 후원이 들어온 뒤가 아니라 연결 시점에 알려 준다.
    if (!hasRequiredScope(tokens.scope)) {
      return back('youtube=scope_missing');
    }

    const channelRes = await adapter.getChannel(tokens.accessToken);
    if (!channelRes.ok || !channelRes.data) {
      return back(`youtube=channel_failed&code=${encodeURIComponent(channelRes.code ?? '')}`);
    }
    const channel = channelRes.data;

    const common = {
      channelId: channel.channelId,
      channelTitle: channel.title,
      channelThumb: channel.thumbnailUrl ?? null,
      accessTokenEnc: encrypt(tokens.accessToken),
      scope: tokens.scope,
      expiresAt: tokens.expiresAt,
      status: 'CONNECTED' as const,
      lastError: null,
      lastCheckedAt: new Date(),
    };

    /**
     * **refresh token 이 비어 있으면 기존 값을 덮어쓰지 않는다.**
     *
     * 구글은 refresh token 을 **최초 동의 때만** 내려준다. 크리에이터가 "다른 채널로 다시
     * 연결" 하면 재동의라 refresh token 이 오지 않는 것이 정상이다. 예전에는 그것을 그대로
     * `encrypt('')` 로 덮어써서, 다시 연결한 순간 멀쩡하던 갱신 수단이 사라지고
     * 액세스 토큰이 만료되는 약 1시간 뒤에 연결이 영구히 죽었다(복구 방법은 재연결뿐인데
     * 재연결이 또 같은 결과를 낳는다). 갱신 경로(`ensureYouTubeAccessToken`)는 이미
     * 같은 방식으로 보존하고 있었는데 이 경로만 빠져 있었다.
     *
     * 최초 연결(create)에는 refresh token 이 반드시 있어야 한다. 없으면 연결을 만들지 않고
     * 되돌려 보낸다 — 만들어 봐야 1시간짜리 연결이다.
     */
    const refreshTokenEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

    const before = await prisma.youTubeConnection.findUnique({
      where: { creatorId },
      select: { id: true },
    });

    if (!before && !refreshTokenEnc) {
      logger.warn('유튜브 최초 연결에 refresh token 이 없습니다.', { creatorId });
      return back('youtube=no_refresh_token');
    }

    await prisma.youTubeConnection.upsert({
      where: { creatorId },
      create: { id: newId(), creatorId, ...common, refreshTokenEnc: refreshTokenEnc as string },
      update: { ...common, ...(refreshTokenEnc ? { refreshTokenEnc } : {}) },
    });

    return back('youtube=connected');
  } catch (e) {
    // 토큰 값은 로그에 남기지 않는다.
    logger.warn('유튜브 연결 실패', { creatorId, message: (e as Error).message });
    return back('youtube=error');
  }
}
