'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, HeartHandshake } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { VIDEO_PLATFORMS, isVideoPlatform, type VideoPlatformSlug } from '@/lib/video-hub';

export type HubChipTone = 'normal' | 'brand' | 'dark' | 'live' | 'live-on' | 'active';

export interface HubChip {
  key: string;
  href: string;
  label: string;
  tone?: HubChipTone;
  dot?: string;
  count?: number;
}

const TONES: Record<HubChipTone, string> = {
  normal: 'border-ink-100 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800',
  brand: 'border-brand-200 bg-brand-50 text-brand-800 hover:bg-brand-100',
  dark: 'border-ink-900 bg-ink-900 text-white hover:opacity-90',
  live: 'border-ink-100 bg-white text-ink-600 hover:bg-ink-50',
  'live-on': 'border-danger-600 bg-danger-600 text-white hover:opacity-90',
  active: 'border-brand-400 bg-brand-400 text-ink-900',
};

export function HubChipLink({ chip, size = 'sm' }: {
  chip: HubChip;
  size?: 'sm' | 'md';
}) {
  return (
    <Link
      href={chip.href}
      prefetch={false}
      scroll={chip.tone === 'active' ? false : undefined}
      aria-current={chip.tone === 'active' ? 'page' : undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-3 font-bold transition-colors focus-visible:outline-2 focus-visible:outline-brand-500',
        size === 'sm' ? 'min-h-8 text-[11.5px]' : 'min-h-9 text-[12.5px]',
        TONES[chip.tone ?? 'normal'],
      )}
    >
      {chip.tone === 'live' || chip.tone === 'live-on' ? (
        <span className={cx('size-1.5 shrink-0 rounded-full', chip.tone === 'live-on' ? 'bg-white motion-safe:animate-pulse' : 'bg-ink-300')} aria-hidden />
      ) : null}
      {chip.key === 'c:donaido' ? <HeartHandshake size={12} strokeWidth={2} className="shrink-0" aria-hidden /> : null}
      {chip.dot ? <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: chip.dot }} aria-hidden /> : null}
      {chip.label}
      {chip.count ? <span className="shrink-0 text-[10px] font-semibold opacity-60">{chip.count}</span> : null}
    </Link>
  );
}

type PlatformChoice = VideoPlatformSlug | 'all';

export function PlatformSelect({ value, counts, size = 'sm', className, ...action }: {
  value: PlatformChoice;
  counts?: Partial<Record<VideoPlatformSlug, number>>;
  size?: 'sm' | 'md';
  className?: string;
} & (
  | { onChange: (platform: PlatformChoice) => void; hrefFor?: never }
  | { hrefFor: (platform: PlatformChoice) => string; onChange?: never }
)) {
  const router = useRouter();

  function select(next: string) {
    if (next !== 'all' && !isVideoPlatform(next)) return;
    if (action.hrefFor) router.push(action.hrefFor(next), { scroll: false });
    else action.onChange(next);
  }

  return (
    <div className={cx('relative shrink-0', className)}>
      <select
        aria-label="방송 플랫폼"
        value={value}
        onChange={(event) => select(event.target.value)}
        className={cx(
          'block w-full appearance-none truncate rounded-full border border-ink-100 bg-white pl-3 pr-7 font-bold text-ink-700 focus-visible:outline-2 focus-visible:outline-brand-500',
          size === 'sm' ? 'min-h-8 text-[11.5px]' : 'min-h-9 text-[12.5px]',
        )}
      >
        <option value="all">전체 플랫폼</option>
        {VIDEO_PLATFORMS.map(({ slug, label }) => (
          <option value={slug} key={slug}>{label}{counts?.[slug] ? ` (${counts[slug]})` : ''}</option>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
    </div>
  );
}

export function HubChipGrid({ chips, size = 'sm', label, className }: {
  chips: HubChip[];
  size?: 'sm' | 'md';
  label: string;
  className?: string;
}) {
  const railRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ back: false, forward: false });
  const overflow = edges.back || edges.forward;
  const activeKey = chips.find((chip) => chip.tone === 'active')?.key;

  useEffect(() => {
    const rail = railRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!rail || !viewport || !track) return;

    const measure = () => {
      const overflowing = track.offsetWidth > rail.clientWidth + 1;
      const back = overflowing && viewport.scrollLeft > 1;
      const forward = overflowing && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
      setEdges((previous) => previous.back === back && previous.forward === forward ? previous : { back, forward });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(track);
    viewport.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', measure);
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const active = viewport?.querySelector('[aria-current="page"]');
    if (!viewport || !active) return;

    const bounds = viewport.getBoundingClientRect();
    const chip = active.getBoundingClientRect();
    if (chip.left < bounds.left + 2) {
      viewport.scrollBy({ left: chip.left - bounds.left - 2, behavior: 'instant' });
    } else if (chip.right > bounds.right - 2) {
      viewport.scrollBy({ left: chip.right - bounds.right + 2, behavior: 'instant' });
    }
  }, [activeKey, overflow]);

  function move(direction: -1 | 1) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(80, Math.round(viewport.clientWidth * 0.8)),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }

  const arrow = 'hidden size-8 shrink-0 place-items-center rounded-full border border-ink-100 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-35 [@media(hover:hover)_and_(pointer:fine)]:grid';

  return (
    <nav ref={railRef} aria-label={label} className={cx('flex min-w-0 items-center gap-1', className)}>
      {overflow ? (
        <button type="button" className={arrow} aria-label={`${label} 이전으로 넘기기`} disabled={!edges.back} onClick={() => move(-1)}>
          <ChevronLeft size={16} aria-hidden />
        </button>
      ) : null}
      <div ref={viewportRef} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={trackRef} className="flex w-max gap-1.5 p-0.5">
          {chips.map((chip) => <HubChipLink key={chip.key} chip={chip} size={size} />)}
        </div>
      </div>
      {overflow ? (
        <button type="button" className={arrow} aria-label={`${label} 다음으로 넘기기`} disabled={!edges.forward} onClick={() => move(1)}>
          <ChevronRight size={16} aria-hidden />
        </button>
      ) : null}
    </nav>
  );
}
