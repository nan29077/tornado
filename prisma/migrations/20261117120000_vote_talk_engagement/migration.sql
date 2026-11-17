-- 크리에이터 투표·랭킹 / 투표권 충전(오퍼월·결제) / 소통 채팅(월 구독) / 1:1 예약 채팅 (2026-11-17)
--
-- 전부 "추가"만 한다. 기존 테이블의 컬럼 변경·삭제는 없다.
--  - ledger_entry_type: VOTE_REVENUE_SHARE / TALK_SUBSCRIPTION_PROCEEDS / TALK_SESSION_PROCEEDS 값 추가
--    (같은 트랜잭션 안에서 새 값을 쓰지 않는다)
--  - shop_payment: method(nullable) 추가. 기존 행은 null
--  - 새 테이블: creator_engagement_policy, vote_*, offerwall_reward, talk_*
--  - 투표권 묶음 잔량은 음수가 될 수 없고 지급량을 넘을 수 없다 (동시 투표 초과 사용을 DB 에서 막는 마지막 방어선)
--  - 1:1 예약: 같은 크리에이터·같은 시작 시각에 살아 있는 예약은 하나뿐 (부분 유니크 인덱스)

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ledger_entry_type" ADD VALUE 'VOTE_REVENUE_SHARE';
ALTER TYPE "ledger_entry_type" ADD VALUE 'TALK_SUBSCRIPTION_PROCEEDS';
ALTER TYPE "ledger_entry_type" ADD VALUE 'TALK_SESSION_PROCEEDS';

-- AlterTable
ALTER TABLE "shop_payment" ADD COLUMN     "method" TEXT;

-- CreateTable
CREATE TABLE "creator_engagement_policy" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "vote_share_rate" DECIMAL(10,6),
    "talk_sub_fee_rate" DECIMAL(10,6),
    "talk_sub_price_mode" TEXT,
    "talk_sub_price" BIGINT,
    "talk_sub_price_min" BIGINT,
    "talk_sub_price_max" BIGINT,
    "session_fee_rate" DECIMAL(10,6),
    "session_price_mode" TEXT,
    "session_price" BIGINT,
    "session_price_min" BIGINT,
    "session_price_max" BIGINT,
    "session_allowed" BOOLEAN,
    "memo" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creator_engagement_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_ticket_lot" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "value_won" BIGINT NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "ref_id" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_ticket_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_ticket_ledger" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "lot_id" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_ticket_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_ticket_product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "tickets" INTEGER NOT NULL,
    "bonus" INTEGER NOT NULL DEFAULT 0,
    "badge" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_ticket_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_ticket_order" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT,
    "product_name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "tickets" INTEGER NOT NULL,
    "bonus" INTEGER NOT NULL DEFAULT 0,
    "payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "paid_lot_id" TEXT,
    "bonus_lot_id" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "refund_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_ticket_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offerwall_reward" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reward_key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign" TEXT,
    "points" INTEGER NOT NULL,
    "tickets" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GRANTED',
    "reason" TEXT,
    "lot_id" TEXT,
    "payload_masked" JSONB,
    "ip" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offerwall_reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_round" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_round_candidate" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vote_round_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_cast" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "round_id" TEXT,
    "votes" INTEGER NOT NULL,
    "tickets" INTEGER NOT NULL,
    "from_free" INTEGER NOT NULL DEFAULT 0,
    "from_paid" INTEGER NOT NULL DEFAULT 0,
    "from_bonus" INTEGER NOT NULL DEFAULT 0,
    "paid_value" BIGINT NOT NULL DEFAULT 0,
    "share_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "share_amount" BIGINT NOT NULL DEFAULT 0,
    "ip_hash" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "voided_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_cast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_tally" (
    "id" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "votes" BIGINT NOT NULL DEFAULT 0,
    "last_vote_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_tally_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_period_result" (
    "id" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "votes" BIGINT NOT NULL,
    "finalized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_period_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_room" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT false,
    "welcome_message" TEXT,
    "fan_title" TEXT,
    "sub_price" BIGINT,
    "session_enabled" BOOLEAN NOT NULL DEFAULT false,
    "session_price" BIGINT,
    "session_minutes" INTEGER NOT NULL DEFAULT 20,
    "session_blocked_dates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "creator_last_read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "talk_room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_subscription" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "price" BIGINT NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "fee_amount" BIGINT NOT NULL DEFAULT 0,
    "net_amount" BIGINT NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL,
    "payment_id" TEXT,
    "refund_amount" BIGINT NOT NULL DEFAULT 0,
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_message" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fan_user_id" TEXT,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "hearted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_read_state" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "last_read_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "talk_read_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_block" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_report" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "reporter_user_id" TEXT NOT NULL,
    "reporter_role" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "handled_by" TEXT,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_slot_rule" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_slot_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_session" (
    "id" TEXT NOT NULL,
    "session_no" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "price" BIGINT NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "fee_amount" BIGINT NOT NULL DEFAULT 0,
    "net_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "request_note" TEXT,
    "method" TEXT NOT NULL,
    "payment_id" TEXT,
    "approval_deadline" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "refund_amount" BIGINT NOT NULL DEFAULT 0,
    "refunded_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "talk_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talk_session_message" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talk_session_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creator_engagement_policy_creator_id_key" ON "creator_engagement_policy"("creator_id");

-- CreateIndex
CREATE INDEX "vote_ticket_lot_user_id_bucket_idx" ON "vote_ticket_lot"("user_id", "bucket");

-- CreateIndex
CREATE INDEX "vote_ticket_lot_expires_at_idx" ON "vote_ticket_lot"("expires_at");

-- CreateIndex
CREATE INDEX "vote_ticket_ledger_user_id_created_at_idx" ON "vote_ticket_ledger"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_ticket_ledger_type_created_at_idx" ON "vote_ticket_ledger"("type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vote_ticket_order_order_no_key" ON "vote_ticket_order"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "vote_ticket_order_payment_id_key" ON "vote_ticket_order"("payment_id");

-- CreateIndex
CREATE INDEX "vote_ticket_order_user_id_created_at_idx" ON "vote_ticket_order"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_ticket_order_status_created_at_idx" ON "vote_ticket_order"("status", "created_at");

-- CreateIndex
CREATE INDEX "offerwall_reward_user_id_created_at_idx" ON "offerwall_reward"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "offerwall_reward_created_at_idx" ON "offerwall_reward"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "offerwall_reward_provider_reward_key_key" ON "offerwall_reward"("provider", "reward_key");

-- CreateIndex
CREATE INDEX "vote_round_status_starts_at_idx" ON "vote_round"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "vote_round_candidate_round_id_creator_id_key" ON "vote_round_candidate"("round_id", "creator_id");

-- CreateIndex
CREATE INDEX "vote_cast_creator_id_created_at_idx" ON "vote_cast"("creator_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_cast_user_id_created_at_idx" ON "vote_cast"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "vote_cast_round_id_idx" ON "vote_cast"("round_id");

-- CreateIndex
CREATE INDEX "vote_cast_created_at_idx" ON "vote_cast"("created_at");

-- CreateIndex
CREATE INDEX "vote_tally_period_type_period_key_votes_idx" ON "vote_tally"("period_type", "period_key", "votes");

-- CreateIndex
CREATE UNIQUE INDEX "vote_tally_period_type_period_key_creator_id_key" ON "vote_tally"("period_type", "period_key", "creator_id");

-- CreateIndex
CREATE INDEX "vote_period_result_period_type_period_key_rank_idx" ON "vote_period_result"("period_type", "period_key", "rank");

-- CreateIndex
CREATE INDEX "vote_period_result_creator_id_idx" ON "vote_period_result"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "vote_period_result_period_type_period_key_creator_id_key" ON "vote_period_result"("period_type", "period_key", "creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "talk_room_creator_id_key" ON "talk_room"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "talk_subscription_payment_id_key" ON "talk_subscription"("payment_id");

-- CreateIndex
CREATE INDEX "talk_subscription_user_id_creator_id_ends_at_idx" ON "talk_subscription"("user_id", "creator_id", "ends_at");

-- CreateIndex
CREATE INDEX "talk_subscription_creator_id_ends_at_idx" ON "talk_subscription"("creator_id", "ends_at");

-- CreateIndex
CREATE INDEX "talk_message_creator_id_kind_created_at_idx" ON "talk_message"("creator_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "talk_message_creator_id_fan_user_id_created_at_idx" ON "talk_message"("creator_id", "fan_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "talk_read_state_user_id_creator_id_key" ON "talk_read_state"("user_id", "creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "talk_block_creator_id_user_id_key" ON "talk_block"("creator_id", "user_id");

-- CreateIndex
CREATE INDEX "talk_report_status_created_at_idx" ON "talk_report"("status", "created_at");

-- CreateIndex
CREATE INDEX "talk_slot_rule_creator_id_idx" ON "talk_slot_rule"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "talk_session_session_no_key" ON "talk_session"("session_no");

-- CreateIndex
CREATE UNIQUE INDEX "talk_session_payment_id_key" ON "talk_session"("payment_id");

-- CreateIndex
CREATE INDEX "talk_session_creator_id_starts_at_idx" ON "talk_session"("creator_id", "starts_at");

-- CreateIndex
CREATE INDEX "talk_session_user_id_starts_at_idx" ON "talk_session"("user_id", "starts_at");

-- CreateIndex
CREATE INDEX "talk_session_status_starts_at_idx" ON "talk_session"("status", "starts_at");

-- CreateIndex
CREATE INDEX "talk_session_message_session_id_created_at_idx" ON "talk_session_message"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "creator_engagement_policy" ADD CONSTRAINT "creator_engagement_policy_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_ticket_lot" ADD CONSTRAINT "vote_ticket_lot_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_ticket_ledger" ADD CONSTRAINT "vote_ticket_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_ticket_order" ADD CONSTRAINT "vote_ticket_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offerwall_reward" ADD CONSTRAINT "offerwall_reward_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_round_candidate" ADD CONSTRAINT "vote_round_candidate_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "vote_round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_round_candidate" ADD CONSTRAINT "vote_round_candidate_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_cast" ADD CONSTRAINT "vote_cast_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_cast" ADD CONSTRAINT "vote_cast_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_tally" ADD CONSTRAINT "vote_tally_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_period_result" ADD CONSTRAINT "vote_period_result_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_room" ADD CONSTRAINT "talk_room_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_subscription" ADD CONSTRAINT "talk_subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_subscription" ADD CONSTRAINT "talk_subscription_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_message" ADD CONSTRAINT "talk_message_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_read_state" ADD CONSTRAINT "talk_read_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_block" ADD CONSTRAINT "talk_block_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_block" ADD CONSTRAINT "talk_block_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_slot_rule" ADD CONSTRAINT "talk_slot_rule_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_session" ADD CONSTRAINT "talk_session_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_session" ADD CONSTRAINT "talk_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talk_session_message" ADD CONSTRAINT "talk_session_message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "talk_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 투표권 묶음 잔량 범위
ALTER TABLE "vote_ticket_lot" ADD CONSTRAINT "vote_ticket_lot_remaining_range" CHECK ("remaining" >= 0 AND "remaining" <= "amount");
-- 투표 1건은 1표 이상
ALTER TABLE "vote_cast" ADD CONSTRAINT "vote_cast_votes_positive" CHECK ("votes" > 0 AND "tickets" > 0);
-- 같은 시간대 중복 예약 차단 (거절·만료·취소·불참 처리된 예약은 다시 열린다)
CREATE UNIQUE INDEX "talk_session_slot_active_uniq" ON "talk_session" ("creator_id", "starts_at") WHERE "status" IN ('REQUESTED', 'ACCEPTED', 'COMPLETED');
