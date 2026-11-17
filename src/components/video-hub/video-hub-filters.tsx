'use client';

import Link from 'next/link';
import { Search } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { HubChipGrid, PlatformSelect, type HubChip } from './hub-chip-grid';
import { VIDEO_CATEGORIES, VIDEO_ORDERS, VIDEO_TYPES, videosHref, type VideoCategorySlug, type VideoOrder, type VideoPlatformSlug, type VideoType } from '@/lib/video-hub';

export function VideoHubFilters({ category, platform = 'all', query, sort, type = 'all', categories, liveCount = 0, counts, platformCounts }: {
  category: VideoCategorySlug;
  /** 플랫폼 카테고리 (2026-11-17) */
  platform?: VideoPlatformSlug | 'all';
  platformCounts?: Partial<Record<VideoPlatformSlug, number>>;
  query: string;
  sort: VideoOrder;
  type?: VideoType;
  categories: VideoCategorySlug[];
  /** 지금 방송 중인 크리에이터 수 (라이브 탭 배지) */
  liveCount?: number;
  /** 카테고리별 영상 수 (칩 옆 숫자) */
  counts?: Partial<Record<VideoCategorySlug, number>>;
}) {
  return (
    <div className="sticky top-[68px] z-30 mt-4 space-y-2 rounded-2xl border border-warm-200 bg-white/95 px-2.5 py-2.5 backdrop-blur sm:px-3">
      <form action="/videos" method="get" role="search" aria-label="방송국 검색" className="flex gap-2">
        {type !== 'all' ? <input type="hidden" name="t" value={type} /> : null}
        {category !== 'all' ? <input type="hidden" name="c" value={category} /> : null}
        {platform !== 'all' ? <input type="hidden" name="p" value={platform} /> : null}
        {sort !== 'latest' ? <input type="hidden" name="sort" value={sort} /> : null}
        <input key={query} aria-label="영상 제목 또는 채널 검색" name="q" type="search" maxLength={50} defaultValue={query} placeholder="영상 제목 · 채널 검색"
          className="h-11 min-w-0 flex-1 rounded-xl border border-ink-100 bg-ink-50 px-3 text-base outline-none focus:border-brand-500 sm:text-sm" />
        <button type="submit" aria-label="검색" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-400 text-ink-900 hover:bg-brand-500">
          <Search size={18} />
        </button>
      </form>
      <nav aria-label="영상 형식" className="grid grid-cols-4 gap-1 rounded-xl bg-ink-900/[0.04] p-1">
        {VIDEO_TYPES.map((t) => (
          <Link key={t.value} href={videosHref({ t: t.value, c: category, p: platform, q: query, sort })} scroll={false}
            aria-current={type === t.value ? 'page' : undefined}
            className={cx('relative flex min-h-10 items-center justify-center gap-1 rounded-lg text-[12.5px] font-extrabold', type === t.value ? 'bg-ink-900 text-white shadow-sm' : 'text-ink-600 hover:text-ink-900')}>
            {t.value === 'live' ? <span className={cx('h-1.5 w-1.5 rounded-full', liveCount > 0 ? 'animate-pulse bg-danger-500' : 'bg-ink-300')} aria-hidden /> : null}
            {t.label}
            {t.value === 'live' && liveCount > 0 ? <span className="text-[10.5px] font-bold opacity-80">{liveCount}</span> : null}
          </Link>
        ))}
      </nav>
      {/* 1차 분류: 플랫폼(셀렉트) + 정렬 — 한 줄 */}
      <div className="flex items-center gap-2">
        <PlatformSelect
          value={platform}
          counts={platformCounts}
          size="md"
          className={type !== 'live' ? 'w-[132px] sm:w-[156px]' : 'w-full sm:w-[200px]'}
          hrefFor={(p) => videosHref({ t: type, c: category, p, q: query, sort })}
        />
        {type !== 'live' ? (
          <nav aria-label="영상 정렬" className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-xl bg-ink-50 p-1">
            {VIDEO_ORDERS.map((order) => (
              <Link key={order.value} href={videosHref({ t: type, c: category, p: platform, q: query, sort: order.value })} scroll={false}
                aria-current={sort === order.value ? 'page' : undefined}
                className={cx('flex min-h-8 items-center justify-center whitespace-nowrap rounded-lg text-xs font-bold', sort === order.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900')}>
                {order.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
      {/* 2차 분류: 주제 카테고리 — 한 줄, 옆으로 넘김 */}
      {categories.length > 1 ? (
        <HubChipGrid
          label="영상 카테고리"
          chips={VIDEO_CATEGORIES.filter(({ slug }) => categories.includes(slug)).map(({ slug, label }): HubChip => ({
            key: `c:${slug}`,
            href: videosHref({ t: type, c: slug, p: platform, q: query, sort }),
            label,
            tone: category === slug ? 'active' : slug === 'donaido' ? 'brand' : 'normal',
            count: slug !== 'all' ? counts?.[slug] : undefined,
          }))}
        />
      ) : null}
    </div>
  );
}
