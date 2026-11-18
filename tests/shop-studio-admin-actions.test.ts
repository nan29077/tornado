import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { parseProductForm, saveProduct } from '@/server/services/shop/catalog';
import { addToCart, placeOrder } from '@/server/services/shop/orders';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * 도네이도 샵 — 크리에이터 관리자·최고관리자 서버 액션 (2026-11-17)
 * 권한 경계(내 것만), 입력 검증, 판매자 정보 필수, 배송지 열람 범위, 발주서 다운로드 권한
 */

const session = vi.hoisted(() => ({
  creator: null as null | { id: string; creatorId: string },
  adminPermission: 'SUPER_ADMIN',
}));
vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    requireCreator: vi.fn(async () => {
      if (!session.creator) throw new Error('크리에이터 권한이 필요합니다.');
      return { id: session.creator.id, creatorId: session.creator.creatorId, role: 'CREATOR', email: null, name: 'c', avatarIndex: 0 };
    }),
    requireAdmin: vi.fn(async () => ({ id: 'admin-x', email: null, name: '운영', role: 'ADMIN', avatarIndex: 0, adminPermission: session.adminPermission })),
    writeAudit: vi.fn(async () => undefined),
  };
});

const studio = await import('@/app/actions/studio-shop');
const admin = await import('@/app/actions/admin/shop');
const poRoute = await import('@/app/api/admin/shop/po/[id]/route');

const P = { ok: false };
const ADDR = { recipient: '홍길동', phone: '010-1234-5678', zipcode: '06236', address1: '서울특별시 강남구 테헤란로 123', address2: '101동 202호' };

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

let fx: Fixture;
let other: { userId: string; creatorId: string };

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  session.creator = { id: fx.creatorUserId, creatorId: fx.creatorId };
  session.adminPermission = 'SUPER_ADMIN';
  const u = await prisma.user.create({ data: { id: newId(), email: `o-${newId()}@t.kr`, role: 'CREATOR' } });
  const c = await prisma.creatorProfile.create({ data: { id: newId(), userId: u.id, code: `TOR-${newId().slice(-5)}`, displayName: '다른크리에이터', status: 'APPROVED', donationAmount: 3000n } });
  other = { userId: u.id, creatorId: c.id };
});

async function adminProduct() {
  const fd = form({ name: '관리자상품', price: '10000', shippingFee: '3000', referralRate: '5', status: 'ON_SALE', variants: '기본 | 0 | 5' });
  return saveProduct(parseProductForm(fd, { forAdmin: true }), { type: 'ADMIN' });
}

describe('샵 기본 설정', () => {
  it('정상 저장, 잘못된 탭·최소금액·추천금액 거절', async () => {
    const ok = await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'SHOP', shopMarginPreset: 'clouds', shopDonationMin: '2,000', shopDonationPresets: '2000,5000', shopVideoDonation: 'on' }));
    expect(ok.ok, ok.message).toBe(true);
    const c = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } });
    expect(c).toMatchObject({ shopDefaultTab: 'SHOP', shopMarginPreset: 'clouds', shopDonationMin: 2000n, shopDonationPresets: '2000,5000', shopVideoDonation: true });
    expect((await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'X', shopDonationMin: '1000' }))).ok).toBe(false);
    expect((await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'VIDEO', shopDonationMin: '500' }))).ok).toBe(false);
    const low = await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'VIDEO', shopDonationMin: '3000', shopDonationPresets: '1000' }));
    expect(low.ok).toBe(false);
    expect(low.message).toMatch(/최소 금액 이상/);
    expect((await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'VIDEO', shopMarginPreset: '../evil', shopDonationMin: '1000' }))).ok).toBe(false);
    // 체크 해제 → 영상 후원 끄기
    await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'VIDEO', shopDonationMin: '1000' }));
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } })).shopVideoDonation).toBe(false);
  });

  it('로그인하지 않으면 거절', async () => {
    session.creator = null;
    expect((await studio.saveShopBasicsAction(P, form({ shopDefaultTab: 'VIDEO', shopDonationMin: '1000' }))).ok).toBe(false);
  });
});

describe('채널 · 영상', () => {
  it('다른 크리에이터가 쓰는 채널은 막고, 내 채널은 저장', async () => {
    await prisma.creatorChannel.create({ data: { id: newId(), creatorId: other.creatorId, platform: 'TIKTOK', url: 'https://www.tiktok.com/@taken', urlKey: 'tiktok.com/@taken' } });
    const bad = await studio.saveShopChannelsAction(P, form({ channelPlatform: 'TIKTOK', channelUrl: 'https://tiktok.com/@Taken', channelTitle: '', channelFollowers: '', primaryChannel: '0' }));
    expect(bad.ok).toBe(false);
    const ok = await studio.saveShopChannelsAction(P, form({ channelPlatform: ['YOUTUBE', 'TIKTOK'], channelUrl: ['https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb', 'https://www.tiktok.com/@mine'], channelTitle: ['', ''], channelFollowers: ['1만', ''], primaryChannel: '0' }));
    expect(ok.ok, ok.message).toBe(true);
    expect(await prisma.creatorChannel.count({ where: { creatorId: fx.creatorId } })).toBe(2);
    // [6차 P1-4] 새로 넣은 채널은 최고관리자 확인 전까지 확인 대기 — 대표 채널로도 쓰지 않는다
    expect(await prisma.creatorChannel.count({ where: { creatorId: fx.creatorId, verifiedAt: null } })).toBe(2);
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } })).channelUrl).toBeNull();
    const { verifyCreatorChannels } = await import('@/server/services/creator-application');
    await prisma.$transaction((tx) => verifyCreatorChannels(tx, fx.creatorId));
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } })).channelUrl).toContain('youtube.com/channel/UCb');
  });

  it('영상 주소 등록·숨김·삭제, 잘못된 주소 거절, 자동 수집 영상 숨김 행', async () => {
    expect((await studio.addShopVideoAction(P, form({ url: 'https://evil.example.com/video/1' }))).ok).toBe(false);
    expect((await studio.addShopVideoAction(P, form({ url: 'http://www.tiktok.com/@a/video/1234567890123' }))).ok).toBe(false);
    const ok = await studio.addShopVideoAction(P, form({ url: 'https://www.tiktok.com/@a/video/1234567890123?lang=ko', title: '틱톡' }));
    expect(ok.ok, ok.message).toBe(true);
    const v = await prisma.shopVideo.findFirstOrThrow({ where: { creatorId: fx.creatorId } });
    expect(v).toMatchObject({ platform: 'TIKTOK', externalId: '1234567890123', source: 'MANUAL' });
    await studio.shopVideoOpAction(P, form({ platform: 'TIKTOK', externalId: v.externalId, op: 'hide' }));
    expect((await prisma.shopVideo.findUniqueOrThrow({ where: { id: v.id } })).hidden).toBe(true);
    // 유튜브 자동 수집 영상은 설정 행으로 기억
    await studio.shopVideoOpAction(P, form({ platform: 'YOUTUBE', externalId: 'dQw4w9WgXcQ', op: 'pin' }));
    expect(await prisma.shopVideo.findFirst({ where: { creatorId: fx.creatorId, platform: 'YOUTUBE', source: 'AUTO', pinned: true } })).not.toBeNull();
    // 형식이 틀린 ID 로 행을 만들 수 없다
    expect((await studio.shopVideoOpAction(P, form({ platform: 'YOUTUBE', externalId: 'bad', op: 'pin' }))).ok).toBe(false);
    await studio.shopVideoOpAction(P, form({ platform: 'TIKTOK', externalId: v.externalId, op: 'delete' }));
    expect(await prisma.shopVideo.findUnique({ where: { id: v.id } })).toBeNull();
    // 다른 크리에이터 영상은 건드리지 못한다
    const theirs = await prisma.shopVideo.create({ data: { id: newId(), creatorId: other.creatorId, platform: 'TIKTOK', externalId: '99999999999', url: 'https://www.tiktok.com/@b/video/99999999999' } });
    await studio.shopVideoOpAction(P, form({ platform: 'TIKTOK', externalId: '99999999999', op: 'delete' }));
    expect(await prisma.shopVideo.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

describe('상품 진열 · 직접 상품', () => {
  it('관리자 상품 진열/내리기, 관리자 차단 상품은 다시 못 올림, 다른 크리에이터 직접 상품은 진열 불가', async () => {
    const pid = await adminProduct();
    expect((await studio.toggleDisplayAction(P, form({ productId: pid, on: '1' }))).ok).toBe(true);
    expect((await prisma.creatorProduct.findFirstOrThrow({ where: { creatorId: fx.creatorId, productId: pid } })).active).toBe(true);
    await studio.toggleDisplayAction(P, form({ productId: pid, on: '0' }));
    expect((await prisma.creatorProduct.findFirstOrThrow({ where: { creatorId: fx.creatorId, productId: pid } })).active).toBe(false);
    await prisma.creatorProduct.updateMany({ where: { creatorId: fx.creatorId, productId: pid }, data: { blocked: true } });
    expect((await studio.toggleDisplayAction(P, form({ productId: pid, on: '1' }))).message).toMatch(/판매를 중지/);
    const theirs = await saveProduct(parseProductForm(form({ name: '남의상품', price: '5000', status: 'ON_SALE', variants: '기본 | 0 | 1' }), { forAdmin: false }), { type: 'CREATOR', creatorId: other.creatorId });
    expect((await studio.toggleDisplayAction(P, form({ productId: theirs, on: '1' }))).ok).toBe(false);
  });

  it('판매자 정보 없이는 직접 상품 등록 불가 → 입력 후 등록하면 검수 대기 + 관리자 알림', async () => {
    const productForm = form({ name: '굿즈', price: '15000', shippingFee: '3000', status: 'ON_SALE', variants: 'S | 0 | 3' });
    const r1 = await studio.saveCreatorProductAction(P, productForm);
    expect(r1.ok).toBe(false);
    expect(r1.message).toMatch(/판매자 정보/);
    expect((await studio.saveSellerInfoAction(P, form({ sellerBizNo: '123' }))).ok).toBe(false);
    const s = await studio.saveSellerInfoAction(P, form({ sellerBizName: '굿즈샵', sellerBizNo: '1234567890', sellerCsPhone: '010-1111-2222', sellerReturnAddress: '서울 어딘가' }));
    expect(s.ok, s.message).toBe(true);
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } })).sellerBizNo).toBe('123-45-67890');
    // 신규 등록은 상세로 redirect
    await expect(studio.saveCreatorProductAction(P, productForm)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });
    const p = await prisma.product.findFirstOrThrow({ where: { creatorId: fx.creatorId, ownerType: 'CREATOR' } });
    expect(p.reviewStatus).toBe('PENDING');
    // 다른 크리에이터는 내 상품을 수정·삭제할 수 없다
    session.creator = { id: other.userId, creatorId: other.creatorId };
    await prisma.creatorProfile.update({ where: { id: other.creatorId }, data: { sellerBizName: 'x', sellerBizNo: '111-11-11111', sellerCsPhone: '010', sellerReturnAddress: 'y' } });
    const hijack = form({ id: p.id, name: '탈취', price: '1', status: 'ON_SALE', variants: 'S | 0 | 1' });
    expect((await studio.saveCreatorProductAction(P, hijack)).ok).toBe(false);
    expect((await studio.deleteCreatorProductAction(P, form({ id: p.id }))).ok).toBe(false);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).name).toBe('굿즈');
  });
});

describe('직접 상품 주문 처리 · 배송지 열람', () => {
  async function directOrder() {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { sellerBizName: '굿즈샵', sellerBizNo: '123-45-67890', sellerCsPhone: '010-1', sellerReturnAddress: '서울' } });
    const pid = await saveProduct(parseProductForm(form({ name: '굿즈', price: '10000', status: 'ON_SALE', variants: '기본 | 0 | 5' }), { forAdmin: false }), { type: 'CREATOR', creatorId: fx.creatorId });
    await prisma.product.update({ where: { id: pid }, data: { reviewStatus: 'APPROVED' } });
    const buyer = await prisma.user.create({ data: { id: newId(), email: `b-${newId()}@t.kr`, name: '구매자', role: 'DONOR' } });
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: pid } });
    await addToCart(buyer.id, fx.creatorId, pid, variant.id, 1);
    const ids = (await prisma.cartItem.findMany({ where: { userId: buyer.id } })).map((c) => c.id);
    const r = await placeOrder({ id: buyer.id, name: buyer.name }, { cartItemIds: ids, address: ADDR });
    expect(r.ok, r.message).toBe(true);
    return prisma.shopOrder.findFirstOrThrow({ where: { userId: buyer.id } });
  }

  it('내 주문만 발송·배송지 열람, 다른 크리에이터는 거절', async () => {
    const order = await directOrder();
    const addr = await studio.revealShippingAddressAction(P, form({ orderId: order.id }));
    expect(addr.ok, addr.message).toBe(true);
    expect(addr.secret).toContain('홍길동');
    expect(addr.secret).toContain('101동 202호');
    expect((await studio.creatorOrderOpAction(P, form({ orderId: order.id, op: 'ship', courier: 'CJ대한통운', trackingNo: '123456789012' }))).ok).toBe(true);
    expect((await prisma.shopOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SHIPPED');
    session.creator = { id: other.userId, creatorId: other.creatorId };
    expect((await studio.revealShippingAddressAction(P, form({ orderId: order.id }))).ok).toBe(false);
    expect((await studio.creatorOrderOpAction(P, form({ orderId: order.id, op: 'delivered' }))).ok).toBe(false);
  });
});

describe('최고관리자 액션 · 발주서 다운로드 권한', () => {
  it('크리에이터 수익률 저장·삭제, 운영 등급은 수익률 변경 불가', async () => {
    const r = await admin.saveCreatorCommission(P, form({ creatorCode: fx.creatorCode, rate: '12.5' }));
    expect(r.ok, r.message).toBe(true);
    expect((await prisma.creatorCommission.findUniqueOrThrow({ where: { creatorId: fx.creatorId } })).rate.toString()).toBe('0.125');
    await admin.saveCreatorCommission(P, form({ creatorCode: fx.creatorCode, rate: '' }));
    expect(await prisma.creatorCommission.findUnique({ where: { creatorId: fx.creatorId } })).toBeNull();
    session.adminPermission = 'OPERATION';
    expect((await admin.saveCreatorCommission(P, form({ creatorCode: fx.creatorCode, rate: '5' }))).ok).toBe(false);
    session.adminPermission = 'READ_ONLY';
    expect((await admin.saveSupplier(P, form({ name: '공급처' }))).ok).toBe(false);
  });

  it('발주서 CSV: 운영·최고관리자만, 교차 사이트·프리페치 차단', async () => {
    const supplier = await prisma.supplier.create({ data: { id: newId(), name: '공급처B' } });
    const po = await prisma.purchaseOrder.create({ data: { id: newId(), poNo: `PO-${newId().slice(-6)}`, supplierId: supplier.id } });
    const call = (headers: Record<string, string> = {}) => poRoute.GET(new Request(`http://localhost/api/admin/shop/po/${po.id}`, { headers }), { params: Promise.resolve({ id: po.id }) });
    session.adminPermission = 'READ_ONLY';
    expect((await call()).status).toBe(403);
    session.adminPermission = 'OPERATION';
    const ok = await call({ 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await ok.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // 엑셀 한글용 BOM
    expect(new TextDecoder().decode(bytes)).toContain('발주번호');
    expect((await call({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call({ 'sec-purpose': 'prefetch' })).status).toBe(403);
    const missing = await poRoute.GET(new Request('http://localhost/x'), { params: Promise.resolve({ id: 'nope' }) });
    expect(missing.status).toBe(404);
  });
});
