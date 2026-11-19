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
 * 같은 영역(data-sticker-scope) 안의 유튜브 iframe 재생 위치(초).
 * 유튜브 IFrame API 스크립트를 따로 싣지 않고, 임베드 주소의 enablejsapi=1 로 플레이어가 보내는
 * infoDelivery 메시지(currentTime)만 읽는다. 위치를 아직 모르면 null.
 */
function useYouTubeCurrentTime(anchor: React.RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [sec, setSec] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const scope = anchor.current?.closest('[data-sticker-scope]') ?? anchor.current?.parentElement ?? null;
    const frame = scope?.querySelector('iframe') ?? null;
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
 * 플레이어 아래 "이 영상 속 상품" 줄 (2026-11-19 7차 점검 P1-2).
 *
 * 예전에는 유튜브·틱톡 플레이어 **위에** 스티커를 겹쳐 띄웠다. 유튜브 API 서비스 정책은 임베드 플레이어를
 * 다른 요소로 가리는 것을 제한하고, 위반 시 영상 수집·후원 채팅 송출에 쓰는 API 키까지 정지될 수 있다.
 * 그래서 외부 플레이어 위에는 아무것도 겹치지 않고, 플레이어 바로 아래 이 줄만 둔다.
 *
 * 유튜브 영상에 표시 시간대를 정했다면, 재생 위치가 그 구간에 들어올 때 이 줄이 "지금 영상에 나와요" 로 강조된다
 * (같은 data-sticker-scope 영역 안의 iframe 재생 위치를 읽는다). 구간 밖이어도 줄은 남아 언제든 살 수 있다.
 */
export function VideoProductStrip({
  sticker,
  platform,
  shopCode,
  loggedIn,
  loginHref,
  className,
  compact = false,
}: {
  sticker: VideoSticker;
  /** 시간대 강조는 유튜브만 (재생 위치를 읽을 수 있는 플랫폼) */
  platform?: string;
  shopCode: string;
  loggedIn: boolean;
  loginHref: string;
  className?: string;
  /** 좁은 미리보기 플레이어용 작은 줄 */
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const anchor = React.useRef<HTMLSpanElement>(null);
  const timed = platform === 'YOUTUBE' && (sticker.startSec != null || sticker.endSec != null);
  const current = useYouTubeCurrentTime(anchor, timed);
  const nowShowing = timed && current != null && isTagVisibleAt(sticker, current);
  return (
    <>
      <span ref={anchor} hidden />
      <button
        type="button"
        data-now-showing={nowShowing ? 'on' : 'off'}
        onClick={() => {
          void trackStickerClickAction(sticker.tagId).catch(() => undefined);
          setOpen(true);
        }}
        className={cx(
          'flex w-full items-center gap-3 rounded-2xl border bg-white text-left shadow-card transition-[border-color,box-shadow] hover:border-brand-300',
          compact ? 'p-2' : 'p-2.5',
          nowShowing ? 'border-brand-400 ring-2 ring-brand-200' : 'border-warm-300/70',
          className,
        )}
      >
        <StickerThumb sticker={sticker} size={compact ? 'h-11 w-11' : 'h-14 w-14'} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[11.5px] font-extrabold text-brand-800">
            <ShoppingBag size={13} strokeWidth={2} aria-hidden />
            이 영상 속 상품
            {nowShowing ? <span className="ml-1 rounded-full bg-brand-400 px-1.5 py-px text-[10px] font-black text-ink-900">지금 영상에 나와요</span> : null}
          </span>
          <span className={cx('mt-0.5 block truncate font-bold text-ink-900', compact ? 'text-[13px]' : 'text-[14px]')}>{sticker.name}</span>
          <span className="flex items-baseline gap-1.5">
            {sticker.listPrice && sticker.listPrice > sticker.price ? (
              <span className="text-[12px] text-ink-400 line-through">{won(sticker.listPrice)}</span>
            ) : null}
            <span className={cx('font-black text-ink-900', compact ? 'text-[13px]' : 'text-[14px]')}>{sticker.soldOut ? '품절' : won(sticker.price)}</span>
          </span>
        </span>
        <span className={cx('shrink-0 rounded-xl bg-brand-400 font-extrabold text-ink-900', compact ? 'px-2.5 py-1.5 text-[12px]' : 'px-3 py-2 text-[12.5px]')}>구매하기</span>
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
 * 브라우저에서 영상을 고르는 플레이어(메인 영상 미리보기 등)용: 크리에이터 코드·영상 ID 로 상품을 받아
 * 플레이어 아래에 [이 영상 속 상품] 줄을 띄운다. 도네이도 가입 크리에이터의 유튜브 영상에만 쓴다.
 * 플레이어와 같은 data-sticker-scope 영역 안에 두어야 시간대 강조가 동작한다.
 */
export function RemoteVideoSticker({ creatorCode, videoId, className }: { creatorCode: string; videoId: string; className?: string }) {
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
    <VideoProductStrip
      sticker={data.sticker}
      platform="YOUTUBE"
      shopCode={creatorCode}
      loggedIn={data.loggedIn}
      loginHref={`/c/${encodeURIComponent(creatorCode)}/login?next=${encodeURIComponent(next)}`}
      className={className}
      compact
    />
  );
}
