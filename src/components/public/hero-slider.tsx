'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, PlayCircle } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import type { HomeBanner } from '@/lib/home-banners';
import { embedUrlFor } from '@/lib/shop-video-embed';

type BannerVideo = { kind: 'file'; url: string } | { kind: 'youtube'; id: string };
export type HeroSlide = Omit<HomeBanner, 'video'> & { video: BannerVideo | null };

function HeroVideo({ video, poster, title }: { video: BannerVideo; poster: string; title: string }) {
  const [loadEmbed, setLoadEmbed] = useState(false);
  const frameClass = 'block aspect-video w-full overflow-hidden rounded-[inherit] bg-ink-900';

  if (video.kind === 'file') {
    return (
      <video
        src={video.url}
        poster={poster || undefined}
        aria-label={title}
        controls
        playsInline
        preload="none"
        className={frameClass}
      />
    );
  }

  return loadEmbed ? (
    <iframe
      src={embedUrlFor('YOUTUBE', video.id, '', true) ?? undefined}
      title={title}
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      className={frameClass}
    />
  ) : (
    <button
      type="button"
      onClick={() => setLoadEmbed(true)}
      aria-label={`${title} 재생`}
      className={cx(frameClass, 'relative isolate grid place-items-center text-white focus-visible:outline-2 focus-visible:outline-white')}
    >
      {poster ? <Image alt="" src={poster} fill unoptimized className="-z-10 object-cover opacity-75" /> : null}
      <PlayCircle size={46} strokeWidth={1.7} className="drop-shadow-lg" />
    </button>
  );
}

export function HeroSlider({ slides, label, autoRotate }: { slides: HeroSlide[]; label: string; autoRotate: boolean }) {
  const [current, setCurrent] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const count = slides.length;
  const slide = slides[current];
  const playingSlide = Boolean(slide.video);

  useEffect(() => {
    if (!autoRotate || hovered || interacted || playingSlide || count < 2) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const timer = window.setInterval(() => {
      if (!motion.matches) setCurrent((index) => (index + 1) % count);
    }, 5600);
    return () => window.clearInterval(timer);
  }, [autoRotate, count, hovered, interacted, playingSlide]);

  function move(next: number) {
    setInteracted(true);
    setCurrent((next + count) % count);
  }

  const arrow = 'grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/25 bg-black/25 text-white backdrop-blur transition-colors hover:bg-black/55 focus-visible:outline-2 focus-visible:outline-white';
  const text = (
    <>
      {slide.eyebrow ? <p className="text-xs font-bold tracking-wide text-amber-200">{slide.eyebrow}</p> : null}
      <h1 className="mt-2 whitespace-pre-line break-words text-[27px] font-black leading-[1.16] tracking-[-0.045em] text-white sm:text-[34px]">
        {slide.title}
      </h1>
      {slide.description ? (
        <p className="mt-3 max-w-[25rem] break-words text-[13px] leading-relaxed text-white/85">{slide.description}</p>
      ) : null}
      {slide.href && slide.cta ? (
        <Link
          href={slide.href}
          className="mt-4 inline-flex min-h-10 w-fit items-center gap-2 rounded-full bg-white px-4 py-2 text-[13px] font-extrabold text-ink-900 transition-colors hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {slide.cta}
          <ArrowRight size={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
        </Link>
      ) : null}
    </>
  );

  return (
    <section
      aria-label={label}
      aria-roledescription="캐러셀"
      className="hero-slider relative isolate overflow-hidden rounded-[26px] bg-[#160e22] shadow-[0_20px_55px_rgba(23,18,54,0.20)]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setInteracted(true)}
    >
      <div
        key={current}
        aria-roledescription="슬라이드"
        role="group"
        aria-label={`${current + 1} / ${count}`}
        className={cx('relative isolate', playingSlide && 'sm:grid sm:min-h-[360px] sm:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] sm:items-center sm:gap-4 sm:p-7 sm:pb-20')}
      >
        <div className={cx('relative aspect-[3/2] sm:absolute sm:inset-0 sm:aspect-auto', playingSlide && 'sm:-z-10')}>
          <Image
            src={slide.image}
            alt=""
            fill
            preload={current === 0}
            unoptimized={!slide.image.startsWith('/') || slide.image.startsWith('/api/media/')}
            sizes="(min-width: 640px) 616px, 100vw"
            className="object-cover object-right"
          />
          <div className={cx(
            'absolute inset-0 bg-[linear-gradient(180deg,transparent_32%,#160e22_100%)]',
            playingSlide
              ? 'sm:bg-[linear-gradient(90deg,rgba(22,14,34,0.88),rgba(22,14,34,0.20))]'
              : 'sm:bg-[linear-gradient(90deg,rgba(22,14,34,0.95),rgba(22,14,34,0.54)_49%,rgba(22,14,34,0.03)_78%)]',
          )} />
        </div>

        {slide.video ? (
          <div className="relative -mt-[32%] mx-6 rounded-2xl border border-white/25 bg-black p-0.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] sm:order-2 sm:mx-0 sm:mt-0">
            <HeroVideo video={slide.video} poster={slide.poster} title={slide.title.replace(/\s+/g, ' ')} />
          </div>
        ) : null}

        <div className={cx(
          'relative min-w-0 px-6 pb-4',
          playingSlide
            ? 'pt-5 sm:order-1 sm:p-0'
            : '-mt-8 sm:mt-0 sm:flex sm:min-h-[360px] sm:w-[58%] sm:flex-col sm:justify-center sm:px-8 sm:pb-20 sm:pt-8',
        )}>
          {text}
        </div>
      </div>

      {count > 1 ? (
        <div className="relative flex items-center justify-between gap-3 px-6 pb-4 sm:absolute sm:inset-x-0 sm:bottom-0 sm:px-7 sm:pb-5">
          <div className="flex flex-wrap items-center">
            {slides.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`${index + 1}번 배너 보기`}
                aria-current={current === index ? 'true' : undefined}
                onClick={() => move(index)}
                className="grid h-9 place-items-center rounded px-1.5 first:pl-0 focus-visible:outline-2 focus-visible:outline-white"
              >
                <span className={cx('h-1.5 rounded-full', current === index ? 'w-6 bg-amber-200' : 'w-2 bg-white/50')} />
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button type="button" aria-label="이전 배너" onClick={() => move(current - 1)} className={arrow}>
              <ChevronLeft size={18} strokeWidth={1.8} aria-hidden />
            </button>
            <button type="button" aria-label="다음 배너" onClick={() => move(current + 1)} className={arrow}>
              <ChevronRight size={18} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
