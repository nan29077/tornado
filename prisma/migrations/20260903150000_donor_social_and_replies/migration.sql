CREATE TABLE "social_identity" (
  "id" TEXT PRIMARY KEY,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('kakao', 'naver')),
  "provider_user_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "app_user"("id") ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "social_identity_provider_provider_user_id_key" ON "social_identity"("provider", "provider_user_id");
CREATE INDEX "social_identity_user_id_idx" ON "social_identity"("user_id");
CREATE TABLE "donation_reply" (
  "id" TEXT PRIMARY KEY,
  "donation_id" TEXT NOT NULL REFERENCES "donation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "body" VARCHAR(1000) NOT NULL CHECK (char_length(trim("body")) > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "donation_reply_donation_id_key" ON "donation_reply"("donation_id");
