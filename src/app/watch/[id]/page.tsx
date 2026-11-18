import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink, HeartHandshake, UserPlus } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { VideoProfile, VideoCard } from '@/components/video-hub/video-card';
import { VideoPlayer } from '@/components/video-hub/video-player';
import {
  categoryLabel,
  formatViews,
  isYouTubeVideoId,
  timeAgo,
  videosHref,
  youtubeChannelUrl,
  youtubeWatchUrl,
} from '@/lib/video-hub';
import { getVideoWithRelated, isVideoHubEnabled } from '@/server/services/video-hub';
import { getStickerForVideo } from '@/server/services/shop/video-products';
import { getSessionUser } from '@/server/auth';
import { VideoProductSticker, VideoProductStrip } from '@/components/shop/video-product-sticker';

export const dynamic = 'force-dynamic';

async function load(id: string) {
  if (!isVideoHubEnabled() || !isYouTubeVideoId(id)) return null;
  return getVideoWithRelated(id).catch(() => null);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const data = await load(id);
  return data?.item ? { title: data.item.title, description: `${data.item.channelTitle} · 도네이도 크리에이터 영상` } : { title: '영상' };
}

export default async function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await load(id);
  if (!data?.item) notFound();
  const { item, related, now } = data;
  const meta = [formatViews(item.views), timeAgo(item.publishedAt, now)].filter(Boolean).join(' · ');
  // 도네이도 가입 크리에이터의 유튜브 영상이면 크리에이터가 연결한 상품 스티커를 띄운다
  const [sticker, viewer] = item.creator && item.source === 'youtube'
    ? await Promise.all([getStickerForVideo(item.creator.code, 'YOUTUBE', item.id), getSessionUser().catch(() => null)])
    : [null, null];
  const shopCode = item.creator?.code ?? '';
  const loggedIn = Boolean(viewer && viewer.role !== 'ADMIN');
  const loginHref = `/c/${encodeURIComponent(shopCode)}/login?next=${encodeURIComponent(`/watch/${item.id}`)}`;

  return (
    <PublicShell>
      <Link href="/videos" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm font-extrabold text-brand-800">
        <ArrowLeft size={16} /> 방송국으로
      </Link>
      <div className="mt-2 space-y-6">
        <div className="min-w-0 flex-1">
          <VideoPlayer
            item={item}
            overlay={sticker ? <VideoProductSticker sticker={sticker} platform="YOUTUBE" shopCode={shopCode} loggedIn={loggedIn} loginHref={loginHref} /> : null}
          />
          {sticker ? <VideoProductStrip sticker={sticker} shopCode={shopCode} loggedIn={loggedIn} loginHref={loginHref} className="mt-3" /> : null}

          <h1 className="mt-3 text-[18px] font-black leading-snug tracking-[-0.02em] text-ink-900 sm:text-[20px]">{item.title}</h1>

          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <VideoProfile item={item} detailed />
            <div className="flex flex-wrap gap-2">
              {item.creator ? (
                <Link
                  href={`/c/${encodeURIComponent(item.creator.code)}?tab=donate`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-brand-400 px-4 text-[13.5px] font-extrabold text-ink-900 shadow-[0_6px_14px_rgba(237,166,0,0.28)] hover:bg-brand-500"
                >
                  <HeartHandshake size={16} strokeWidth={1.9} />
                  후원하기
                </Link>
              ) : null}
              {item.source === 'youtube' ? (
                <>
                  <a
                    href={youtubeChannelUrl(item.channelId, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink-900 px-4 text-[13.5px] font-extrabold text-white hover:opacity-90"
                  >
                    <UserPlus size={16} strokeWidth={1.9} />
                    유튜브에서 구독
                  </a>
                  <a
                    href={youtubeWatchUrl(item.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-10 items-center gap-1.5 rounded-full border border-ink-200 bg-white px-4 text-[13.5px] font-bold text-ink-700 hover:bg-ink-50"
                  >
                    <ExternalLink size={15} strokeWidth={1.8} />
                    유튜브에서 보기
                  </a>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-3 rounded-2xl bg-warm-50 px-4 py-3 text-[13px] text-ink-700">
            <p className="font-bold">
              {meta}
              <Link href={videosHref({ c: item.category })} className="ml-2 text-brand-700">
                #{categoryLabel(item.category)}
              </Link>
            </p>
            {item.creator ? (
              <p className="mt-1.5 leading-relaxed text-ink-500">
                문자 한 통으로 {item.creator.displayName} 님을 응원할 수 있어요. 후원하기를 누르면 후원 방법이 안내됩니다.
              </p>
            ) : null}
          </div>
        </div>

        <aside aria-labelledby="related-title">
          <h2 id="related-title" className="mb-2 px-1 text-[16px] font-black text-ink-900">관련 영상</h2>
          {related.length > 0 ? (
            <div className="space-y-1">
              {related.map((v) => (
                <VideoCard key={v.id} item={v} now={now} layout="row" />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl bg-ink-50 px-4 py-6 text-center text-[13px] text-ink-500">관련 영상이 아직 없어요.</p>
          )}
        </aside>
      </div>
    </PublicShell>
  );
}
