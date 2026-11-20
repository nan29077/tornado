import { prisma } from '@/server/db';
import { donationSourceOf, type DonationSource } from '@/lib/labels';

/**
 * 후원 목록의 경로(문자 · 간편계좌이체 · 신용카드 · 영상)를 한 번에 구한다 (8차 점검, 2026-11-20).
 * 샵 후원(channel SHOP)만 결제 기록(shop_payment.kind)을 한 번 더 조회한다.
 */
export async function donationSources(rows: { id: string; channel: string }[]): Promise<Map<string, DonationSource>> {
  const shopIds = rows.filter((r) => r.channel === 'SHOP').map((r) => r.id);
  const kinds = new Map<string, string>();
  if (shopIds.length) {
    const pays = await prisma.shopPayment.findMany({ where: { donationId: { in: shopIds } }, select: { donationId: true, kind: true } });
    for (const p of pays) if (p.donationId) kinds.set(p.donationId, p.kind);
  }
  const out = new Map<string, DonationSource>();
  for (const r of rows) out.set(r.id, donationSourceOf(r.channel, kinds.get(r.id)));
  return out;
}
