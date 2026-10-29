-- [P2-8] 이체파일 재발급 시각 (2026-10-29 4차 점검)
--
-- 이체파일을 재발급해도 최초 발급 시각(payout_issued_at)만 남아, 재발급 파일로 이체한 건의
-- 지급일(paid_at)이 최초 발급일로 기록됐다. 월을 넘겨 재발급하면 원천징수 귀속월이 틀어진다.
-- 최초 발급 시각은 이중이체 추적용으로 그대로 두고, 마지막 재발급 시각을 따로 남긴다.
ALTER TABLE "settlement_request"
  ADD COLUMN IF NOT EXISTS "payout_reissued_at" TIMESTAMPTZ(3);
