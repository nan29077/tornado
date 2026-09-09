-- 감사 텍스트 등장 애니메이션 선택값.
-- 기존 크리에이터는 AUTO(금액 구간 레벨에 맞춰 자동)로 시작한다.
-- 구간을 쓰지 않으면 언제나 레벨 1(SLIDE_UP)이라 기존 동작과 크게 다르지 않다.
ALTER TABLE "overlay_setting"
  ADD COLUMN IF NOT EXISTS "text_anim" TEXT NOT NULL DEFAULT 'AUTO';
