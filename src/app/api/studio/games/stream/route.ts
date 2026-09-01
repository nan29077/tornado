import { requireCreator } from '@/server/auth';
import { gameStateStream } from '@/server/services/game-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 크리에이터 컨트롤용 실시간 상태 (SSE).
 * 참여자 유입·집계가 그대로 흘러오므로 컨트롤 화면은 새로 고침이 필요 없다.
 * 정답이 포함된 뷰이므로 반드시 본인 세션만 통과시킨다.
 */
export async function GET() {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch {
    return new Response('unauthorized', { status: 401 });
  }
  // 크리에이터 본인 화면이므로 미리보기 상한(넉넉한 쪽)으로 센다.
  return gameStateStream(creatorId, 'studio', 'preview');
}
