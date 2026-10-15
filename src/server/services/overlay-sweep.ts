/**
 * 오버레이 보충 조회(sweep) 범위 계산 (OV-F).
 *
 * 문제
 *   예전 보충 조회는 "기준 시각 이후(createdAt > sweepFrom)" 만 읽고, 기준 시각을 읽은 행 중 가장 늦은
 *   createdAt 으로 옮겼다. createdAt 은 저장 시작 시각이라 **늦게 커밋된 앞선 이벤트**(커밋 순서가 뒤바뀐 경우)
 *   나 인스턴스 간 시계 차이로 기준보다 이른 시각이 찍힌 이벤트는 이미 지나간 구간에 들어가 영영 읽히지 않았다.
 *
 * 방식
 *   - 기준 시각보다 {@link SWEEP_OVERLAP_MS} 앞부터 겹쳐 읽는다. 겹친 구간의 중복은 연결의 sentIds 가 거른다.
 *   - 겹친 구간에서 이미 읽은 행은 id 로 제외한다. 제외하지 않으면 그 구간에 take 이상의 행이 있을 때
 *     매번 같은 행만 읽고 새 행에 닿지 못한다.
 *   - 연결을 연 시각보다 앞은 읽지 않는다. 새로 연 미리보기 화면에 직전 알림이 다시 뜨면 안 된다
 *     (끊긴 사이의 알림은 lastEventId 재전송이 맡는다).
 */

/** 기준 시각보다 얼마나 앞부터 겹쳐 읽을지. 커밋 지연·시계 차이를 감안한 값. */
export const SWEEP_OVERLAP_MS = 10_000;
/** 한 번에 읽을 최대 행 수 (기존 값 유지). */
export const SWEEP_TAKE = 20;

export interface SweepCursor {
  /** 연결을 연 시각. 이보다 앞은 읽지 않는다. */
  floor: Date;
  /** 지금까지 읽은 가장 늦은 createdAt */
  from: Date;
  /** 겹침 구간 안에서 이미 읽은 행 id -> createdAt(ms) */
  seen: Map<string, number>;
}

export function createSweepCursor(now: Date = new Date()): SweepCursor {
  return { floor: now, from: now, seen: new Map() };
}

/** 이번 보충 조회의 where 조건. */
export function sweepWhere(creatorId: string, cursor: SweepCursor) {
  const lower = new Date(Math.max(cursor.floor.getTime(), cursor.from.getTime() - SWEEP_OVERLAP_MS));
  const exclude = Array.from(cursor.seen.keys());
  return {
    creatorId,
    // floor 와 같은 시각은 포함하지 않는다(기존 gt 동작 유지).
    createdAt: { gt: lower },
    ...(exclude.length > 0 ? { id: { notIn: exclude } } : {}),
  };
}

/** 읽은 행으로 기준 시각을 옮기고, 겹침 구간을 벗어난 기록은 버린다. */
export function advanceSweepCursor(cursor: SweepCursor, rows: Array<{ id: string; createdAt: Date }>): void {
  for (const row of rows) {
    cursor.seen.set(row.id, row.createdAt.getTime());
    if (row.createdAt > cursor.from) cursor.from = row.createdAt;
  }
  const cutoff = cursor.from.getTime() - SWEEP_OVERLAP_MS;
  for (const [id, at] of cursor.seen) {
    if (at <= cutoff) cursor.seen.delete(id);
  }
}
