'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, Clapperboard, ExternalLink, X } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { VIDEO_CATEGORIES, VIDEO_ORDERS, sortVideos, videoPlatformOf, videosHref, youtubeWatchUrl, type VideoCategorySlug, type VideoItem, type VideoOrder, type VideoPlatformSlug } from '@/lib/video-hub';
import { HubChipGrid, HubChipLink, PlatformSelect, type HubChip } from './hub-chip-grid';
import { VideoCard, VideoProfile } from './video-card';
import { VideoPlayer } from './video-player';
import { RemoteVideoSticker } from '@/components/shop/video-product-sticker';

/** PC와 모바일에서 같은 탭·스와이프 탐색을 제공하는 작은 미리보기. */
export function HomeVideoPane({
  items,
  now,
  inDialog = false,
  liveCount = 0,
  categories = [],
  hasShorts = false,
}: {
  items: VideoItem[];
  now: number;
  inDialog?: boolean;
  /** 지금 방송 중인 도네이도 크리에이터 수 */
  liveCount?: number;
  /** (이전 버전 호환용) 영상이 있는 카테고리. 2026-11-17 부터 방송국 카테고리를 모두 보여 준다 */
  categories?: VideoCategorySlug[];
  hasShorts?: boolean;
}) {
  const [order, setOrder] = React.useState<VideoOrder>('latest');
  // 1차 분류: 플랫폼 (셀렉트) — 패널 영상도 그 플랫폼으로 거른다
  const [platform, setPlatform] = React.useState<VideoPlatformSlug | 'all'>('all');
  void categories;
  const platformCounts = React.useMemo(() => {
    const count: Partial<Record<VideoPlatformSlug, number>> = {};
    for (const v of items) count[videoPlatformOf(v)] = (count[videoPlatformOf(v)] ?? 0) + 1;
    return count;
  }, [items]);
  const pool = React.useMemo(() => (platform === 'all' ? items : items.filter((v) => videoPlatformOf(v) === platform)), [items, platform]);
  // 2차 분류: 방송국 주제 카테고리 전체 (후원 가능 포함), 고른 플랫폼을 유지해 방송국으로 이동
  const topicChips = React.useMemo<HubChip[]>(
    () => VIDEO_CATEGORIES.filter((c) => c.slug !== 'all').map((c): HubChip => ({ key: `c:${c.slug}`, href: videosHref({ c: c.slug, p: platform }), label: c.label, tone: c.slug === 'donaido' ? 'brand' : 'normal' })),
    [platform],
  );
  const [position, setPosition] = React.useState(0);
  const [playing, setPlaying] = React.useState<VideoItem | null>(null);
  const rail = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const shown = React.useMemo(() => sortVideos(pool, order).slice(0, 8), [pool, order]);
  const moreHref = videosHref({ sort: order, p: platform });
  const canBrowse = !playing && shown.length > 1;

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
    <section aria-label="크리에이터 영상 미리보기" className={inDialog ? undefined : 'overflow-hidden rounded-[24px] border border-brand-200/75 bg-[linear-gradient(160deg,#fffae9_0%,#fffdf8_56%,#fff_100%)] p-3 shadow-[0_14px_36px_rgba(91,57,18,0.12)]'}>
      {inDialog ? null : (
        <div className="flex items-center justify-between gap-2 px-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-400 text-ink-900 shadow-[0_4px_9px_rgba(191,125,0,0.20)]"><Clapperboard size={17} strokeWidth={1.8} aria-hidden /></span>
            <h2 className="text-[15px] font-black leading-tight tracking-tight text-ink-900">크리에이터 영상</h2>
          </div>
          <Link href={moreHref} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-brand-200 bg-white px-2.5 text-[11px] font-extrabold text-brand-800 transition-colors hover:bg-brand-50">
            더 보기 <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      )}
      <div className={cx('space-y-2', !inDialog && 'mt-2.5')}>
        {/* 1차: 플랫폼 셀렉트 + 라이브 · 쇼츠 */}
        <div className="flex items-center gap-1.5">
          <PlatformSelect value={platform} counts={platformCounts} onChange={(next) => { setPlatform(next); setPlaying(null); setPosition(0); rail.current?.scrollTo({ left: 0 }); }} className="min-w-0 flex-1" />
          <HubChipLink chip={{ key: 'live', href: videosHref({ t: 'live', p: platform }), label: liveCount > 0 ? `라이브 ${liveCount}` : '라이브', tone: liveCount > 0 ? 'live-on' : 'live' }} />
          {hasShorts ? <HubChipLink chip={{ key: 'shorts', href: videosHref({ t: 'shorts', p: platform }), label: '쇼츠', tone: 'dark' }} /> : null}
        </div>
        {/* 2차: 주제 카테고리 한 줄 (옆으로 넘김) */}
        <HubChipGrid chips={topicChips} label="방송국 카테고리" />
      </div>
      <div className={cx('mb-2.5 mt-3 grid grid-cols-3 gap-1 rounded-xl p-1', inDialog ? 'bg-ink-50' : 'border border-brand-100 bg-brand-50')} role="tablist" aria-label="영상 정렬">
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
            className={cx(
              'min-h-9 rounded-lg text-[11px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-brand-500',
              order !== tab.value && 'text-ink-600 hover:bg-white hover:text-ink-900',
              order === tab.value && (inDialog ? 'bg-white text-brand-800 shadow-sm' : 'bg-brand-400 text-ink-900 shadow-sm'),
            )}>
            {tab.label}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${order}`}>
        {playing ? (
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="line-clamp-2 text-xs font-extrabold">{playing.title}</p>
              <button type="button" aria-label="영상 재생 닫기" onClick={() => setPlaying(null)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-ink-100">
                <X size={16} />
              </button>
            </div>
            <VideoPlayer
              item={playing}
              autoplay
              rounded="rounded-lg"
              overlay={playing.creator ? <RemoteVideoSticker key={playing.id} creatorCode={playing.creator.code} videoId={playing.id} /> : null}
            />
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
              <VideoCard item={item} now={now} onSelect={inDialog ? setPlaying : undefined} active={playing?.id === item.id} className={inDialog ? 'p-0!' : 'border border-warm-200 bg-white'} />
            </div>
          ))}
        </div>
        {!shown.length ? <p className="py-8 text-center text-sm text-ink-500">{platform === 'all' ? '아직 영상이 없어요.' : '이 플랫폼 영상은 아직 준비 중이에요.'}</p> : null}
      </div>
      {inDialog || canBrowse ? (
        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-warm-100 pt-2">
          {inDialog ? (
            <Link href={moreHref} className="inline-flex min-h-10 items-center gap-1 rounded-lg text-[12px] font-bold text-brand-800 hover:text-brand-900 focus-visible:outline-2 focus-visible:outline-brand-500">
              전체 영상 보기 <ArrowRight size={14} aria-hidden />
            </Link>
          ) : <span className="text-[11px] font-medium text-ink-500">옆으로 넘겨 보기</span>}
          {canBrowse ? (
            <div className="flex shrink-0 items-center gap-1">
              <span className="mr-1 text-[11px] tabular-nums text-ink-500" aria-live="polite">{position + 1} / {shown.length}</span>
              <button type="button" aria-label="이전 영상" disabled={position === 0} onClick={() => move(-1)} className={cx('grid place-items-center rounded-full border border-ink-100 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-30', inDialog ? 'size-10' : 'size-9')}><ChevronLeft size={16} aria-hidden /></button>
              <button type="button" aria-label="다음 영상" disabled={position >= shown.length - 1} onClick={() => move(1)} className={cx('grid place-items-center rounded-full border border-ink-100 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-30', inDialog ? 'size-10' : 'size-9')}><ChevronRight size={16} aria-hidden /></button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
