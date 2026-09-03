-- 크리에이터 SNS 링크와 플랫폼별 라이브 스위치.
--
-- 배경
--   예전에는 라이브 플랫폼을 **하나만** 고를 수 있었다(live_platform 라디오 + live_on 체크박스).
--   실제로는 유튜브와 인스타에 동시송출하는 크리에이터가 있고, 후원 페이지에는 방송 여부와
--   무관하게 채널 링크를 걸어 두고 싶다는 요구가 있다. 그래서
--     - 링크는 플랫폼마다 하나씩 두고(후원 페이지에 링크 버튼으로 노출),
--     - "지금 방송 중" 을 플랫폼마다 따로 켤 수 있게 한다.
--
--   live_on / live_platform / live_url 은 없애지 않고 **파생값으로 계속 채운다.**
--   후원 페이지 외에도 이 세 컬럼을 읽는 곳이 생길 수 있어, 한쪽만 보고도 모순이 없게 유지한다.
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "facebook_live_url" TEXT;
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "youtube_live"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "instagram_live" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "tiktok_live"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "facebook_live"  BOOLEAN NOT NULL DEFAULT false;

-- 기존 상태 이관.
--   지금 방송 중으로 켜 둔 크리에이터는 그 플랫폼 스위치만 켜진 상태로 옮긴다.
--   live_platform 이 비어 있던 예전 데이터는 유튜브로 본다(그 시절 단일 필드는 유튜브 전용이었다).
UPDATE "creator_profile"
   SET "youtube_live" = true
 WHERE "live_on" = true AND COALESCE("live_platform", 'YOUTUBE') = 'YOUTUBE';

UPDATE "creator_profile"
   SET "instagram_live" = true
 WHERE "live_on" = true AND "live_platform" = 'INSTAGRAM';

UPDATE "creator_profile"
   SET "tiktok_live" = true
 WHERE "live_on" = true AND "live_platform" = 'TIKTOK';

-- 스위치를 켰는데 그 플랫폼 주소가 비어 있으면 배지가 갈 곳이 없다. 그런 행은 꺼 둔다.
UPDATE "creator_profile" SET "youtube_live"   = false WHERE "youtube_live"   = true AND COALESCE("youtube_live_url", '')   = '';
UPDATE "creator_profile" SET "instagram_live" = false WHERE "instagram_live" = true AND COALESCE("instagram_live_url", '') = '';
UPDATE "creator_profile" SET "tiktok_live"    = false WHERE "tiktok_live"    = true AND COALESCE("tiktok_live_url", '')    = '';
