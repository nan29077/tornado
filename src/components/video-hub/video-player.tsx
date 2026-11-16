import * as React from 'react';
import { PlayCircle } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { youtubeEmbedUrl, type VideoItem } from '@/lib/video-hub';

/**
 * 유튜브 공식 임베드 플레이어.
 * 샘플 항목은 실제 영상이 없으므로 재생하지 않고 안내만 보여 준다.
 */
export function VideoPlayer({
  item,
  autoplay = false,
  className,
  rounded = 'rounded-2xl',
}: {
  item: VideoItem;
  autoplay?: boolean;
  className?: string;
  /** 모서리 클래스. 모바일 시청 화면처럼 가장자리까지 붙일 때 바꾼다 */
  rounded?: string;
}) {
  return (
    <div className={cx('relative aspect-video w-full overflow-hidden bg-ink-900', rounded, className)}>
      {item.source === 'youtube' ? (
        <iframe
          key={item.id}
          src={youtubeEmbedUrl(item.id, autoplay)}
          title={item.title}
          className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-[linear-gradient(135deg,#2a2622_0%,#17161a_100%)] p-6 text-center text-white">
          <div>
            <PlayCircle size={44} strokeWidth={1.4} className="mx-auto text-brand-300" />
            <p className="mt-3 text-[15px] font-extrabold">샘플 영상은 재생되지 않습니다</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/75">
              실제 유튜브 채널이 등록되면 이 자리에서 영상이 재생됩니다.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
