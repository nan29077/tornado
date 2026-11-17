'use client';

import { useCallback, useState } from 'react';
import { cx } from '@/components/ui';

export function LiveCardFrame({ thumbnail, className }: {
  thumbnail?: string | null;
  className?: string;
}) {
  const [loadedThumbnail, setLoadedThumbnail] = useState<string | null>(null);
  const hasThumbnail = Boolean(thumbnail && thumbnail === loadedThumbnail);
  const checkCachedImage = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth > 0) setLoadedThumbnail(thumbnail ?? null);
  }, [thumbnail]);

  return (
    <div className={cx('relative isolate aspect-video overflow-hidden rounded-xl bg-[#2c1430] @container', className)}>
      {thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={thumbnail}
          src={thumbnail}
          alt=""
          loading="lazy"
          decoding="async"
          className={cx('absolute inset-0 h-full w-full object-cover', !hasThumbnail && 'opacity-0')}
          ref={checkCachedImage}
          onLoad={() => setLoadedThumbnail(thumbnail)}
          onError={() => setLoadedThumbnail(null)}
        />
      ) : null}
      {hasThumbnail ? (
        <span className="absolute left-1.5 top-1.5"><LiveBadge /></span>
      ) : (
        <>
          <div aria-hidden className="absolute inset-0 bg-[url('/assets/donaido-live-card-v2.webp')] bg-cover bg-center" />
          <span className="absolute left-1/2 top-[86%] flex -translate-x-1/2 -translate-y-1/2">
            <LiveBadge centered />
          </span>
        </>
      )}
    </div>
  );
}

export function LiveBadge({ centered = false }: { centered?: boolean }) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1.5 whitespace-nowrap bg-danger-600 font-black text-white',
      centered
        ? 'rounded-full px-[clamp(8px,3.5cqw,20px)] py-[clamp(2px,0.65cqw,5px)] text-[clamp(10px,3.1cqw,16px)] leading-none shadow-md ring-1 ring-white/35'
        : 'rounded-md px-1.5 py-0.5 text-[10.5px]',
    )}>
      <span className="size-1.5 shrink-0 rounded-full bg-white motion-safe:animate-pulse" aria-hidden />
      {centered ? '라이브 중' : 'LIVE'}
    </span>
  );
}
