import Link from 'next/link';
import { Search } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { VIDEO_CATEGORIES, VIDEO_ORDERS, VIDEO_TYPES, videosHref, type VideoCategorySlug, type VideoOrder, type VideoType } from '@/lib/video-hub';

export function VideoHubFilters({ category, query, sort, type = 'all', categories, liveCount = 0, counts }: {
  category: VideoCategorySlug;
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
        {sort !== 'latest' ? <input type="hidden" name="sort" value={sort} /> : null}
        <input key={query} aria-label="영상 제목 또는 채널 검색" name="q" type="search" maxLength={50} defaultValue={query} placeholder="영상 제목 · 채널 검색"
          className="h-11 min-w-0 flex-1 rounded-xl border border-ink-100 bg-ink-50 px-3 text-base outline-none focus:border-brand-500 sm:text-sm" />
        <button type="submit" aria-label="검색" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-400 text-ink-900 hover:bg-brand-500">
          <Search size={18} />
        </button>
      </form>
      <nav aria-label="영상 형식" className="grid grid-cols-4 gap-1 rounded-xl bg-ink-900/[0.04] p-1">
        {VIDEO_TYPES.map((t) => (
          <Link key={t.value} href={videosHref({ t: t.value, c: category, q: query, sort })} scroll={false}
            aria-current={type === t.value ? 'page' : undefined}
            className={cx('relative flex min-h-10 items-center justify-center gap-1 rounded-lg text-[12.5px] font-extrabold', type === t.value ? 'bg-ink-900 text-white shadow-sm' : 'text-ink-600 hover:text-ink-900')}>
            {t.value === 'live' ? <span className={cx('h-1.5 w-1.5 rounded-full', liveCount > 0 ? 'animate-pulse bg-danger-500' : 'bg-ink-300')} aria-hidden /> : null}
            {t.label}
            {t.value === 'live' && liveCount > 0 ? <span className="text-[10.5px] font-bold opacity-80">{liveCount}</span> : null}
          </Link>
        ))}
      </nav>
      {type !== 'live' ? (
        <nav aria-label="영상 정렬" className="grid grid-cols-3 gap-1 rounded-xl bg-ink-50 p-1">
          {VIDEO_ORDERS.map((order) => (
            <Link key={order.value} href={videosHref({ t: type, c: category, q: query, sort: order.value })} scroll={false}
              aria-current={sort === order.value ? 'page' : undefined}
              className={cx('flex min-h-10 items-center justify-center rounded-lg text-xs font-bold', sort === order.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900')}>
              {order.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {categories.length > 1 ? (
        <nav aria-label="영상 카테고리" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {VIDEO_CATEGORIES.filter(({ slug }) => categories.includes(slug)).map(({ slug, label }) => (
            <Link key={slug} href={videosHref({ t: type, c: slug, q: query, sort })} scroll={false} aria-current={category === slug ? 'page' : undefined}
              className={cx('inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-bold', category === slug ? 'bg-brand-100 text-brand-800' : 'bg-warm-50 text-ink-600 hover:bg-warm-100')}>
              {label}
              {slug !== 'all' && counts?.[slug] ? <span className="text-[10.5px] font-semibold opacity-60">{counts[slug]}</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
