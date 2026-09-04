/**
 * EMMA (Enterprise Mobile Mail Agent) 연동 타입.
 *
 * EMMA 는 인포뱅크가 제공하는 **온프레미스 SMS 에이전트**다. HTTP 웹훅을 보내지 않고
 * 자기 DB 테이블에 직접 읽고 쓴다. 그래서 우리 쪽은 "웹훅 수신"이 아니라 "테이블 폴링"으로 붙는다.
 *
 *   MO(수신) : 통신사 → EMMA → em_mo_log_YYYYMM 에 INSERT → 우리가 폴링
 *   MT(발신) : 우리가 em_smt_tran 에 INSERT → EMMA 가 픽업해 발송
 *
 * 중요(검증된 사실):
 *  - EMMA 의 SMS MO 프로시저는 `sp_em_smo_log_create` 와 `sp_em_smo_tran_insert` 둘뿐이다.
 *    즉 **EMMA 는 MO 행을 INSERT 만 하고 다시 읽지 않는다.** 우리가 msg_status 를 바꿔도
 *    EMMA 의 수신 동작에는 영향이 없다.
 *  - 예외는 통계 스케줄러(`sp_em_stat_mo_insert`)뿐인데, msg_status='3' 을 성공 건수로 센다.
 *    우리가 '9' 로 바꾸면 그 통계가 0 으로 잡힌다. 인포뱅크 내부 지표일 뿐 과금과 무관하고,
 *    권장 설정(`process.use.statscheduler = 0`)에서는 아예 동작하지 않는다.
 *
 * 이 디렉터리는 토네이도 도메인에 의존하지 않는다(메시지페이·셀러브릭스에 그대로 이식하기 위함).
 * 도메인 연결은 `src/server/services/emma-mo-ingest.ts` 가 담당한다.
 */

/** em_mo_log_YYYYMM 한 행. 컬럼명은 인포뱅크 PostgreSQL 명세서 v3.7.1.0 기준. */
export interface EmmaMoRow {
  /** 인포뱅크 G/W 가 발급한 메시지 키. 중복 수신 차단의 1차 키로 그대로 쓴다. */
  mo_key: string;
  /** 서비스 구분. '4'=SMS MO, '5'=MMS MO */
  service_type: string;
  /** MO 수신 대표번호(특번). 예: 16881234 */
  mo_recipient: string;
  /** MO 추가번호(emo 번호). 대표번호 뒤에 붙는 내선 4자리가 여기로 온다. */
  emo_recipient: string | null;
  /** 보낸 사람 휴대전화번호 원문 */
  mo_originator: string;
  /** 보낸 사람이 입력한 회신번호 */
  mo_callback: string | null;
  /** 메시지 상태. 수신 직후에는 항상 '3' */
  msg_status: string;
  subject: string | null;
  content: string | null;
  /**
   * MO 발생 시각.
   *
   * 원본 컬럼은 시간대가 없는 TIMESTAMP 다. 폴러가 SELECT 단계에서 `AT TIME ZONE 'UTC'` 로
   * 확정하지만, 드라이버에 따라 Date 가 아니라 문자열로 올 수 있어 두 형태를 모두 받는다.
   * (해석은 `parseEmmaTimestamp` 한 곳에서만 한다)
   */
  date_mo: Date | string;
  /** 인포뱅크로부터 수신한 시각. date_mo 와 같은 이유로 두 형태를 모두 받는다. */
  date_mo_recv: Date | string;
  /** 착신망. 10001(SKT) 10002(KT) 10003(LGU+) 10008(NGM) 10000(ETC) */
  carrier: number | null;
  rs_id: string | null;
  ems_id: number | null;
  ems_total: number | null;
  ems_seq: number | null;
  /** EMMA 이중화 시 인스턴스 식별자. 이중화를 쓰지 않으면 공백 */
  emma_id: string | null;
}

/**
 * MO 메시지 상태값.
 *
 * '3' 만 EMMA 가 쓰는 값이다(명세서: "3 - MO 접수"). 나머지는 우리가 처리 진행을 표시하려고
 * 덧붙인 값이다. EMMA 가 MO 를 다시 읽지 않으므로 충돌하지 않는다.
 */
export const EMMA_MO_STATUS = {
  /** EMMA 가 넣은 신규 수신 건 */
  NEW: '3',
  /** 우리가 선점해 처리 중 */
  CLAIMED: '2',
  /** 우리가 처리를 끝낸 건 (EMMA 는 이 값을 쓰지 않는다) */
  DONE: '9',
} as const;

/** em_smt_tran 에 넣을 MT 발송 요청 */
export interface EmmaMtRequest {
  /** 수신자 휴대전화번호 */
  to: string;
  /** 발신번호(회신번호). 사전등록된 번호여야 한다. */
  callback: string;
  /** 본문 */
  content: string;
}

/** MT 큐 적재 결과 */
export interface EmmaMtQueued {
  /** em_smt_tran.mt_pr 기반 식별자 */
  providerMessageId: string;
}

/**
 * 폴러가 도메인 계층으로 넘기는 정규화된 수신 문자.
 *
 * 이 타입에는 토네이도 고유 개념(크리에이터·후원)이 들어가지 않는다. 메시지페이·셀러브릭스가
 * 같은 폴러를 쓰고 각자의 핸들러만 갈아 끼울 수 있도록 하기 위함이다.
 */
export interface EmmaMoMessage {
  /** 인포뱅크 메시지 키. 중복 차단 키로 그대로 쓴다. */
  moKey: string;
  /** 복원된 수신번호 전체 (숫자만). 예: 168812345678 */
  receivedNumber: string;
  /** 대표번호 부분. 예: 16881234 */
  baseNumber: string;
  /** 서브번호 부분(크리에이터·가맹점·셀러 식별자). 예: 5678 */
  subCode: string;
  /** 보낸 사람 휴대전화번호 원문. 수신 즉시 해시·암호화하고 폐기해야 한다. */
  fromNumber: string;
  content: string;
  messageType: 'SMS' | 'LMS' | 'MMS';
  receivedAt: Date;
  /** 원본 행. 진단·감사에만 쓴다. */
  raw: EmmaMoRow;
  /**
   * 장문(MMS MO)이 여러 조각으로 나뉘어 온 경우의 조립 정보.
   * 단문이거나 조각이 하나면 undefined 다.
   */
  parts?: {
    /** EMMA 가 같은 메시지의 조각에 붙이는 묶음 번호 */
    emsId: number;
    /** 전체 조각 수 */
    total: number;
    /** 실제로 이어 붙인 조각 수. total 보다 작으면 일부가 끝내 오지 않은 것이다. */
    used: number;
  };
}

/**
 * 도메인 핸들러가 "아직 확정할 수 없으니 다음 폴링에서 다시 보라"고 알릴 때 쓰는 반환값.
 *
 * 예외와 다르다. 예외는 "처리하다 실패했다"이고, 이쪽은 "실패한 것이 아니라 판단을 미룬다"이다.
 * 대표 사례는 **직전 수신 처리가 강제 종료로 중단돼 PENDING 으로 남은 경우**다. 그 행을 완료('9')로
 * 덮으면 사업자·EMMA 재전송이 영영 오지 않아 후원 문자 한 통이 통째로 유실된다(E-3).
 */
export interface EmmaMoHandlerResult {
  outcome: 'DONE' | 'RETRY';
  /** 폴링 로그에 남길 요약 */
  detail?: string;
}

/**
 * 수신 문자 1건을 처리하는 도메인 핸들러.
 *
 * 반환 문자열은 폴링 결과 로그에 남는 요약이다(예: 'ROUTED', 'UNKNOWN_ROUTE').
 * `{ outcome: 'RETRY' }` 를 돌려주면 폴러가 상태를 신규('3')로 되돌려 다음 폴링에서 다시 본다.
 * **예외를 던지면** 마찬가지로 신규('3')로 되돌리되, 반복 실패 횟수를 세어 상한을 넘기면
 * 완료로 내려 무한 재시도(독약 메시지)를 끊는다.
 */
export type EmmaMoHandler = (message: EmmaMoMessage) => Promise<string | void | EmmaMoHandlerResult>;

/** 폴링 1회 결과 */
export interface EmmaPollResult {
  /** 조회한 행 수 */
  fetched: number;
  /** 우리 쪽으로 넘겨 처리한 행 수 */
  handed: number;
  /** 다른 프로세스가 먼저 선점해 건너뛴 행 수 */
  skipped: number;
  /** 처리 중 예외가 난 행 수 (다음 폴링에서 재시도) */
  failed: number;
  /** 핸들러가 판단을 미뤄 신규 상태로 되돌린 행 수 (다음 폴링에서 다시 본다) */
  deferred: number;
  /** 반복 실패 상한을 넘겨 재시도를 포기한 행 수 (사람이 봐야 하는 건) */
  abandoned: number;
  details: Array<{
    moKey: string;
    outcome: 'handed' | 'skipped' | 'failed' | 'deferred' | 'abandoned';
    /** 도메인 처리 결과(예: ROUTED, UNKNOWN_ROUTE) 또는 오류 사유 */
    detail?: string;
  }>;
}
