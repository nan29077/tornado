/**
 * 실시간 연결(SSE) 열기 — 같은 주소를 여러 화면이 쓰면 연결 하나를 나눠 쓴다.
 *
 * 배경
 *   브라우저는 http(HTTP/1.1) 주소 하나에 연결을 6개까지만 연다. 스튜디오는 후원·게임 미리보기
 *   iframe 이 각자 실시간 연결을 잡고 있어서, 구간 미리보기 창이나 게임 진행 탭을 더 열면 6개가 차고
 *   버튼(서버 요청)이 연결이 빌 때까지 30초 가까이 멈췄다. 실제 서비스(https · HTTP/2)에는 없는
 *   문제지만 로컬 미리보기에서는 그대로 드러난다.
 *
 * 방식
 *   `share: true` 이면 SharedWorker(public/sse-hub.js)가 주소별로 연결 하나만 열고 이벤트를 나눠 준다.
 *   SharedWorker 를 못 쓰는 환경(일부 내장 브라우저 등)이거나 2초 안에 응답이 없으면 예전처럼
 *   화면마다 EventSource 를 직접 연다. 동작은 두 경우가 같다.
 *
 *   방송용(OBS·PRISM) 화면은 각자 독립 브라우저라 나눠 쓸 대상이 없으므로 `share: false` 로 직접 연다.
 */

export interface StreamMessage {
  data: string;
  lastEventId: string;
}

export interface StreamOptions {
  /** 받을 이벤트 이름 */
  events: string[];
  onEvent: (name: string, message: StreamMessage) => void;
  onOpen?: () => void;
  /** 연결이 끊겼다. 연결은 이미 닫힌 상태이며, 다시 열지는 호출한 쪽이 정한다. */
  onError: () => void;
  /** 같은 주소를 쓰는 다른 화면(iframe·탭)과 연결을 나눠 쓴다. */
  share?: boolean;
}

export interface StreamHandle {
  close: () => void;
}

/** public/sse-hub.js 를 바꾸면 올린다. 주소가 바뀌어야 브라우저가 새 공유기를 띄운다. */
const HUB_VERSION = '1';
const HELLO_TIMEOUT_MS = 2000;
const PING_MS = 10_000;

type HubMessage =
  | { type: 'hello' }
  | { type: 'open'; id: string }
  | { type: 'error'; id: string }
  | { type: 'event'; id: string; event: string; data: string; lastEventId: string };

interface Hub {
  port: MessagePort;
  handlers: Map<string, StreamOptions>;
}

/** undefined: 아직 시도 전 · null: 쓸 수 없음 */
let hubPromise: Promise<Hub | null> | undefined;
let seq = 0;

function startHub(): Promise<Hub | null> {
  if (hubPromise) return hubPromise;
  hubPromise = new Promise<Hub | null>((resolve) => {
    if (typeof window === 'undefined' || typeof SharedWorker === 'undefined') {
      resolve(null);
      return;
    }
    let worker: SharedWorker;
    try {
      worker = new SharedWorker(`/sse-hub.js?v=${HUB_VERSION}`, { name: 'donaido-sse-hub' });
    } catch {
      resolve(null);
      return;
    }
    const hub: Hub = { port: worker.port, handlers: new Map() };
    let settled = false;
    const finish = (value: Hub | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), HELLO_TIMEOUT_MS);
    worker.onerror = () => finish(null);

    hub.port.onmessage = (e: MessageEvent<HubMessage>) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'hello') {
        finish(hub);
        return;
      }
      const h = hub.handlers.get(msg.id);
      if (!h) return;
      if (msg.type === 'open') h.onOpen?.();
      else if (msg.type === 'event') h.onEvent(msg.event, { data: msg.data, lastEventId: msg.lastEventId });
      else if (msg.type === 'error') {
        // 공유기는 연결을 이미 정리했다. 이 구독은 끝난 것으로 본다.
        hub.handlers.delete(msg.id);
        h.onError();
      }
    };
    hub.port.start();
    hub.port.postMessage({ type: 'hello' });

    // 생존 신호. 끊기면(탭 강제 종료 등) 공유기가 이 화면의 구독을 정리한다.
    setInterval(() => {
      try {
        hub.port.postMessage({ type: 'ping' });
      } catch {
        /* ignore */
      }
    }, PING_MS);
    window.addEventListener('pagehide', () => {
      try {
        hub.port.postMessage({ type: 'bye' });
      } catch {
        /* ignore */
      }
    });
  });
  return hubPromise;
}

function openDirect(url: string, opts: StreamOptions): StreamHandle {
  const es = new EventSource(url);
  es.onopen = () => opts.onOpen?.();
  for (const name of opts.events) {
    es.addEventListener(name, (ev) => {
      const m = ev as MessageEvent;
      opts.onEvent(name, { data: String(m.data), lastEventId: m.lastEventId || '' });
    });
  }
  es.onerror = () => {
    es.close();
    opts.onError();
  };
  return { close: () => es.close() };
}

export function openStream(url: string, opts: StreamOptions): StreamHandle {
  if (!opts.share) return openDirect(url, opts);

  let closed = false;
  let inner: StreamHandle | null = null;

  void startHub().then((hub) => {
    if (closed) return;
    if (!hub) {
      inner = openDirect(url, opts);
      return;
    }
    seq += 1;
    const id = `s${Date.now().toString(36)}${seq}`;
    hub.handlers.set(id, opts);
    // 공유기는 같은 출처에서 돌므로 상대 주소를 절대 주소로 바꿔 넘긴다.
    const absolute = new URL(url, window.location.href).toString();
    hub.port.postMessage({ type: 'sub', id, url: absolute, events: opts.events });
    inner = {
      close: () => {
        hub.handlers.delete(id);
        try {
          hub.port.postMessage({ type: 'unsub', id });
        } catch {
          /* ignore */
        }
      },
    };
  });

  return {
    close: () => {
      closed = true;
      inner?.close();
    },
  };
}
