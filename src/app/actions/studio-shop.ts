'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { requireCreator } from '@/server/auth';
import { newId } from '@/lib/id';
import { isSiteImageSelection } from '@/lib/site-images';
import { parseVideoUrl } from '@/lib/shop-video-embed';
import { findTakenChannel, parseChannelsFromForm, replaceCreatorChannels } from '@/server/services/creator-application';
import { VIDEO_DONATION_MAX } from '@/server/services/shop/video-donation';
import { parseProductForm, saveProduct, sellerInfoMissing } from '@/server/services/shop/catalog';
import { markDelivered, markPreparing, markShipped, processClaim } from '@/server/services/shop/orders';
import { notifySuperAdmins } from '@/server/services/notifications';
import { openAddress } from '@/server/services/shop/address';
import type { StudioActionState } from './studio';

/**
 * 크리에이터 관리자 > 도네이도 샵 서버 액션 (2026-11-17).
 * 모든 액션은 requireCreator() 후 본인 creatorId 범위에서만 변경한다.
 */

type Ctx = { creatorId: string; userId: string; code: string };

async function withShop(fn: (c: Ctx) => Promise<StudioActionState>): Promise<StudioActionState> {
  let ctx: Ctx;
  try {
    const u = await requireCreator();
    const c = await prisma.creatorProfile.findUnique({ where: { id: u.creatorId }, select: { code: true } });
    if (!c) throw new Error('크리에이터 정보를 찾을 수 없습니다.');
    ctx = { creatorId: u.creatorId, userId: u.id, code: c.code };
  } catch (e) {
    return { ok: false, message: (e as Error).message || '크리에이터 권한이 필요합니다.' };
  }
  try {
    return await fn(ctx);
  } catch (e) {
    if ((e as { digest?: string })?.digest?.startsWith('NEXT_REDIRECT')) throw e;
    const message = (e as Error)?.message ?? '';
    if (!message || /prisma|invocation|ECONNREFUSED|ETIMEDOUT/i.test(message) || !/[가-힣]/.test(message)) {
      logger.error('샵 관리 액션 오류', { message });
      return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    return { ok: false, message };
  }
}

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function refreshShop(code: string) {
  revalidatePath(`/c/${code}`);
  revalidatePath('/studio/shop');
}

// ------------------------------------------------------------------ 샵 설정

export async function saveShopBasicsAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const tab = text(fd, 'shopDefaultTab');
    if (!['VIDEO', 'SHOP', 'DONATE'].includes(tab)) throw new Error('첫 화면 탭을 골라 주세요.');
    const margin = text(fd, 'shopMarginPreset');
    if (margin && !isSiteImageSelection('margin', margin)) throw new Error('여백 이미지를 다시 골라 주세요.');
    const minRaw = text(fd, 'shopDonationMin').replace(/[,\s원]/g, '');
    if (!/^\d{3,7}$/.test(minRaw)) throw new Error('영상 후원 최소 금액을 숫자로 입력해 주세요. (1,000원 이상)');
    const min = BigInt(minRaw);
    if (min < 1000n || min > VIDEO_DONATION_MAX) throw new Error('영상 후원 최소 금액은 1,000원 ~ 1,000,000원입니다.');
    const presetsRaw = text(fd, 'shopDonationPresets');
    const presets = presetsRaw
      .split(',')
      .map((v) => v.replace(/[^\d]/g, ''))
      .filter(Boolean);
    if (presets.length > 6) throw new Error('추천 금액은 6개까지 입력할 수 있습니다.');
    for (const p of presets) {
      const n = BigInt(p);
      if (n < min || n > VIDEO_DONATION_MAX) throw new Error(`추천 금액 ${Number(p).toLocaleString('ko-KR')}원은 최소 금액 이상, 1,000,000원 이하여야 합니다.`);
    }
    const data = {
      shopDefaultTab: tab,
      shopMarginPreset: margin || null,
      shopVideoDonation: fd.get('shopVideoDonation') != null,
      shopDonationMin: min,
      shopDonationPresets: presets.length ? presets.join(',') : null,
    };
    await prisma.creatorProfile.update({ where: { id: creatorId }, data });
    refreshShop(code);
    return { ok: true, message: '샵 설정을 저장했습니다.' };
  });
}

export async function saveShopChannelsAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const channels = parseChannelsFromForm(fd);
    // [6차 P1-4] 새로 넣은 채널 주소는 최고관리자 확인 전까지 샵 영상·공개 링크에 쓰지 않는다
    const pending = await prisma.$transaction(async (tx) => {
      const taken = await findTakenChannel(tx, channels, creatorId);
      if (taken) throw new Error(`이미 다른 크리에이터가 등록한 채널입니다: ${taken}`);
      const r = await replaceCreatorChannels(tx, creatorId, channels, { keepVerified: true });
      if (Object.keys(r.cols).length > 0) await tx.creatorProfile.update({ where: { id: creatorId }, data: r.cols });
      return r.pending;
    });
    if (pending > 0) {
      const c = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { displayName: true } });
      await notifySuperAdmins({ title: '채널 확인 요청', body: `${c?.displayName ?? ''} (${code}) · 새 채널 ${pending}개`, linkUrl: `/admin/creators/${creatorId}` }).catch(() => undefined);
    }
    refreshShop(code);
    return {
      ok: true,
      message: pending > 0
        ? `채널 ${channels.length}개를 저장했습니다. 새로 넣은 채널 ${pending}개는 운영팀이 본인 채널인지 확인한 뒤 샵에 반영됩니다.`
        : `채널 ${channels.length}개를 저장했습니다. 유튜브 채널의 새 영상은 영상 탭에 자동으로 올라옵니다.`,
    };
  });
}

export async function saveSellerInfoAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const bizNo = text(fd, 'sellerBizNo').replace(/[^\d]/g, '');
    if (bizNo && bizNo.length !== 10) throw new Error('사업자등록번호는 숫자 10자리입니다.');
    const phone = text(fd, 'sellerCsPhone').replace(/[^\d-]/g, '');
    if (phone && !/^\d[\d-]{7,14}$/.test(phone)) throw new Error('고객센터 연락처를 확인해 주세요.');
    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: {
        sellerBizName: text(fd, 'sellerBizName').slice(0, 60) || null,
        sellerBizNo: bizNo ? `${bizNo.slice(0, 3)}-${bizNo.slice(3, 5)}-${bizNo.slice(5)}` : null,
        sellerMailOrderNo: text(fd, 'sellerMailOrderNo').slice(0, 40) || null,
        sellerCsPhone: phone || null,
        sellerReturnAddress: text(fd, 'sellerReturnAddress').slice(0, 200) || null,
      },
    });
    refreshShop(code);
    return { ok: true, message: '판매자 정보를 저장했습니다. 직접 상품 상세 화면 하단에 표시됩니다.' };
  });
}

// ------------------------------------------------------------------ 영상

export async function addShopVideoAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const parsed = parseVideoUrl(text(fd, 'url'));
    if (!parsed) throw new Error('YouTube · TikTok · Instagram · Facebook 영상 주소(https)를 붙여 넣어 주세요.');
    const count = await prisma.shopVideo.count({ where: { creatorId, source: 'MANUAL' } });
    if (count >= 200) throw new Error('직접 등록 영상은 200개까지입니다. 오래된 영상을 지운 뒤 다시 시도해 주세요.');
    const title = text(fd, 'title').slice(0, 100) || null;
    await prisma.shopVideo.upsert({
      where: { creatorId_platform_externalId: { creatorId, platform: parsed.platform, externalId: parsed.externalId } },
      create: { id: newId(), creatorId, platform: parsed.platform, externalId: parsed.externalId, url: parsed.url, title, source: 'MANUAL' },
      update: { url: parsed.url, ...(title ? { title } : {}), hidden: false },
    });
    refreshShop(code);
    return { ok: true, message: '영상을 등록했습니다.' };
  });
}

export async function shopVideoOpAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const platform = text(fd, 'platform');
    const externalId = text(fd, 'externalId');
    const op = text(fd, 'op');
    if (!['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'].includes(platform) || !externalId || externalId.length > 60) throw new Error('영상을 찾을 수 없습니다.');
    const where = { creatorId_platform_externalId: { creatorId, platform, externalId } };
    if (op === 'delete') {
      await prisma.shopVideo.deleteMany({ where: { creatorId, platform, externalId, source: 'MANUAL' } });
    } else {
      const patch = op === 'hide' ? { hidden: true } : op === 'show' ? { hidden: false } : op === 'pin' ? { pinned: true } : op === 'unpin' ? { pinned: false } : null;
      if (!patch) throw new Error('알 수 없는 처리입니다.');
      // 자동 수집(유튜브) 영상은 설정 행(source AUTO)을 만들어 숨김·고정을 기억한다
      const url = platform === 'YOUTUBE' ? `https://www.youtube.com/watch?v=${externalId}` : '';
      const existing = await prisma.shopVideo.findUnique({ where, select: { id: true } });
      if (!existing && platform !== 'YOUTUBE') throw new Error('영상을 찾을 수 없습니다.');
      if (!existing && !/^[A-Za-z0-9_-]{11}$/.test(externalId)) throw new Error('영상을 찾을 수 없습니다.');
      await prisma.shopVideo.upsert({ where, create: { id: newId(), creatorId, platform, externalId, url, source: 'AUTO', ...patch }, update: patch });
    }
    refreshShop(code);
    return { ok: true, message: '반영했습니다.' };
  });
}

// ------------------------------------------------------------------ 상품

/** 관리자 상품을 내 샵에 진열/내리기 */
export async function toggleDisplayAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const productId = text(fd, 'productId');
    const on = text(fd, 'on') === '1';
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null, OR: [{ ownerType: 'ADMIN', reviewStatus: 'APPROVED' }, { ownerType: 'CREATOR', creatorId }] }, select: { id: true, ownerType: true } });
    if (!product) throw new Error('상품을 찾을 수 없습니다.');
    if (on) {
      const n = await prisma.creatorProduct.count({ where: { creatorId, active: true } });
      if (n >= 300) throw new Error('샵에는 상품을 300개까지 진열할 수 있습니다.');
    }
    const existing = await prisma.creatorProduct.findUnique({ where: { creatorId_productId: { creatorId, productId } }, select: { id: true, blocked: true } });
    if (existing?.blocked && on) throw new Error('관리자가 이 샵에서 판매를 중지한 상품입니다.');
    if (existing) await prisma.creatorProduct.update({ where: { id: existing.id }, data: { active: on } });
    else if (on) await prisma.creatorProduct.create({ data: { id: newId(), creatorId, productId } });
    refreshShop(code);
    revalidatePath('/studio/shop/products');
    return { ok: true, message: on ? '내 샵에 진열했습니다.' : '내 샵에서 내렸습니다.' };
  });
}

export async function moveDisplayAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const productId = text(fd, 'productId');
    const dir = text(fd, 'dir') === 'up' ? -1 : 1;
    const rows = await prisma.creatorProduct.findMany({ where: { creatorId, active: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], select: { id: true, productId: true } });
    const i = rows.findIndex((r) => r.productId === productId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rows.length) return { ok: true, message: '더 옮길 수 없습니다.' };
    [rows[i], rows[j]] = [rows[j], rows[i]];
    await prisma.$transaction(rows.map((r, idx) => prisma.creatorProduct.update({ where: { id: r.id }, data: { sortOrder: idx } })));
    refreshShop(code);
    revalidatePath('/studio/shop/products');
    return { ok: true, message: '순서를 바꿨습니다.' };
  });
}

/** 크리에이터 직접 상품 등록·수정 → 최고관리자 검수 대기 */
export async function saveCreatorProductAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const c = await prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { displayName: true, sellerBizName: true, sellerBizNo: true, sellerCsPhone: true, sellerReturnAddress: true } });
    const missing = c ? sellerInfoMissing(c) : ['판매자 정보'];
    if (missing.length) throw new Error(`직접 상품을 올리려면 판매자 정보를 먼저 입력해 주세요: ${missing.join(', ')} (샵 관리 > 판매자 정보)`);
    const id = text(fd, 'id') || undefined;
    const input = parseProductForm(fd, { forAdmin: false });
    const productId = await saveProduct(input, { type: 'CREATOR', creatorId }, id);
    await notifySuperAdmins({ title: '크리에이터 상품 검수 요청', body: `${c?.displayName ?? ''} · ${input.name}`, linkUrl: '/admin/shop/products?tab=creator' }).catch(() => undefined);
    refreshShop(code);
    revalidatePath('/studio/shop/products');
    if (!id) redirect(`/studio/shop/products/${productId}?saved=1`);
    return { ok: true, message: '저장했습니다. 최고관리자 검수 후 샵에 노출됩니다.' };
  });
}

export async function deleteCreatorProductAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, code }) => {
    const id = text(fd, 'id');
    const moved = await prisma.product.updateMany({ where: { id, ownerType: 'CREATOR', creatorId, deletedAt: null }, data: { deletedAt: new Date(), status: 'HIDDEN' } });
    if (moved.count === 0) throw new Error('상품을 찾을 수 없습니다.');
    await prisma.cartItem.deleteMany({ where: { variant: { productId: id } } });
    refreshShop(code);
    revalidatePath('/studio/shop/products');
    redirect('/studio/shop/products?tab=mine');
  });
}

// ------------------------------------------------------------------ 주문 (직접 상품)

export async function creatorOrderOpAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, userId }) => {
    const actor = { type: 'CREATOR' as const, creatorId, userId };
    const id = text(fd, 'orderId');
    const op = text(fd, 'op');
    if (op === 'preparing') await markPreparing(id, actor);
    else if (op === 'ship') await markShipped(id, actor, text(fd, 'courier'), text(fd, 'trackingNo'));
    else if (op === 'delivered') await markDelivered(id, actor);
    else throw new Error('알 수 없는 처리입니다.');
    revalidatePath('/studio/shop/orders');
    return { ok: true, message: '처리했습니다.' };
  });
}

export async function creatorClaimAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId, userId }) => {
    const approve = text(fd, 'decision') === 'APPROVE';
    await processClaim(text(fd, 'claimId'), { type: 'CREATOR', creatorId, userId }, approve, text(fd, 'reason'));
    revalidatePath('/studio/shop/orders');
    return { ok: true, message: approve ? '승인하고 구매자에게 전액 환불했습니다.' : '거절했습니다.' };
  });
}

/** 직접 상품 발송용 받는 분 전체 정보 (한 번만 보여 주고 저장하지 않는다) */
export async function revealShippingAddressAction(_p: StudioActionState, fd: FormData): Promise<StudioActionState> {
  return withShop(async ({ creatorId }) => {
    const order = await prisma.shopOrder.findFirst({
      where: { id: text(fd, 'orderId'), sellerType: 'CREATOR', sellerCreatorId: creatorId, status: { in: ['PAID', 'PREPARING', 'SHIPPED'] } },
      select: { recipientEnc: true, phoneEnc: true, addressEnc: true, zipcode: true, memo: true, orderNo: true },
    });
    if (!order) throw new Error('발송 대기 중인 내 직접 상품 주문만 배송지를 볼 수 있습니다.');
    const a = openAddress(order);
    logger.info('직접 상품 배송지 열람', { creatorId, orderNo: order.orderNo });
    return {
      ok: true,
      message: '배송지를 확인했습니다. 발송 외 용도로 쓰지 마세요.',
      secret: `${a.recipient} / ${a.phone} / (${a.zipcode}) ${a.address}${order.memo ? ` / 메모: ${order.memo}` : ''}`,
      secretLabel: `${order.orderNo} 배송지`,
      secretHint: '개인정보입니다. 발송에만 사용해 주세요.',
    };
  });
}
