import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { parseProductForm, saveProduct } from '@/server/services/shop/catalog';
import { addToCart, placeOrder } from '@/server/services/shop/orders';
import {
  getShopStickers,
  getStickerForVideo,
  listCreatorVideoTags,
  normalizeTagWindow,
  recordStickerClick,
  removeVideoProductTag,
  saveVideoProductTag,
} from '@/server/services/shop/video-products';
import { __resetShopVideoCache } from '@/server/services/shop/videos';
import { describeTagWindow, formatTagTime, isTagVisibleAt, isVideoTagKey, parseTagTime } from '@/lib/video-product-time';
import { embedUrlFor } from '@/lib/shop-video-embed';
import { youtubeEmbedUrl } from '@/lib/video-hub';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 영상 상품 스티커 (2026-11-18)
 * 영상 1개당 상품 1개, 내 샵 진열 상품만, 유튜브만 시간대 지정, 판매 중지 시 자동 숨김,
 * 스티커에서 담은 상품은 주문 항목에 영상 출처가 남는다.
 */

const ADDR = { recipient: '홍길동', phone: '010-1234-5678', zipcode: '06236', address1: '서울특별시 강남구 테헤란로 123', address2: '101동 202호' };
const YT_ID = 'abcdefghijk';

let fx: Fixture;
let buyer: { id: string; name: string | null };

function feedXml(channelId: string, ids: string[]) {
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${ids
    .map(
      (id) => `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>영상 ${id}</title><author><name>채널</name></author><published>2026-11-10T00:00:00+00:00</published><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/></entry>`,
    )
    .join('')}</feed>`;
}

beforeEach(async () => {
  await resetDb();
  __resetShopVideoCache();
  fx = await seedBasics();
  // 유튜브 연동 채널 ID 를 실제 형식(UC + 22자)으로 바꿔 자동 수집 영상이 생기게 한다
  const conn = await prisma.youTubeConnection.update({ where: { creatorId: fx.creatorId }, data: { channelId: 'UCabcdefghijklmnopqrstuv' }, select: { channelId: true } });
  // 유튜브 공개 피드는 네트워크 대신 고정 응답을 쓴다
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('feeds/videos.xml')) return new Response(feedXml(conn?.channelId ?? 'UCxxxxxxxxxxxxxxxxxxxxxx', [YT_ID]), { status: 200 });
      return new Response('not found', { status: 404 });
    }),
  );
  const u = await prisma.user.create({ data: { id: newId(), email: `b-${newId()}@test.kr`, name: '구매자', role: 'DONOR' } });
  buyer = { id: u.id, name: u.name };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function product(opts: { display?: boolean; status?: string } = {}) {
  const fd = new FormData();
  fd.set('name', `스티커상품${newId().slice(-4)}`);
  fd.set('price', '15000');
  fd.set('shippingFee', '0');
  fd.set('referralRate', '5');
  fd.set('status', opts.status ?? 'ON_SALE');
  fd.set('variants', '기본 | 0 | 5');
  const id = await saveProduct(parseProductForm(fd, { forAdmin: true }), { type: 'ADMIN' });
  if (opts.display !== false) await prisma.creatorProduct.create({ data: { id: newId(), creatorId: fx.creatorId, productId: id } });
  const variants = await prisma.productVariant.findMany({ where: { productId: id } });
  return { id, variantId: variants[0].id };
}

async function manualVideo(platform = 'TIKTOK', externalId = '1234567890123') {
  await prisma.shopVideo.create({ data: { id: newId(), creatorId: fx.creatorId, platform, externalId, url: `https://www.tiktok.com/@a/video/${externalId}`, title: '틱톡 영상', source: 'MANUAL' } });
  return { platform, externalId };
}

describe('시간 입력·표시', () => {
  it('분:초·초 입력을 초로 바꾸고 되돌린다', () => {
    expect(parseTagTime('')).toBeNull();
    expect(parseTagTime('80')).toBe(80);
    expect(parseTagTime('1:20')).toBe(80);
    expect(parseTagTime('1:02:03')).toBe(3723);
    expect(() => parseTagTime('1:75')).toThrow(/0~59/);
    expect(() => parseTagTime('abc')).toThrow(/분:초/);
    expect(() => parseTagTime('25:00:00')).toThrow(/24시간/);
    expect(formatTagTime(80)).toBe('1:20');
    expect(formatTagTime(3723)).toBe('1:02:03');
    expect(describeTagWindow(null, null)).toBe('영상 내내');
    expect(describeTagWindow(80, 120)).toBe('1:20 ~ 2:00');
    expect(describeTagWindow(80, null)).toBe('1:20부터 끝까지');
  });

  it('재생 위치에 따라 스티커를 보인다', () => {
    expect(isTagVisibleAt({ startSec: null, endSec: null }, null)).toBe(true);
    expect(isTagVisibleAt({ startSec: 80, endSec: 120 }, null)).toBe(false);
    expect(isTagVisibleAt({ startSec: 80, endSec: 120 }, 79.9)).toBe(false);
    expect(isTagVisibleAt({ startSec: 80, endSec: 120 }, 80)).toBe(true);
    expect(isTagVisibleAt({ startSec: 80, endSec: 120 }, 120)).toBe(false);
    expect(isTagVisibleAt({ startSec: null, endSec: 30 }, 10)).toBe(true);
  });

  it('시간대는 유튜브에서만, 끝은 시작보다 뒤', () => {
    expect(normalizeTagWindow('YOUTUBE', 0, 30)).toEqual({ startSec: null, endSec: 30 });
    expect(() => normalizeTagWindow('YOUTUBE', 60, 30)).toThrow(/뒤여야/);
    expect(() => normalizeTagWindow('TIKTOK', 10, null)).toThrow(/유튜브 영상에서만/);
    expect(normalizeTagWindow('LIVE', null, null)).toEqual({ startSec: null, endSec: null });
  });

  it('영상 키 형식 · 유튜브 임베드는 재생 위치를 읽을 수 있게 enablejsapi 를 켠다', () => {
    expect(isVideoTagKey('YOUTUBE:abcdefghijk')).toBe(true);
    expect(isVideoTagKey('INSTAGRAM:reel/AbC_123')).toBe(true);
    expect(isVideoTagKey('LIVE:LIVE')).toBe(true);
    expect(isVideoTagKey('EVIL:<script>')).toBe(false);
    expect(embedUrlFor('YOUTUBE', YT_ID, '')).toContain('enablejsapi=1');
    expect(youtubeEmbedUrl(YT_ID)).toContain('enablejsapi=1');
  });
});

describe('영상에 상품 연결', () => {
  it('유튜브 자동 수집 영상 · 직접 등록 영상 · 라이브에 상품을 1개씩 연결하고 바꿀 수 있다', async () => {
    const a = await product();
    const b = await product();
    const v = await manualVideo();
    await saveVideoProductTag(fx.creatorId, { platform: 'YOUTUBE', externalId: YT_ID, productId: a.id, startSec: 80, endSec: 120 });
    await saveVideoProductTag(fx.creatorId, { platform: v.platform, externalId: v.externalId, productId: a.id, startSec: null, endSec: null });
    await saveVideoProductTag(fx.creatorId, { platform: 'LIVE', externalId: 'anything', productId: b.id, startSec: null, endSec: null });
    // 같은 영상에 다시 저장하면 바뀐다(영상 1개당 1개)
    await saveVideoProductTag(fx.creatorId, { platform: 'YOUTUBE', externalId: YT_ID, productId: b.id, startSec: null, endSec: 90 });
    expect(await prisma.videoProductTag.count({ where: { creatorId: fx.creatorId } })).toBe(3);

    const stickers = await getShopStickers(fx.creatorId);
    expect(Object.keys(stickers).sort()).toEqual(['LIVE:LIVE', `TIKTOK:${v.externalId}`, `YOUTUBE:${YT_ID}`].sort());
    expect(stickers[`YOUTUBE:${YT_ID}`]).toMatchObject({ productId: b.id, startSec: null, endSec: 90, price: 15000, soldOut: false });
    expect(stickers['LIVE:LIVE'].variants[0]).toMatchObject({ name: '기본', stock: 5 });

    const watch = await getStickerForVideo(fx.creatorCode, 'YOUTUBE', YT_ID);
    expect(watch?.productId).toBe(b.id);
    expect(await getStickerForVideo('NO-SUCH', 'YOUTUBE', YT_ID)).toBeNull();

    expect(await removeVideoProductTag(fx.creatorId, 'LIVE', 'LIVE')).toBe(true);
    expect((await getShopStickers(fx.creatorId))['LIVE:LIVE']).toBeUndefined();
  });

  it('내 샵에 진열하지 않은 상품 · 판매 중이 아닌 상품 · 내 영상이 아닌 영상은 연결할 수 없다', async () => {
    const notShown = await product({ display: false });
    const draft = await product({ status: 'DRAFT' });
    const ok = await product();
    await expect(saveVideoProductTag(fx.creatorId, { platform: 'LIVE', externalId: 'LIVE', productId: notShown.id, startSec: null, endSec: null })).rejects.toThrow(/진열 중인 상품/);
    await expect(saveVideoProductTag(fx.creatorId, { platform: 'LIVE', externalId: 'LIVE', productId: draft.id, startSec: null, endSec: null })).rejects.toThrow();
    await expect(saveVideoProductTag(fx.creatorId, { platform: 'YOUTUBE', externalId: 'zzzzzzzzzzz', productId: ok.id, startSec: null, endSec: null })).rejects.toThrow(/찾을 수 없습니다/);
    await expect(saveVideoProductTag(fx.creatorId, { platform: 'TIKTOK', externalId: '999999999999', productId: ok.id, startSec: null, endSec: null })).rejects.toThrow(/찾을 수 없습니다/);
    const v = await manualVideo();
    await expect(saveVideoProductTag(fx.creatorId, { platform: v.platform, externalId: v.externalId, productId: ok.id, startSec: 10, endSec: 20 })).rejects.toThrow(/유튜브 영상에서만/);
  });

  it('진열을 내리거나 관리자가 막거나 품절·숨김이면 스티커가 자동으로 숨는다', async () => {
    const p = await product();
    await saveVideoProductTag(fx.creatorId, { platform: 'LIVE', externalId: 'LIVE', productId: p.id, startSec: null, endSec: null });
    expect(Object.keys(await getShopStickers(fx.creatorId))).toHaveLength(1);

    await prisma.creatorProduct.updateMany({ where: { creatorId: fx.creatorId, productId: p.id }, data: { active: false } });
    expect(Object.keys(await getShopStickers(fx.creatorId))).toHaveLength(0);
    const tags = await listCreatorVideoTags(fx.creatorId);
    expect(tags[0]).toMatchObject({ key: 'LIVE:LIVE', visible: false });

    await prisma.creatorProduct.updateMany({ where: { creatorId: fx.creatorId, productId: p.id }, data: { active: true, blocked: true } });
    expect(Object.keys(await getShopStickers(fx.creatorId))).toHaveLength(0);

    await prisma.creatorProduct.updateMany({ where: { creatorId: fx.creatorId, productId: p.id }, data: { blocked: false } });
    await prisma.product.update({ where: { id: p.id }, data: { status: 'SOLD_OUT' } });
    expect((await getShopStickers(fx.creatorId))['LIVE:LIVE'].soldOut).toBe(true);
    await prisma.product.update({ where: { id: p.id }, data: { status: 'HIDDEN' } });
    expect(Object.keys(await getShopStickers(fx.creatorId))).toHaveLength(0);
  });

  it('다른 크리에이터 샵에는 내 스티커가 보이지 않는다', async () => {
    const p = await product();
    await saveVideoProductTag(fx.creatorId, { platform: 'LIVE', externalId: 'LIVE', productId: p.id, startSec: null, endSec: null });
    const otherUser = await prisma.user.create({ data: { id: newId(), email: `c-${newId()}@test.kr`, role: 'CREATOR' } });
    const other = await prisma.creatorProfile.create({ data: { id: newId(), userId: otherUser.id, code: `TOR-${newId().slice(-4)}`, displayName: '다른', status: 'APPROVED', donationAmount: 3000n } });
    expect(await getShopStickers(other.id)).toEqual({});
  });
});

describe('스티커에서 구매', () => {
  it('스티커로 담은 상품은 주문 항목에 영상 출처가 남고, 클릭·판매 수가 집계된다', async () => {
    const p = await product();
    const tag = await saveVideoProductTag(fx.creatorId, { platform: 'YOUTUBE', externalId: YT_ID, productId: p.id, startSec: null, endSec: null });
    await recordStickerClick(tag.id);
    await recordStickerClick(tag.id);
    await addToCart(buyer.id, fx.creatorId, p.id, p.variantId, 2, { sourceVideoKey: `YOUTUBE:${YT_ID}` });
    const cart = await prisma.cartItem.findFirstOrThrow({ where: { userId: buyer.id } });
    expect(cart.sourceVideoKey).toBe(`YOUTUBE:${YT_ID}`);
    const r = await placeOrder(buyer, { cartItemIds: [cart.id], address: ADDR });
    expect(r.ok, r.message).toBe(true);
    const item = await prisma.shopOrderItem.findFirstOrThrow({ where: { productId: p.id } });
    expect(item.sourceVideoKey).toBe(`YOUTUBE:${YT_ID}`);
    const [row] = await listCreatorVideoTags(fx.creatorId);
    expect(row).toMatchObject({ clickCount: 2, soldQuantity: 2, visible: true });
  });

  it('연결되지 않은 영상 키·잘못된 값은 출처로 남기지 않지만 담기는 된다', async () => {
    const p = await product();
    const other = await product();
    await saveVideoProductTag(fx.creatorId, { platform: 'LIVE', externalId: 'LIVE', productId: other.id, startSec: null, endSec: null });
    await addToCart(buyer.id, fx.creatorId, p.id, p.variantId, 1, { sourceVideoKey: 'LIVE:LIVE' }); // 라이브 스티커 상품이 아님
    await addToCart(buyer.id, fx.creatorId, other.id, (await prisma.productVariant.findFirstOrThrow({ where: { productId: other.id } })).id, 1, { sourceVideoKey: 'EVIL:<x>' });
    const rows = await prisma.cartItem.findMany({ where: { userId: buyer.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourceVideoKey === null)).toBe(true);
  });
});
