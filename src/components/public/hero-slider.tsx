'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, PlayCircle } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import type { HomeBanner } from '@/lib/home-banners';
import { embedUrlFor } from '@/lib/shop-video-embed';

type BannerVideo = { kind: 'file'; url: string } | { kind: 'youtube'; id: string };
export type HeroSlide = Omit<HomeBanner, 'video'> & { video: BannerVideo | null };

/** 자동 넘김 간격 */
const ROTATE_MS = 5600;

function HeroVideo({ video, poster, title, active, onPlayingChange }: {
  video: BannerVideo;
  poster: string;
  title: string;
  active: boolean;
  onPlayingChange: (playing: boolean) => void;
}) {
  const [loadEmbed, setLoadEmbed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameClass = 'block aspect-video w-full overflow-hidden rounded-[inherit] bg-ink-900';

  // 다른 배너로 넘어가면 재생을 멈춘다 (화면에 안 보이는 배너에서 소리가 나지 않게)
  // 임베드 해제는 렌더 중 상태 조정으로 처리한다(effect 안 setState 는 연쇄 렌더를 만든다).
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setLoadEmbed(false);
  }
  useEffect(() => {
    if (active) return;
    videoRef.current?.pause();
  }, [active]);

  if (video.kind === 'file') {
    return (
      <video
        ref={videoRef}
        src={video.url}
        poster={poster || undefined}
        aria-label={title}
        controls
        playsInline
        preload="none"
        onPlay={() => onPlayingChange(true)}
        onPause={() => onPlayingChange(false)}
        onEnded={() => onPlayingChange(false)}
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
      onClick={() => {
        setLoadEmbed(true);
        onPlayingChange(true);
      }}
      aria-label={`${title} 재생`}
      className={cx(frameClass, 'relative isolate grid place-items-center text-white focus-visible:outline-2 focus-visible:outline-white')}
    >
      {poster ? <Image alt="" src={poster} fill unoptimized className="-z-10 object-cover opacity-75" /> : null}
      <PlayCircle size={46} strokeWidth={1.7} className="drop-shadow-lg" />
    </button>
  );
}

/**
 * 메인 상단 배너 (구독자 전용 · 크리에이터 전용 공용). 2026-11-17 수정:
 *  - 모바일: 배너 크기는 이미지형 배너(첫 번째 배너) 기준. 영상이 있는 배너는 배경 이미지를 상자 전체에 깔고
 *    영상을 위쪽에 작게, 문구를 아래쪽에 두어 같은 크기 안에 들어가게 한다(예전처럼 세로로 길어지지 않음).
 *    문구는 잘리지 않도록 짧게 쓰고, 관리자가 길게 입력해도 설명은 모바일에서 2줄까지만 보인다.
 *  - 모든 배너를 같은 칸에 겹쳐 그려, 영상이 있는 배너와 이미지 배너의 높이가 달라도
 *    상자 크기는 항상 가장 큰 배너에 맞춰 같게 유지된다(모바일에서 첫 배너만 크기가 다르던 문제).
 *  - 자동 넘김: 5.6초마다. 마우스를 올리거나(PC) 배너 안 버튼에 초점이 있거나 영상이 재생 중일 때만 잠시 멈춘다.
 *    화살표·점으로 직접 넘기면 그 시점부터 다시 시간을 센다(예전처럼 한 번 누르면 영영 멈추지 않는다).
 */
export function HeroSlider({ slides, label, autoRotate = true }: { slides: HeroSlide[]; label: string; autoRotate?: boolean }) {
  const [current, setCurrent] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const count = slides.length;

  useEffect(() => {
    if (!autoRotate || hovered || focused || videoPlaying || count < 2) return;
    const timer = window.setTimeout(() => setCurrent((index) => (index + 1) % count), ROTATE_MS);
    return () => window.clearTimeout(timer);
  }, [autoRotate, count, hovered, focused, videoPlaying, current]);

  function move(next: number) {
    setVideoPlaying(false);
    setCurrent((next + count) % count);
  }

  const arrow = 'grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/25 bg-black/25 text-white backdrop-blur transition-colors hover:bg-black/55 focus-visible:outline-2 focus-visible:outline-white';

  return (
    <section
      aria-label={label}
      aria-roledescription="캐러셀"
      className="hero-slider relative isolate overflow-hidden rounded-[26px] bg-[#160e22] shadow-[0_20px_55px_rgba(23,18,54,0.20)]"
      // 터치 기기는 탭할 때 mouseenter 만 오고 mouseleave 가 오지 않아 자동 넘김이 멈춰 버린다 → 마우스일 때만
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHovered(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHovered(false); }}
      onFocus={(e) => { if ((e.target as HTMLElement).matches(':focus-visible')) setFocused(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
    >
      {/* 모든 배너를 같은 칸(1/1)에 겹친다 → 상자 높이 = 가장 큰 배너, 넘겨도 크기가 변하지 않는다 */}
      <div className="grid">
        {slides.map((slide, index) => {
          const active = index === current;
          const playingSlide = Boolean(slide.video);
          return (
            <div
              key={index}
              aria-roledescription="슬라이드"
              role="group"
              aria-label={`${index + 1} / ${count}`}
              aria-hidden={active ? undefined : true}
              inert={!active}
              className={cx(
                'relative isolate [grid-area:1/1] transition-opacity duration-500 motion-reduce:transition-none',
                active ? 'z-[1] opacity-100' : 'pointer-events-none opacity-0',
                playingSlide && 'flex flex-col sm:grid sm:min-h-[360px] sm:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] sm:items-center sm:gap-4 sm:p-7 sm:pb-20',
              )}
            >
              <div className={cx(playingSlide ? 'absolute inset-0 -z-10' : 'relative aspect-[3/2] sm:absolute sm:inset-0 sm:aspect-auto')}>
                <Image
                  src={slide.image}
                  alt=""
                  fill
                  preload={index === 0}
                  unoptimized={!slide.image.startsWith('/') || slide.image.startsWith('/api/media/')}
                  sizes="(min-width: 640px) 616px, 100vw"
                  className="object-cover object-right"
                />
                <div className={cx(
                  'absolute inset-0',
                  playingSlide
                    ? 'bg-[linear-gradient(180deg,rgba(22,14,34,0.30)_0%,rgba(22,14,34,0.62)_45%,#160e22_100%)] sm:bg-[linear-gradient(90deg,rgba(22,14,34,0.88),rgba(22,14,34,0.20))]'
                    : 'bg-[linear-gradient(180deg,transparent_32%,#160e22_100%)]',
                  playingSlide
                    ? ''
                    : 'sm:bg-[linear-gradient(90deg,rgba(22,14,34,0.95),rgba(22,14,34,0.54)_49%,rgba(22,14,34,0.03)_78%)]',
                )} />
              </div>

              {slide.video ? (
                <div className="relative mx-6 mt-6 w-[66%] max-w-[300px] rounded-2xl border border-white/25 bg-black p-0.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] sm:order-2 sm:mx-0 sm:mt-0 sm:w-auto sm:max-w-none">
                  <HeroVideo
                    video={slide.video}
                    poster={slide.poster}
                    title={slide.title.replace(/\s+/g, ' ')}
                    active={active}
                    onPlayingChange={(playing) => { if (active) setVideoPlaying(playing); }}
                  />
                </div>
              ) : null}

              <div className={cx(
                'relative min-w-0 px-6 pb-4',
                playingSlide
                  ? 'mt-auto pt-4 sm:order-1 sm:mt-0 sm:p-0'
                  : '-mt-8 sm:mt-0 sm:flex sm:min-h-[360px] sm:w-[58%] sm:flex-col sm:justify-center sm:px-8 sm:pb-20 sm:pt-8',
              )}>
                {slide.eyebrow ? <p className="truncate text-xs font-bold tracking-wide text-amber-200 sm:whitespace-normal">{slide.eyebrow}</p> : null}
                {index === 0 ? (
                  <h1 className="mt-2 whitespace-pre-line break-words text-[27px] font-black leading-[1.16] tracking-[-0.045em] text-white sm:text-[34px]">{slide.title}</h1>
                ) : (
                  <p className="mt-2 whitespace-pre-line break-words text-[27px] font-black leading-[1.16] tracking-[-0.045em] text-white sm:text-[34px]">{slide.title}</p>
                )}
                {slide.description ? (
                  <p className="mt-3 max-w-[25rem] break-words text-[13px] leading-relaxed text-white/85 max-sm:line-clamp-2">{slide.description}</p>
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
              </div>
            </div>
          );
        })}
      </div>

      {count > 1 ? (
        <div className="relative z-[2] flex items-center justify-between gap-3 px-6 pb-4 sm:absolute sm:inset-x-0 sm:bottom-0 sm:px-7 sm:pb-5">
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
                <span className={cx('h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none', current === index ? 'w-6 bg-amber-200' : 'w-2 bg-white/50')} />
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
