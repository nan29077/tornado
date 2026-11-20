/**
 * 내장 DB(PGlite) 소켓 서버의 동시 접속 문제 보정 (8차 점검, 2026-11-20).
 *
 * 증상: 미리보기에서 요청이 몰리면 드물게
 *   "bind message supplies 2 parameters, but prepared statement "" requires 3"
 * 같은 DB 오류로 화면 한 번이 실패했다.
 *
 * 원인: @electric-sql/pglite-socket 0.2.x 의 질의 대기열은 메시지(Parse · Bind · Execute · Sync)를 한 개씩
 * 순서대로 PGlite 에 넘기고, 같은 연결끼리 묶는 것은 "트랜잭션 중" 일 때뿐이다. 그런데 Prisma(pg) 는 트랜잭션
 * 밖에서도 확장 질의 프로토콜(Parse → Bind → Execute → Sync)을 쓰므로, 두 연결의 메시지가 섞이면
 * A 의 Parse 다음에 B 의 Parse 가 끼어들어 A 의 Bind 가 엉뚱한 문장에 붙는다. PGlite 는 백엔드가 하나라
 * 이름 없는 준비 문장("")을 모든 연결이 함께 쓰기 때문이다.
 *
 * 보정: 한 연결이 확장 질의를 시작하면(Parse/Bind/Describe/Execute/Close/Flush) 그 연결의 Sync 가 끝날 때까지
 * 다른 연결의 메시지를 기다리게 한다. 트랜잭션 중 같은 연결 우선 규칙은 그대로 둔다.
 * 실제 PostgreSQL(운영)에는 해당 없다 — 미리보기 · 테스트용 내장 DB 에만 적용한다.
 */

const EXTENDED = new Set([0x50 /* P */, 0x42 /* B */, 0x44 /* D */, 0x45 /* E */, 0x43 /* C */, 0x48 /* H */]);
const ENDS = new Set([0x53 /* S Sync */, 0x51 /* Q 단순 질의 */, 0x58 /* X 종료 */]);

export function patchPgliteQueryQueue(socketServer, db) {
  const q = socketServer?.queryQueue;
  if (!q || typeof q.processQueue !== 'function' || q.__donaidoPatched) return false;
  q.__donaidoPatched = true;
  /** 확장 질의 도중인 연결 (Sync 전까지 다른 연결은 대기) */
  let pinned = null;

  q.processQueue = async function processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const owner = pinned ?? (db.isInTransaction() && this.lastHandlerId ? this.lastHandlerId : null);
        let item;
        if (owner != null) {
          const idx = this.queue.findIndex((x) => x.handlerId === owner);
          if (idx === -1) break; // 그 연결의 다음 메시지가 올 때까지 기다린다 (도착하면 enqueue 가 다시 부른다)
          item = this.queue.splice(idx, 1)[0];
        } else {
          item = this.queue.shift();
        }
        const type = item.message[0];
        let bytes = 0;
        try {
          await db.runExclusive(async () =>
            db.execProtocolRawStream(item.message, {
              onRawData: (chunk) => {
                bytes += chunk.length;
                item.onData(chunk);
              },
            }),
          );
        } catch (e) {
          if (pinned === item.handlerId) pinned = null;
          item.reject(e);
          continue;
        }
        this.lastHandlerId = item.handlerId;
        if (ENDS.has(type)) {
          if (pinned === item.handlerId) pinned = null;
        } else if (EXTENDED.has(type)) {
          pinned = item.handlerId;
        }
        item.resolve(bytes);
      }
    } finally {
      this.processing = false;
    }
  };

  // 확장 질의 도중 연결이 끊기면 대기를 풀어 다른 연결이 멈추지 않게 한다
  const clear = q.clearQueueForHandler.bind(q);
  q.clearQueueForHandler = function clearQueueForHandler(handlerId) {
    clear(handlerId);
    if (pinned === handlerId) {
      pinned = null;
      setImmediate(() => void this.processQueue());
    }
  };
  return true;
}
