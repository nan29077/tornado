import { authorizeOverlay } from '@/server/services/overlay-access';
import { gameStateStream } from '@/server/services/game-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 게임 오버레이 실시간 상태 (SSE).
 *
 * 후원 알림 스트림과 같은 토큰을 쓴다. 크리에이터가 관리할 비밀은 하나뿐이고,
 * 재발급하면 후원용·게임용 브라우저 소스가 함께 무효화된다.
 *
 * 정답·키워드는 이 경로로 절대 나가지 않는다(공개 뷰).
 */
export async function GET(req: Request, ctx: { params: Promise<{ creatorId: string }> }) {
  const { creatorId } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const token = sp.get('token') ?? '';
  const preview = sp.get('preview') === '1';

  if (!preview && !token) return new Response('unauthorized', { status: 401 });

  const access = await authorizeOverlay(creatorId, token, preview);
  if (!access.ok) return new Response('unauthorized', { status: 401 });

  // 후원 알림 스트림과 같은 상한을 공유한다. 토큰으로 붙은 방송용과 스튜디오 미리보기를 구분해 센다.
  return gameStateStream(creatorId, 'public', preview ? 'preview' : 'broadcast');
}
