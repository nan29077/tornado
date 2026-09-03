-- MO 번호를 대표번호 + 서브번호로 분해해 보관한다.
--
-- 배경
--   번호 체계가 `1688-□□□□-XXXX` 로 확정됐다.
--     - 앞 8자리(1688 + 계약 시 확정되는 4자리)는 인포뱅크와 계약한 대표번호로 고정이다.
--     - 뒤 4자리(XXXX)는 인포뱅크 승인 없이 토네이도가 크리에이터에게 직접 부여한다.
--   EMMA 는 수신번호를 mo_recipient(대표번호) 와 emo_recipient(추가번호) 로 나눠 담으므로
--   우리 쪽도 같은 축으로 보관해야 조회·발급·회수를 다룰 수 있다.
--
-- 왜 phone_number 를 그대로 두는가
--   라우팅(routeCreator)은 수신번호 전체로 조회하고, 중복 방지 제약도 phone_number 에 걸려 있다.
--   컬럼을 갈아엎으면 그 경로를 전부 다시 검증해야 한다. 전체번호는 그대로 두고
--   조회·집계용 축만 덧붙인다. 두 값은 항상 phone_number = base_number || sub_code 를 만족한다.
ALTER TABLE "creator_mo_number" ADD COLUMN IF NOT EXISTS "base_number" TEXT;
ALTER TABLE "creator_mo_number" ADD COLUMN IF NOT EXISTS "sub_code" TEXT;

-- 대표번호별로 "이미 쓰고 있는 서브번호" 를 훑는 조회가 발급 때마다 일어난다.
CREATE INDEX IF NOT EXISTS "creator_mo_number_base_number_sub_code_idx"
  ON "creator_mo_number" ("base_number", "sub_code");

-- 기존 행 보정.
--   전용번호(keyword IS NULL) 는 전체번호에서 숫자만 남긴 뒤 뒤 4자리를 서브번호로 본다.
--   대표번호+키워드(SHARED_PREFIX) 방식은 번호를 나눠 쓰는 개념이 아니므로 건드리지 않는다.
UPDATE "creator_mo_number"
   SET "base_number" = LEFT(REGEXP_REPLACE("phone_number", '\D', '', 'g'),
                            GREATEST(LENGTH(REGEXP_REPLACE("phone_number", '\D', '', 'g')) - 4, 0)),
       "sub_code"    = RIGHT(REGEXP_REPLACE("phone_number", '\D', '', 'g'), 4)
 WHERE "keyword" IS NULL
   AND "base_number" IS NULL
   AND LENGTH(REGEXP_REPLACE("phone_number", '\D', '', 'g')) > 4;

-- 같은 대표번호 안에서 서브번호는 유일해야 한다.
--   이 제약이 없으면 채번 경쟁 상황에서 두 크리에이터가 같은 번호를 갖게 되고,
--   그 번호로 온 후원이 누구 것인지 판별할 수 없게 된다(라우팅 충돌).
--   전용번호(keyword IS NULL) 에만 적용한다. SHARED_PREFIX 는 번호를 공유하는 방식이라 무관하다.
CREATE UNIQUE INDEX IF NOT EXISTS "creator_mo_number_base_sub_uniq"
  ON "creator_mo_number" ("base_number", "sub_code")
  WHERE "keyword" IS NULL AND "base_number" IS NOT NULL AND "sub_code" IS NOT NULL;
