'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ShoppingBag, X } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { isTagVisibleAt } from '@/lib/video-product-time';
import { trackStickerClickAction, videoStickerAction } from '@/app/actions/shop';
import { AddToCartForm } from './add-to-cart-form';

/** 서버 VideoStickerView 와 같은 모양 (브라우저 전용 타입으로 따로 둔다) */
export interface VideoSticker {
  tagId: string;
  key: string;
  productId: string;
  name: string;
  summary: string | null;
  thumbnailUrl: string | null;
  price: number;
  listPrice: number | null;
  soldOut: boolean;
  startSec: number | null;
  endSec: number | null;
  variants: Array<{ id: string; name: string; extraPrice: number; stock: number }>;
}

const YT_ORIGINS = new Set(['https://www.youtube-nocookie.com', 'https://www.youtube.com']);

/**
 * 같은 플레이어 상자 안의 유튜브 iframe 재생 위치(초).
 * 유튜브 IFrame API 스크립트를 따로 싣지 않고, 임베드 주소의 enablejsapi=1 로 플레이어가 보내는
 * infoDelivery 메시지(currentTime)만 읽는다. 위치를 아직 모르면 null.
 */
function useYouTubeCurrentTime(anchor: React.RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [sec, setSec] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const frame = anchor.current?.parentElement?.querySelector('iframe') ?? null;
    if (!frame) return;
    const listen = () => {
      try {
        frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'donaido-sticker', channel: 'widget' }), '*');
      } catch {
        // 플레이어가 아직 준비되지 않았다. 다음 타이머에서 다시 시도한다.
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || !YT_ORIGINS.has(e.origin)) return;
      let data: unknown = e.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const info = (data as { info?: { currentTime?: unknown } } | null)?.info;
      const t = info && typeof info.currentTime === 'number' ? info.currentTime : null;
      if (t != null && Number.isFinite(t)) setSec(t);
    };
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', listen);
    listen();
    // 플레이어가 늦게 뜨는 경우를 위해 몇 번 더 알린다
    const timer = window.setInterval(listen, 2500);
    const stop = window.setTimeout(() => window.clearInterval(timer), 20_000);
    return () => {
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', listen);
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [anchor, enabled]);
  return sec;
}

function won(n: number) {
  return `${n.toLocaleString('ko-KR')}원`;
}

/**
 * 영상 위 상품 스티커 (유튜브 쇼핑 스티커와 같은 역할).
 * 플레이어 상자(position: relative) 안, iframe 바로 옆에 둔다.
 * 유튜브 정책상 플레이어 조작 버튼·화면을 가리지 않도록 모서리에 작게 띄우고, 닫을 수 있다.
 */
export function VideoProductSticker({
  sticker,
  platform,
  shopCode,
  loggedIn,
  loginHref,
}: {
  sticker: VideoSticker;
  platform: string;
  shopCode: string;
  loggedIn: boolean;
  loginHref: string;
}) {
  const anchor = React.useRef<HTMLSpanElement>(null);
  const timed = platform === 'YOUTUBE' && (sticker.startSec != null || sticker.endSec != null);
  const current = useYouTubeCurrentTime(anchor, timed);
  const [dismissed, setDismissed] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const visible = !dismissed && isTagVisibleAt(sticker, timed ? current : null);

  const openSheet = () => {
    void trackStickerClickAction(sticker.tagId).catch(() => undefined);
    setOpen(true);
  };

  return (
    <>
      <span ref={anchor} hidden />
      {visible ? (
        <div
          className={cx(
            'pointer-events-none absolute left-2 z-10 max-w-[min(15rem,70%)] sm:left-3',
            // 유튜브는 아래 조작 막대를 피해서, 나머지(세로 영상 등)는 위쪽에 둔다
            platform === 'YOUTUBE' || platform === 'LIVE' ? 'bottom-14' : 'top-2 sm:top-3',
          )}
        >
          <div className="pointer-events-auto flex items-center gap-2 rounded-xl bg-white/95 p-1.5 pr-1 shadow-[0_6px_18px_rgba(0,0,0,0.28)] backdrop-blur">
            <button
              type="button"
              onClick={openSheet}
              className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-brand-500"
              aria-label={`영상 속 상품 ${sticker.name} 보기`}
            >
              <StickerThumb sticker={sticker} size="h-10 w-10" />
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-[10.5px] font-extrabold text-brand-800">
                  <ShoppingBag size={11} strokeWidth={2} aria-hidden />
                  영상 속 상품
                </span>
                <span className="block truncate text-[12px] font-bold text-ink-900">{sticker.name}</span>
                <span className="block text-[12px] font-black text-ink-900">{sticker.soldOut ? '품절' : won(sticker.price)}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="상품 스티커 닫기"
              className="grid h-7 w-7 shrink-0 place-items-center self-start rounded-full text-ink-400 hover:bg-ink-100"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        </div>
      ) : null}
      {open ? <ProductSheet sticker={sticker} shopCode={shopCode} loggedIn={loggedIn} loginHref={loginHref} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** 플레이어 아래 "이 영상 속 상품" 줄 (스티커를 닫았거나 시간대 밖이어도 항상 살 수 있게) */
export function VideoProductStrip({
  sticker,
  shopCode,
  loggedIn,
  loginHref,
  className,
}: {
  sticker: VideoSticker;
  shopCode: string;
  loggedIn: boolean;
  loginHref: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void trackStickerClickAction(sticker.tagId).catch(() => undefined);
          setOpen(true);
        }}
        className={cx(
          'flex w-full items-center gap-3 rounded-2xl border border-warm-300/70 bg-white p-2.5 text-left shadow-card hover:border-brand-300',
          className,
        )}
      >
        <StickerThumb sticker={sticker} size="h-14 w-14" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[11.5px] font-extrabold text-brand-800">
            <ShoppingBag size={13} strokeWidth={2} aria-hidden />
            이 영상 속 상품
          </span>
          <span className="mt-0.5 block truncate text-[14px] font-bold text-ink-900">{sticker.name}</span>
          <span className="flex items-baseline gap-1.5">
            {sticker.listPrice && sticker.listPrice > sticker.price ? (
              <span className="text-[12px] text-ink-400 line-through">{won(sticker.listPrice)}</span>
            ) : null}
            <span className="text-[14px] font-black text-ink-900">{sticker.soldOut ? '품절' : won(sticker.price)}</span>
          </span>
        </span>
        <span className="shrink-0 rounded-xl bg-brand-400 px-3 py-2 text-[12.5px] font-extrabold text-ink-900">구매하기</span>
      </button>
      {open ? <ProductSheet sticker={sticker} shopCode={shopCode} loggedIn={loggedIn} loginHref={loginHref} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function StickerThumb({ sticker, size }: { sticker: VideoSticker; size: string }) {
  return (
    <span className={cx('relative block shrink-0 overflow-hidden rounded-lg bg-warm-100', size)}>
      {sticker.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={sticker.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-brand-700">
          <ShoppingBag size={18} strokeWidth={1.7} aria-hidden />
        </span>
      )}
    </span>
  );
}

/** 영상을 멈추지 않고 그 자리에서 옵션·수량을 골라 담거나 바로 구매하는 시트 */
function ProductSheet({
  sticker,
  shopCode,
  loggedIn,
  loginHref,
  onClose,
}: {
  sticker: VideoSticker;
  shopCode: string;
  loggedIn: boolean;
  loginHref: string;
  onClose: () => void;
}) {
  const titleId = React.useId();
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const productHref = `/c/${encodeURIComponent(shopCode)}/shop/${encodeURIComponent(sticker.productId)}`;
  // 화면 아래 고정 메뉴·변형(transform)된 부모에 갇히지 않도록 body 에 바로 띄운다
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-[1.5rem] bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-[1.5rem]">
        <div className="flex items-start gap-3">
          <StickerThumb sticker={sticker} size="h-20 w-20" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 text-[11.5px] font-extrabold text-brand-800">
              <ShoppingBag size={13} strokeWidth={2} aria-hidden />
              영상 속 상품
            </p>
            <h2 id={titleId} className="mt-0.5 line-clamp-2 text-[16px] font-black leading-snug text-ink-900">
              {sticker.name}
            </h2>
            <p className="mt-1 flex items-baseline gap-1.5">
              {sticker.listPrice && sticker.listPrice > sticker.price ? (
                <span className="text-[12.5px] text-ink-400 line-through">{won(sticker.listPrice)}</span>
              ) : null}
              <span className="text-[17px] font-black text-ink-900">{won(sticker.price)}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-ink-100">
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>
        {sticker.summary ? <p className="mt-3 text-[13px] leading-relaxed text-ink-600">{sticker.summary}</p> : null}
        <div className="mt-4">
          <AddToCartForm
            shopCode={shopCode}
            productId={sticker.productId}
            basePrice={sticker.price}
            variants={sticker.variants}
            soldOut={sticker.soldOut}
            loggedIn={loggedIn}
            loginHref={loginHref}
            sourceVideo={sticker.key}
          />
        </div>
        <a
          href={productHref}
          target="_blank"
          rel="noopener"
          className="mt-3 flex h-10 items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold text-ink-600 hover:bg-ink-50"
        >
          <ExternalLink size={14} strokeWidth={1.8} aria-hidden />
          상품 자세히 보기 (새 창)
        </a>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 브라우저에서 영상을 고르는 플레이어(방송국 미리보기 등)용: 크리에이터 코드·영상 ID 로 스티커를 받아 띄운다.
 * 도네이도 가입 크리에이터의 유튜브 영상에만 쓴다.
 */
export function RemoteVideoSticker({ creatorCode, videoId }: { creatorCode: string; videoId: string }) {
  const [data, setData] = React.useState<{ sticker: VideoSticker | null; loggedIn: boolean } | null>(null);
  React.useEffect(() => {
    let alive = true;
    videoStickerAction(creatorCode, videoId)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [creatorCode, videoId]);
  if (!data?.sticker) return null;
  const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
  return (
    <VideoProductSticker
      sticker={data.sticker}
      platform="YOUTUBE"
      shopCode={creatorCode}
      loggedIn={data.loggedIn}
      loginHref={`/c/${encodeURIComponent(creatorCode)}/login?next=${encodeURIComponent(next)}`}
    />
  );
}
