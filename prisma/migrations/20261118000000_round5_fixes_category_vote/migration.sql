-- 2026-11-18 5차 점검 수정 + 카테고리별 투표 (추가만 한다)

-- 샵 결제: 어떤 후원에 대한 결제인지, 어떤 크리에이터에게 가는 결제인지 기록 (샵 후원 환불·한도 집계)
ALTER TABLE "shop_payment" ADD COLUMN IF NOT EXISTS "donation_id" TEXT;
ALTER TABLE "shop_payment" ADD COLUMN IF NOT EXISTS "creator_id" TEXT;
-- 결제사 취소가 실패해 다시 시도해야 하는 금액과 사유 (관리자 재시도 대상)
ALTER TABLE "shop_payment" ADD COLUMN IF NOT EXISTS "cancel_pending_amount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "shop_payment" ADD COLUMN IF NOT EXISTS "cancel_pending_reason" TEXT;

CREATE INDEX IF NOT EXISTS "shop_payment_donation_id_idx" ON "shop_payment" ("donation_id");
CREATE INDEX IF NOT EXISTS "shop_payment_creator_id_created_at_idx" ON "shop_payment" ("creator_id", "created_at");
CREATE INDEX IF NOT EXISTS "shop_payment_status_created_at_idx" ON "shop_payment" ("status", "created_at");

-- 기존 영상·카드 후원 결제에 후원 ID 를 채운다 (상태 이력 사유에 결제번호가 남아 있다)
UPDATE "shop_payment" sp
SET "donation_id" = l."donation_id",
    "creator_id" = d."creator_id"
FROM "donation_status_log" l
JOIN "donation" d ON d."id" = l."donation_id"
WHERE sp."donation_id" IS NULL
  AND sp."kind" IN ('VIDEO_DONATION', 'CARD_DONATION')
  AND l."to_status" = 'PAYMENT_SUCCESS'
  AND d."channel" = 'SHOP'
  AND position(sp."payment_no" in coalesce(l."reason", '')) > 0;

-- 카테고리별 랭킹 조회용
CREATE INDEX IF NOT EXISTS "creator_profile_content_category_idx" ON "creator_profile" ("content_category");
