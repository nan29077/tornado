'use client';

import * as React from 'react';
import Link from 'next/link';
import { HeartHandshake, Pin, PlayCircle, X } from '@/components/brand/icons';
import { LiveBadge, LiveCardFrame } from '@/components/public/live-card-frame';
import { cx } from '@/components/ui';
import { embedUrlFor, liveThumbnailUrl, SHOP_VIDEO_PLATFORM_LABEL } from '@/lib/shop-video-embed';
import { donateVideoAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';
import { ShopLiveFeed } from './shop-live-feed';

export interface ShopVideoView {
  key: string;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  thumbnail: string | null;
  meta: string;
  pinned: boolean;
}

/**
 * 도네이도 샵 영상 탭.
 *  - 방송 중이면 맨 위에 라이브 플레이어 + 실시간 후원 + [라이브 후원하기]
 *  - 영상을 누르면 위쪽에서 재생하고, 바로 아래에서 그 영상에 후원한다(PG 결제, 지금은 테스트 결제)
 *  - 후원은 방송 오버레이·유튜브 라이브 채팅·샵 실시간 후원 목록에 함께 표시된다
 */
export function ShopVideoTab({
  creatorId,
  creatorCode,
  creatorName,
  videos,
  liveEmbedUrl,
  liveUrl,
  donationEnabled,
  presets,
  minAmount,
  loggedIn,
  defaultNickname,
  paymentMock,
}: {
  creatorId: string;
  creatorCode: string;
  creatorName: string;
  videos: ShopVideoView[];
  liveEmbedUrl: string | null;
  liveUrl: string | null;
  donationEnabled: boolean;
  presets: string[];
  minAmount: string;
  loggedIn: boolean;
  defaultNickname: string;
  paymentMock: boolean;
}) {
  const [selected, setSelected] = React.useState<ShopVideoView | null>(null);
  const [platform, setPlatform] = React.useState<string>('ALL');
  const topRef = React.useRef<HTMLDivElement>(null);
  const platforms = React.useMemo(() => [...new Set(videos.map((v) => v.platform))], [videos]);
  const shown = platform === 'ALL' ? videos : videos.filter((v) => v.platform === platform);
  const live = Boolean(liveEmbedUrl || liveUrl);
  const target = selected ?? (live ? { key: 'LIVE', platform: 'LIVE', externalId: 'live', url: liveUrl ?? '', title: '라이브 방송', thumbnail: null, meta: '', pinned: false } : null);

  const choose = (v: ShopVideoView) => {
    setSelected(v);
    requestAnimationFrame(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="mt-6 space-y-5">
      <div ref={topRef} className="scroll-mt-24 space-y-3">
        {selected ? (
          <Player key={selected.key} video={selected} onClose={() => setSelected(null)} />
        ) : live ? (
          <section className="overflow-hidden rounded-[1.5rem] border border-warm-300/70 bg-white shadow-card">
            <div className="flex items-center gap-2 px-4 py-3">
              {liveEmbedUrl ? <LiveBadge /> : null}
              <p className="text-[14px] font-extrabold text-ink-900">{creatorName} 님이 방송 중이에요</p>
            </div>
            {liveEmbedUrl ? (
              <div className="relative aspect-video bg-ink-900">
                <iframe src={liveEmbedUrl} title="라이브 방송" className="absolute inset-0 h-full w-full" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
              </div>
            ) : liveUrl ? (
              <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="mx-4 mb-3 block rounded-2xl focus-visible:outline-2 focus-visible:outline-brand-500">
                <LiveCardFrame thumbnail={liveThumbnailUrl(liveUrl)} className="rounded-2xl" />
                <span className="mt-2 flex items-center justify-center gap-1.5 rounded-xl bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-800 hover:bg-brand-100">
                  <PlayCircle size={16} strokeWidth={1.7} aria-hidden />
                  방송 보러 가기
                </span>
              </a>
            ) : null}
            <div className="px-4 py-3">
              <ShopLiveFeed creatorCode={creatorCode} />
            </div>
          </section>
        ) : null}

        {target && donationEnabled ? (
          loggedIn ? (
            <DonateForm
              creatorId={creatorId}
              creatorName={creatorName}
              video={target}
              presets={presets}
              minAmount={minAmount}
              defaultNickname={defaultNickname}
              paymentMock={paymentMock}
            />
          ) : (
            <Link
              href={`/c/${creatorCode}/login?next=${encodeURIComponent(`/c/${creatorCode}?tab=video`)}`}
              className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[14px] font-extrabold text-ink-900"
            >
              <HeartHandshake size={17} strokeWidth={1.9} />
              로그인하고 {target.key === 'LIVE' ? '라이브' : '이 영상'}에 후원하기
            </Link>
          )
        ) : null}
      </div>

      <section>
        <div className="flex items-end justify-between px-1">
          <h2 className="text-[16px] font-black tracking-[-0.02em] text-ink-900">영상</h2>
          <span className="text-[11.5px] text-ink-400">영상을 누르면 재생하고 후원할 수 있어요</span>
        </div>
        {platforms.length > 1 ? (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
            {['ALL', ...platforms].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={cx('h-8 shrink-0 rounded-lg px-3 text-[12.5px] font-bold', platform === p ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}
              >
                {p === 'ALL' ? '전체' : SHOP_VIDEO_PLATFORM_LABEL[p] ?? p}
              </button>
            ))}
          </div>
        ) : null}
        {shown.length === 0 ? (
          <div className="mt-3 rounded-[1.5rem] border border-dashed border-warm-300 bg-white/70 px-5 py-9 text-center">
            <p className="text-[13.5px] font-bold text-ink-700">아직 등록된 영상이 없어요</p>
            <p className="mt-1 text-[12.5px] text-ink-400">크리에이터가 채널을 연결하면 영상이 여기에 나와요.</p>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {shown.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => choose(v)}
                aria-pressed={selected?.key === v.key}
                className={cx(
                  'rounded-2xl border bg-white p-2 text-left shadow-card transition hover:-translate-y-0.5',
                  selected?.key === v.key ? 'border-brand-400 ring-2 ring-brand-200' : 'border-warm-300/70',
                )}
              >
                <Thumb video={v} />
                <p className="mt-2 line-clamp-2 px-1 text-[13.5px] font-bold leading-snug text-ink-900">{v.title}</p>
                <p className="mt-0.5 flex items-center gap-1 px-1 text-[11.5px] text-ink-400">
                  {v.pinned ? <Pin size={11} strokeWidth={2} className="text-brand-700" /> : null}
                  {SHOP_VIDEO_PLATFORM_LABEL[v.platform] ?? v.platform}
                  {v.meta ? ` · ${v.meta}` : ''}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Thumb({ video }: { video: ShopVideoView }) {
  return (
    <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-100">
      {video.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={video.thumbnail} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-[linear-gradient(135deg,#fff3cf_0%,#ffd77a_55%,#f2b541_100%)] text-brand-800">
          <span className="flex flex-col items-center gap-1 text-[12px] font-extrabold">
            <PlayCircle size={30} strokeWidth={1.5} />
            {SHOP_VIDEO_PLATFORM_LABEL[video.platform] ?? video.platform}
          </span>
        </div>
      )}
    </div>
  );
}

function Player({ video, onClose }: { video: ShopVideoView; onClose: () => void }) {
  const src = embedUrlFor(video.platform, video.externalId, video.url, true);
  const vertical = video.platform === 'TIKTOK' || (video.platform === 'INSTAGRAM' && video.externalId.startsWith('reel/'));
  return (
    <section className="overflow-hidden rounded-[1.5rem] border border-warm-300/70 bg-white shadow-card">
      <div className={cx('relative mx-auto bg-ink-900', vertical ? 'aspect-[9/16] max-h-[640px] w-full max-w-[360px]' : 'aspect-video w-full')}>
        {src ? (
          <iframe src={src} title={video.title} className="absolute inset-0 h-full w-full" allow="autoplay; encrypted-media; picture-in-picture; clipboard-write" allowFullScreen />
        ) : (
          <a href={video.url} target="_blank" rel="noopener noreferrer" className="absolute inset-0 grid place-items-center text-[14px] font-bold text-white">
            원본에서 보기
          </a>
        )}
      </div>
      <div className="flex items-start gap-2 px-4 py-3">
        <p className="min-w-0 flex-1 text-[14.5px] font-extrabold leading-snug text-ink-900">{video.title}</p>
        <button type="button" onClick={onClose} aria-label="재생 닫기" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-ink-100">
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>
    </section>
  );
}

function DonateForm({
  creatorId,
  creatorName,
  video,
  presets,
  minAmount,
  defaultNickname,
  paymentMock,
}: {
  creatorId: string;
  creatorName: string;
  video: ShopVideoView;
  presets: string[];
  minAmount: string;
  defaultNickname: string;
  paymentMock: boolean;
}) {
  const [amount, setAmount] = React.useState(presets[1] ?? presets[0] ?? minAmount);
  return (
    <section className="rounded-[1.5rem] border border-brand-200 bg-brand-50/70 p-4">
      <p className="flex items-center gap-1.5 text-[14px] font-extrabold text-ink-900">
        <HeartHandshake size={17} strokeWidth={1.9} className="text-brand-700" />
        {video.key === 'LIVE' ? `${creatorName} 님 라이브에 후원` : '이 영상에 후원'}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
        결제가 끝난 후원은 방송 오버레이와 유튜브 라이브 채팅, 샵 실시간 후원에 표시됩니다.
      </p>
      <ShopActionForm action={donateVideoAction} className="mt-3 space-y-2.5">
        {(pending) => (
          <>
            <input type="hidden" name="creatorId" value={creatorId} />
            <input type="hidden" name="videoRef" value={video.key} />
            <input type="hidden" name="videoTitle" value={video.title} />
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  className={cx('h-9 rounded-xl px-3 text-[13px] font-extrabold', amount === p ? 'bg-ink-900 text-white' : 'border border-warm-300 bg-white text-ink-800')}
                >
                  {Number(p).toLocaleString('ko-KR')}원
                </button>
              ))}
            </div>
            <label className="block">
              <span className="sr-only">후원 금액</span>
              <input
                name="amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                className="h-11 w-full rounded-xl border border-warm-300 bg-white px-3 text-[15px] font-extrabold text-ink-900"
                aria-label="후원 금액(원)"
              />
            </label>
            <p className="text-[11.5px] text-ink-400">최소 {Number(minAmount).toLocaleString('ko-KR')}원</p>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input name="nickname" maxLength={20} defaultValue={defaultNickname} placeholder="방송에 표시할 이름" className="h-11 rounded-xl border border-warm-300 bg-white px-3 text-[14px]" aria-label="닉네임" />
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-600">
                <input type="checkbox" name="anonymous" />
                익명
              </label>
            </div>
            <textarea name="message" rows={2} maxLength={200} placeholder="응원 메시지 (방송에 표시돼요)" className="w-full rounded-xl border border-warm-300 bg-white px-3 py-2 text-[14px]" aria-label="응원 메시지" />
            <button type="submit" disabled={pending} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] disabled:opacity-50">
              {pending ? '결제 중' : `${Number(amount || 0).toLocaleString('ko-KR')}원 후원하기`}
            </button>
            {paymentMock ? (
              <p className="text-center text-[11.5px] font-semibold text-warning-600">테스트 결제입니다. 실제로 돈이 나가지 않습니다.</p>
            ) : null}
          </>
        )}
      </ShopActionForm>
    </section>
  );
}
