import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { subscribeOverlay, type OverlayEventPayload } from '@/server/services/overlay-bus';
import { authorizeOverlay } from '@/server/services/overlay-access';
import { registerOverlayConnection } from '@/server/services/overlay-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 오버레이 실시간 이벤트 (SSE).
 * OBS / PRISM 브라우저 소스가 이 스트림을 구독한다.
 * 토큰이 없거나 틀리면 즉시 거절한다.
 * preview=1 은 스튜디오 미리보기 전용으로, 로그인한 본인 크리에이터만 통과한다.
 *
 * 끊김 복구
 *  - 각 donation 이벤트에 `id: <eventId>` 를 붙인다.
 *  - 재연결 시 클라이언트가 마지막으로 받은 이벤트 ID 를 보내면(Last-Event-ID 헤더 또는
 *    lastEventId 쿼리) 그 이후에 쌓인 OverlayEvent 를 즉시 재전송한다.
 *  - 재전송 대상은 **최근 5분 이내**로 제한한다. 방송이 끝난 뒤 몇 시간 만에 다시 연결했을 때
 *    옛날 후원 알림이 한꺼번에 쏟아지면 안 된다.
 */

/** 재전송 대상 시간창. 이보다 오래된 이벤트는 무시한다. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** 한 번에 재전송할 최대 건수. 넘치면 최신 건만 보낸다. */
const REPLAY_MAX = 20;

/** 재연결 클라이언트가 알려 준 마지막 이벤트 ID. 없으면 빈 문자열. */
function readLastEventId(req: Request, sp: URLSearchParams): string {
  // 브라우저가 자동 재연결할 때는 헤더로, 클라이언트가 직접 다시 연결할 때는 쿼리로 온다.
  const header = req.headers.get('last-event-id') ?? '';
  const value = header || sp.get('lastEventId') || '';
  // ULID 형식만 받는다. 임의 문자열로 DB 를 긁게 하지 않는다.
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value.trim()) ? value.trim() : '';
}

/**
 * 마지막으로 받은 이벤트 이후에 쌓인 이벤트를 찾는다.
 *
 * 앵커(마지막 이벤트)를 찾지 못하거나 이미 5분보다 오래됐으면 최근 5분만 대상으로 한다.
 * 다른 크리에이터의 이벤트 ID 를 보내 남의 알림을 훔쳐보는 것을 막기 위해 앵커의
 * creatorId 가 일치할 때만 앵커로 인정한다.
 */
async function loadMissedEvents(creatorId: string, lastEventId: string) {
  const since = new Date(Date.now() - REPLAY_WINDOW_MS);

  const anchor = await prisma.overlayEvent.findUnique({
    where: { id: lastEventId },
    select: { creatorId: true, createdAt: true },
  });
  const after = anchor && anchor.creatorId === creatorId && anchor.createdAt > since ? anchor.createdAt : since;

  // 최신 건이 더 중요하므로 내림차순으로 잘라낸 뒤 시간순으로 되돌린다.
  const rows = await prisma.overlayEvent.findMany({
    where: { creatorId, createdAt: { gt: after } },
    orderBy: { createdAt: 'desc' },
    take: REPLAY_MAX,
    select: { id: true, payload: true },
  });
  return rows.reverse();
}

export async function GET(req: Request, ctx: { params: Promise<{ creatorId: string }> }) {
  const { creatorId } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const token = sp.get('token') ?? '';
  const preview = sp.get('preview') === '1';

  // 토큰도 미리보기 표시도 없는 요청은 어차피 통과할 수 없다.
  // DB 조회 전에 잘라내 미인증 트래픽이 커넥션 풀을 먹는 것을 막는다.
  if (!preview && !token) {
    return new Response('unauthorized', { status: 401 });
  }

  const access = await authorizeOverlay(creatorId, token, preview);
  if (!access.ok) {
    return new Response('unauthorized', { status: 401 });
  }

  const lastEventId = readLastEventId(req, sp);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let unregister: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unregister?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      /**
       * 이 연결로 이미 보낸 후원 이벤트 ID.
       * 아래 보충 조회(sweep)가 같은 알림을 두 번 띄우지 않게 하기 위한 것이다.
       */
      const sentIds = new Set<string>();
      const SENT_MAX = 500;

      const send = (event: string, data: unknown, id?: string) => {
        if (closed) return;
        if (event === 'donation' && id) {
          if (sentIds.has(id)) return;
          sentIds.add(id);
          if (sentIds.size > SENT_MAX) {
            const oldest = sentIds.values().next().value;
            if (oldest) sentIds.delete(oldest);
          }
        }
        try {
          const head = id ? `id: ${id}\n` : '';
          controller.enqueue(encoder.encode(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* 연결 종료 */
        }
      };

      // 동시 연결 상한. 같은 종류(방송용 / 미리보기)끼리만 상한을 세고 방출한다.
      // 스튜디오 미리보기를 여러 개 열어도 방송 중인 OBS 연결이 끊기지 않아야 한다.
      unregister = registerOverlayConnection(
        creatorId,
        teardown,
        preview ? 'preview' : 'broadcast',
        'donation',
      );

      /**
       * 프록시 버퍼 밀어내기.
       *
       * SSE 는 응답을 열어 둔 채 조금씩 흘려보내는 방식인데, 중간에 낀 프록시(Cloudflare
       * 터널·회사 프록시·일부 CDN)가 **일정 크기가 찰 때까지 응답을 붙들고 있는** 경우가 있다.
       * 그러면 서버는 정상적으로 보냈는데 화면에는 아무것도 도착하지 않는다.
       * localhost 로 열면 멀쩡하고 터널 주소로만 안 되는 증상이 정확히 이것이다.
       *
       * 주석 줄(':')로 2KB 를 먼저 흘려 그 버퍼를 채워 준다. SSE 규격상 주석은 무시되므로
       * 클라이언트에는 아무 영향이 없고, 연결당 딱 한 번 2KB 다.
       */
      try {
        controller.enqueue(encoder.encode(`:${' '.repeat(2048)}\n\n`));
      } catch {
        /* 연결 종료 */
      }

      send('ready', { creatorId, at: new Date().toISOString(), resumed: Boolean(lastEventId) });

      // 재전송 중에 도착한 실시간 이벤트는 잠시 모아 두었다가 재전송 뒤에 이어 보낸다.
      // (구독을 먼저 걸어야 조회하는 사이에 들어온 후원이 사라지지 않는다)
      let replaying = Boolean(lastEventId);
      const buffered: OverlayEventPayload[] = [];

      unsubscribe = subscribeOverlay(creatorId, (payload) => {
        if (replaying) {
          buffered.push(payload);
          return;
        }
        send('donation', payload, payload.eventId);
      });

      if (lastEventId) {
        void (async () => {
          try {
            const missed = await loadMissedEvents(creatorId, lastEventId);
            if (missed.length > 0) {
              logger.info('오버레이 재연결 — 놓친 이벤트를 재전송합니다.', {
                creatorId,
                count: missed.length,
              });
            }
            for (const row of missed) send('donation', row.payload, row.id);
          } catch (e) {
            // 재전송 실패가 실시간 구독까지 막지는 않는다.
            logger.warn('오버레이 재전송 실패', { creatorId, message: (e as Error).message });
          } finally {
            replaying = false;
            for (const payload of buffered) send('donation', payload, payload.eventId);
            buffered.length = 0;
          }
        })();
      }

      /**
       * 보충 조회 기준 시각. 이 시각 이후에 저장된 이벤트를 하트비트마다 확인한다.
       *
       * 실시간 전달은 Redis Pub/Sub 을 타는데, 인스턴스가 여러 대일 때 그 전파가 실패하면
       * 다른 인스턴스에 붙어 있는 OBS 는 그 알림을 영영 못 받는다. 연결 자체는 끊기지 않으므로
       * 재연결도, 재연결 시의 재전송도 일어나지 않기 때문이다. 결제·정산은 정상이라
       * 아무도 눈치채지 못한 채 방송에서 후원 알림만 사라진다.
       *
       * 이벤트는 어느 인스턴스에서 처리되든 overlay_event 표에 남으므로,
       * 하트비트마다 그 표를 확인해 빠진 것을 채운다. Redis 가 흔들려도 20초 안에 복구된다.
       */
      let sweepFrom = new Date();
      let sweeping = false;

      const sweepMissed = async () => {
        if (closed || replaying || sweeping) return;
        sweeping = true;
        try {
          const rows = await prisma.overlayEvent.findMany({
            where: { creatorId, createdAt: { gt: sweepFrom } },
            orderBy: { createdAt: 'asc' },
            take: 20,
            select: { id: true, payload: true, createdAt: true },
          });
          for (const row of rows) {
            send('donation', row.payload, row.id);
            if (row.createdAt > sweepFrom) sweepFrom = row.createdAt;
          }
        } catch (e) {
          // 보충 조회 실패가 실시간 구독을 막지는 않는다.
          logger.warn('오버레이 보충 조회 실패', { creatorId, message: (e as Error).message });
        } finally {
          sweeping = false;
        }
      };

      // 프록시 타임아웃 방지용 하트비트 + 놓친 이벤트 보충
      //
      // 틱은 1초. sweep 주기:
      //   미리보기(preview) → 1초: 서버 액션과 라우트 핸들러의 모듈 그래프가 분리되어
      //   EventEmitter 로 이벤트가 전달되지 않는 환경에서는 이 보충 조회가 유일한 경로다.
      //   [테스트 후원 보내기]의 체감 지연이 곧 이 주기이므로 짧게 잡는다.
      //   방송용(OBS/PRISM) → 20초: Redis 전파 실패를 보완하는 용도이므로 20초면 충분.
      const TICK_MS = 1000;
      let sweepTick = 0;
      const SWEEP_EVERY = preview ? 1 : 20; // 틱 기준 (1s * 1 = 1s, 1s * 20 = 20s)
      heartbeat = setInterval(() => {
        if (closed) return;
        sweepTick += 1;
        // ping 은 20초마다 보낸다(프록시 타임아웃 방지).
        if (sweepTick % 20 === 0) {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            /* 연결 종료 */
          }
        }
        if (sweepTick % SWEEP_EVERY === 0) void sweepMissed();
      }, TICK_MS);

      req.signal.addEventListener('abort', teardown);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      unregister?.();
      if (heartbeat) clearInterval(heartbeat);
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
