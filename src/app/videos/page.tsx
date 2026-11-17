import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowDown, ArrowRight, Clapperboard, Radio, SearchX } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { VideoHubFilters } from '@/components/video-hub/video-hub-filters';
import { VideoCard, VideoProfile } from '@/components/video-hub/video-card';
import { LiveCreatorCard } from '@/components/video-hub/live-creator-card';
import { AutoRail } from '@/components/public/auto-rail';
import { CONTENT_CATEGORY_SLUGS, categoryLabel, isVideoCategory, videosHref, videoOrder, videoType, sortVideos, type LiveCreator, type VideoCategorySlug, type VideoItem, type VideoType } from '@/lib/video-hub';
import { getLiveCreators, getVideoFeed, isVideoHubEnabled } from '@/server/services/video-hub';
import { filterVideos } from '@/server/services/video-hub-parse';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '방송국',
  description: '시사·정치·유머·게임·먹방 등 카테고리별 영상과 쇼츠, 지금 방송 중인 라이브를 모아 보고 도네이도 크리에이터에게 바로 후원하세요.',
};

const PAGE = 24;
const MAX = 240;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string | string[]; q?: string | string[]; limit?: string | string[]; sort?: string | string[]; t?: string | string[] }>;
}) {
  if (!isVideoHubEnabled()) notFound();
  const sp = await searchParams;
  const cRaw = first(sp.c);
  const c = isVideoCategory(cRaw) ? cRaw : 'all';
  const q = first(sp.q).trim().slice(0, 50);
  const sort = videoOrder(first(sp.sort));
  const limitNum = Number.parseInt(first(sp.limit), 10);
  const limit = Number.isFinite(limitNum) ? Math.min(Math.max(limitNum, PAGE), MAX) : PAGE;

  const type: VideoType = videoType(first(sp.t));

  const [feed, lives] = await Promise.all([getVideoFeed(), getLiveCreators()]);
  const { curated, now } = feed;
  const filtered = sortVideos(filterVideos(feed.items, { c, q }), sort);
  const items = type === 'shorts' ? filtered.filter((v) => v.isShort) : type === 'video' ? filtered.filter((v) => !v.isShort) : filtered;
  const liveShown = filterLives(lives, c, q);

  const counts: Partial<Record<VideoCategorySlug, number>> = {};
  const categories = new Set<VideoCategorySlug>(['all', c]);
  for (const item of feed.items) {
    if (type === 'shorts' && !item.isShort) continue;
    if (type === 'video' && item.isShort) continue;
    categories.add(item.category);
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    if (item.creator) {
      categories.add('donaido');
      counts.donaido = (counts.donaido ?? 0) + 1;
    }
  }
  for (const l of lives) if (l.category) categories.add(l.category);

  // 유튜브 홈처럼: 전체 첫 화면에서는 라이브 → 영상 → 쇼츠 선반 → 카테고리별 선반 → 나머지 영상
  const home = type === 'all' && c === 'all' && !q;
  const shelfShorts = type === 'all' && !q ? items.filter((v) => v.isShort).slice(0, 14) : [];
  const main = type === 'all' && shelfShorts.length > 0 ? items.filter((v) => !v.isShort) : items;
  const visible = main.slice(0, limit);
  const head = visible.slice(0, 8);
  const rest = visible.slice(8);
  const shelves = home ? categoryShelves(main) : [];
  const heading = q
    ? `‘${q}’ 검색 결과 ${(type === 'live' ? liveShown.length : items.length).toLocaleString('ko-KR')}개`
    : `${c === 'all' ? '' : `${categoryLabel(c)} `}${type === 'shorts' ? '쇼츠' : type === 'live' ? '라이브' : type === 'video' ? '동영상' : c === 'all' ? '전체 영상' : '영상'}`;

  return (
    <PublicShell>
      <header className="flex items-center gap-3 rounded-[22px] border border-brand-100 bg-brand-50 p-4 sm:p-5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-400 text-ink-900"><Clapperboard size={22} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-black tracking-tight text-ink-900">방송국</h1>
          <p className="mt-0.5 text-[13px] text-ink-600">시사·정치·유머부터 게임·먹방까지, 영상 · 쇼츠 · 라이브</p>
        </div>
        {lives.length > 0 ? (
          <Link href={videosHref({ t: 'live' })} className="hidden shrink-0 items-center gap-1.5 rounded-full bg-danger-600 px-3 py-1.5 text-[12px] font-black text-white sm:inline-flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden /> LIVE {lives.length}
          </Link>
        ) : null}
      </header>

      <VideoHubFilters category={c} query={q} sort={sort} type={type} categories={[...categories]} liveCount={lives.length} counts={counts} />

      {type === 'live' ? (
        <LiveSection lives={liveShown} query={q} category={c} />
      ) : (
        <>
          {home && lives.length > 0 ? (
            <section className="mt-5" aria-labelledby="live-shelf-title">
              <ShelfHeader id="live-shelf-title" title="지금 라이브" href={videosHref({ t: 'live' })} live />
              <AutoRail bleed={false} gap="gap-3 pr-3" className="pb-2" controls label="지금 라이브">
                {lives.slice(0, 12).map((l) => (
                  <LiveCreatorCard key={l.code} live={l} compact />
                ))}
              </AutoRail>
            </section>
          ) : null}

          <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
            <h2 className="min-w-0 break-words text-[15px] font-extrabold text-ink-900">{heading}</h2>
            {curated ? <p className="text-xs text-ink-500">YouTube 공개 영상</p> : null}
          </div>
          {sort === 'popular' && items.length > 0 && items.every((item) => item.views === null) ? (
            <p className="mt-1 px-1 text-xs text-ink-500">조회수 정보가 없어 최신순으로 표시해요.</p>
          ) : null}

          {visible.length === 0 && shelfShorts.length === 0 ? (
            <div className="mx-auto mt-16 max-w-sm text-center">
              <SearchX size={40} strokeWidth={1.4} className="mx-auto text-ink-300" />
              <p className="mt-3 text-[15px] font-extrabold text-ink-900">{q ? '검색 결과가 없어요' : type === 'shorts' ? '아직 쇼츠가 없어요' : '아직 영상이 없어요'}</p>
              <p className="mt-1 text-[13px] text-ink-500">다른 카테고리를 골라 보거나 검색어를 바꿔 보세요.</p>
              <Link href="/videos" className="mt-4 inline-block text-[13.5px] font-extrabold text-brand-700">
                전체 영상 보기
              </Link>
            </div>
          ) : type === 'shorts' ? (
            <>
              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
                {visible.map((v) => (
                  <ShortCard key={v.id} item={v} fluid />
                ))}
              </div>
              <LoadMore show={main.length > visible.length && limit < MAX} href={videosHref({ t: type, c, q, sort, limit: limit + PAGE })} />
            </>
          ) : (
            <>
              <VideoGrid items={head} now={now} />
              {shelfShorts.length > 0 ? (
                <section className="mt-6" aria-labelledby="shorts-title">
                  <ShelfHeader id="shorts-title" title="쇼츠" href={videosHref({ t: 'shorts', c, sort })} />
                  <AutoRail bleed={false} gap="gap-3 pr-3" className="pb-2" speed={20} controls label="쇼츠">
                    {shelfShorts.map((v) => (
                      <ShortCard key={v.id} item={v} />
                    ))}
                  </AutoRail>
                </section>
              ) : null}
              {shelves.map((shelf) => (
                <section key={shelf.slug} className="mt-6" aria-labelledby={`shelf-${shelf.slug}`}>
                  <ShelfHeader id={`shelf-${shelf.slug}`} title={categoryLabel(shelf.slug)} href={videosHref({ c: shelf.slug, sort })} />
                  {/* 자동 흐름 선반 안에서는 % 폭이 계산되지 않아 고정 폭으로 둔다 */}
                  <AutoRail bleed={false} gap="gap-3 pr-3" className="pb-2" controls label={categoryLabel(shelf.slug)}>
                    {shelf.items.map((v) => (
                      <div key={v.id} className="w-[264px] shrink-0 sm:w-[300px]">
                        <VideoCard item={v} now={now} className="border border-warm-200 bg-white" />
                      </div>
                    ))}
                  </AutoRail>
                </section>
              ))}
              {rest.length > 0 ? (
                <>
                  {home ? <h2 className="mt-7 px-1 text-[15px] font-extrabold text-ink-900">최근 올라온 영상</h2> : null}
                  <VideoGrid items={rest} now={now} />
                </>
              ) : null}
              <LoadMore show={main.length > visible.length && limit < MAX} href={videosHref({ t: type, c, q, sort, limit: limit + PAGE })} />
            </>
          )}
        </>
      )}
    </PublicShell>
  );
}

/** 카테고리별 선반: 영상이 4편 이상인 카테고리를 목록 순서대로, 최대 12개 */
function categoryShelves(items: VideoItem[]): Array<{ slug: VideoCategorySlug; items: VideoItem[] }> {
  const by = new Map<VideoCategorySlug, VideoItem[]>();
  for (const v of items) {
    const list = by.get(v.category) ?? [];
    if (list.length < 10) list.push(v);
    by.set(v.category, list);
  }
  return CONTENT_CATEGORY_SLUGS.filter((slug) => (by.get(slug)?.length ?? 0) >= 4)
    .slice(0, 12)
    .map((slug) => ({ slug, items: by.get(slug)! }));
}

function filterLives(lives: LiveCreator[], c: VideoCategorySlug, q: string): LiveCreator[] {
  const needle = q.toLowerCase();
  return lives.filter((l) => (c === 'all' || c === 'donaido' || l.category === c) && (!needle || l.displayName.toLowerCase().includes(needle)));
}

function ShelfHeader({ id, title, href, live = false }: { id: string; title: string; href: string; live?: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 px-1">
      <h2 id={id} className="flex items-center gap-1.5 text-[17px] font-black text-ink-900">
        {live ? <Radio size={17} className="text-danger-600" aria-hidden /> : null}
        {title}
      </h2>
      <Link href={href} className="inline-flex min-h-9 items-center gap-0.5 rounded-full px-2 text-[12.5px] font-extrabold text-brand-800 hover:bg-brand-50">
        더보기 <ArrowRight size={13} />
      </Link>
    </div>
  );
}

function LoadMore({ show, href }: { show: boolean; href: string }) {
  if (!show) return null;
  return (
    <div className="mt-6 flex justify-center">
      <Link href={href} scroll={false} className="inline-flex h-11 items-center gap-1.5 rounded-full border border-ink-200 bg-white px-6 text-[13.5px] font-extrabold text-ink-900 shadow-sm hover:bg-ink-50">
        더 불러오기
        <ArrowDown size={15} strokeWidth={2} />
      </Link>
    </div>
  );
}

function LiveSection({ lives, query, category }: { lives: LiveCreator[]; query: string; category: VideoCategorySlug }) {
  return (
    <section className="mt-5" aria-labelledby="live-title">
      <h2 id="live-title" className="flex items-center gap-1.5 px-1 text-[15px] font-extrabold text-ink-900">
        <Radio size={16} className="text-danger-600" aria-hidden /> 지금 방송 중 {lives.length > 0 ? lives.length : ''}
      </h2>
      <p className="mt-1 px-1 text-[12.5px] text-ink-500">도네이도 크리에이터의 라이브예요. 누르면 크리에이터 샵에서 방송을 보면서 바로 후원할 수 있어요.</p>
      {lives.length === 0 ? (
        <div className="mx-auto mt-14 max-w-sm text-center">
          <Radio size={40} strokeWidth={1.4} className="mx-auto text-ink-300" />
          <p className="mt-3 text-[15px] font-extrabold text-ink-900">{query || category !== 'all' ? '조건에 맞는 라이브가 없어요' : '지금 방송 중인 크리에이터가 없어요'}</p>
          <p className="mt-1 text-[13px] text-ink-500">방송이 시작되면 여기에 바로 나타나요. 그동안 영상과 쇼츠를 둘러보세요.</p>
          <Link href="/videos" className="mt-4 inline-block text-[13.5px] font-extrabold text-brand-700">
            영상 보러 가기
          </Link>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {lives.map((l) => (
            <LiveCreatorCard key={l.code} live={l} />
          ))}
        </div>
      )}
    </section>
  );
}

function VideoGrid({ items, now }: { items: VideoItem[]; now: number }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
      {items.map((v) => (
        <VideoCard key={v.id} item={v} now={now} className="border border-warm-200 bg-white" />
      ))}
    </div>
  );
}

function ShortCard({ item, fluid = false }: { item: VideoItem; fluid?: boolean }) {
  return (
    <article className={fluid ? 'min-w-0' : 'w-[132px] shrink-0 snap-start sm:w-[150px]'}>
      <Link href={`/watch/${encodeURIComponent(item.id)}`} prefetch={false} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-brand-500">
        <div className="relative aspect-[9/16] overflow-hidden rounded-xl bg-ink-100">
          {item.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.thumbnail} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 bg-[linear-gradient(160deg,#fff3cf_0%,#ffd77a_55%,#f2b541_100%)]" />
          )}
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] font-bold leading-snug text-ink-900">{item.title}</p>
      </Link>
      <div className="mt-1.5"><VideoProfile item={item} /></div>
    </article>
  );
}
