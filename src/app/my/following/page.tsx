import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BellRing } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { ShopActionForm } from '@/components/shop/shop-action-form';
import { setFollowNotifyAction, toggleFollowAction } from '@/app/actions/shop';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

/** 마이페이지 > 구독 중인 크리에이터 */
export default async function MyFollowingPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/my/following');
  const follows = await prisma.memberFollow.findMany({
    where: { userId: user.id, creator: { status: 'APPROVED' } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, liveOn: true, user: { select: { avatarIndex: true } } } } },
  });
  if (follows.length === 0) {
    return (
      <div className="rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-12 text-center">
        <BellRing size={28} strokeWidth={1.5} className="mx-auto text-ink-300" />
        <p className="mt-2 text-[14px] font-bold text-ink-700">구독 중인 크리에이터가 없어요</p>
        <p className="mt-1 text-[12.5px] text-ink-400">크리에이터의 도네이도 샵에서 [구독하기]를 누르면 여기에 모입니다.</p>
        <Link href="/videos" className="mt-4 inline-block rounded-full bg-ink-900 px-4 py-2 text-[13px] font-bold text-white">
          크리에이터 영상 둘러보기
        </Link>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {follows.map((f) => (
        <li key={f.id} className="flex items-center gap-3 rounded-[1.25rem] border border-warm-300/70 bg-white p-3 shadow-card">
          <Link href={`/c/${f.creator.code}`} className="flex min-w-0 flex-1 items-center gap-3">
            <ProfileAvatar seed={f.creator.id} avatarIndex={f.creator.user.avatarIndex} name={f.creator.displayName} imageUrl={f.creator.avatarUrl} className="h-11 w-11 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-extrabold text-ink-900">{f.creator.displayName}</span>
              <span className="text-[12px] text-ink-400">{f.creator.liveOn ? '지금 방송 중' : '도네이도 샵 방문'}</span>
            </span>
          </Link>
          <ShopActionForm action={setFollowNotifyAction} hideMessage>
            <input type="hidden" name="creatorId" value={f.creator.id} />
            <input type="hidden" name="notify" value={f.notify ? '0' : '1'} />
            <button className="rounded-full border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-600">{f.notify ? '알림 끄기' : '알림 켜기'}</button>
          </ShopActionForm>
          <ShopActionForm action={toggleFollowAction} hideMessage confirm={`${f.creator.displayName} 구독을 해지할까요?`}>
            <input type="hidden" name="creatorId" value={f.creator.id} />
            <input type="hidden" name="on" value="0" />
            <button className="rounded-full px-2 py-1.5 text-[12px] font-bold text-ink-400">해지</button>
          </ShopActionForm>
        </li>
      ))}
    </ul>
  );
}
