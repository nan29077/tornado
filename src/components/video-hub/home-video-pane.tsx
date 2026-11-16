'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, Clapperboard, ExternalLink, X } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { VIDEO_ORDERS, categoryLabel, sortVideos, videosHref, youtubeWatchUrl, type VideoCategorySlug, type VideoItem, type VideoOrder } from '@/lib/video-hub';
import { VideoCard, VideoProfile } from './video-card';
import { VideoPlayer } from './video-player';

/** PC와 모바일에서 같은 탭·스와이프 탐색을 제공하는 작은 미리보기. */
export function HomeVideoPane({
  items,
  now,
  inlinePlayback = false,
  liveCount = 0,
  categories = [],
  hasShorts = false,
}: {
  items: VideoItem[];
  now: number;
  inlinePlayback?: boolean;
  /** 지금 방송 중인 도네이도 크리에이터 수 */
  liveCount?: number;
  /** 영상이 있는 카테고리 (방송국 바로가기 칩) */
  categories?: VideoCategorySlug[];
  hasShorts?: boolean;
}) {
  const [order, setOrder] = React.useState<VideoOrder>('latest');
  const [position, setPosition] = React.useState(0);
  const [playing, setPlaying] = React.useState<VideoItem | null>(null);
  const rail = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const shown = React.useMemo(() => sortVideos(items, order).slice(0, 8), [items, order]);

  function choose(next: VideoOrder) {
    setOrder(next);
    setPlaying(null);
    setPosition(0);
  }

  function move(direction: number) {
    const el = rail.current;
    if (!el) return;
    const step = el.children[0]?.getBoundingClientRect().width ?? el.clientWidth;
    el.scrollBy({ left: direction * (step + 8), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  return (
    <section aria-label="크리에이터 영상 미리보기" className="overflow-hidden rounded-[24px] border border-brand-200/75 bg-[linear-gradient(160deg,#fffae9_0%,#fffdf8_56%,#fff_100%)] p-3 shadow-[0_14px_36px_rgba(91,57,18,0.12)]">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-400 text-ink-900 shadow-[0_4px_9px_rgba(191,125,0,0.20)]"><Clapperboard size={17} strokeWidth={1.8} aria-hidden /></span>
          <h2 className="text-[15px] font-black leading-tight tracking-tight text-ink-900">크리에이터 영상</h2>
        </div>
        <Link href={videosHref({ sort: order })} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-brand-200 bg-white px-2.5 text-[11px] font-extrabold text-brand-800 transition-colors hover:bg-brand-50">
          더 보기 <ArrowRight size={13} />
        </Link>
      </div>
      <nav aria-label="방송국 바로가기" className="-mx-0.5 mt-2.5 flex gap-1.5 overflow-x-auto px-0.5 pb-0.5 [scrollbar-width:none]">
        <Link href={videosHref({ t: 'live' })} className={cx('inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-extrabold', liveCount > 0 ? 'bg-danger-600 text-white' : 'border border-ink-100 bg-white text-ink-600')}>
          <span className={cx('h-1.5 w-1.5 rounded-full', liveCount > 0 ? 'animate-pulse bg-white' : 'bg-ink-300')} aria-hidden />
          라이브{liveCount > 0 ? ` ${liveCount}` : ''}
        </Link>
        {hasShorts ? (
          <Link href={videosHref({ t: 'shorts' })} className="inline-flex min-h-8 shrink-0 items-center rounded-full bg-ink-900 px-2.5 text-[11.5px] font-extrabold text-white">
            쇼츠
          </Link>
        ) : null}
        {categories.map((slug) => (
          <Link key={slug} href={videosHref({ c: slug })} className="inline-flex min-h-8 shrink-0 items-center rounded-full border border-brand-100 bg-white px-2.5 text-[11.5px] font-bold text-ink-700 hover:bg-brand-50">
            {categoryLabel(slug)}
          </Link>
        ))}
      </nav>
      <div className="mb-2.5 mt-3 grid grid-cols-3 gap-1 rounded-xl border border-brand-100 bg-brand-50 p-1" role="tablist" aria-label="영상 정렬">
        {VIDEO_ORDERS.map((tab, index) => (
          <button key={tab.value} id={`${id}-${tab.value}`} type="button" role="tab" aria-selected={order === tab.value}
            aria-controls={`${id}-panel`} tabIndex={order === tab.value ? 0 : -1}
            onClick={() => choose(tab.value)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
              if (next < 0) return;
              event.preventDefault();
              choose(VIDEO_ORDERS[next].value);
              document.getElementById(`${id}-${VIDEO_ORDERS[next].value}`)?.focus();
            }}
            className={cx('min-h-9 rounded-lg text-[11px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-brand-500', order === tab.value ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-600 hover:bg-white hover:text-ink-900')}>
            {tab.label}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${order}`}>
        {playing ? (
          <div className="mb-3 rounded-xl border border-warm-200 bg-warm-50 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="line-clamp-2 text-xs font-extrabold">{playing.title}</p>
              <button type="button" aria-label="영상 재생 닫기" onClick={() => setPlaying(null)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-ink-100">
                <X size={16} />
              </button>
            </div>
            <VideoPlayer item={playing} autoplay rounded="rounded-lg" />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
              <VideoProfile item={playing} />
              <a href={youtubeWatchUrl(playing.id)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 text-xs font-bold text-brand-800">
                YouTube에서 보기 <ExternalLink size={12} />
              </a>
            </div>
          </div>
        ) : null}
        <div key={order} ref={rail} onScroll={() => {
          const el = rail.current;
          if (!el?.clientWidth) return;
          const step = (el.children[0]?.getBoundingClientRect().width ?? el.clientWidth) + 8;
          const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
          setPosition(atEnd ? shown.length - 1 : Math.min(shown.length - 1, Math.round(el.scrollLeft / step)));
        }} className={playing ? 'hidden' : 'flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none]'}>
          {shown.map((item) => (
            <div key={item.id} className="w-[92%] shrink-0 snap-start xl:w-full">
              <VideoCard item={item} now={now} onSelect={inlinePlayback ? setPlaying : undefined} active={playing?.id === item.id} className="border border-warm-200 bg-white" />
            </div>
          ))}
        </div>
        {!shown.length ? <p className="py-8 text-center text-sm text-ink-500">아직 영상이 없어요.</p> : null}
      </div>
      {!playing && shown.length > 1 ? <div className="mt-1.5 flex items-center justify-between border-t border-warm-100 pt-2">
        <span className="text-[11px] font-medium text-ink-500">옆으로 넘겨 보기</span>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] tabular-nums text-ink-500" aria-live="polite">{shown.length ? position + 1 : 0} / {shown.length}</span>
          <button type="button" aria-label="이전 영상" disabled={position === 0} onClick={() => move(-1)} className="grid h-9 w-9 place-items-center rounded-full border border-ink-100 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-30"><ChevronLeft size={16} /></button>
          <button type="button" aria-label="다음 영상" disabled={position >= shown.length - 1} onClick={() => move(1)} className="grid h-9 w-9 place-items-center rounded-full border border-ink-100 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-30"><ChevronRight size={16} /></button>
        </div>
      </div> : null}
    </section>
  );
}
