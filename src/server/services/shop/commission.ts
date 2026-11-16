/**
 * 레퍼럴 수익률 결정 (관리자 상품).
 * 우선순위: 크리에이터×상품 개별 지정 > 크리에이터별 > 상품 기본값
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';

type Db = Pick<Prisma.TransactionClient, 'creatorProductCommission' | 'creatorCommission'>;

export interface RateSource {
  rate: string;
  source: 'CREATOR_PRODUCT' | 'CREATOR' | 'PRODUCT';
}

export async function resolveReferralRate(
  creatorId: string,
  product: { id: string; referralRate: Prisma.Decimal | string | number },
  db: Db = prisma,
): Promise<RateSource> {
  const [cp, c] = await Promise.all([
    db.creatorProductCommission.findUnique({ where: { creatorId_productId: { creatorId, productId: product.id } }, select: { rate: true } }),
    db.creatorCommission.findUnique({ where: { creatorId }, select: { rate: true } }),
  ]);
  if (cp) return { rate: cp.rate.toString(), source: 'CREATOR_PRODUCT' };
  if (c) return { rate: c.rate.toString(), source: 'CREATOR' };
  return { rate: product.referralRate.toString(), source: 'PRODUCT' };
}

export const RATE_SOURCE_LABEL: Record<RateSource['source'], string> = {
  CREATOR_PRODUCT: '이 상품 개별 지정',
  CREATOR: '크리에이터별 지정',
  PRODUCT: '상품 기본',
};
