/**
 * 테스트용 더미 데이터 넣기 · 정리 (2026-11-17) — 배포 전 정리 대상.
 *
 * - 모든 더미 행의 ID 는 demo- 로 시작한다. 정리는 이 접두사로만 찾는다(실제 데이터는 건드리지 않는다).
 * - 여러 번 실행해도 같은 결과가 되도록 전부 upsert 한다.
 * - 서버(DEMO_DATA=true 첫 접속)와 스크립트(scripts/demo-data.ts)가 함께 쓴다.
 *   그래서 prisma 클라이언트를 인자로 받고, env·db 모듈을 import 하지 않는다.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import {
  DEMO_CREATORS,
  DEMO_ID_PREFIX,
  DEMO_PRODUCTS,
  demoCreatorCode,
  demoCreatorId,
  demoProductId,
} from './catalog';

const pad = (n: number) => String(n).padStart(2, '0');
const userId = (n: number) => `${DEMO_ID_PREFIX}user-${pad(n)}`;

/** 크리에이터 n 의 샵에 진열할 상품 번호 (30개 중 10개씩 겹치게 돌려 가며) */
export function demoDisplayProducts(creatorN: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 10; k++) out.push((((creatorN - 1) * 5 + k) % DEMO_PRODUCTS.length) + 1);
  return out;
}

export async function seedDemoData(db: PrismaClient): Promise<{ creators: number; products: number }> {
  const now = new Date();

  for (const c of DEMO_CREATORS) {
    const id = demoCreatorId(c.n);
    const code = demoCreatorCode(c.n);
    await db.user.upsert({
      where: { id: userId(c.n) },
      create: {
        id: userId(c.n),
        email: `demo-creator-${pad(c.n)}@demo.donaido.invalid`,
        role: 'CREATOR',
        name: c.name,
        avatarIndex: c.avatarIndex,
      },
      update: { name: c.name, avatarIndex: c.avatarIndex, role: 'CREATOR', status: 'ACTIVE' },
    });
    const live = c.liveViewers != null;
    const profile = {
      displayName: c.name,
      channelName: `${c.name} 채널`,
      description: c.description,
      contentCategory: c.category,
      status: 'APPROVED' as const,
      approvedAt: now,
      liveOn: live,
      livePlatform: live ? (c.livePlatform ?? 'YOUTUBE') : null,
      youtubeLive: live && (c.livePlatform ?? 'YOUTUBE') === 'YOUTUBE',
      instagramLive: live && c.livePlatform === 'INSTAGRAM',
      tiktokLive: live && c.livePlatform === 'TIKTOK',
      shopDefaultTab: 'SHOP',
    };
    await db.creatorProfile.upsert({
      where: { id },
      create: { id, userId: userId(c.n), code, ...profile },
      update: profile,
    });
    await db.creatorCode.upsert({
      where: { id: `${DEMO_ID_PREFIX}code-${pad(c.n)}` },
      create: { id: `${DEMO_ID_PREFIX}code-${pad(c.n)}`, creatorId: id, code, active: true },
      update: { active: true },
    });
  }

  for (const p of DEMO_PRODUCTS) {
    const id = demoProductId(p.n);
    const data = {
      ownerType: 'ADMIN',
      name: p.name,
      category: p.category,
      summary: p.summary,
      description: `${p.summary}\n\n테스트용 샘플 상품입니다. 실제로 판매·배송되지 않습니다.`,
      thumbnailUrl: p.image,
      price: BigInt(p.price),
      listPrice: p.listPrice ? BigInt(p.listPrice) : null,
      shippingFee: BigInt(3000),
      freeShippingOver: BigInt(30000),
      referralRate: '0.100000',
      status: 'ON_SALE',
      reviewStatus: 'APPROVED',
      soldCount: p.soldCount,
      notice: [
        { label: '제조국', value: '대한민국' },
        { label: '안내', value: '테스트용 샘플 상품' },
      ],
      deletedAt: null,
    };
    await db.product.upsert({ where: { id }, create: { id, ...data }, update: data });
    for (let i = 0; i < p.variants.length; i++) {
      const vid = `${DEMO_ID_PREFIX}variant-${pad(p.n)}-${i + 1}`;
      await db.productVariant.upsert({
        where: { id: vid },
        create: { id: vid, productId: id, name: p.variants[i], stock: 999, sortOrder: i },
        update: { name: p.variants[i], active: true, sortOrder: i },
      });
    }
    const imgId = `${DEMO_ID_PREFIX}image-${pad(p.n)}-1`;
    await db.productImage.upsert({
      where: { id: imgId },
      create: { id: imgId, productId: id, url: p.image, sortOrder: 0 },
      update: { url: p.image },
    });
  }

  for (const c of DEMO_CREATORS) {
    const list = demoDisplayProducts(c.n);
    for (let i = 0; i < list.length; i++) {
      const pid = demoProductId(list[i]);
      const did = `${DEMO_ID_PREFIX}display-${pad(c.n)}-${pad(list[i])}`;
      await db.creatorProduct.upsert({
        where: { id: did },
        create: { id: did, creatorId: demoCreatorId(c.n), productId: pid, sortOrder: i },
        update: { active: true, blocked: false, sortOrder: i },
      });
    }
  }

  return { creators: DEMO_CREATORS.length, products: DEMO_PRODUCTS.length };
}

export interface DemoCleanResult {
  products: number;
  creators: number;
  /** 주문·정산 기록이 남아 지우지 못하고 숨김·정지 처리한 크리에이터 수 */
  creatorsSuspended: number;
}

/**
 * 더미 행 정리. demo- 접두사로만 찾는다.
 * - 상품: 장바구니·찜·진열은 함께 지워진다(Cascade). 주문 항목은 상품명 스냅샷이라 남아도 된다.
 * - 크리에이터: 테스트 중 주문·정산 기록이 생겼으면 FK 때문에 지울 수 없다 → 정지(SUSPENDED)로 숨긴다.
 */
export async function cleanDemoData(db: PrismaClient): Promise<DemoCleanResult> {
  const startsWith = { startsWith: DEMO_ID_PREFIX };
  await db.creatorProduct.deleteMany({ where: { OR: [{ id: startsWith }, { productId: startsWith }, { creatorId: startsWith }] } });
  const products = await db.product.deleteMany({ where: { id: startsWith } });

  const creators = await db.creatorProfile.findMany({ where: { id: startsWith }, select: { id: true, userId: true } });
  let removed = 0;
  let suspended = 0;
  for (const c of creators) {
    try {
      await db.$transaction([
        db.memberFollow.deleteMany({ where: { creatorId: c.id } }),
        db.creatorCode.deleteMany({ where: { creatorId: c.id } }),
        db.creatorProfile.delete({ where: { id: c.id } }),
        db.user.delete({ where: { id: c.userId } }),
      ]);
      removed++;
    } catch {
      await db.creatorProfile.update({ where: { id: c.id }, data: { status: 'SUSPENDED', liveOn: false, suspendedAt: new Date() } });
      await db.user.update({ where: { id: c.userId }, data: { status: 'SUSPENDED' } });
      suspended++;
    }
  }
  return { products: products.count, creators: removed, creatorsSuspended: suspended };
}
