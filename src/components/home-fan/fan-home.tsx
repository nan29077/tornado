import Link from 'next/link';
import {
  ArrowRight, Bell, CreditCard, HeartHandshake, MessageSquare, ShieldCheck, Sparkles,
} from '@/components/brand/icons';
import { CreatorCodeForm } from '@/components/creator-code-form';
import { BannerStrip } from '@/components/public/banner-strip';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { VideoCard } from '@/components/video-hub/video-card';
import { Card, CardTitle, SectionTitle } from '@/components/ui';
import { CONTENT_CATEGORY_SLUGS, categoryLabel, sortVideos, videosHref } from '@/lib/video-hub';
import { formatKst } from '@/lib/datetime';
import type { FanHomeData } from '@/server/services/home-fan';
import { BrowseAll } from './browse-all';
import { ComingSoonSticker } from './coming-soon-sticker';
import { WatchingCounter } from './watching-counter';
import {
  ChannelAvatar, FanChannelCard, FanCreatorCard, FanLiveCard, FanProductCard, Rail, UnregisteredBadge, compactKo, won,
} from './parts';

/**
 * 메인 [구독자 전용] 탭 (2026-11-17).
 * 섹션 순서: 시청 중 인원 → 크리에이터 찾기 → 이벤트 배너 → 지금 라이브 → 방송국 → 도네이도 크리에이터
 *          → 방송국 인기 채널 → 샵 인기 상품 → 내 구독 → 이번 주 주목 → 카테고리 → 후원 방법 → 공지 → 전체 둘러보기
 * 데이터가 없는 섹션은 숨긴다(상품만 "준비 중" 스티커).
 */
/** KST 기준 MM.DD */
function HeadRow({ id, title, href, link }: { id?: string; title: string; href: string; link: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-2">
      <h2 id={id} className="text-[18px] font-black tracking-[-0.025em] text-ink-900 sm:text-[19px]">{title}</h2>
      <Link href={href} className="shrink-0 text-[13px] font-semibold text-brand-700">{link}</Link>
    </div>
  );
}

function mmdd(iso: string): string {
  return formatKst(new Date(iso), false).slice(5, 10).replace('-', '.');
}

export function FanHome({ data, loggedIn }: { data: FanHomeData; loggedIn: boolean }) {
  const shorts = data.feed.filter((v) => v.isShort);
  const videos = sortVideos(data.feed.filter((v) => !v.isShort), 'recommended').slice(0, 4);
  const browseVideos = sortVideos(data.feed, 'popular').slice(0, 120);
  const creatorsPopular = [...data.creators].sort((a, b) => b.subscribers - a.subscribers).slice(0, 12);
  const newCreators = [...data.creators]
    .filter((c) => c.approvedAt)
    .sort((a, b) => Date.parse(b.approvedAt!) - Date.parse(a.approvedAt!))
    .slice(0, 6);
  const quickCats = CONTENT_CATEGORY_SLUGS.slice(0, 11);

  return (
    <div data-home-tab="fan">
      <WatchingCounter viewers={data.watching.viewers} liveCount={data.watching.liveCount} />

      {/* 1. 크리에이터 찾기 (크리에이터 전용 탭에서 옮겨 왔다) */}
      <section className="mt-4">
        <Card className="border border-brand-100">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
              <Sparkles size={17} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>크리에이터 찾기</CardTitle>
              <p className="text-[12px] text-ink-400">코드 · 유튜브 채널명 · 닉네임으로 검색하세요.</p>
            </div>
          </div>
          <CreatorCodeForm />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
            승인된 크리에이터만 검색됩니다. 크리에이터 코드뿐 아니라 유튜브 채널명이나 닉네임으로도 후원 페이지에 접근할 수 있습니다.
          </p>
        </Card>
      </section>

      <BannerStrip position="FAN_TOP" className="mt-4" />

      {/* 2. 지금 라이브 */}
      {data.live.length > 0 ? (
        <section className="mt-8" aria-labelledby="fan-live">
          <div className="mb-3 flex items-end justify-between gap-2">
            <h2 id="fan-live" className="text-[18px] font-black tracking-[-0.025em] text-ink-900 sm:text-[19px]">지금 라이브</h2>
            <Link href={videosHref({ t: 'live' })} className="text-[13px] font-semibold text-brand-700">전체 보기</Link>
          </div>
          <Rail>
            {data.live.slice(0, 12).map((l) => <FanLiveCard key={l.key} item={l} />)}
          </Rail>
        </section>
      ) : null}

      {/* 3. 방송국 */}
      {videos.length > 0 ? (
        <section className="mt-8" aria-labelledby="fan-broadcast">
          <div className="mb-2 flex items-end justify-between gap-2">
            <h2 id="fan-broadcast" className="text-[18px] font-black tracking-[-0.025em] text-ink-900 sm:text-[19px]">방송국</h2>
            <Link href="/videos" className="text-[13px] font-semibold text-brand-700">방송국 전체보기</Link>
          </div>
          <Rail className="mb-2">
            {[{ slug: 'all', label: '전체' }, ...quickCats.slice(0, 8).map((s) => ({ slug: s, label: categoryLabel(s) }))].map((c) => (
              <Link
                key={c.slug}
                href={videosHref({ c: c.slug })}
                className="shrink-0 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-[12.5px] font-bold text-ink-700 hover:border-brand-300 hover:bg-brand-50"
              >
                {c.label}
              </Link>
            ))}
          </Rail>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {videos.map((v) => <VideoCard key={v.id} item={v} now={data.now} />)}
          </div>
          {shorts.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 text-[14px] font-extrabold text-ink-900">쇼츠</p>
              <Rail>
                {shorts.slice(0, 10).map((s) => (
                  <Link key={s.id} href={`/watch/${encodeURIComponent(s.id)}`} prefetch={false} className="relative w-[118px] shrink-0 snap-start">
                    <div className="relative aspect-[9/16] overflow-hidden rounded-xl bg-ink-100">
                      {s.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.thumbnail} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[12px] font-bold leading-snug text-ink-900">{s.title}</p>
                    {s.views != null ? <p className="text-[11px] text-ink-400">조회수 {compactKo(s.views)}회</p> : null}
                  </Link>
                ))}
              </Rail>
            </div>
          ) : null}
          {data.curated ? <p className="mt-2 text-[11.5px] text-ink-400">채널 소식을 불러오는 중이라 선별 영상을 먼저 보여 드려요.</p> : null}
        </section>
      ) : null}

      {/* 4. 도네이도 크리에이터 (가입 · 후원 가능) */}
      {creatorsPopular.length > 0 ? (
        <section className="mt-8">
          <SectionTitle title="도네이도 크리에이터" description="도네이도에 가입한 크리에이터예요. 문자 한 통으로 바로 후원할 수 있어요." />
          <Rail>
            {creatorsPopular.map((c) => <FanCreatorCard key={c.id} creator={c} />)}
          </Rail>
          {newCreators.length > 0 ? (
            <div className="mt-3 flex items-center gap-2 overflow-x-auto [scrollbar-width:none]">
              <span className="shrink-0 rounded-md bg-brand-50 px-2 py-1 text-[11.5px] font-extrabold text-brand-800">새로 합류</span>
              {newCreators.map((c) => (
                <Link key={c.id} href={`/c/${encodeURIComponent(c.code)}`} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink-100 bg-white py-1 pl-1 pr-2.5 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50">
                  <ProfileAvatar seed={c.code} avatarIndex={c.avatarIndex} name={c.displayName} imageUrl={c.avatarUrl} className="h-6 w-6" />
                  {c.displayName}
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 5. 방송국 인기 채널 (미가입 · 후원 없음) */}
      {data.channels.length > 0 ? (
        <section className="mt-8">
          <SectionTitle title="방송국 인기 채널" description="아직 도네이도에 가입하지 않은 채널이에요. 영상만 볼 수 있어요." />
          <Rail>
            {data.channels.slice(0, 12).map((c) => <FanChannelCard key={c.channelId} channel={c} />)}
          </Rail>
        </section>
      ) : null}

      {/* 6. 크리에이터 샵 인기 상품 */}
      <section className="mt-8">
        <SectionTitle title="크리에이터 샵 인기 상품" description="크리에이터가 직접 고른 상품을 샵에서 만나 보세요." />
        {data.products.length > 0 ? (
          <Rail>
            {data.products.map((p) => <FanProductCard key={p.id} product={p} />)}
          </Rail>
        ) : (
          <Card>
            <ComingSoonSticker />
          </Card>
        )}
      </section>

      {/* 7. 내 구독 (로그인 시) */}
      {loggedIn && data.mine ? (
        <section className="mt-8">
          <HeadRow title="내 구독" href="/my/following" link="구독 관리" />
          <Card>
            {data.mine.follows.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none]">
                {data.mine.follows.map((f) => (
                  <Link key={f.code} href={`/c/${encodeURIComponent(f.code)}`} className="w-16 shrink-0 text-center">
                    <span className="relative mx-auto block w-fit">
                      <ProfileAvatar seed={f.code} avatarIndex={f.avatarIndex} name={f.displayName} imageUrl={f.avatarUrl} className={f.liveOn ? 'h-14 w-14 ring-2 ring-danger-600 ring-offset-2' : 'h-14 w-14'} />
                    </span>
                    <span className="mt-1.5 block truncate text-[11.5px] font-bold text-ink-700">{f.displayName}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-500">아직 구독한 크리에이터가 없어요. 마음에 드는 크리에이터 샵에서 구독을 눌러 보세요.</p>
            )}
            {data.mine.donations.length > 0 ? (
              <div className="mt-4 border-t border-ink-100 pt-3">
                <p className="mb-2 text-[12.5px] font-extrabold text-ink-700">최근 후원</p>
                <ul className="space-y-1.5">
                  {data.mine.donations.map((d) => (
                    <li key={d.id} className="flex items-center justify-between text-[13px]">
                      <Link href={`/c/${encodeURIComponent(d.creatorCode)}`} className="truncate font-bold text-ink-800">{d.creatorName}</Link>
                      <span className="shrink-0 text-ink-500">{won(d.amount)} · {mmdd(d.paidAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Link href="/my" className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-bold text-brand-700">
              <Bell size={13} aria-hidden />
              마이페이지 · 알림
            </Link>
          </Card>
        </section>
      ) : null}

      <BannerStrip position="FAN_MIDDLE" className="mt-8" />

      {/* 8. 이번 주 주목받은 크리에이터 */}
      {data.trending.creators.length > 0 || data.trending.channels.length > 0 ? (
        <section className="mt-8">
          <SectionTitle title="이번 주 주목받은 크리에이터" description="후원이 많이 모인 크리에이터와 업로드가 활발한 채널이에요." />
          {data.trending.creators.length > 0 ? (
            <Rail>
              {data.trending.creators.map((c, i) => <FanCreatorCard key={c.id} creator={c} rank={i + 1} />)}
            </Rail>
          ) : null}
          {data.trending.channels.length > 0 ? (
            <Card padded={false} className="mt-3 divide-y divide-ink-100">
              <p className="px-4 pt-3 text-[12.5px] font-extrabold text-ink-700">업로드 활발한 채널</p>
              {data.trending.channels.map((c, i) => (
                <Link key={c.channelId} href={`/watch/${encodeURIComponent(c.latest.id)}`} prefetch={false} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
                  <span className="w-4 text-center text-[12px] font-black text-ink-400">{i + 1}</span>
                  <ChannelAvatar channel={c} className="h-9 w-9 text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-[13.5px] font-extrabold text-ink-900">{c.title}</span>
                      <UnregisteredBadge />
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-400">{categoryLabel(c.category)} · 최근 7일 업로드 {c.uploads7d}개</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-ink-300" aria-hidden />
                </Link>
              ))}
            </Card>
          ) : null}
        </section>
      ) : null}

      {/* 9. 카테고리 바로가기 */}
      <section className="mt-8">
        <HeadRow title="카테고리" href="/videos" link="전체 카테고리" />
        <div className="grid grid-cols-4 gap-2">
          {quickCats.slice(0, 7).map((s) => (
            <Link key={s} href={videosHref({ c: s })} className="flex min-h-14 items-center justify-center rounded-xl border border-warm-200 bg-white px-1 text-center text-[12.5px] font-bold text-ink-700 hover:border-brand-300 hover:bg-brand-50">
              {categoryLabel(s)}
            </Link>
          ))}
          <Link href="/videos" className="flex min-h-14 items-center justify-center rounded-xl border border-dashed border-brand-300 bg-brand-50 text-[12.5px] font-extrabold text-brand-800">
            더보기
          </Link>
        </div>
      </section>

      {/* 10. 문자 후원 3단계 */}
      <section className="mt-8">
        <SectionTitle title="문자 한 통으로 후원하기" description="처음 한 번만 등록하면, 그다음부터는 문자만 보내면 돼요." />
        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: <MessageSquare size={18} strokeWidth={1.7} />, title: '번호로 문자', body: '방송에 안내된 후원 번호로 응원 메시지' },
            { icon: <CreditCard size={18} strokeWidth={1.7} />, title: '최초 1회 등록', body: '안내 링크에서 계좌 등록·동의' },
            { icon: <ShieldCheck size={18} strokeWidth={1.7} />, title: 'PIN 인증', body: 'PIN 입력 후 방송에 바로 표시' },
          ].map((s, i) => (
            <Card key={s.title} padded={false} className="p-3 text-center">
              <span className="relative mx-auto grid h-9 w-9 place-items-center rounded-xl bg-brand-50 text-brand-700">
                {s.icon}
                <span className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[10.5px] font-bold text-white">{i + 1}</span>
              </span>
              <p className="mt-2 text-[13px] font-extrabold text-ink-900">{s.title}</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-ink-500">{s.body}</p>
            </Card>
          ))}
        </div>
        <Link href="/how-it-works" className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-bold text-brand-700">
          <HeartHandshake size={14} aria-hidden />
          이용방법 자세히 보기
        </Link>
      </section>

      {/* 11. 공지 */}
      {data.notices.length > 0 ? (
        <section className="mt-8">
          <HeadRow title="공지·이벤트" href="/notice" link="전체 보기" />
          <Card padded={false} className="divide-y divide-ink-100">
            {data.notices.map((n) => (
              <Link key={n.id} href="/notice" className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50">
                <span className="truncate text-[13.5px] font-bold text-ink-800">{n.title}</span>
                <span className="shrink-0 text-[11.5px] text-ink-400">{mmdd(n.createdAt)}</span>
              </Link>
            ))}
          </Card>
        </section>
      ) : null}

      {/* 12. 전체 둘러보기 */}
      <section className="mt-8" aria-labelledby="fan-browse">
        <h2 id="fan-browse" className="mb-3 text-[18px] font-black tracking-[-0.025em] text-ink-900 sm:text-[19px]">전체 둘러보기</h2>
        <BrowseAll creators={data.creators} channels={data.channels} videos={browseVideos} live={data.live} now={data.now} />
      </section>

      {data.demo ? (
        <p className="mt-6 text-center text-[11px] text-ink-300">
          테스트 데이터가 포함된 화면입니다. (시청자 수 · 구독자 수 · 샘플 상품 · 일부 라이브)
        </p>
      ) : null}
    </div>
  );
}
