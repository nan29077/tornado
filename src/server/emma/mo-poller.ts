/**
 * EMMA MO 폴러.
 *
 * em_mo_log_YYYYMM 에서 신규 수신 건을 읽어 도메인 핸들러로 넘긴다.
 *
 * 상태 전이
 * ---------
 *   '3'(EMMA 가 넣은 신규)
 *      → '2'(우리가 선점, 조건부 UPDATE 라 동시 실행에도 한 프로세스만 성공)
 *      → '9'(처리 완료)  또는  '3'(예외·판단 보류 → 다음 폴링에서 재시도)
 *
 * EMMA 는 MO 행을 INSERT 만 하고 다시 읽지 않으므로 이 갱신이 EMMA 동작에 영향을 주지 않는다.
 * (검증: emma_sp_smo.sql 에는 log_create 와 tran_insert 두 함수뿐이다)
 *
 * 중복 처리에 대하여
 * ------------------
 * 선점 실패 시 건너뛰지만, 이것은 **성능을 위한 1차 방어일 뿐 정확성의 근거가 아니다.**
 * 정확성은 도메인 쪽 `mo_inbound_message.provider_message_id` UNIQUE 제약이 보장한다.
 * 잠금이 만료된 채로 폴링이 겹쳐 같은 행을 두 번 넘기더라도 후원은 한 번만 생성된다.
 *
 * 무한 재시도(독약 메시지)에 대하여
 * ----------------------------------
 * 예외가 나면 신규('3')로 되돌리므로, 어떤 이유로든 **항상** 실패하는 행이 하나 생기면 그 행이
 * 매 폴링마다 배치 앞자리를 차지하며 영원히 재시도된다(ORDER BY date_mo ASC). 뒤에 쌓인 정상
 * 후원까지 밀린다. 그래서 실패 횟수를 세어 상한(MAX_HANDLER_FAILURES)을 넘기면 완료로 내리고
 * ERROR 로그를 남겨 사람이 보게 한다.
 */

import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { kv } from '@/server/redis';
import {
  assertSafeSuffix,
  getEmmaQuerier,
  moTableExists,
  pollingSuffixes,
} from './client';
import { restoreMoNumber, splitMoNumber } from './number';
import {
  EMMA_MO_STATUS,
  type EmmaMoHandler,
  type EmmaMoHandlerResult,
  type EmmaMoMessage,
  type EmmaMoRow,
  type EmmaPollResult,
} from './types';

/**
 * 조회 컬럼. 명세서에 있는 필드만 읽는다.
 *
 * date_mo / date_mo_recv 는 시간대 정보가 없는 TIMESTAMP 다(E-6). 이 값을 드라이버가 알아서
 * 해석하게 두면 **접속 방식에 따라 결과가 달라진다.** Prisma(같은 DB 구성)는 UTC 로,
 * node-postgres(전용 DB 구성)는 Node 프로세스의 로컬 시간대로 읽는다. 컨테이너 TZ 하나만
 * 바뀌어도 수신 시각이 9시간 어긋나고, 그 값이 그대로 후원 기록(receivedAt)에 박힌다.
 * `AT TIME ZONE 'UTC'` 로 DB 에서 timestamptz 로 확정해 두 경로가 같은 절대 시각을 보게 한다.
 */
const MO_COLUMNS = `mo_key, service_type, mo_recipient, emo_recipient, mo_originator,
                    mo_callback, msg_status, subject, content,
                    (date_mo AT TIME ZONE 'UTC') AS date_mo,
                    (date_mo_recv AT TIME ZONE 'UTC') AS date_mo_recv,
                    carrier, rs_id, ems_id, ems_total, ems_seq, emma_id`;

/** 같은 행에서 예외가 반복될 때 재시도를 포기하는 횟수. */
const MAX_HANDLER_FAILURES = 5;
/**
 * 핸들러가 "다음에 다시 보라"(RETRY)고 미룬 횟수의 상한.
 *
 * 예외보다 넉넉히 잡는다. 정상적인 보류 사유(직전 처리가 중단돼 PENDING 으로 남은 행)는
 * 정리 배치(recoverStuckMoMessages)가 5분 뒤 풀어 주므로 몇 번의 폴링이면 해소된다.
 * 그래도 상한은 둔다 — 풀리지 않는 상황에서 영원히 도는 것을 막는다.
 */
const MAX_HANDLER_DEFERRALS = 60;
/** 실패 카운터 보존 기간(초). 오래된 카운터는 알아서 사라진다. */
const FAILURE_TTL_SEC = 7 * 24 * 60 * 60;

/** 마지막 폴링 성공 시각을 남기는 키. 폴링 정지를 감지하는 유일한 지표다(E-8). */
export const EMMA_LAST_POLL_KEY = 'emma:lastPollAt';

function failureKey(moKey: string, kind: 'fail' | 'defer'): string {
  return `emma:mo:${kind}:${moKey}`;
}

/** 실패/보류 횟수를 1 올리고 누적값을 돌려준다. 카운터 저장소 장애가 폴링을 막지 않는다. */
async function bumpAttempt(moKey: string, kind: 'fail' | 'defer'): Promise<number> {
  try {
    return await kv.incr(failureKey(moKey, kind), FAILURE_TTL_SEC);
  } catch {
    // 카운터를 셀 수 없으면 상한을 적용하지 않는다(기존 동작 = 계속 재시도).
    return 0;
  }
}

async function clearAttempts(moKey: string): Promise<void> {
  await kv.del(failureKey(moKey, 'fail')).catch(() => undefined);
  await kv.del(failureKey(moKey, 'defer')).catch(() => undefined);
}

/**
 * 처리 대상 행을 읽는다.
 *
 * 신규('3') 와, 선점된 채 오래 남은 건('2')을 함께 본다. 후자는 처리 도중 프로세스가 죽어
 * 영영 묻히는 것을 막기 위한 복구 경로다. EMMA 테이블에는 갱신 시각 컬럼이 없으므로
 * **EMMA 가 행을 넣은 시각(date_mo_recv)** 을 기준으로 오래된 것만 되살린다.
 * (정상 처리는 1초 안에 끝나므로 기본 5분이면 진행 중인 건을 건드리지 않는다)
 */
async function fetchCandidates(suffix: string, limit: number, staleSec: number): Promise<EmmaMoRow[]> {
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  return q.query<EmmaMoRow>(
    `SELECT ${MO_COLUMNS}
       FROM em_mo_log_${suffix}
      WHERE msg_status = $1
         OR (msg_status = $2 AND date_mo_recv < NOW() - MAKE_INTERVAL(secs => $3))
      ORDER BY date_mo ASC
      LIMIT ${Number(limit)}`,
    [EMMA_MO_STATUS.NEW, EMMA_MO_STATUS.CLAIMED, staleSec],
  );
}

/**
 * 상태를 '처리 중'으로 원자적으로 선점한다.
 * 다른 프로세스가 먼저 가져갔으면 0행이 갱신되어 false 를 돌려준다.
 */
async function claim(suffix: string, moKey: string, staleSec: number): Promise<boolean> {
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  const affected = await q.execute(
    `UPDATE em_mo_log_${suffix}
        SET msg_status = $1
      WHERE mo_key = $2
        AND (msg_status = $3
             OR (msg_status = $1 AND date_mo_recv < NOW() - MAKE_INTERVAL(secs => $4)))`,
    [EMMA_MO_STATUS.CLAIMED, moKey, EMMA_MO_STATUS.NEW, staleSec],
  );
  return affected > 0;
}

/** 상태를 바꾼다(완료 '9' 또는 재시도를 위한 신규 '3' 복귀). */
async function setStatus(suffix: string, moKey: string, status: string): Promise<void> {
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  await q.execute(`UPDATE em_mo_log_${suffix} SET msg_status = $1 WHERE mo_key = $2`, [status, moKey]);
}

/** EMMA 의 service_type 을 메시지 종류로 옮긴다. '4'=SMS MO, '5'=MMS MO */
function toMessageType(serviceType: string | null): EmmaMoMessage['messageType'] {
  return String(serviceType ?? '').trim() === '5' ? 'MMS' : 'SMS';
}

/**
 * 수신 시각 정규화(E-6).
 *
 * SELECT 에서 `AT TIME ZONE 'UTC'` 로 확정하지만, 드라이버가 문자열로 돌려주는 경우까지
 * 대비한다. 시간대 표기가 없는 문자열은 **UTC 로 명시해** 해석한다(로컬 시간대 추정 금지).
 */
export function parseEmmaTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;
  // 이미 시간대가 붙어 있으면 그대로 믿는다. (+09, +09:00, Z)
  const hasZone = /(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(raw);
  const iso = raw.replace(' ', 'T');
  const parsed = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 원본 행 → 정규화 메시지. 번호 복원이 여기서 일어난다. */
export function toMoMessage(row: EmmaMoRow): EmmaMoMessage {
  const receivedNumber = restoreMoNumber(row.mo_recipient, row.emo_recipient);
  const { base, sub } = splitMoNumber(receivedNumber);
  return {
    moKey: row.mo_key,
    receivedNumber,
    baseNumber: base,
    subCode: sub,
    fromNumber: String(row.mo_originator ?? '').trim(),
    content: row.content ?? '',
    messageType: toMessageType(row.service_type),
    receivedAt: parseEmmaTimestamp(row.date_mo) ?? new Date(),
    raw: row,
  };
}

/** 핸들러 반환값을 한 가지 모양으로 맞춘다(문자열·void·객체 모두 허용). */
function normalizeHandlerResult(value: string | void | EmmaMoHandlerResult): EmmaMoHandlerResult {
  if (value && typeof value === 'object' && 'outcome' in value) return value;
  return { outcome: 'DONE', detail: typeof value === 'string' ? value : undefined };
}

/**
 * 폴링 1회.
 *
 * @param handler 수신 문자 1건을 처리할 도메인 함수
 */
export async function pollEmmaMo(handler: EmmaMoHandler): Promise<EmmaPollResult> {
  const result: EmmaPollResult = {
    fetched: 0,
    handed: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    abandoned: 0,
    details: [],
  };

  const limit = env.emma.batchSize;
  const staleSec = env.emma.staleSec;
  const expectedBase = env.emma.baseNumber.replace(/\D/g, '');

  for (const suffix of pollingSuffixes()) {
    if (!(await moTableExists(suffix))) continue;

    let rows: EmmaMoRow[];
    try {
      rows = await fetchCandidates(suffix, limit, staleSec);
    } catch (e) {
      // 한 달치 테이블 조회가 실패해도 나머지 달은 계속 본다.
      logger.error('EMMA MO 조회 실패', { suffix, message: (e as Error).message });
      continue;
    }
    result.fetched += rows.length;

    for (const row of rows) {
      const moKey = row.mo_key;

      let claimed = false;
      try {
        claimed = await claim(suffix, moKey, staleSec);
      } catch (e) {
        result.failed++;
        result.details.push({ moKey, outcome: 'failed', detail: `선점 실패: ${(e as Error).message}` });
        continue;
      }
      if (!claimed) {
        result.skipped++;
        result.details.push({ moKey, outcome: 'skipped', detail: '다른 실행이 이미 선점' });
        continue;
      }

      const message = toMoMessage(row);

      // 대표번호가 설정과 다르면 남의 번호가 섞여 들어온 것이다. 처리하지 않고 남겨 둔다.
      // (한 EMMA 에 여러 서비스의 번호가 물린 구성에서 서로의 후원을 가로채는 사고를 막는다)
      if (expectedBase && message.baseNumber !== expectedBase) {
        await setStatus(suffix, moKey, EMMA_MO_STATUS.NEW).catch(() => undefined);
        result.skipped++;
        result.details.push({
          moKey,
          outcome: 'skipped',
          detail: `대표번호 불일치 (수신 ${message.baseNumber || '없음'} / 설정 ${expectedBase})`,
        });
        logger.warn('EMMA MO 대표번호 불일치 — 처리하지 않음', {
          moKey,
          received: message.baseNumber,
          expected: expectedBase,
        });
        continue;
      }

      try {
        const handled = normalizeHandlerResult(await handler(message));

        if (handled.outcome === 'RETRY') {
          /**
           * 핸들러가 판단을 미뤘다(E-3). 대표적으로 직전 처리가 강제 종료로 중단돼 수신 로그가
           * PENDING 으로 남은 경우다. 완료('9')로 덮으면 그 문자는 영영 재처리되지 않는다.
           */
          const deferrals = await bumpAttempt(moKey, 'defer');
          if (deferrals > MAX_HANDLER_DEFERRALS) {
            await setStatus(suffix, moKey, EMMA_MO_STATUS.DONE);
            await clearAttempts(moKey);
            result.abandoned++;
            result.details.push({ moKey, outcome: 'abandoned', detail: `보류 ${deferrals}회 — 재시도 포기` });
            logger.error('EMMA MO 보류 상한 초과 — 재시도를 포기했습니다. 수동 확인이 필요합니다.', {
              moKey,
              deferrals,
              detail: handled.detail,
            });
            continue;
          }
          await setStatus(suffix, moKey, EMMA_MO_STATUS.NEW);
          result.deferred++;
          result.details.push({ moKey, outcome: 'deferred', detail: handled.detail ?? '판단 보류' });
          logger.warn('EMMA MO 처리 보류 — 다음 폴링에서 다시 봅니다', {
            moKey,
            deferrals,
            detail: handled.detail,
          });
          continue;
        }

        await setStatus(suffix, moKey, EMMA_MO_STATUS.DONE);
        await clearAttempts(moKey);
        result.handed++;
        result.details.push({ moKey, outcome: 'handed', detail: handled.detail });
      } catch (e) {
        // 도메인 처리에서 예외가 났다. 신규로 되돌려 다음 폴링에서 다시 시도한다.
        // (되돌리기 자체가 실패하면 '2' 로 남지만, staleSec 이 지나면 복구 대상이 된다)
        const failures = await bumpAttempt(moKey, 'fail');
        const message2 = (e as Error).message;

        if (failures > MAX_HANDLER_FAILURES) {
          // 무엇을 해도 실패하는 행(독약 메시지). 계속 되돌리면 배치 앞자리를 영원히 차지해
          // 뒤에 쌓인 정상 후원까지 막는다. 완료로 내리고 사람이 볼 수 있게 남긴다.
          await setStatus(suffix, moKey, EMMA_MO_STATUS.DONE).catch(() => undefined);
          await clearAttempts(moKey);
          result.abandoned++;
          result.details.push({ moKey, outcome: 'abandoned', detail: `${failures}회 실패 — 재시도 포기: ${message2}` });
          logger.error('EMMA MO 반복 실패 — 재시도를 포기했습니다. 수동 확인이 필요합니다.', {
            moKey,
            failures,
            message: message2,
          });
          continue;
        }

        await setStatus(suffix, moKey, EMMA_MO_STATUS.NEW).catch(() => undefined);
        result.failed++;
        result.details.push({ moKey, outcome: 'failed', detail: message2 });
        logger.error('EMMA MO 처리 실패 — 재시도 대상으로 되돌림', { moKey, failures, message: message2 });
      }
    }
  }

  /**
   * 폴링이 살아 있다는 흔적(E-8).
   *
   * 배치가 멈추면 문자가 들어와도 후원이 만들어지지 않는데, 화면 어디에도 오류가 뜨지 않는다
   * (조용한 실패). 마지막 성공 시각을 남겨 두면 /admin/system 과 /api/health 에서
   * "몇 분째 폴링이 없다"를 바로 볼 수 있다.
   */
  await kv.set(EMMA_LAST_POLL_KEY, new Date().toISOString()).catch(() => undefined);

  return result;
}

/** 마지막 폴링 시각. 기록이 없으면 null (한 번도 돌지 않았거나 캐시가 비워진 상태). */
export async function readEmmaLastPollAt(): Promise<Date | null> {
  try {
    const raw = await kv.get(EMMA_LAST_POLL_KEY);
    if (!raw) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/**
 * 폴링 생존 여부 요약(E-8).
 *
 * 경과 시간 계산까지 여기서 한다. 화면(서버 컴포넌트) 렌더 중에 현재 시각을 읽으면
 * 렌더가 순수하지 않게 되어(react-hooks/purity) 재렌더마다 값이 흔들린다.
 *
 * @param staleSec 이 시간을 넘도록 흔적이 없으면 멈춘 것으로 본다. 스케줄러 주기는 1분이다.
 */
export async function readEmmaPollHealth(
  staleSec = 300,
): Promise<{ at: Date | null; ageSec: number | null; stalled: boolean }> {
  const at = await readEmmaLastPollAt();
  const ageSec = at ? Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000)) : null;
  return { at, ageSec, stalled: ageSec === null || ageSec > staleSec };
}
