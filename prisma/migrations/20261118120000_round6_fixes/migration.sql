-- 2026-11-18 6차 점검 수정 (추가만 한다)

-- 활동 카테고리를 마지막으로 바꾼 시각 (스튜디오에서 바꿀 때 변경 간격 제한)
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "content_category_changed_at" TIMESTAMPTZ(3);

-- 채널 확인 시각: 최고관리자가 확인한 채널만 샵 영상 자동 수집·공개 링크에 쓴다
ALTER TABLE "creator_channel" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ(3);

-- 이미 승인(또는 정지)된 크리에이터의 채널은 가입 심사 때 확인된 것으로 본다
UPDATE "creator_channel" ch
SET "verified_at" = ch."created_at"
FROM "creator_profile" c
WHERE c."id" = ch."creator_id"
  AND ch."verified_at" IS NULL
  AND c."status" IN ('APPROVED', 'SUSPENDED');
