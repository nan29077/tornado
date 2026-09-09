-- 팬 관리용 크리에이터 비공개 메모.
--
-- 왜 필요한가
--   팬 관리 화면은 목록만 보여 주고, 크리에이터가 "이 팬은 매주 후원하는 단골" 같은
--   운영 메모를 남길 곳이 없었다. blocked_donor.reason 은 차단 사유 전용이라
--   차단하지 않은 팬에는 쓸 수 없다.
--
--   후원자에게는 어떤 경로로도 노출하지 않는 비공개 값이다(애플리케이션에서 200자 제한).
ALTER TABLE "donor_creator_link" ADD COLUMN IF NOT EXISTS "creator_memo" TEXT;
