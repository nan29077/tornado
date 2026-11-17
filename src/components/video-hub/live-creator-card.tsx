import Link from 'next/link';
import { Radio } from '@/components/brand/icons';
import { LiveCardFrame } from '@/components/public/live-card-frame';
import { cx } from '@/components/ui';
import { liveThumbnailUrl } from '@/lib/shop-video-embed';
import { categoryLabel, platformSlugOf, videoPlatformLabel, type LiveCreator } from '@/lib/video-hub';


/** 지금 방송 중인 도네이도 크리에이터 카드. 누르면 그 크리에이터의 도네이도 샵(영상 탭: 라이브 시청 + 후원)으로 간다. */
export function LiveCreatorCard({ live, compact = false }: { live: LiveCreator; compact?: boolean }) {
  const details = [
    live.platform ? videoPlatformLabel(platformSlugOf(live.platform)) : null,
    live.category ? categoryLabel(live.category) : null,
    '도네이도 샵에서 시청·후원',
  ].filter(Boolean).join(' · ');

  return (
    <article className={cx('relative rounded-2xl border border-warm-200 bg-white p-1.5 transition-colors hover:bg-brand-50/70', compact ? 'w-[150px] shrink-0 snap-start sm:w-[168px]' : 'w-full')}>
      <Link href={`/c/${encodeURIComponent(live.code)}?tab=video`} target="_blank" rel="noopener" aria-label={`${live.displayName} 라이브 보기 (새 창)`} className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-2 focus-visible:outline-brand-500" prefetch={false} />
      <LiveCardFrame thumbnail={liveThumbnailUrl(live.liveUrl)} />
      <div className="mt-2 flex min-w-0 items-center gap-1.5 px-0.5">
        <Radio size={14} className="shrink-0 text-danger-600" aria-hidden />
        <p className="truncate text-[13.5px] font-extrabold text-ink-900">{live.displayName}</p>
      </div>
      <p className="mt-0.5 truncate px-0.5 text-[11.5px] text-ink-500">{details}</p>
    </article>
  );
}
