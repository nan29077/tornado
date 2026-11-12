-- 기존 기본 캐릭터 5종을 그대로 사용하던 기준에 새 원화를 배정한다.
-- 시작 금액, 표시 시간, 연속 후원 규칙은 저장된 값을 유지한다.
UPDATE "system_setting"
SET "value" = jsonb_set("value", '{levels}', (
  SELECT jsonb_agg(level.spec || jsonb_build_object('effect', art.effect) ORDER BY level.position)
  FROM jsonb_array_elements("value" -> 'levels') WITH ORDINALITY AS level(spec, position)
  JOIN (VALUES
    (1, 'DONAIDO_WAVE'),
    (2, 'DONAIDO_STARLIGHT'),
    (3, 'DONAIDO_HEARTBURST'),
    (4, 'DONAIDO_FESTIVAL'),
    (5, 'DONAIDO_ROYAL_TORNADO')
  ) AS art(position, effect) USING (position)
))
WHERE "key" = 'overlay.ladder'
  AND jsonb_typeof("value" -> 'levels') = 'array'
  AND "value" #> '{levels,5}' IS NULL
  AND "value" #>> '{levels,0,effect}' = 'DONAIDO_HEART_PEEK'
  AND "value" #>> '{levels,1,effect}' = 'DONAIDO_THANKS_BOW'
  AND "value" #>> '{levels,2,effect}' = 'DONAIDO_GIFT_POP'
  AND "value" #>> '{levels,3,effect}' = 'DONAIDO_FRIENDS'
  AND "value" #>> '{levels,4,effect}' = 'DONAIDO_CROWN_CEREMONY';
