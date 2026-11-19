-- 7차 전체 점검 수정 (2026-11-19). 추가만 한다.

-- P2-2: /api/media 가 팬챗 첨부 파일 권한을 확인할 때 주소로 메시지를 찾는다
CREATE INDEX IF NOT EXISTS "talk_message_media_url_idx" ON "talk_message"("media_url");
CREATE INDEX IF NOT EXISTS "talk_message_image_url_idx" ON "talk_message"("image_url");

-- P2-5: 수집기가 자동으로 숨긴 영상(비공개·퍼가기 금지·삭제)과 관리자가 숨긴 영상을 구분한다
ALTER TABLE "youtube_api_video" ADD COLUMN IF NOT EXISTS "auto_hidden" BOOLEAN NOT NULL DEFAULT false;
