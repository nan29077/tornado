-- 크리에이터당 배정된 전용 MO 번호는 하나만 존재해야 한다.
--
-- 왜 필요한가
--   기존 부분 유니크 인덱스는 "번호"의 중복만 막는다.
--     - creator_mo_number_dedicated_uniq  : phone_number (keyword IS NULL)
--     - creator_mo_number_base_sub_uniq   : (base_number, sub_code)
--   그래서 한 크리에이터가 서로 다른 서브번호를 가진 ASSIGNED 행을 **두 개** 갖는 것은
--   아무것도 막지 못했다. 승인 액션의 상태 검사가 비원자적이라 관리자가 [승인]을 두 번
--   빠르게 누르면 실제로 두 번 발급됐다.
--
--   두 번호 모두 라우팅 자체는 같은 크리에이터로 정상 동작하므로 후원이 유실되지는 않는다.
--   대신 (1) 회선 비용이 매월 두 배로 나가고, (2) 스튜디오가 보여 주는 번호가
--   findFirst 정렬 없이 뽑혀 실행할 때마다 달라질 수 있으며, (3) 나중에 한쪽을 회수하면
--   그 번호를 안내받았던 후원자들의 문자가 조용히 끊긴다.

-- 1) 이미 생긴 중복을 정리한다. 가장 먼저 배정된 행 하나만 남기고 나머지는 회수 처리한다.
--    (가장 오래된 것을 남기는 이유: 그 번호가 이미 시청자에게 안내됐을 가능성이 가장 높다)
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "creator_id"
      ORDER BY "assigned_at" ASC NULLS LAST, "created_at" ASC
    ) AS rn
  FROM "creator_mo_number"
  WHERE "status" = 'ASSIGNED'
    AND "creator_id" IS NOT NULL
    AND "keyword" IS NULL
)
UPDATE "creator_mo_number" AS c
   SET "status"      = 'RECLAIMED',
       "creator_id"  = NULL,
       "released_at" = NOW(),
       "memo"        = '중복 발급 정리 — 크리에이터당 전용번호 1개 제약 도입'
  FROM ranked r
 WHERE c."id" = r."id"
   AND r.rn > 1;

-- 2) 앞으로는 DB 가 직접 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS "creator_mo_number_creator_assigned_uniq"
  ON "creator_mo_number" ("creator_id")
  WHERE "status" = 'ASSIGNED' AND "creator_id" IS NOT NULL AND "keyword" IS NULL;
