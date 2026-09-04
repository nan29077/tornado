/**
 * EMMA MT 발송 큐 적체 감시.
 *
 * 왜 필요한가
 * -----------
 * 우리는 `em_smt_tran`(단문) · `em_mmt_tran`(장문)에 행을 넣는 것까지만 한다. 실제 발송은
 * EMMA 데몬이 집어가서 처리한다. 그래서 EMMA 쪽 발송 서비스가 꺼져 있으면
 *   - 우리 기록은 전건 "발송 성공"(정확히는 큐 적재 성공)
 *   - 후원자는 PIN 문자를 못 받아 결제를 못 함
 *   - 화면 어디에도 오류가 나지 않음
 * 이 되어 아무도 알아채지 못한다. 같은 계열 서비스인 나눔플러스가 실제로 이 상태였다
 * (emma.cf 의 mtsender·mtreceiver·smtcollector·mtdistributor 가 모두 0).
 *
 * 게다가 EMMA 의 정리 배치(trandeleter)는 발송 대기('1')로 **10일** 넘게 남은 행을 그냥 지운다.
 * 열흘이 지나면 못 나간 문자의 흔적조차 사라진다. 그래서 조용히 넘어가지 않도록 여기서 센다.
 *
 * 비용
 * ----
 * EMMA 가 테이블을 만들 때 `ix_em_smt_tran_01 (msg_status, date_client_req)` 인덱스를 함께
 * 만든다. 아래 조회 조건이 그 인덱스와 컬럼 순서까지 일치해 인덱스 범위 스캔 한 번으로 끝난다.
 * 이 테이블은 진행 중인 건만 들고 있어(끝난 건은 월별 로그로 이관) 평소 수십~수백 행이다.
 */

import { logger } from '@/lib/logger';
import { getEmmaQuerier, emmaTableExists } from './client';

/** 이 시간을 넘도록 발송 대기 상태면 적체로 본다. EMMA 는 정상이면 2초 주기로 집어간다. */
export const MT_QUEUE_STUCK_MINUTES = 10;

export interface EmmaQueueStat {
  /** 큐 테이블이 있는가 (해당 서비스를 계약·활성화했는가) */
  present: boolean;
  /** 발송 대기('1') 상태 행 수 */
  pending: number;
  /** 그중 기준 시간을 넘긴 행 수 */
  stuck: number;
  /** 가장 오래된 대기 건의 적재 시각 */
  oldestAt: Date | null;
}

export interface EmmaQueueHealth {
  /** EMMA 연동 자체가 켜져 있는가 */
  checked: boolean;
  sms: EmmaQueueStat;
  mms: EmmaQueueStat;
  /** 단문 + 장문 적체 합계. 0 이 아니면 사람이 봐야 한다. */
  stuck: number;
}

const EMPTY: EmmaQueueStat = { present: false, pending: 0, stuck: 0, oldestAt: null };

async function readQueue(table: 'em_smt_tran' | 'em_mmt_tran', stuckMinutes: number): Promise<EmmaQueueStat> {
  if (!(await emmaTableExists(table))) return { ...EMPTY };

  const q = getEmmaQuerier();
  // 테이블명은 파라미터 바인딩이 안 되지만, 위 유니온 타입으로 두 값만 들어온다(주입 여지 없음).
  const rows = await q.query<{ pending: number | string; stuck: number | string; oldest: Date | string | null }>(
    `SELECT COUNT(*)::int AS pending,
            COUNT(*) FILTER (WHERE date_client_req < NOW() - MAKE_INTERVAL(mins => $1))::int AS stuck,
            MIN(date_client_req) AS oldest
       FROM ${table}
      WHERE msg_status = '1'`,
    [stuckMinutes],
  );

  const row = rows[0];
  const oldest = row?.oldest ?? null;
  return {
    present: true,
    pending: Number(row?.pending ?? 0),
    stuck: Number(row?.stuck ?? 0),
    oldestAt: oldest instanceof Date ? oldest : oldest ? new Date(oldest) : null,
  };
}

/**
 * 큐 상태를 읽는다. 조회 실패가 배치를 멈추지 않도록 전부 흡수한다.
 *
 * @param enabled EMMA 연동 사용 여부. 꺼져 있으면 조회하지 않는다.
 */
export async function readEmmaMtQueueHealth(
  enabled: boolean,
  stuckMinutes = MT_QUEUE_STUCK_MINUTES,
): Promise<EmmaQueueHealth> {
  if (!enabled) return { checked: false, sms: { ...EMPTY }, mms: { ...EMPTY }, stuck: 0 };

  try {
    const [sms, mms] = await Promise.all([
      readQueue('em_smt_tran', stuckMinutes),
      readQueue('em_mmt_tran', stuckMinutes),
    ]);
    return { checked: true, sms, mms, stuck: sms.stuck + mms.stuck };
  } catch (e) {
    logger.warn('EMMA MT 큐 상태 조회 실패', { message: (e as Error).message });
    return { checked: false, sms: { ...EMPTY }, mms: { ...EMPTY }, stuck: 0 };
  }
}

/**
 * 정리 배치에서 부른다. 적체가 있으면 ERROR 로그로 사람을 부른다.
 *
 * @returns 적체 건수 (배치 응답에 그대로 실린다)
 */
export async function checkEmmaMtQueueBacklog(enabled: boolean): Promise<number> {
  const health = await readEmmaMtQueueHealth(enabled);
  if (!health.checked || health.stuck === 0) return 0;

  logger.error(
    'EMMA MT 발송 큐 적체 — 문자가 큐에 쌓이기만 하고 발송되지 않고 있습니다. ' +
      'EMMA 설정(emma.cf)의 process.use.mtsender / mtreceiver / smtcollector / mmtcollector / mtdistributor 가 ' +
      '모두 1 인지 확인하십시오. em_smt_tran.emma_id 가 EMMA 설정과 다를 때도 영원히 발송되지 않습니다.',
    {
      stuck: health.stuck,
      smsPending: health.sms.pending,
      smsStuck: health.sms.stuck,
      smsOldestAt: health.sms.oldestAt?.toISOString() ?? null,
      mmsPending: health.mms.pending,
      mmsStuck: health.mms.stuck,
      mmsOldestAt: health.mms.oldestAt?.toISOString() ?? null,
      stuckMinutes: MT_QUEUE_STUCK_MINUTES,
    },
  );
  return health.stuck;
}
