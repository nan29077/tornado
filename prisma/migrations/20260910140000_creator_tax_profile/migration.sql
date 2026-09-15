-- 크리에이터 세무 프로필 (최고관리자 세무관리 화면)
--
-- tax_type 기본값을 'INDIVIDUAL'(비사업자) 로 두는 이유:
-- 세무유형을 확인하지 못한 크리에이터에게 원천징수 없이 지급하면
-- 원천징수의무 불이행으로 도네이도가 가산세를 부담한다. 모르는 상태에서는 징수하는 쪽이 안전하다.

ALTER TABLE "creator_profile"
  ADD COLUMN "tax_type" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN "business_name" TEXT,
  ADD COLUMN "tax_invoice_email" TEXT,
  ADD COLUMN "tax_memo" TEXT,
  ADD COLUMN "tax_updated_at" TIMESTAMPTZ(3);

-- 이미 사업자등록번호가 들어 있는 크리에이터는 일반과세로 추정해 둔다.
-- (간이·면세 여부는 운영자가 세무관리 화면에서 정정한다)
UPDATE "creator_profile"
   SET "tax_type" = 'GENERAL'
 WHERE "business_no" IS NOT NULL
   AND btrim("business_no") <> '';

CREATE INDEX "creator_profile_tax_type_idx" ON "creator_profile"("tax_type");

-- 좌측 메뉴의 "미처리 이상거래" 배지가 모든 관리자 화면에서 resolved 만으로 센다.
-- 기존 (level, resolved) 복합 인덱스는 level 조건이 없으면 쓰이지 않아 전체 스캔이 된다.
CREATE INDEX "risk_detection_resolved_idx" ON "risk_detection"("resolved");
