import { MemberOrderList } from '@/components/shop/member-order-list';
import { getSessionUser } from '@/server/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** 마이페이지 > 주문·배송 (모든 크리에이터 샵 주문을 한곳에서) */
export default async function MyOrdersPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/my/orders');
  return <MemberOrderList userId={user.id} detailBase="/my/orders" />;
}
