import { prisma } from '@/server/db';
import { maskDisplayName } from '@/components/public/mask';

export const dynamic = 'force-dynamic';

const PAID = ['BROADCASTED', 'SETTLEMENT_PENDING', 'PARTIAL_DELIVERY_FAILED', 'SETTLED', 'BROADCAST_PENDING'] as const;

/**
 * 도네이도 샵 라이브 화면의 실시간 후원 (공개). 후원 페이지 "최근 후원"과 같은 범위(결제 완료, 이름 일부 공개).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const creator = await prisma.creatorProfile.findUnique({ where: { code: code.toUpperCase() }, select: { id: true, status: true } });
  if (!creator || creator.status !== 'APPROVED') return Response.json({ items: [] }, { status: 404 });
  const rows = await prisma.donation.findMany({
    where: { creatorId: creator.id, status: { in: [...PAID] }, isTest: false },
    orderBy: { paidAt: 'desc' },
    take: 15,
    select: { id: true, displayName: true, anonymous: true, amount: true, message: true, paidAt: true },
  });
  return Response.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        name: r.anonymous ? '익명' : maskDisplayName(r.displayName),
        amount: r.amount.toString(),
        message: r.message,
        at: r.paidAt?.toISOString() ?? null,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
