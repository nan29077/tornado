import { getSessionUser } from '@/server/auth';
import { getTalkConfig } from '@/server/services/engagement/config';
import { subscribeTalkSignals, type TalkSignal } from '@/server/services/talk/bus';
import { getSubscriptionStatus } from '@/server/services/talk/talk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 팬챗 실시간 신호 (SSE, 2026-11-18).
 *   GET /api/talk/stream?c=<creatorId>
 *
 * 본문은 보내지 않는다. "새 소식이 있다" 는 신호만 보내고, 화면이 권한 확인을 거치는 조회로 내용을 가져온다.
 * - 구독 중인 팬: 크리에이터 메시지 · 나에게 온 답장 · 삭제 신호 (단체방이면 다른 팬 메시지도)
 * - 그 방의 크리에이터: 팬 답장 · 팬레터 · 하트
 * 10분마다 연결을 닫는다 → 브라우저가 다시 연결하면서 구독 상태를 다시 확인한다.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const creatorId = (url.searchParams.get('c') ?? '').slice(0, 40);
  if (!creatorId) return new Response('bad request', { status: 400 });
  const user = await getSessionUser().catch(() => null);
  if (!user) return new Response('unauthorized', { status: 401 });
  const asCreator = user.creatorId === creatorId;
  if (!asCreator) {
    const status = await getSubscriptionStatus(user.id, creatorId);
    if (!status.active) return new Response('forbidden', { status: 403 });
  }
  const group = (await getTalkConfig()).roomMode === 'GROUP';

  const wanted = (s: TalkSignal): boolean => {
    if (asCreator) return s.kind === 'FAN_REPLY' || s.kind === 'LETTER' || s.kind === 'REACTION';
    if (s.kind === 'BROADCAST' || s.kind === 'DELETE') return true;
    if (s.kind === 'DIRECT' || s.kind === 'LETTER') return s.fanUserId === user.id;
    if (s.kind === 'FAN_REPLY') return group || s.fanUserId === user.id;
    return false;
  };

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let closer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          teardown();
        }
      };
      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (ping) clearInterval(ping);
        if (closer) clearTimeout(closer);
        try {
          controller.close();
        } catch {
          /* 이미 닫힘 */
        }
      };
      send('retry: 3000\n\n');
      send(`event: ready\ndata: {}\n\n`);
      unsubscribe = subscribeTalkSignals(creatorId, (s) => {
        if (wanted(s)) send(`event: talk\ndata: ${JSON.stringify({ kind: s.kind, at: s.at })}\n\n`);
      });
      ping = setInterval(() => send(': ping\n\n'), 20_000);
      closer = setTimeout(teardown, MAX_AGE_MS);
      req.signal.addEventListener('abort', teardown);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (ping) clearInterval(ping);
      if (closer) clearTimeout(closer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
