-- 계정 기반 팬(휴대폰 미연결).
--
-- 왜 필요한가
--   팬 소속은 크리에이터마다 따로 생긴다. 한 사람이 A 페이지로 가입하고 B 페이지에도
--   로그인하면 A 와 B 모두의 팬이다. 그런데 donor_creator_link 는 전화번호(donor_profile)를
--   요구해서, 번호를 연결하지 않은 계정은 담을 수 없었다.
--   앞선 마이그레이션에서는 app_user.signup_creator_id 하나로 대신했는데, 그 컬럼은 계정당
--   하나뿐이라 **두 번째 크리에이터의 팬 목록에는 나타나지 않는 문제**가 있었다.
--
--   signup_creator_id 는 그대로 둔다. 그 값의 뜻은 "이 계정을 처음 데려온 크리에이터"
--   (유입 실적)로 좁히고, 팬 목록은 이 표를 본다.
CREATE TABLE IF NOT EXISTS "creator_fan_account" (
  "id"         TEXT NOT NULL,
  "creator_id" TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_fan_account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "creator_fan_account_creator_id_user_id_key"
  ON "creator_fan_account" ("creator_id", "user_id");
CREATE INDEX IF NOT EXISTS "creator_fan_account_user_id_idx"
  ON "creator_fan_account" ("user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_fan_account_creator_id_fkey') THEN
    ALTER TABLE "creator_fan_account" ADD CONSTRAINT "creator_fan_account_creator_id_fkey"
      FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_fan_account_user_id_fkey') THEN
    ALTER TABLE "creator_fan_account" ADD CONSTRAINT "creator_fan_account_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 기존에 signup_creator_id 로만 표시되던 팬을 이 표로 옮긴다(번호 미연결 계정만).
INSERT INTO "creator_fan_account" ("id", "creator_id", "user_id", "created_at")
SELECT
  'cfa_' || substr(md5(u."id" || ':' || u."signup_creator_id"), 1, 22),
  u."signup_creator_id",
  u."id",
  u."created_at"
FROM "app_user" u
LEFT JOIN "donor_profile" d ON d."user_id" = u."id"
WHERE u."signup_creator_id" IS NOT NULL
  AND d."id" IS NULL
  AND u."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
