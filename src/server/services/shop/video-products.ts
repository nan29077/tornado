/**
 * 영상 상품 스티커 (2026-11-18).
 *
 * 유튜브 쇼핑 스티커처럼 영상 위에 상품을 띄우고 시청자가 바로 구매하게 한다.
 *  - 유튜브·틱톡 같은 외부 플랫폼 화면에는 적용할 수 없다. 도네이도 안에서 재생되는 영상
 *    (도네이도 샵 영상 탭, 방송국 시청 화면, 샵 라이브 영역)에만 표시한다.
 *  - 크리에이터가 스튜디오 > 도네이도 샵에서 영상마다 상품을 1개 연결한다.
 *  - 고를 수 있는 상품 = 그 크리에이터 샵에 진열 중인 상품(관리자 상품 + 검수 통과한 직접 상품).
 *  - 유튜브 영상은 표시 시간대(시작·끝)를 정할 수 있고, 비우면 영상 내내 표시한다.
 *    틱톡·인스타·페이스북·라이브는 재생 위치를 읽을 수 없어 항상 표시한다.
 *  - 진열을 내리거나, 관리자가 판매를 막거나, 상품이 판매 중지되면 스티커도 자동으로 숨는다(행은 남긴다).
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { SELLABLE_PRODUCT, getShopProduct } from './catalog';
import { getShopVideos } from './videos';
import { LIVE_TAG_KEY, isVideoTagKey, supportsTimedTag, videoTagKey } from '@/lib/video-product-time';

export const TAG_PLATFORMS = ['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'LIVE'] as const;
export type TagPlatform = (typeof TAG_PLATFORMS)[number];

export function isTagPlatform(v: unknown): v is TagPlatform {
  return typeof v === 'string' && (TAG_PLATFORMS as readonly string[]).includes(v);
}

/** 시청자 화면에 내려보내는 스티커 (브라우저로 가므로 문자열·숫자만) */
export interface VideoStickerView {
  tagId: string;
  key: string;
  productId: string;
  name: string;
  summary: string | null;
  thumbnailUrl: string | null;
  price: number;
  listPrice: number | null;
  soldOut: boolean;
  startSec: number | null;
  endSec: number | null;
  variants: Array<{ id: string; name: string; extraPrice: number; stock: number }>;
}

export interface SaveTagInput {
  platform: string;
  externalId: string;
  productId: string;
  videoTitle?: string | null;
  startSec: number | null;
  endSec: number | null;
}

/** 시간대 검증. 유튜브가 아니면 시간 값을 받지 않는다 */
export function normalizeTagWindow(platform: string, startSec: number | null, endSec: number | null): { startSec: number | null; endSec: number | null } {
  if (!supportsTimedTag(platform)) {
    if (startSec != null || endSec != null) throw new Error('표시 시간대는 유튜브 영상에서만 정할 수 있습니다.');
    return { startSec: null, endSec: null };
  }
  const s = startSec === 0 ? null : startSec; // 0초부터 = 처음부터
  if (endSec != null && endSec <= (s ?? 0)) throw new Error('끝나는 시간은 시작 시간보다 뒤여야 합니다.');
  return { startSec: s, endSec };
}

/** 이 크리에이터 샵의 영상인가 (라이브는 항상 가능) */
async function assertOwnVideo(creatorId: string, platform: TagPlatform, externalId: string): Promise<string | null> {
  if (platform === 'LIVE') {
    if (externalId !== 'LIVE') throw new Error('영상을 찾을 수 없습니다.');
    return '라이브 방송';
  }
  if (!externalId || externalId.length > 60 || !isVideoTagKey(videoTagKey(platform, externalId))) throw new Error('영상을 찾을 수 없습니다.');
  const row = await prisma.shopVideo.findUnique({
    where: { creatorId_platform_externalId: { creatorId, platform, externalId } },
    select: { source: true, title: true },
  });
  if (row?.source === 'MANUAL') return row.title;
  // 자동 수집(유튜브) 영상: 지금 내 샵 영상 목록에 있는지 확인한다
  const list = await getShopVideos(creatorId, { includeHidden: true }).catch(() => []);
  const found = list.find((v) => v.platform === platform && v.externalId === externalId);
  if (!found) throw new Error('내 샵 영상 목록에서 이 영상을 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
  return found.title;
}

/** 영상에 상품 연결 (영상 1개당 1개 — 이미 있으면 바꾼다) */
export async function saveVideoProductTag(creatorId: string, input: SaveTagInput) {
  const platform = input.platform;
  if (!isTagPlatform(platform)) throw new Error('영상을 찾을 수 없습니다.');
  const externalId = platform === 'LIVE' ? 'LIVE' : input.externalId.trim();
  const product = await getShopProduct(creatorId, input.productId);
  if (!product) throw new Error('내 샵에 진열 중인 상품만 연결할 수 있습니다. 상품 관리에서 먼저 진열해 주세요.');
  if (product.status !== 'ON_SALE') throw new Error('판매 중인 상품만 연결할 수 있습니다.');
  const window = normalizeTagWindow(platform, input.startSec, input.endSec);
  const fetchedTitle = await assertOwnVideo(creatorId, platform, externalId);
  const videoTitle = (input.videoTitle?.trim() || fetchedTitle || null)?.slice(0, 120) ?? null;
  const where = { creatorId_platform_externalId: { creatorId, platform, externalId } };
  const data = { productId: product.id, videoTitle, startSec: window.startSec, endSec: window.endSec, active: true };
  return prisma.videoProductTag.upsert({
    where,
    create: { id: newId(), creatorId, platform, externalId, ...data },
    update: data,
  });
}

export async function removeVideoProductTag(creatorId: string, platform: string, externalId: string): Promise<boolean> {
  if (!isTagPlatform(platform)) return false;
  const res = await prisma.videoProductTag.deleteMany({ where: { creatorId, platform, externalId: platform === 'LIVE' ? 'LIVE' : externalId } });
  return res.count > 0;
}

/** 스튜디오용: 내 영상별 연결 상품 (판매 가능 여부 포함) */
export async function listCreatorVideoTags(creatorId: string) {
  const rows = await prisma.videoProductTag.findMany({
    where: { creatorId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, platform: true, externalId: true, productId: true, startSec: true, endSec: true, clickCount: true, videoTitle: true,
      product: { select: { name: true, thumbnailUrl: true, status: true, deletedAt: true, reviewStatus: true } },
    },
  });
  const displays = await prisma.creatorProduct.findMany({
    where: { creatorId, productId: { in: [...new Set(rows.map((r) => r.productId))] } },
    select: { productId: true, active: true, blocked: true },
  });
  const shown = new Map(displays.map((d) => [d.productId, d.active && !d.blocked]));
  const sales = rows.length
    ? await prisma.shopOrderItem.groupBy({
        by: ['sourceVideoKey'],
        where: { shopCreatorId: creatorId, sourceVideoKey: { in: rows.map((r) => videoTagKey(r.platform, r.externalId)) }, order: { status: { notIn: ['PENDING_PAYMENT', 'CANCELLED'] } } },
        _sum: { quantity: true },
      })
    : [];
  const sold = new Map(sales.map((s) => [s.sourceVideoKey, s._sum.quantity ?? 0]));
  return rows.map((r) => {
    const key = videoTagKey(r.platform, r.externalId);
    const live = !r.product.deletedAt && r.product.reviewStatus === 'APPROVED' && r.product.status === 'ON_SALE' && shown.get(r.productId) === true;
    return { ...r, key, visible: live, soldQuantity: sold.get(key) ?? 0 };
  });
}

type StickerRow = {
  id: string;
  platform: string;
  externalId: string;
  startSec: number | null;
  endSec: number | null;
  product: {
    id: string;
    name: string;
    summary: string | null;
    thumbnailUrl: string | null;
    price: bigint;
    listPrice: bigint | null;
    status: string;
    variants: Array<{ id: string; name: string; extraPrice: bigint; stock: number }>;
  };
};

const STICKER_SELECT = {
  id: true,
  platform: true,
  externalId: true,
  startSec: true,
  endSec: true,
  product: {
    select: {
      id: true, name: true, summary: true, thumbnailUrl: true, price: true, listPrice: true, status: true,
      variants: { where: { active: true }, orderBy: { sortOrder: 'asc' as const }, select: { id: true, name: true, extraPrice: true, stock: true } },
    },
  },
} as const;

function toView(r: StickerRow): VideoStickerView {
  const variants = r.product.variants.map((v) => ({ id: v.id, name: v.name, extraPrice: Number(v.extraPrice), stock: v.stock }));
  return {
    tagId: r.id,
    key: videoTagKey(r.platform, r.externalId),
    productId: r.product.id,
    name: r.product.name,
    summary: r.product.summary,
    thumbnailUrl: r.product.thumbnailUrl,
    price: Number(r.product.price),
    listPrice: r.product.listPrice != null ? Number(r.product.listPrice) : null,
    soldOut: r.product.status !== 'ON_SALE' || variants.every((v) => v.stock <= 0),
    startSec: r.startSec,
    endSec: r.endSec,
    variants,
  };
}

/** 이 샵에서 지금 팔 수 있는 상품의 스티커만 (진열·차단·판매 상태 확인) */
function sellableTagWhere(creatorId: string) {
  return {
    creatorId,
    active: true,
    product: {
      ...SELLABLE_PRODUCT,
      OR: [{ ownerType: 'ADMIN' }, { ownerType: 'CREATOR', creatorId }],
      displays: { some: { creatorId, active: true, blocked: false } },
    },
  };
}

/** 샵 영상 탭용: 영상 키 → 스티커 */
export async function getShopStickers(creatorId: string): Promise<Record<string, VideoStickerView>> {
  try {
    const rows = await prisma.videoProductTag.findMany({ where: sellableTagWhere(creatorId), select: STICKER_SELECT, take: 500 });
    return Object.fromEntries(rows.map((r) => [videoTagKey(r.platform, r.externalId), toView(r)]));
  } catch (e) {
    logger.warn('video-products: 스티커 조회 실패', { creatorId, error: (e as Error).message });
    return {};
  }
}

/** 방송국 시청 화면용: 크리에이터 코드 + 영상 1건 */
export async function getStickerForVideo(creatorCode: string, platform: string, externalId: string): Promise<VideoStickerView | null> {
  if (!isTagPlatform(platform)) return null;
  try {
    const creator = await prisma.creatorProfile.findFirst({ where: { code: creatorCode, status: 'APPROVED' }, select: { id: true } });
    if (!creator) return null;
    const row = await prisma.videoProductTag.findFirst({
      where: { ...sellableTagWhere(creator.id), platform, externalId },
      select: STICKER_SELECT,
    });
    return row ? toView(row) : null;
  } catch (e) {
    logger.warn('video-products: 시청 화면 스티커 조회 실패', { creatorCode, error: (e as Error).message });
    return null;
  }
}

/** 스티커 클릭 수 (통계용, 실패해도 무시) */
export async function recordStickerClick(tagId: string): Promise<void> {
  if (!/^[0-9A-Za-z]{10,40}$/.test(tagId)) return;
  await prisma.videoProductTag.updateMany({ where: { id: tagId }, data: { clickCount: { increment: 1 } } }).catch(() => undefined);
}

/**
 * 장바구니 담기 출처 검증: 이 샵에서 이 상품이 그 영상의 스티커로 연결되어 있을 때만 기록한다.
 * (잘못된 값은 조용히 버린다 — 구매 자체는 막지 않는다)
 */
export async function resolveSourceVideoKey(shopCreatorId: string, productId: string, raw: string | null | undefined): Promise<string | null> {
  if (!raw || !isVideoTagKey(raw)) return null;
  const idx = raw.indexOf(':');
  const platform = raw.slice(0, idx);
  const externalId = raw.slice(idx + 1);
  if (raw === LIVE_TAG_KEY || platform !== 'LIVE') {
    const tag = await prisma.videoProductTag
      .findUnique({ where: { creatorId_platform_externalId: { creatorId: shopCreatorId, platform, externalId } }, select: { productId: true } })
      .catch(() => null);
    return tag?.productId === productId ? raw : null;
  }
  return null;
}
