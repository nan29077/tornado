import { redirect } from 'next/navigation';
import { CheckCircle2 } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { MemberOrderList } from '@/components/shop/member-order-list';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { getSessionUser } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: '주문 내역 | 도네이도 샵', robots: { index: false, follow: false } };

export default async function ShopOrdersPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ done?: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const sp = await searchParams;
  const user = await getSessionUser().catch(() => null);
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(`/c/${creator.code}/orders`)}`);
  return (
    <CreatorDonateShell creator={creator} activeMenu="orders">
      <div className="py-6">
        <h1 className="text-[20px] font-black text-ink-900">주문 내역</h1>
      </div>
      {sp.done ? (
        <p className="mb-4 flex items-center gap-2 rounded-2xl bg-success-50 px-4 py-3 text-[13.5px] font-bold text-success-600">
          <CheckCircle2 size={17} strokeWidth={1.9} />
          주문이 완료되었습니다. 판매자가 상품을 준비하면 알림으로 알려 드릴게요.
        </p>
      ) : null}
      <MemberOrderList userId={user.id} />
    </CreatorDonateShell>
  );
}
