/*
 * 도네이도 실시간 연결 공유기 (SharedWorker).
 *
 * 왜 필요한가
 *   브라우저는 http(HTTP/1.1) 주소 하나에 동시에 6개까지만 연결을 연다. 스튜디오 화면은 후원·게임
 *   미리보기 iframe 이 각자 실시간 연결(SSE)을 하나씩 잡고 있어, 미리보기 창을 하나 더 열거나 같은
 *   주소의 탭(게임 진행 화면 등)을 열면 6개가 다 차 버린다. 그러면 버튼(서버 요청)이 연결이 빌 때까지
 *   30초 가까이 대기한다. 실제 서비스(https · HTTP/2)에서는 생기지 않고 로컬 미리보기에서만 생긴다.
 *
 * 무엇을 하나
 *   같은 주소의 실시간 연결을 이 공유기 하나가 대표로 열고, 받은 이벤트를 구독한 모든 화면(iframe·탭)에
 *   나눠 준다. 미리보기 4개 + 미리보기 창 + 게임 진행 탭이 열려 있어도 실제 연결은 주소 종류별 1개다.
 *
 * 규칙
 *   - 화면 쪽 코드는 src/lib/shared-event-source.ts 다. 이 파일을 바꾸면 그쪽 HUB_VERSION 도 올린다.
 *   - 'donation' 같은 일회성 이벤트는 저장하지 않는다(나중에 붙은 화면이 옛 알림을 재생하면 안 된다).
 *     'ready' · 'state' · 'layout' 처럼 "현재 상태" 이벤트만 마지막 값을 기억해 새 구독자에게 바로 준다.
 *   - 화면이 정리 신호 없이 사라질 수 있으므로(iframe 제거·탭 강제 종료) 생존 신호가 끊긴 화면은
 *     150초 뒤 구독에서 뺀다. 구독자가 0 이 되면 연결을 닫는다.
 *   - [SSE-A] 구독을 뺄 때는 반드시 그 화면에 'error' 를 보낸다. 화면이 실제로는 살아 있었다면
 *     (백그라운드 탭의 타이머가 늦어진 경우 등) 'error' 를 받고 다시 구독한다. 예전에는 조용히 빼서
 *     화면은 "연결됨" 인데 이벤트가 영영 오지 않았다.
 *   - [SSE-A] 정리된 화면에서 메시지가 다시 오면 그 화면을 새로 등록한다. 'check' 로 화면이 가진
 *     구독 id 를 보내면 공유기가 모르는 id 에 'error' 를 돌려줘 화면이 다시 구독하게 한다.
 */
'use strict';

var STICKY = { ready: true, state: true, layout: true };
/**
 * [SSE-A] 35초 → 150초. 크롬은 5분 넘게 가려진 탭의 타이머를 1분에 1번 정도로 늦춘다.
 * 생존 신호(10초 간격)가 1분 간격으로 늦어져도 끊기지 않도록 여유를 둔다.
 * 실제로 사라진 화면의 연결은 그만큼 늦게 정리되지만 연결 수가 잠시 더 남는 정도라 괜찮다.
 */
var PORT_TIMEOUT_MS = 150000;
var CLOSE_GRACE_MS = 1500;

/** key -> { es, url, subs: Map<subKey, {port, id}>, sticky: Map, open, attached: Set, closeTimer } */
var streams = new Map();
/** port -> { lastSeen, subs: Map<id, key> } */
var ports = new Map();

/** 재연결용 lastEventId 만 다른 주소는 같은 연결로 본다. */
function keyOf(url) {
  try {
    var u = new URL(url, self.location.origin);
    u.searchParams.delete('lastEventId');
    u.searchParams.sort();
    return u.pathname + '?' + u.searchParams.toString();
  } catch (e) {
    return url;
  }
}

function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch (e) {
    /* 닫힌 화면 */
  }
}

function subKey(port, id) {
  // 포트 객체는 문자열로 못 바꾸므로 포트별 일련번호를 붙여 둔다.
  if (!port.__donaidoSeq) port.__donaidoSeq = Math.random().toString(36).slice(2);
  return port.__donaidoSeq + ':' + id;
}

function attach(s, name) {
  if (s.attached.has(name)) return;
  s.attached.add(name);
  s.es.addEventListener(name, function (ev) {
    var data = { data: ev.data, lastEventId: ev.lastEventId || '' };
    if (STICKY[name]) s.sticky.set(name, data);
    s.subs.forEach(function (sub) {
      post(sub.port, { type: 'event', id: sub.id, event: name, data: data.data, lastEventId: data.lastEventId });
    });
  });
}

function dropStream(key, notify) {
  var s = streams.get(key);
  if (!s) return;
  streams.delete(key);
  if (s.closeTimer) clearTimeout(s.closeTimer);
  try {
    s.es.close();
  } catch (e) {
    /* ignore */
  }
  s.subs.forEach(function (sub) {
    var p = ports.get(sub.port);
    if (p) p.subs.delete(sub.id);
    if (notify) post(sub.port, { type: 'error', id: sub.id });
  });
  s.subs.clear();
}

function subscribe(port, p, id, url, events) {
  var key = keyOf(url);
  var s = streams.get(key);
  if (!s) {
    var es = new EventSource(url);
    s = { es: es, url: url, subs: new Map(), sticky: new Map(), open: false, attached: new Set(), closeTimer: null };
    streams.set(key, s);
    es.onopen = function () {
      s.open = true;
      s.subs.forEach(function (sub) {
        post(sub.port, { type: 'open', id: sub.id });
      });
    };
    es.onerror = function () {
      // 화면 쪽이 지금과 같은 방식(지수 백오프)으로 다시 구독한다. 여기서는 연결을 정리만 한다.
      dropStream(key, true);
    };
  }
  if (s.closeTimer) {
    clearTimeout(s.closeTimer);
    s.closeTimer = null;
  }
  for (var i = 0; i < events.length; i++) attach(s, String(events[i]));
  s.subs.set(subKey(port, id), { port: port, id: id });
  p.subs.set(id, key);

  // 이미 열린 연결에 나중에 붙은 화면: 연결됨 + 현재 상태를 바로 알려 준다.
  if (s.open) post(port, { type: 'open', id: id });
  s.sticky.forEach(function (data, name) {
    if (events.indexOf(name) >= 0) {
      post(port, { type: 'event', id: id, event: name, data: data.data, lastEventId: data.lastEventId });
    }
  });
}

function unsubscribe(port, p, id) {
  var key = p.subs.get(id);
  p.subs.delete(id);
  if (!key) return;
  var s = streams.get(key);
  if (!s) return;
  s.subs.delete(subKey(port, id));
  if (s.subs.size === 0 && !s.closeTimer) {
    // 화면이 다시 그려지며 곧바로 재구독하는 경우가 많아 아주 잠깐 기다렸다 닫는다.
    s.closeTimer = setTimeout(function () {
      s.closeTimer = null;
      if (s.subs.size === 0) dropStream(key, false);
    }, CLOSE_GRACE_MS);
  }
}

/**
 * 화면(포트)의 구독을 모두 정리한다.
 * notify: [SSE-A] 생존 신호가 끊겨 정리할 때는 true. 화면이 살아 있었다면 'error' 를 받고 다시 구독한다.
 *         화면이 스스로 떠난다고 알린('bye') 경우는 받을 화면이 없으므로 false.
 */
function dropPort(port, notify) {
  var p = ports.get(port);
  if (!p) return;
  Array.from(p.subs.keys()).forEach(function (id) {
    unsubscribe(port, p, id);
    if (notify) post(port, { type: 'error', id: id });
  });
  ports.delete(port);
}

/**
 * [SSE-A] 포트 등록 정보를 꺼낸다. 정리된 뒤 다시 말을 건 포트(늦어진 백그라운드 탭,
 * bfcache 에서 돌아온 탭)는 새로 등록한다. 예전에는 정리된 등록 정보(클로저)에 계속 구독을 붙여
 * 다시는 정리되지 않는 연결이 남았다.
 */
function portEntry(port) {
  var p = ports.get(port);
  if (!p) {
    p = { lastSeen: Date.now(), subs: new Map() };
    ports.set(port, p);
  }
  return p;
}

self.onconnect = function (e) {
  var port = e.ports[0];
  portEntry(port);
  port.onmessage = function (m) {
    var d = m.data || {};
    if (d.type === 'bye') {
      dropPort(port, false);
      return;
    }
    var p = portEntry(port);
    p.lastSeen = Date.now();
    if (d.type === 'hello') post(port, { type: 'hello' });
    else if (d.type === 'sub' && d.id && d.url) subscribe(port, p, String(d.id), String(d.url), d.events || []);
    else if (d.type === 'unsub' && d.id) unsubscribe(port, p, String(d.id));
    else if (d.type === 'check' && Array.isArray(d.ids)) {
      // [SSE-A] 화면이 아직 살아 있다고 믿는 구독 중 공유기가 모르는 것은 끊긴 것으로 알린다.
      for (var i = 0; i < d.ids.length; i++) {
        var id = String(d.ids[i]);
        if (!p.subs.has(id)) post(port, { type: 'error', id: id });
      }
    }
  };
  port.start();
};

setInterval(function () {
  var now = Date.now();
  ports.forEach(function (p, port) {
    if (now - p.lastSeen > PORT_TIMEOUT_MS) dropPort(port, true);
  });
}, 10000);
