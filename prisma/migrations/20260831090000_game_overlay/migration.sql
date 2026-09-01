-- ---------------------------------------------------------------------------
-- 방송 게임 (게임 오버레이)
--
-- game            게임 정의 (재사용). 회차를 반복해서 돌린다.
-- game_round      1회차. 방송 화면에 실제로 뜨는 단위.
-- game_participant 회차 참여자. 리셋해도 지우지 않는다(분쟁 대응).
-- game_winner     당첨자. 무형 보상 이름만 기록하며 금전 지급 수단이 아니다.
--
-- 결제·정산 원장과는 어떤 컬럼으로도 연결하지 않는다.
-- (후원 자동 참여의 donation_id 는 추적용 단순 컬럼이며 FK 를 걸지 않는다)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "game" (
  "id"                  TEXT NOT NULL,
  "creator_id"          TEXT NOT NULL,
  "type"                TEXT NOT NULL,
  "title"               TEXT NOT NULL,
  "items"               JSONB NOT NULL DEFAULT '[]',
  "config"              JSONB NOT NULL DEFAULT '{}',
  "entry_mode"          TEXT NOT NULL DEFAULT 'LINK',
  "donation_min_amount" BIGINT NOT NULL DEFAULT 0,
  "auto_close_sec"      INTEGER NOT NULL DEFAULT 0,
  "archived_at"         TIMESTAMPTZ(3),
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "game_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "game_round" (
  "id"          TEXT NOT NULL,
  "game_id"     TEXT NOT NULL,
  "creator_id"  TEXT NOT NULL,
  "seq"         INTEGER NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'OPEN',
  "join_code"   TEXT NOT NULL,
  "closes_at"   TIMESTAMPTZ(3),
  "result"      JSONB,
  "opened_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"   TIMESTAMPTZ(3),
  "revealed_at" TIMESTAMPTZ(3),
  "ended_at"    TIMESTAMPTZ(3),
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "game_round_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "game_participant" (
  "id"           TEXT NOT NULL,
  "round_id"     TEXT NOT NULL,
  "game_id"      TEXT NOT NULL,
  "creator_id"   TEXT NOT NULL,
  "donor_id"     TEXT,
  "donation_id"  TEXT,
  "display_name" TEXT NOT NULL,
  "entry"        TEXT,
  "source"       TEXT NOT NULL DEFAULT 'LINK',
  "entry_key"    TEXT NOT NULL,
  "amount"       BIGINT NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "game_participant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "game_winner" (
  "id"           TEXT NOT NULL,
  "round_id"     TEXT NOT NULL,
  "game_id"      TEXT NOT NULL,
  "creator_id"   TEXT NOT NULL,
  "rank"         INTEGER NOT NULL DEFAULT 1,
  "display_name" TEXT NOT NULL,
  "donor_id"     TEXT,
  "prize"        TEXT NOT NULL DEFAULT '',
  "fulfilled_at" TIMESTAMPTZ(3),
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "game_winner_pkey" PRIMARY KEY ("id")
);

-- 외래키 -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_creator_id_fkey') THEN
    ALTER TABLE "game" ADD CONSTRAINT "game_creator_id_fkey"
      FOREIGN KEY ("creator_id") REFERENCES "creator_profile" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_round_game_id_fkey') THEN
    ALTER TABLE "game_round" ADD CONSTRAINT "game_round_game_id_fkey"
      FOREIGN KEY ("game_id") REFERENCES "game" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_participant_round_id_fkey') THEN
    ALTER TABLE "game_participant" ADD CONSTRAINT "game_participant_round_id_fkey"
      FOREIGN KEY ("round_id") REFERENCES "game_round" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_participant_donor_id_fkey') THEN
    ALTER TABLE "game_participant" ADD CONSTRAINT "game_participant_donor_id_fkey"
      FOREIGN KEY ("donor_id") REFERENCES "donor_profile" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_winner_round_id_fkey') THEN
    ALTER TABLE "game_winner" ADD CONSTRAINT "game_winner_round_id_fkey"
      FOREIGN KEY ("round_id") REFERENCES "game_round" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 인덱스 -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "game_creator_id_created_at_idx" ON "game" ("creator_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "game_round_join_code_key" ON "game_round" ("join_code");
CREATE UNIQUE INDEX IF NOT EXISTS "game_round_game_id_seq_key" ON "game_round" ("game_id", "seq");
CREATE INDEX IF NOT EXISTS "game_round_creator_id_status_idx" ON "game_round" ("creator_id", "status");
CREATE INDEX IF NOT EXISTS "game_round_creator_id_opened_at_idx" ON "game_round" ("creator_id", "opened_at");

-- 같은 회차에 같은 사람이 두 번 들어오지 못하게 하는 마지막 방어선.
-- 응용 계층 검사만으로는 동시 요청을 막지 못한다.
CREATE UNIQUE INDEX IF NOT EXISTS "game_participant_round_id_entry_key_key"
  ON "game_participant" ("round_id", "entry_key");
CREATE INDEX IF NOT EXISTS "game_participant_round_id_created_at_idx"
  ON "game_participant" ("round_id", "created_at");
CREATE INDEX IF NOT EXISTS "game_participant_creator_id_created_at_idx"
  ON "game_participant" ("creator_id", "created_at");

CREATE INDEX IF NOT EXISTS "game_winner_round_id_idx" ON "game_winner" ("round_id");
CREATE INDEX IF NOT EXISTS "game_winner_creator_id_created_at_idx"
  ON "game_winner" ("creator_id", "created_at");
