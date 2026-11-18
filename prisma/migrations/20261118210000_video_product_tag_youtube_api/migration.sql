-- 2026-11-18 영상 상품 스티커 + 최고관리자 YouTube Data API 영상 수집 (추가만 한다)

-- AlterTable
ALTER TABLE "cart_item" ADD COLUMN     "source_video_key" TEXT;

-- AlterTable
ALTER TABLE "shop_order_item" ADD COLUMN     "source_video_key" TEXT;

-- CreateTable
CREATE TABLE "video_product_tag" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "video_title" TEXT,
    "start_sec" INTEGER,
    "end_sec" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "video_product_tag_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "video_product_tag_time_check" CHECK (
        ("start_sec" IS NULL OR "start_sec" >= 0)
        AND ("end_sec" IS NULL OR "end_sec" > 0)
        AND ("start_sec" IS NULL OR "end_sec" IS NULL OR "end_sec" > "start_sec")
    )
);

-- CreateTable
CREATE TABLE "youtube_api_channel" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "title" TEXT,
    "handle" TEXT,
    "avatar_url" TEXT,
    "subscriber_count" INTEGER,
    "uploads_playlist_id" TEXT,
    "category" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_fetched_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "youtube_api_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_api_video" (
    "id" TEXT NOT NULL,
    "video_id" TEXT NOT NULL,
    "channel_row_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnail" TEXT,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "views" INTEGER,
    "duration_sec" INTEGER,
    "is_short" BOOLEAN NOT NULL DEFAULT false,
    "live_state" TEXT NOT NULL DEFAULT 'none',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_api_video_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_product_tag_product_id_idx" ON "video_product_tag"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_product_tag_creator_id_platform_external_id_key" ON "video_product_tag"("creator_id", "platform", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_api_channel_channel_id_key" ON "youtube_api_channel"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_api_video_video_id_key" ON "youtube_api_video"("video_id");

-- CreateIndex
CREATE INDEX "youtube_api_video_channel_row_id_published_at_idx" ON "youtube_api_video"("channel_row_id", "published_at");

-- CreateIndex
CREATE INDEX "youtube_api_video_published_at_idx" ON "youtube_api_video"("published_at");

-- AddForeignKey
ALTER TABLE "video_product_tag" ADD CONSTRAINT "video_product_tag_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_product_tag" ADD CONSTRAINT "video_product_tag_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_api_video" ADD CONSTRAINT "youtube_api_video_channel_row_id_fkey" FOREIGN KEY ("channel_row_id") REFERENCES "youtube_api_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
