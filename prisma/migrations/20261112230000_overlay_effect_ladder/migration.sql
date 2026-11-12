-- 금액별 후원 연출 차등 (2026-11-12)
--
-- 1) 크리에이터별 연출 방식(AUTO/CUSTOM/OFF) · 연속 후원 단계 상승 · 가벼운 효과 모드
-- 2) 금액 구간별 연출 단계(1~5) 직접 지정
--
-- 기존 크리에이터의 방송 화면이 바뀌지 않도록 옮긴다.
--   - 금액 구간을 만들어 둔 크리에이터 → CUSTOM (지금처럼 자기 구간을 따른다)
--   - 구간이 없는 크리에이터           → OFF    (지금처럼 전역 설정 하나로 재생한다)
--   - 연속 후원 단계 상승은 새 기능이므로 기존 크리에이터는 꺼 둔다(스튜디오에서 켤 수 있다)
-- 이 마이그레이션 뒤에 만들어지는 크리에이터는 컬럼 기본값(AUTO · 상승 켬)을 받는다.
ALTER TABLE "creator_profile"
  ADD COLUMN IF NOT EXISTS "overlay_tier_mode" TEXT NOT NULL DEFAULT 'AUTO',
  ADD COLUMN IF NOT EXISTS "overlay_combo_boost" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "overlay_light_effects" BOOLEAN NOT NULL DEFAULT false;

UPDATE "creator_profile" AS c
SET "overlay_tier_mode" = CASE
      WHEN EXISTS (SELECT 1 FROM "overlay_tier" t WHERE t."creator_id" = c."id") THEN 'CUSTOM'
      ELSE 'OFF'
    END,
    "overlay_combo_boost" = false;

ALTER TABLE "overlay_tier"
  ADD COLUMN IF NOT EXISTS "intensity" INTEGER;
