-- 후원 오버레이와 게임 오버레이를 서로 독립적으로 켜고 끌 수 있게 한다.
-- 기존 크리에이터는 지금까지의 동작을 유지하도록 기본값을 true 로 둔다.
ALTER TABLE "overlay_setting"
  ADD COLUMN IF NOT EXISTS "game_enabled" BOOLEAN NOT NULL DEFAULT true;
