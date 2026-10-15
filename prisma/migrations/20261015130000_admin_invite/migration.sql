-- [SEC-A] 관리자 초대 (2026-10-15 3차 점검)
--
-- 예전에는 최고관리자가 이메일만 입력하면 그 이메일로 가입된 계정이 **즉시** 관리자로 승격됐다.
-- 공격자가 미리 비슷한(또는 오타가 난) 이메일로 가입해 두면 그대로 관리자 콘솔에 들어온다.
-- 이제는 초대 -> 1회용 링크 -> 초대받은 이메일 계정으로 로그인한 본인이 수락해야 승격된다.
--
-- 사용 규칙
--  - 토큰 원문은 저장하지 않는다(token_hash 만). 유효시간 72시간, 1회용(accepted_at).
--  - 회수(revoked_at)·만료된 초대는 수락할 수 없다.
--  - 이메일 발송은 연동 전이다. 링크는 최고관리자 화면에 표시되고 직접 전달한다(mock 명시).
--  - accepted_user_id / revoked_by_id 는 감사용 기록이라 FK 를 두지 않는다.

CREATE TABLE "admin_invite" (
  "id"               TEXT NOT NULL,
  "email"            TEXT NOT NULL,
  "permission"       "admin_permission" NOT NULL,
  "token_hash"       TEXT NOT NULL,
  "invited_by_id"    TEXT NOT NULL,
  "expires_at"       TIMESTAMPTZ(3) NOT NULL,
  "accepted_at"      TIMESTAMPTZ(3),
  "accepted_user_id" TEXT,
  "revoked_at"       TIMESTAMPTZ(3),
  "revoked_by_id"    TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_invite_token_hash_key" ON "admin_invite"("token_hash");
CREATE INDEX "admin_invite_email_idx" ON "admin_invite"("email");
CREATE INDEX "admin_invite_expires_at_idx" ON "admin_invite"("expires_at");

ALTER TABLE "admin_invite"
  ADD CONSTRAINT "admin_invite_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
