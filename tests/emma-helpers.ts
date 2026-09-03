/**
 * EMMA 연동 테스트용 보조 함수.
 *
 * 실제 EMMA 데몬 없이 **EMMA 가 만드는 것과 같은 테이블**을 만들어 두고, 그 테이블에 수신 행을
 * 넣어 폴러를 돌린다. DDL 은 인포뱅크가 배포한 `emma_sp_smo.sql` / `emma_sp_smt.sql` 의
 * CREATE TABLE 문을 그대로 옮긴 것이다. 컬럼 하나라도 다르면 실제 연동에서 어긋나므로
 * 임의로 고치지 않는다.
 */

import { prisma } from '@/server/db';
import { moTableSuffix } from '@/server/emma';

/** EMMA 가 MO 를 기록하는 테이블. 실제 DDL 과 컬럼·타입·기본값이 같아야 한다. */
export async function createEmmaMoTable(suffix = moTableSuffix()) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS em_mo_log_${suffix} (
      mo_key        VARCHAR(50)  NOT NULL,
      service_type  CHAR(2)      NOT NULL,
      mo_recipient  VARCHAR(32)  NOT NULL,
      emo_recipient VARCHAR(80),
      mo_originator VARCHAR(32)  NOT NULL,
      mo_callback   VARCHAR(32)  NOT NULL,
      msg_status    CHAR(1)      NOT NULL DEFAULT '3',
      subject       VARCHAR(40),
      content       VARCHAR(4000),
      date_mo       TIMESTAMP    NOT NULL,
      date_mo_recv  TIMESTAMP    NOT NULL DEFAULT now(),
      carrier       NUMERIC(5),
      rs_id         VARCHAR(20),
      ems_id        NUMERIC(3),
      ems_total     NUMERIC(1),
      ems_seq       NUMERIC(1),
      emma_id       CHAR(2)      DEFAULT ' ',
      CONSTRAINT pk_em_mo_log_${suffix} PRIMARY KEY (mo_key)
    )
  `);
}

/** EMMA 가 픽업해 발송하는 큐 테이블 + 시퀀스. */
export async function createEmmaMtTable() {
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS sq_em_smt_tran_01 INCREMENT BY 1 START WITH 1`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS em_smt_tran (
      mt_pr            NUMERIC(11)  NOT NULL,
      msg_key          VARCHAR(20),
      input_type       CHAR(1)      NOT NULL DEFAULT '0',
      mt_refkey        VARCHAR(20),
      priority         CHAR(2)      NOT NULL DEFAULT 'S',
      date_client_req  TIMESTAMP    NOT NULL,
      content          VARCHAR(4000) NOT NULL,
      callback         VARCHAR(25)  NOT NULL,
      service_type     CHAR(2)      NOT NULL,
      broadcast_yn     CHAR(1)      NOT NULL DEFAULT 'N',
      msg_status       CHAR(1)      NOT NULL DEFAULT '1',
      recipient_num    VARCHAR(25),
      country_code     VARCHAR(8)   NOT NULL DEFAULT '82',
      emma_id          CHAR(2)      DEFAULT ' ',
      reg_date         TIMESTAMP    DEFAULT NOW(),
      CONSTRAINT pk_em_smt_tran PRIMARY KEY (mt_pr)
    )
  `);
}

export async function createEmmaTables(suffix = moTableSuffix()) {
  await createEmmaMoTable(suffix);
  await createEmmaMtTable();
}

/** 테스트 사이에 EMMA 테이블을 비운다. */
export async function clearEmmaTables(suffix = moTableSuffix()) {
  await prisma.$executeRawUnsafe(`DELETE FROM em_mo_log_${suffix}`).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM em_smt_tran`).catch(() => undefined);
}

let moSeq = 0;

export interface FakeMoInput {
  /** mo_recipient. 보통 대표번호 8자리 */
  moRecipient: string;
  /** emo_recipient. 보통 서브번호 4자리 */
  emoRecipient?: string | null;
  from?: string;
  content?: string;
  moKey?: string;
  /** '4'=SMS MO, '5'=MMS MO */
  serviceType?: string;
  status?: string;
  dateMo?: Date;
  /** date_mo_recv 를 과거로 밀어 '중단된 건 복구' 경로를 만든다. */
  receivedAgoSec?: number;
  suffix?: string;
}

/** EMMA 가 넣은 것과 같은 모양의 수신 행을 만든다. */
export async function insertFakeMo(input: FakeMoInput): Promise<string> {
  moSeq += 1;
  const suffix = input.suffix ?? moTableSuffix();
  const moKey = input.moKey ?? `EMMA-TEST-${Date.now()}-${moSeq}`;
  const dateMo = input.dateMo ?? new Date();
  const agoSec = input.receivedAgoSec ?? 0;

  await prisma.$executeRawUnsafe(
    `INSERT INTO em_mo_log_${suffix}
       (mo_key, service_type, mo_recipient, emo_recipient, mo_originator, mo_callback,
        msg_status, content, date_mo, date_mo_recv, carrier, emma_id)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, NOW() - MAKE_INTERVAL(secs => $9), 10001, ' ')`,
    moKey,
    input.serviceType ?? '4',
    input.moRecipient,
    input.emoRecipient ?? null,
    input.from ?? '01012345678',
    input.status ?? '3',
    input.content ?? '응원합니다',
    dateMo,
    agoSec,
  );
  return moKey;
}

/** 특정 수신 행의 현재 상태값을 읽는다. */
export async function readMoStatus(moKey: string, suffix = moTableSuffix()): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ msg_status: string }>>(
    `SELECT msg_status FROM em_mo_log_${suffix} WHERE mo_key = $1`,
    moKey,
  );
  return rows[0]?.msg_status?.trim() ?? null;
}

/** EMMA 발송 큐에 쌓인 문자 목록. */
export async function readMtQueue(): Promise<
  Array<{ mt_pr: string; recipient_num: string; callback: string; content: string; msg_status: string; emma_id: string | null }>
> {
  return prisma.$queryRawUnsafe(
    `SELECT mt_pr::text AS mt_pr, recipient_num, callback, content, msg_status, emma_id
       FROM em_smt_tran ORDER BY mt_pr ASC`,
  );
}
