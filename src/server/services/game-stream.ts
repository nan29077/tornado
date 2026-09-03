import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { subscribeGame } from '@/server/services/game-bus';
import {
  registerOverlayConnection,
  type OverlayConnectionKind,
} from '@/server/services/overlay-connections';
import { autoCloseIfDue } from '@/server/services/games';
import { buildStudioStateShared, toPublicState, type GameStudioState } from '@/server/services/game-state';
import { clampOverlayLayout } from '@/lib/overlay-layout';

/**
 * 게임 상태 SSE 스트림 (방송 오버레이 · 참여 페이지 · 크리에이터 컨트롤 공용).
 *
 * 전달 경로를 두 개 둔다.
 *  1) 실시간 버스 — 같은 프로세스에서 일어난 변화를 즉시 밀어 준다.
 *  2) 주기 확인   — 2초마다 DB 에서 상태를 다시 만들어 달라진 것만 보낸다.
 *
 * 2번이 왜 필요한가.
 *  - 후원 목표 게이지는 MO 웹훅·결제 콜백 같은 **다른 경로**에서 값이 올라간다.
 *    Next 는 라우트 핸들러와 서버 액션의 모듈 그래프가 갈릴 수 있어, 인메모리 버스만
 *    믿으면 그쪽에서 일어난 변화가 오버레이에 영영 도달하지 않는다.
 *  - 다중 인스턴스에서 Redis 전파가 실패해도 2초 안에 스스로 복구된다.
 *
 * 시청자에게 나가는 경로에서는 정답·키워드를 반드시 잘라낸다(view: 'public').
 */

export type GameStreamView = 'public' | 'studio';

export function gameStateStream(
  req: Request,
  creatorId: string,
  view: GameStreamView,
  kind: OverlayConnectionKind = 'preview',
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let unregister: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      /** 마지막으로 내보낸 상태. 같은 내용을 반복해서 보내지 않기 위해 비교용으로만 쓴다. */
      let lastSent = '';

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unregister?.();
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const write = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* 연결 종료 */
        }
      };

      const send = (state: GameStudioState | null) => {
        const payload = state ? (view === 'studio' ? state : toPublicState(state)) : null;
        const serialized = JSON.stringify(payload);
        if (serialized === lastSent) return;
        lastSent = serialized;
        write('state', payload);
      };

      // 후원 알림 스트림과 **같은 카운터**에 등록한다.
      // 그래야 토큰이 유출됐을 때 게임 쪽만 무제한으로 붙는 구멍이 생기지 않고,
      // 스튜디오의 [현재 연결] 수치에 게임 브라우저 소스도 함께 잡힌다.
      // 방송용 상한(6)은 후원 소스 + 게임 소스가 동시에 붙는 것을 전제로 잡아 둔 값이다.
      unregister = registerOverlayConnection(creatorId, teardown, kind, 'game');

      // 후원 알림 스트림과 동일하게 요청 취소 신호에도 반드시 정리한다.
      // ReadableStream.cancel() 만 믿으면, OBS 강제 종료나 프록시 리셋처럼 cancel 이
      // 호출되지 않는 경우에 폴링 타이머와 연결 슬롯이 영구히 남는다.
      req.signal.addEventListener('abort', teardown);

      write('ready', { creatorId, at: new Date().toISOString() });

      let broadcastEnabled = kind !== 'broadcast';
      /** 마지막으로 내보낸 배치 값. 달라졌을 때만 보낸다. */
      let lastLayout = '';

      unsubscribe = subscribeGame(creatorId, (state) => {
        // 종료된 회차는 화면을 비우라는 신호다.
        send(broadcastEnabled && state.roundId ? state : null);
      });

      const refresh = async () => {
        if (closed) return;
        try {
          const [state, setting] = await Promise.all([
            buildStudioStateShared(creatorId),
            prisma.overlaySetting.findUnique({
              where: { creatorId },
              select: { gameEnabled: true, gameOffsetX: true, gameOffsetY: true, gameScalePct: true },
            }),
          ]);
          broadcastEnabled = kind !== 'broadcast' || Boolean(setting?.gameEnabled);

          // 배치를 바꿔 저장하면 브라우저 소스를 다시 로드하지 않아도 방송 화면에 반영된다.
          // (후원 알림은 이벤트 페이로드에 실어 보내지만, 게임은 이벤트가 없을 수도 있다)
          const layout = clampOverlayLayout({
            offsetX: setting?.gameOffsetX,
            offsetY: setting?.gameOffsetY,
            scalePct: setting?.gameScalePct,
          });
          const layoutJson = JSON.stringify(layout);
          if (layoutJson !== lastLayout) {
            lastLayout = layoutJson;
            write('layout', layout);
          }
          // 자동 마감 시각이 지났으면 여기서 마감한다. 별도 스케줄러를 두지 않는다.
          if (state?.status === 'OPEN' && state.closesAt && new Date(state.closesAt).getTime() <= Date.now()) {
            const closedNow = await autoCloseIfDue(creatorId);
            if (closedNow) return; // 마감 처리에서 새 상태가 발행된다
          }
          send(broadcastEnabled ? state : null);
        } catch (e) {
          logger.warn('게임 상태 조회 실패', { creatorId, message: (e as Error).message });
        }
      };

      void refresh();

      const TICK_MS = 1000;
      let tick = 0;
      timer = setInterval(() => {
        if (closed) return;
        tick += 1;
        // 프록시 타임아웃 방지
        if (tick % 20 === 0) {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            /* 연결 종료 */
          }
        }
        // 2초마다 상태를 다시 확인한다. 달라진 것이 없으면 아무것도 내보내지 않는다.
        if (tick % 2 === 0) void refresh();
      }, TICK_MS);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      unregister?.();
      if (timer) clearInterval(timer);
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
