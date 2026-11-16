import Link from 'next/link';
import { Radio } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { categoryLabel, type LiveCreator } from '@/lib/video-hub';

const PLATFORM_LABEL: Record<string, string> = { YOUTUBE: 'YouTube', INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', FACEBOOK: 'Facebook' };

/** 지금 방송 중인 도네이도 크리에이터 카드. 누르면 그 크리에이터의 도네이도 샵(영상 탭: 라이브 시청 + 후원)으로 간다. */
export function LiveCreatorCard({ live, compact = false }: { live: LiveCreator; compact?: boolean }) {
  return (
    <article className={cx('relative rounded-2xl border border-warm-200 bg-white p-1.5 transition-colors hover:bg-brand-50/70', compact ? 'w-[150px] shrink-0 snap-start sm:w-[168px]' : 'w-full')}>
      <Link href={`/c/${encodeURIComponent(live.code)}?tab=video`} aria-label={`${live.displayName} 라이브 보기`} className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-2 focus-visible:outline-brand-500" prefetch={false} />
      <div className="relative grid aspect-video place-items-center overflow-hidden rounded-xl bg-[radial-gradient(circle_at_30%_20%,#fff3cf_0%,#ffd77a_45%,#f2a541_100%)]">
        <ProfileAvatar seed={live.code} avatarIndex={live.avatarIndex} name={live.displayName} imageUrl={live.avatarUrl} className={cx('ring-4 ring-white/80', compact ? 'h-12 w-12' : 'h-16 w-16')} />
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-danger-600 px-1.5 py-0.5 text-[10.5px] font-black text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
          LIVE
        </span>
        {live.platform ? <span className="absolute bottom-1.5 right-1.5 rounded-md bg-ink-900/75 px-1.5 py-0.5 text-[10.5px] font-bold text-white">{PLATFORM_LABEL[live.platform] ?? live.platform}</span> : null}
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 px-0.5">
        <Radio size={14} className="shrink-0 text-danger-600" aria-hidden />
        <p className="truncate text-[13.5px] font-extrabold text-ink-900">{live.displayName}</p>
      </div>
      <p className="mt-0.5 truncate px-0.5 text-[11.5px] text-ink-500">{live.category ? `${categoryLabel(live.category)} · ` : ''}도네이도 샵에서 시청·후원</p>
    </article>
  );
}
