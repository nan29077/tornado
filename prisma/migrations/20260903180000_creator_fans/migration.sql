-- 크리에이터 팬 귀속.
--
-- 규칙
--   후원자는 (1) 그 크리에이터의 전용 MO 번호로 후원했거나
--            (2) 그 크리에이터의 후원 페이지로 로그인·가입했으면
--   그 크리에이터의 팬으로 귀속된다.
--
-- 왜 두 곳에 나눠 담는가
--   후원자 신원이 두 가지다. 문자후원은 **전화번호**(donor_profile)로 식별되고 회원가입이
--   필요 없다. 반대로 카카오·네이버로 가입한 사람은 **계정**(app_user)만 있고 휴대폰을
--   연결하기 전까지 donor_profile 이 없다.
--   그래서 번호가 있는 팬은 donor_creator_link 에, 아직 번호가 없는 팬은
--   app_user.signup_creator_id 에 담고, 팬 목록에서 둘을 합쳐 보여 준다.
--   번호를 연결하는 순간 donor_creator_link 로 승격된다.
ALTER TABLE "donor_creator_link"
  ADD COLUMN IF NOT EXISTS "joined_via" TEXT NOT NULL DEFAULT 'DONATION';

ALTER TABLE "app_user"
  ADD COLUMN IF NOT EXISTS "signup_creator_id" TEXT;

-- 크리에이터가 탈퇴·삭제되어도 후원자 계정은 남아야 한다(귀속만 풀린다).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_user_signup_creator_id_fkey'
  ) THEN
    ALTER TABLE "app_user"
      ADD CONSTRAINT "app_user_signup_creator_id_fkey"
      FOREIGN KEY ("signup_creator_id") REFERENCES "creator_profile"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "app_user_signup_creator_id_idx" ON "app_user" ("signup_creator_id");
