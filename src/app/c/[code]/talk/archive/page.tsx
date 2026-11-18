import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { FanArchive } from '@/components/talk/fan-archive';
import { getSessionUser } from '@/server/auth';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { getTalkConfig } from '@/server/services/engagement/config';
import { searchFanArchive } from '@/server/services/talk/talk';

export const dynamic = 'force-dynamic';
export const metadata = { title: '팬챗 보관함 | 도네이도', robots: { index: false, follow: false } };

/** 팬챗 보관함 — 크리에이터 메시지만 모아 보기 (구독 중일 때) */
export default async function TalkArchivePage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const base = `/c/${creator.code}/talk`;
  const user = await getSessionUser();
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(`${base}/archive`)}`);
  if (!(await getTalkConfig()).enabled) redirect(`/c/${creator.code}`);
  const r = await searchFanArchive(user, creator.id);
  if (!r.allowed) redirect(`/c/${creator.code}?tab=talk`);
  return (
    <CreatorDonateShell creator={creator} activeMenu="donate">
      <div className="py-5">
        <Link href={base} className="mb-3 inline-flex items-center gap-0.5 text-[13px] font-bold text-ink-500 hover:text-brand-800">
          <ChevronLeft size={15} aria-hidden />
          팬챗방으로
        </Link>
        <h1 className="mb-1 text-[20px] font-black tracking-[-0.03em] text-ink-900">{creator.displayName} 보관함</h1>
        <p className="mb-4 text-[12.5px] text-ink-500">크리에이터가 보낸 메시지만 모아 볼 수 있어요. 사진 · 음성 · 영상도 따로 볼 수 있어요.</p>
        <FanArchive creatorId={creator.id} initial={r.messages} />
      </div>
    </CreatorDonateShell>
  );
}
