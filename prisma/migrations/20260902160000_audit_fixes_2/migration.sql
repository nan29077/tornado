-- 2026-09-02 전체 검수 조치
--
-- 이 마이그레이션은 "코드로는 막을 수 없는 것"만 DB 에 넣는다.
--  1) 게임 참여 네트워크 지문 (회차당 참여 상한)
--  2) 게임 결과 재발표 횟수 (조작 시비 대응 기록)
--  3) 크리에이터당 화면에 뜬 회차는 하나 (부분 유니크)
--  4) 유튜브 전송 기록은 후원 1건당 1행 (재시도 도입 시 중복 전송 차단)
--  5) 정산 원장의 후원 분개는 후원 1건당 종류별 1행 (동시 승인 시 3분개 중복 차단)
--  6) 후원자 프로필의 번호 재사용 대응 컬럼
--
-- 순서에 의존하는 DROP 문은 넣지 않는다.

-- ---------------------------------------------------------------- 1) 게임 참여
ALTER TABLE "game_participant" ADD COLUMN IF NOT EXISTS "net_hash" TEXT;
CREATE INDEX IF NOT EXISTS "game_participant_round_id_net_hash_idx"
  ON "game_participant" ("round_id", "net_hash");

-- ---------------------------------------------------------------- 2) 재발표 기록
ALTER TABLE "game_round" ADD COLUMN IF NOT EXISTS "reveal_count" INTEGER NOT NULL DEFAULT 0;

-- 3) 크리에이터당 진행 중인 회차는 하나만.
--    스튜디오 창과 팝아웃 컨트롤에서 동시에 [방송에 시작]을 눌러도 회차가 둘 생기지 않는다.
--    (기존 데이터에 중복이 있으면 오래된 쪽을 먼저 종료 처리한 뒤 인덱스를 만든다)
UPDATE "game_round" r
   SET "status" = 'ENDED', "ended_at" = COALESCE("ended_at", NOW())
 WHERE r."status" IN ('OPEN', 'CLOSED', 'RESULT')
   AND EXISTS (
     SELECT 1 FROM "game_round" o
      WHERE o."creator_id" = r."creator_id"
        AND o."status" IN ('OPEN', 'CLOSED', 'RESULT')
        AND (o."opened_at" > r."opened_at" OR (o."opened_at" = r."opened_at" AND o."id" > r."id"))
   );

CREATE UNIQUE INDEX IF NOT EXISTS "game_round_active_uniq"
  ON "game_round" ("creator_id") WHERE "status" IN ('OPEN', 'CLOSED', 'RESULT');

-- ---------------------------------------------------------------- 4) 유튜브 전송
-- 후원 1건당 전송 기록 1행. 중복이 있으면 가장 최근 행만 남긴다.
DELETE FROM "youtube_chat_delivery" d
 WHERE EXISTS (
   SELECT 1 FROM "youtube_chat_delivery" o
    WHERE o."donation_id" = d."donation_id"
      AND (o."created_at" > d."created_at" OR (o."created_at" = d."created_at" AND o."id" > d."id"))
 );

DROP INDEX IF EXISTS "youtube_chat_delivery_donation_id_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "youtube_chat_delivery_donation_id_key"
  ON "youtube_chat_delivery" ("donation_id");

-- ---------------------------------------------------------------- 5) 정산 원장
-- 결제 승인 1건 = DONATION_GROSS / PG_FEE / PLATFORM_FEE 각 1행.
-- 동시 승인 처리로 같은 분개가 두 번 들어가면 원장은 append-only 라 되돌릴 수 없다.
-- (환불·정산 분개는 여러 번 생길 수 있으므로 이 세 종류만 제한한다)
-- 원장은 append-only 라 중복을 지울 수 없다. 이미 중복이 있으면 인덱스를 만들지 않고
-- 경고만 남긴다(마이그레이션 자체가 실패해 배포가 막히는 쪽이 더 위험하다).
-- 중복이 있다면 반대분개로 정정한 뒤 이 인덱스를 수동으로 만들면 된다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "settlement_ledger"
     WHERE "donation_id" IS NOT NULL
       AND "entry_type"::text IN ('DONATION_GROSS', 'PG_FEE', 'PLATFORM_FEE')
     GROUP BY "donation_id", "entry_type"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[audit_fixes_2] settlement_ledger 에 중복 분개가 있어 settlement_ledger_donation_entry_uniq 인덱스를 만들지 않았습니다. 반대분개로 정정한 뒤 수동으로 생성하십시오.';
  ELSE
    -- 인덱스 조건식(predicate)에는 IMMUTABLE 함수만 쓸 수 있다.
    -- enum -> text 캐스트는 STABLE 이라 `"entry_type"::text IN (...)` 로 쓰면
    -- "functions in index predicate must be marked IMMUTABLE" 로 거절당한다.
    -- enum 리터럴로 직접 비교하면 캐스트가 사라진다.
    CREATE UNIQUE INDEX IF NOT EXISTS "settlement_ledger_donation_entry_uniq"
      ON "settlement_ledger" ("donation_id", "entry_type")
      WHERE "donation_id" IS NOT NULL
        AND "entry_type" IN (
          'DONATION_GROSS'::"ledger_entry_type",
          'PG_FEE'::"ledger_entry_type",
          'PLATFORM_FEE'::"ledger_entry_type"
        );
  END IF;
END $$;

-- ---------------------------------------------------------------- 6) 후원자 프로필
ALTER TABLE "donor_profile" ADD COLUMN IF NOT EXISTS "previous_user_id" TEXT;
ALTER TABLE "donor_profile" ADD COLUMN IF NOT EXISTS "unlinked_at" TIMESTAMPTZ(3);
ALTER TABLE "donor_profile" ADD COLUMN IF NOT EXISTS "retired_at" TIMESTAMPTZ(3);
