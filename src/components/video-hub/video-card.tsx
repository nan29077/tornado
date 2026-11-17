import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, HeartHandshake, PlayCircle } from '@/components/brand/icons';
import { GeneratedAvatar, ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { formatViews, timeAgo, youtubeChannelUrl, type VideoItem } from '@/lib/video-hub';

/**
 * 영상 카드 (유튜브형).
 * 서버·클라이언트 양쪽에서 쓰는 표시 전용 컴포넌트라 훅을 쓰지 않는다.
 * - onSelect 가 있으면 버튼(메인 좌측 영역의 바로 재생), 없으면 /watch 로 가는 링크.
 * - now 는 서버가 정한 기준 시각. 서버·브라우저의 "N분 전" 표기가 어긋나지 않게 한다.
 */

export function VideoThumb({ item, className, rounded = 'rounded-xl' }: { item: VideoItem; className?: string; rounded?: string }) {
  return (
    <div className={cx('relative aspect-video w-full overflow-hidden bg-ink-100', rounded, className)}>
      {item.thumbnail ? (
        // 유튜브 썸네일(i.ytimg.com)은 next/image 최적화 대상에서 뺀다 (원격 도메인 설정을 늘리지 않는다).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.thumbnail}
          alt=""
          loading="lazy"
          decoding="async"
          width={480}
          height={360}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-[linear-gradient(135deg,#fff3cf_0%,#ffd77a_55%,#f2b541_100%)] text-brand-800">
          <PlayCircle size={34} strokeWidth={1.5} />
        </div>
      )}
      <div className="absolute left-1.5 top-1.5 flex gap-1">
        {item.source === 'sample' ? (
          <span className="rounded-md bg-ink-900/80 px-1.5 py-0.5 text-[10.5px] font-bold text-white">샘플</span>
        ) : null}
        {item.isShort ? (
          <span className="rounded-md bg-ink-900/80 px-1.5 py-0.5 text-[10.5px] font-bold text-white">쇼츠</span>
        ) : null}
      </div>
      {item.creator ? (
        <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-brand-400 px-1.5 py-0.5 text-[10.5px] font-extrabold text-ink-900 shadow-sm">
          <HeartHandshake size={12} strokeWidth={2} />
          후원 가능
        </span>
      ) : null}
    </div>
  );
}

export function VideoProfile({ item, detailed = false }: { item: VideoItem; detailed?: boolean }) {
  const creator = item.creator;
  const name = creator?.displayName ?? item.channelTitle;
  const avatarSize = detailed ? 'h-10 w-10' : 'h-7 w-7';
  const className = 'relative z-10 inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg text-left hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-brand-500';
  const content = (
    <>
      {creator ? (
        <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={name} imageUrl={creator.avatarUrl} className={avatarSize} />
      ) : item.channelAvatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.channelAvatarUrl} alt="" loading="lazy" decoding="async" className={cx('shrink-0 rounded-full bg-brand-50 object-cover', avatarSize)} />
      ) : (
        <GeneratedAvatar seed={item.channelId || name} name={name} className={avatarSize} />
      )}
      <span className="min-w-0">
        <span className={cx('block truncate font-bold', detailed ? 'text-[15px]' : 'text-xs')}>{name}</span>
        {detailed ? <span className="block text-xs text-ink-500">{creator ? '도네이도 샵' : 'YouTube 채널'}</span> : null}
      </span>
      {creator ? <ChevronRight size={14} className="shrink-0 text-brand-700" aria-hidden /> : null}
    </>
  );
  if (creator) {
    return <Link href={`/c/${encodeURIComponent(creator.code)}`} aria-label={`${name} 도네이도 샵`} className={className}>{content}</Link>;
  }
  if (item.source === 'youtube') {
    return <a href={youtubeChannelUrl(item.channelId)} target="_blank" rel="noopener noreferrer" aria-label={`${name} YouTube 채널`} className={className}>{content}</a>;
  }
  return (
    <span className={className}>{content}</span>
  );
}

function Meta({ item, now }: { item: VideoItem; now: number }) {
  const views = formatViews(item.views);
  const ago = timeAgo(item.publishedAt, now);
  return (
    <p className="mt-0.5 truncate text-[12px] text-ink-400">
      {[views, ago].filter(Boolean).join(' · ')}
    </p>
  );
}

export function VideoCard({
  item,
  now,
  onSelect,
  active = false,
  layout = 'grid',
  className,
}: {
  item: VideoItem;
  now: number;
  onSelect?: (item: VideoItem) => void;
  active?: boolean;
  /** grid: 유튜브 홈형(세로) / row: 시청 화면 우측 목록형(가로) */
  layout?: 'grid' | 'row';
  className?: string;
}) {
  const row = layout === 'row';
  const actionClass = 'absolute inset-0 z-[1] rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500';
  return (
    <article className={cx('relative w-full rounded-2xl p-1.5 text-left transition-colors hover:bg-brand-50/70', row && 'flex gap-2.5', active && 'bg-brand-50 ring-1 ring-brand-200', className)}>
      {onSelect ? (
        <button type="button" onClick={() => onSelect(item)} className={actionClass} aria-pressed={active} aria-label={`${item.title} 재생`} />
      ) : (
        <Link href={`/watch/${encodeURIComponent(item.id)}`} aria-label={`${item.title} 보기`} className={actionClass} prefetch={false} />
      )}
      <div className={row ? 'w-[34%] max-w-[168px] shrink-0' : undefined}>
        <VideoThumb item={item} rounded={row ? 'rounded-lg' : 'rounded-xl'} />
      </div>
      <div className={cx('min-w-0 flex-1', !row && 'mt-2.5')}>
        <p className="line-clamp-2 text-[14px] font-bold leading-snug text-ink-900">{item.title}</p>
        <div className="mt-1.5"><VideoProfile item={item} /></div>
        <Meta item={item} now={now} />
      </div>
    </article>
  );
}
