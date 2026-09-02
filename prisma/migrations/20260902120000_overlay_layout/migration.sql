-- 오버레이 배치(위치 미세 조정 · 크기 배율)를 크리에이터가 직접 조절할 수 있게 한다.
-- 기존 크리에이터는 지금까지의 화면과 똑같이 보이도록 기본값(이동 0, 배율 100%)을 둔다.
ALTER TABLE "overlay_setting"
  ADD COLUMN IF NOT EXISTS "offset_x" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "offset_y" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scale_pct" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "game_offset_x" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "game_offset_y" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "game_scale_pct" INTEGER NOT NULL DEFAULT 100;
