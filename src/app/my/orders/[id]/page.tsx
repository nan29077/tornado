import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from '@/components/brand/icons';
import { MemberOrderList } from '@/components/shop/member-order-list';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export default async function MyOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/my/orders/${id}`)}`);
  const own = await prisma.shopOrder.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!own) notFound();
  return (
    <div>
      <Link href="/my/orders" className="mb-3 inline-flex items-center gap-1 text-[13px] font-bold text-ink-500">
        <ChevronLeft size={16} strokeWidth={2} /> 주문 목록
      </Link>
      <MemberOrderList userId={user.id} orderId={id} />
    </div>
  );
}
