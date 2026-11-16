-- 도네이도 샵 · 크리에이터 채널/신청 · 상품/주문/발주/정산 (2026-11-17)
--
-- 전부 "추가"만 한다. 기존 테이블의 컬럼 변경·삭제는 없다.
--  - creator_profile: 신청·보완요청·샵 설정·판매자 정보 컬럼 추가 (모두 nullable 또는 기본값)
--  - settlement_ledger: shop_order_id(nullable) 추가. append-only 트리거는 UPDATE/DELETE 만 막으므로 영향 없다
--  - ledger_entry_type: REFERRAL_COMMISSION / SALES_PROCEEDS / BROKER_FEE 값 추가
--    (PostgreSQL 12+ 는 한 마이그레이션에서 여러 값을 추가할 수 있다. 같은 트랜잭션 안에서 새 값을 쓰지 않는다)
--  - 재고는 옵션 단위이며 음수가 될 수 없다 (동시 주문 초과 판매를 DB 에서 막는 마지막 방어선)

ALTER TYPE "ledger_entry_type" ADD VALUE 'REFERRAL_COMMISSION';
ALTER TYPE "ledger_entry_type" ADD VALUE 'SALES_PROCEEDS';
ALTER TYPE "ledger_entry_type" ADD VALUE 'BROKER_FEE';

-- AlterTable
ALTER TABLE "creator_profile" ADD COLUMN     "applied_via" TEXT,
ADD COLUMN     "content_category" TEXT,
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "review_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "seller_biz_name" TEXT,
ADD COLUMN     "seller_biz_no" TEXT,
ADD COLUMN     "seller_cs_phone" TEXT,
ADD COLUMN     "seller_mail_order_no" TEXT,
ADD COLUMN     "seller_return_address" TEXT,
ADD COLUMN     "shop_default_tab" TEXT NOT NULL DEFAULT 'VIDEO',
ADD COLUMN     "shop_donation_min" BIGINT NOT NULL DEFAULT 1000,
ADD COLUMN     "shop_donation_presets" TEXT,
ADD COLUMN     "shop_margin_preset" TEXT,
ADD COLUMN     "shop_video_donation" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "submitted_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "settlement_ledger" ADD COLUMN     "shop_order_id" TEXT;

-- CreateTable
CREATE TABLE "creator_channel" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "url_key" TEXT NOT NULL,
    "title" TEXT,
    "follower_count" INTEGER,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "show_on_shop" BOOLEAN NOT NULL DEFAULT true,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creator_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_follow" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_video" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "thumbnail" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "memo" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "creator_id" TEXT,
    "supplier_id" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "summary" TEXT,
    "description" TEXT,
    "thumbnail_url" TEXT,
    "list_price" BIGINT,
    "price" BIGINT NOT NULL,
    "supply_price" BIGINT,
    "shipping_fee" BIGINT NOT NULL DEFAULT 0,
    "free_shipping_over" BIGINT,
    "referral_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "review_status" TEXT NOT NULL DEFAULT 'APPROVED',
    "reject_reason" TEXT,
    "notice" JSONB,
    "ship_from" TEXT,
    "return_address" TEXT,
    "sold_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "extra_price" BIGINT NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_image" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_product" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_commission" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "rate" DECIMAL(10,6) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creator_commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_product_commission" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "rate" DECIMAL(10,6) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creator_product_commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_wish" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_wish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_address" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT,
    "recipient_masked" TEXT NOT NULL,
    "recipient_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "zipcode" TEXT NOT NULL,
    "address_masked" TEXT NOT NULL,
    "address_enc" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "member_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_item" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "shop_creator_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_payment" (
    "id" TEXT NOT NULL,
    "payment_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "provider" TEXT NOT NULL,
    "provider_tx" TEXT,
    "fail_reason" TEXT,
    "cancelled_amount" BIGINT NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_order" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seller_type" TEXT NOT NULL,
    "seller_creator_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "items_amount" BIGINT NOT NULL,
    "shipping_fee" BIGINT NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "refunded_amount" BIGINT NOT NULL DEFAULT 0,
    "recipient_masked" TEXT NOT NULL,
    "recipient_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "zipcode" TEXT NOT NULL,
    "address_masked" TEXT NOT NULL,
    "address_enc" TEXT NOT NULL,
    "memo" TEXT,
    "courier" TEXT,
    "tracking_no" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "shipped_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_order_item" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "variant_name" TEXT NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "shop_creator_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "supply_price" BIGINT,
    "referral_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "referral_amount" BIGINT NOT NULL DEFAULT 0,
    "broker_fee_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order" (
    "id" TEXT NOT NULL,
    "po_no" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "memo" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_item" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "supply_price" BIGINT,

    CONSTRAINT "purchase_order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_claim" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requested_by" TEXT NOT NULL,
    "processed_by" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "refund_amount" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_commission" (
    "id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_commission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_channel_creator_id_idx" ON "creator_channel"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_channel_url_key_key" ON "creator_channel"("url_key");

-- CreateIndex
CREATE INDEX "member_follow_creator_id_idx" ON "member_follow"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_follow_user_id_creator_id_key" ON "member_follow"("user_id", "creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_video_creator_id_platform_external_id_key" ON "shop_video"("creator_id", "platform", "external_id");

-- CreateIndex
CREATE INDEX "product_owner_type_status_idx" ON "product"("owner_type", "status");

-- CreateIndex
CREATE INDEX "product_creator_id_idx" ON "product"("creator_id");

-- CreateIndex
CREATE INDEX "product_variant_product_id_idx" ON "product_variant"("product_id");

-- CreateIndex
CREATE INDEX "product_image_product_id_idx" ON "product_image"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_product_creator_id_product_id_key" ON "creator_product"("creator_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_commission_creator_id_key" ON "creator_commission"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_product_commission_creator_id_product_id_key" ON "creator_product_commission"("creator_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_wish_user_id_product_id_key" ON "product_wish"("user_id", "product_id");

-- CreateIndex
CREATE INDEX "member_address_user_id_idx" ON "member_address"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_item_user_id_shop_creator_id_variant_id_key" ON "cart_item"("user_id", "shop_creator_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_payment_payment_no_key" ON "shop_payment"("payment_no");

-- CreateIndex
CREATE INDEX "shop_payment_user_id_created_at_idx" ON "shop_payment"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shop_order_order_no_key" ON "shop_order"("order_no");

-- CreateIndex
CREATE INDEX "shop_order_user_id_created_at_idx" ON "shop_order"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "shop_order_seller_type_status_idx" ON "shop_order"("seller_type", "status");

-- CreateIndex
CREATE INDEX "shop_order_seller_creator_id_status_idx" ON "shop_order"("seller_creator_id", "status");

-- CreateIndex
CREATE INDEX "shop_order_item_order_id_idx" ON "shop_order_item"("order_id");

-- CreateIndex
CREATE INDEX "shop_order_item_shop_creator_id_idx" ON "shop_order_item"("shop_creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_po_no_key" ON "purchase_order"("po_no");

-- CreateIndex
CREATE INDEX "purchase_order_supplier_id_status_idx" ON "purchase_order"("supplier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_item_order_item_id_key" ON "purchase_order_item"("order_item_id");

-- CreateIndex
CREATE INDEX "order_claim_order_id_idx" ON "order_claim"("order_id");

-- CreateIndex
CREATE INDEX "order_claim_status_created_at_idx" ON "order_claim"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "referral_commission_order_item_id_key" ON "referral_commission"("order_item_id");

-- CreateIndex
CREATE INDEX "referral_commission_creator_id_status_idx" ON "referral_commission"("creator_id", "status");

-- AddForeignKey
ALTER TABLE "creator_channel" ADD CONSTRAINT "creator_channel_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_follow" ADD CONSTRAINT "member_follow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_follow" ADD CONSTRAINT "member_follow_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_video" ADD CONSTRAINT "shop_video_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_image" ADD CONSTRAINT "product_image_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_product" ADD CONSTRAINT "creator_product_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_product" ADD CONSTRAINT "creator_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_commission" ADD CONSTRAINT "creator_commission_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_product_commission" ADD CONSTRAINT "creator_product_commission_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_product_commission" ADD CONSTRAINT "creator_product_commission_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_wish" ADD CONSTRAINT "product_wish_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_wish" ADD CONSTRAINT "product_wish_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_address" ADD CONSTRAINT "member_address_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_payment" ADD CONSTRAINT "shop_payment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "shop_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_item" ADD CONSTRAINT "shop_order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "shop_order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_claim" ADD CONSTRAINT "order_claim_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_commission" ADD CONSTRAINT "referral_commission_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "shop_order_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_commission" ADD CONSTRAINT "referral_commission_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 재고·금액 무결성
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_stock_nonneg" CHECK ("stock" >= 0);
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_quantity_pos" CHECK ("quantity" > 0);
ALTER TABLE "shop_order_item" ADD CONSTRAINT "shop_order_item_quantity_pos" CHECK ("quantity" > 0);
ALTER TABLE "product" ADD CONSTRAINT "product_price_nonneg" CHECK ("price" >= 0);
