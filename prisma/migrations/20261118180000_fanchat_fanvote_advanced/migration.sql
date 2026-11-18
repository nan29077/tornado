-- 2026-11-18 팬챗(버블형) · 팬투표 고도화 (추가만 한다)
-- 팬챗: 음성·영상, 답장 대상, 예약 발송, 하트, 팬레터, 묶음 구독, 팬챗방 닉네임·알림 끄기
-- 팬투표: 출석, 일일 미션, 친구 초대, 배지, 응원 댓글, 순위 보상(신문 광고 등), 서포트, 기념일

-- AlterTable
ALTER TABLE "vote_round" ADD COLUMN     "banner_url" TEXT,
ADD COLUMN     "daily_max_votes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "result_note" TEXT,
ADD COLUMN     "reward_text" TEXT;

-- AlterTable
ALTER TABLE "talk_subscription" ADD COLUMN     "bundle_order_id" TEXT,
ADD COLUMN     "bundle_payment_id" TEXT;

-- AlterTable
ALTER TABLE "talk_message" ADD COLUMN     "media_duration" INTEGER,
ADD COLUMN     "media_type" TEXT,
ADD COLUMN     "media_url" TEXT,
ADD COLUMN     "notified_at" TIMESTAMPTZ(3),
ADD COLUMN     "reply_to_id" TEXT,
ADD COLUMN     "scheduled_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "talk_read_state" ADD COLUMN     "muted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nickname" TEXT;

-- CreateTable
CREATE TABLE "talk_reaction" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_letter" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'CREAM',
    "title" TEXT,
    "body" TEXT NOT NULL,
    "hearted" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(3),
    "reply_body" TEXT,
    "replied_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_bundle_order" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_ids" TEXT[],
    "list_price" BIGINT NOT NULL,
    "discount_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "price" BIGINT NOT NULL,
    "method" TEXT NOT NULL,
    "payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_bundle_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fan_profile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "referral_code" TEXT NOT NULL,
    "featured_badge" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fan_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_attendance" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "day_key" TEXT NOT NULL,
    "streak" INTEGER NOT NULL,
    "tickets" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_mission_claim" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mission_key" TEXT NOT NULL,
    "day_key" TEXT NOT NULL,
    "tickets" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_mission_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_share_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_id" TEXT,
    "channel" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_share_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_referral" (
    "id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rewarded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fan_badge" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "badge_key" TEXT NOT NULL,
    "earned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fan_badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_cheer" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "round_id" TEXT,
    "body" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_cheer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_reward_policy" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "period_type" TEXT,
    "round_id" TEXT,
    "rank_from" INTEGER NOT NULL DEFAULT 1,
    "rank_to" INTEGER NOT NULL DEFAULT 1,
    "reward_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_reward_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_reward_grant" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT,
    "creator_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_label" TEXT NOT NULL,
    "rank" INTEGER,
    "reward_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "media_name" TEXT,
    "scheduled_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "proof_image_url" TEXT,
    "note" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_reward_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_support" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reward_type" TEXT NOT NULL,
    "banner_url" TEXT,
    "goal_tickets" INTEGER NOT NULL,
    "raised_tickets" INTEGER NOT NULL DEFAULT 0,
    "participant_count" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_support_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_support_contribution" (
    "id" TEXT NOT NULL,
    "support_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tickets" INTEGER NOT NULL,
    "from_free" INTEGER NOT NULL DEFAULT 0,
    "from_paid" INTEGER NOT NULL DEFAULT 0,
    "from_bonus" INTEGER NOT NULL DEFAULT 0,
    "paid_value" BIGINT NOT NULL DEFAULT 0,
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_support_contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_anniversary" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "year" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_anniversary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "talk_reaction_creator_id_created_at_idx" ON "talk_reaction"("creator_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "talk_reaction_message_id_user_id_key" ON "talk_reaction"("message_id", "user_id");

-- CreateIndex
CREATE INDEX "talk_letter_creator_id_created_at_idx" ON "talk_letter"("creator_id", "created_at");

-- CreateIndex
CREATE INDEX "talk_letter_user_id_created_at_idx" ON "talk_letter"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "talk_bundle_order_order_no_key" ON "talk_bundle_order"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "talk_bundle_order_payment_id_key" ON "talk_bundle_order"("payment_id");

-- CreateIndex
CREATE INDEX "talk_bundle_order_user_id_created_at_idx" ON "talk_bundle_order"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fan_profile_user_id_key" ON "fan_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "fan_profile_referral_code_key" ON "fan_profile"("referral_code");

-- CreateIndex
CREATE INDEX "vote_attendance_user_id_created_at_idx" ON "vote_attendance"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vote_attendance_user_id_day_key_key" ON "vote_attendance"("user_id", "day_key");

-- CreateIndex
CREATE INDEX "vote_mission_claim_user_id_created_at_idx" ON "vote_mission_claim"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vote_mission_claim_user_id_mission_key_day_key_key" ON "vote_mission_claim"("user_id", "mission_key", "day_key");

-- CreateIndex
CREATE INDEX "vote_share_log_user_id_created_at_idx" ON "vote_share_log"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vote_referral_invitee_id_key" ON "vote_referral"("invitee_id");

-- CreateIndex
CREATE INDEX "vote_referral_inviter_id_created_at_idx" ON "vote_referral"("inviter_id", "created_at");

-- CreateIndex
CREATE INDEX "fan_badge_user_id_idx" ON "fan_badge"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "fan_badge_user_id_badge_key_key" ON "fan_badge"("user_id", "badge_key");

-- CreateIndex
CREATE INDEX "vote_cheer_creator_id_created_at_idx" ON "vote_cheer"("creator_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_cheer_round_id_created_at_idx" ON "vote_cheer"("round_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_cheer_user_id_created_at_idx" ON "vote_cheer"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_reward_policy_scope_active_idx" ON "vote_reward_policy"("scope", "active");

-- CreateIndex
CREATE INDEX "vote_reward_grant_status_created_at_idx" ON "vote_reward_grant"("status", "created_at");

-- CreateIndex
CREATE INDEX "vote_reward_grant_creator_id_created_at_idx" ON "vote_reward_grant"("creator_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vote_reward_grant_source_type_source_key_creator_id_reward__key" ON "vote_reward_grant"("source_type", "source_key", "creator_id", "reward_type");

-- CreateIndex
CREATE INDEX "vote_support_status_ends_at_idx" ON "vote_support"("status", "ends_at");

-- CreateIndex
CREATE INDEX "vote_support_creator_id_created_at_idx" ON "vote_support"("creator_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_support_contribution_support_id_created_at_idx" ON "vote_support_contribution"("support_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_support_contribution_user_id_created_at_idx" ON "vote_support_contribution"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "creator_anniversary_month_day_idx" ON "creator_anniversary"("month", "day");

-- CreateIndex
CREATE UNIQUE INDEX "creator_anniversary_creator_id_kind_month_day_key" ON "creator_anniversary"("creator_id", "kind", "month", "day");

-- CreateIndex
CREATE INDEX "talk_subscription_bundle_order_id_idx" ON "talk_subscription"("bundle_order_id");

-- CreateIndex
CREATE INDEX "talk_message_reply_to_id_idx" ON "talk_message"("reply_to_id");


-- 마지막 방어선: 수량이 음수가 되지 않게
ALTER TABLE "vote_support" ADD CONSTRAINT "vote_support_raised_nonneg" CHECK ("raised_tickets" >= 0 AND "goal_tickets" > 0);
ALTER TABLE "vote_support_contribution" ADD CONSTRAINT "vote_support_contribution_positive" CHECK ("tickets" > 0);
ALTER TABLE "vote_attendance" ADD CONSTRAINT "vote_attendance_tickets_nonneg" CHECK ("tickets" >= 0 AND "streak" >= 1);
ALTER TABLE "creator_anniversary" ADD CONSTRAINT "creator_anniversary_date_range" CHECK ("month" BETWEEN 1 AND 12 AND "day" BETWEEN 1 AND 31);

-- 팬챗방은 버블형이 기본이다 (2026-11-18 결정). 이미 저장된 설정도 버블형으로 바꾼다.
UPDATE "system_setting"
SET "value" = jsonb_set("value"::jsonb, '{roomMode}', '"BUBBLE"', true)
WHERE "key" = 'talk.config' AND jsonb_typeof("value") = 'object';

-- 이미 있던 팬챗 메시지는 알림을 보낸 것으로 본다 (새 알림 발송기가 옛 메시지로 알림을 다시 보내지 않게)
UPDATE "talk_message" SET "notified_at" = "created_at" WHERE "notified_at" IS NULL;
