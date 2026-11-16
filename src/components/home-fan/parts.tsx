import Link from 'next/link';
import { ChevronRight, HeartHandshake, PlayCircle, Radio, ShoppingBag, Store, Users } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { categoryLabel, youtubeChannelUrl } from '@/lib/video-hub';
import type { FanChannel, FanCreator, FanLiveItem, FanProduct } from '@/server/services/home-fan';

/**
 * 구독자 전용 탭 카드 모음 (서버·클라이언트 공용, 훅 없음).
 * 미가입 채널 카드에는 후원 버튼·후원 링크를 절대 만들지 않는다(테스트로 확인).
 */

/** 1,234 → 1.2천 / 12,345 → 1.2만 / 123,456,789 → 1.2억 */
export function compactKo(n: number): string {
  const trim = (v: number) => (v >= 10 ? Math.floor(v).toString() : (Math.floor(v * 10) / 10).toString());
  if (n >= 100_000_000) return `${trim(n / 100_000_000)}억`;
  if (n >= 10_000) return `${trim(n / 10_000)}만`;
  if (n >= 1_000) return `${trim(n / 1_000)}천`;
  return String(n);
}

export function won(n: number): string {
  return `${n.toLocaleString('ko-KR')}원`;
}

/** 가로 스크롤 선반 */
export function Rail({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('-mx-4 flex snap-x scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1 sm:scroll-px-6 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden', className)}>
      {children}
    </div>
  );
}

function ChannelInitial({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cx('grid shrink-0 place-items-center rounded-full bg-brand-100 font-extrabold text-brand-800', className)}>
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  );
}

export function ChannelAvatar({ channel, className }: { channel: Pick<FanChannel, 'title' | 'avatarUrl'>; className?: string }) {
  if (channel.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={channel.avatarUrl} alt="" loading="lazy" decoding="async" className={cx('shrink-0 rounded-full bg-brand-50 object-cover', className)} />;
  }
  return <ChannelInitial name={channel.title} className={className} />;
}

export function UnregisteredBadge() {
  return <span className="shrink-0 rounded-md bg-ink-100 px-1.5 py-0.5 text-[10.5px] font-bold text-ink-500">미가입</span>;
}

export function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-danger-600 px-1.5 py-0.5 text-[10.5px] font-black text-white">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
      LIVE
    </span>
  );
}

/** 지금 라이브 카드 (가입 크리에이터 → 샵 시청·후원 / 미가입 채널 → 시청 화면) */
export function FanLiveCard({ item, wide = false }: { item: FanLiveItem; wide?: boolean }) {
  return (
    <article className={cx('relative rounded-2xl border border-warm-200 bg-white p-1.5 transition-colors hover:bg-brand-50/70', wide ? 'w-full' : 'w-[200px] shrink-0 snap-start sm:w-[220px]')}>
      <Link
        href={item.href}
        prefetch={false}
        aria-label={`${item.name} 라이브 보기`}
        className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-2 focus-visible:outline-brand-500"
      />
      <div className="relative grid aspect-video place-items-center overflow-hidden rounded-xl bg-[radial-gradient(circle_at_30%_20%,#fff3cf_0%,#ffd77a_45%,#f2a541_100%)]">
        {item.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnail} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        ) : item.creator ? (
          <ProfileAvatar seed={item.creator.code} avatarIndex={item.creator.avatarIndex} name={item.name} imageUrl={item.creator.avatarUrl} className="h-14 w-14 ring-4 ring-white/80" />
        ) : (
          <PlayCircle size={30} strokeWidth={1.5} className="text-brand-800" />
        )}
        <span className="absolute left-1.5 top-1.5"><LiveBadge /></span>
        {item.viewers != null ? (
          <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-ink-900/80 px-1.5 py-0.5 text-[10.5px] font-bold text-white">
            <Users size={11} strokeWidth={2} aria-hidden />
            {item.viewers.toLocaleString('ko-KR')}명 시청 중
          </span>
        ) : null}
        {item.donatable ? (
          <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-brand-400 px-1.5 py-0.5 text-[10.5px] font-extrabold text-ink-900">
            <HeartHandshake size={11} strokeWidth={2} aria-hidden />
            후원 가능
          </span>
        ) : null}
      </div>
      <p className="mt-2 line-clamp-1 px-0.5 text-[13px] font-bold text-ink-900">{item.title}</p>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 px-0.5">
        <Radio size={13} className="shrink-0 text-danger-600" aria-hidden />
        <p className="truncate text-[12px] font-semibold text-ink-600">{item.name}</p>
        {!item.donatable ? <UnregisteredBadge /> : null}
      </div>
      {item.category ? <p className="mt-0.5 truncate px-0.5 text-[11.5px] text-ink-400">{categoryLabel(item.category)}</p> : null}
    </article>
  );
}

/** 도네이도 크리에이터 (가입 · 후원 가능) */
export function FanCreatorCard({ creator, rank }: { creator: FanCreator; rank?: number }) {
  const shop = `/c/${encodeURIComponent(creator.code)}`;
  return (
    <article className="w-[172px] shrink-0 snap-start rounded-2xl border border-warm-200 bg-white p-3 text-center sm:w-[184px]">
      <div className="relative mx-auto w-fit">
        <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={creator.displayName} imageUrl={creator.avatarUrl} className="h-16 w-16" />
        {creator.liveOn ? <span className="absolute -bottom-1 left-1/2 -translate-x-1/2"><LiveBadge /></span> : null}
        {rank ? (
          <span className="absolute -left-2 -top-1 grid h-6 w-6 place-items-center rounded-full bg-ink-900 text-[11px] font-black text-white">{rank}</span>
        ) : null}
      </div>
      <p className="mt-2.5 truncate text-[14px] font-extrabold text-ink-900">{creator.displayName}</p>
      <p className="mt-0.5 truncate text-[11.5px] text-ink-400">
        {[creator.category ? categoryLabel(creator.category) : null, `구독자 ${compactKo(creator.subscribers)}명`].filter(Boolean).join(' · ')}
      </p>
      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        <Link href={`${shop}?tab=donate`} prefetch={false} className="inline-flex min-h-9 items-center justify-center gap-1 rounded-lg bg-brand-400 text-[12px] font-extrabold text-ink-900 hover:bg-brand-300">
          <HeartHandshake size={13} strokeWidth={2} aria-hidden />
          후원하기
        </Link>
        <Link href={`${shop}?tab=shop`} prefetch={false} className="inline-flex min-h-9 items-center justify-center gap-1 rounded-lg border border-ink-200 bg-white text-[12px] font-bold text-ink-700 hover:bg-ink-50">
          <Store size={13} strokeWidth={1.8} aria-hidden />
          샵 보기
        </Link>
      </div>
    </article>
  );
}

/** 방송국 인기 채널 (미가입 · 후원 버튼 없음) */
export function FanChannelCard({ channel }: { channel: FanChannel }) {
  return (
    <article className="relative w-[220px] shrink-0 snap-start rounded-2xl border border-warm-200 bg-white p-1.5 transition-colors hover:bg-brand-50/70 sm:w-[236px]">
      <Link href={`/watch/${encodeURIComponent(channel.latest.id)}`} prefetch={false} aria-label={`${channel.title} 최신 영상 보기`} className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-2 focus-visible:outline-brand-500" />
      <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-100">
        {channel.latest.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={channel.latest.thumbnail} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-2 px-0.5">
        <ChannelAvatar channel={channel} className="h-8 w-8 text-xs" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <p className="truncate text-[13.5px] font-extrabold text-ink-900">{channel.title}</p>
            <UnregisteredBadge />
          </div>
          <p className="truncate text-[11.5px] text-ink-400">
            {[categoryLabel(channel.category), channel.subscribers != null ? `구독자 ${compactKo(channel.subscribers)}명` : null].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      <p className="mt-1.5 line-clamp-1 px-0.5 text-[12px] text-ink-500">{channel.latest.title}</p>
      <a
        href={youtubeChannelUrl(channel.channelId)}
        target="_blank"
        rel="noopener noreferrer"
        className="relative z-[2] mt-1.5 inline-flex items-center gap-0.5 px-0.5 text-[11.5px] font-bold text-ink-500 hover:text-brand-800"
      >
        YouTube 채널
        <ChevronRight size={12} aria-hidden />
      </a>
    </article>
  );
}

/** 샵 인기 상품 */
export function FanProductCard({ product }: { product: FanProduct }) {
  const href = product.shop ? `/c/${encodeURIComponent(product.shop.code)}/shop/${encodeURIComponent(product.id)}` : '#';
  const off = product.listPrice && product.listPrice > product.price ? Math.round((1 - product.price / product.listPrice) * 100) : 0;
  return (
    <article className="relative w-[156px] shrink-0 snap-start sm:w-[168px]">
      <Link href={href} prefetch={false} aria-label={`${product.name} 보기`} className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-2 focus-visible:outline-brand-500" />
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-warm-200 bg-ink-50">
        {product.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.thumbnailUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-ink-300"><ShoppingBag size={28} strokeWidth={1.5} /></span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-[13px] font-bold leading-snug text-ink-900">{product.name}</p>
      <p className="mt-1 text-[14px] font-black text-ink-900">
        {off > 0 ? <span className="mr-1 text-danger-600">{off}%</span> : null}
        {won(product.price)}
      </p>
      <p className="mt-0.5 truncate text-[11.5px] text-ink-400">
        {product.soldCount > 0 ? `${compactKo(product.soldCount)}개 판매 · ` : ''}
        {product.shop?.displayName}
      </p>
    </article>
  );
}
