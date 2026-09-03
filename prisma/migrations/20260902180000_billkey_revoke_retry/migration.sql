-- 빌키(자동출금) 해지 실패 재시도.
--
-- 배경
--   자동출금 동의를 해지하면 내부 상태만 REVOKED 로 바뀌고, 사업자(PG) 해지 호출이
--   실패해도 로그만 남았다. 후원자는 해지했다고 알고 있는데 **PG 쪽 빌키는 살아 있다.**
--   재시도 큐도, 관리자 알림도, 실패한 건을 찾을 방법도 없었다.
--
-- 조치
--   실패 사실을 행에 남겨 배치가 다시 시도하게 하고, 상한을 넘으면 관리자에게 올린다.
--   해지가 확정되면 revoke_failed_at 을 비우고 빌키 암호문도 함께 지운다.
ALTER TABLE "payment_method_token" ADD COLUMN IF NOT EXISTS "revoke_failed_at" TIMESTAMPTZ(3);
ALTER TABLE "payment_method_token" ADD COLUMN IF NOT EXISTS "revoke_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_method_token" ADD COLUMN IF NOT EXISTS "revoke_last_error" TEXT;

CREATE INDEX IF NOT EXISTS "payment_method_token_revoke_failed_at_idx"
  ON "payment_method_token" ("revoke_failed_at");
