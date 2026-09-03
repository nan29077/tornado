/**
 * EMMA 연동 코어.
 *
 * 이 디렉터리는 토네이도 도메인(크리에이터·후원·정산)에 의존하지 않는다.
 * 메시지페이·셀러브릭스에 그대로 복사해 쓰고, 각 프로젝트는 도메인 핸들러만 갈아 끼운다.
 *
 *   토네이도   → src/server/services/emma-mo-ingest.ts (후원)
 *   메시지페이 → 결제 핸들러
 *   셀러브릭스 → 주문/문의 핸들러
 */

export type {
  EmmaMoRow,
  EmmaMoMessage,
  EmmaMoHandler,
  EmmaMoHandlerResult,
  EmmaMtRequest,
  EmmaMtQueued,
  EmmaPollResult,
} from './types';
export { EMMA_MO_STATUS } from './types';

export {
  digitsOnly,
  restoreMoNumber,
  splitMoNumber,
  composeMoNumber,
  formatMoNumber,
  isUsableSubCode,
  RESERVED_SUB_CODES,
  SUB_CODE_LENGTH,
} from './number';

export {
  getEmmaQuerier,
  usesDedicatedDb,
  closeEmmaPool,
  moTableSuffix,
  pollingSuffixes,
  moTableExists,
  emmaTableExists,
  mmsQueueExists,
} from './client';

export {
  pollEmmaMo,
  toMoMessage,
  parseEmmaTimestamp,
  readEmmaLastPollAt,
  readEmmaPollHealth,
  EMMA_LAST_POLL_KEY,
} from './mo-poller';
export { queueEmmaMt, queueEmmaMms } from './mt-sender';
