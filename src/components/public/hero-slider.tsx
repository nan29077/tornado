'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '@/components/ui';
import { DEFAULT_HOME_BANNER } from '@/lib/site-images';

const slides = [
  {
    image: DEFAULT_HOME_BANNER,
    eyebrow: 'MESSAGE TO LIVE',
    title: '문자 한 통이\n방송을 움직입니다',
    description: '진심을 담아 보낸 메시지가 결제 완료 후 라이브 화면과 음성으로 전달됩니다.',
    href: '/how-it-works',
    cta: '문자후원 알아보기',
  },
  {
    image: '/assets/tornado-hero-viewer-v2.png',
    eyebrow: 'SIMPLE SUPPORT',
    title: '보는 순간 바로\n응원을 전하세요',
    description: '복잡한 앱 설치 없이 안내된 번호로 문자를 보내고 안전하게 후원하세요.',
    href: '/how-it-works',
    cta: '이용방법 보기',
  },
  {
    image: '/assets/tornado-hero-studio-v2.png',
    eyebrow: 'FOR CREATORS',
    title: '후원의 순간을\n더 특별한 장면으로',
    description: '유튜브·OBS·PRISM·TTS를 연결해 크리에이터만의 후원 경험을 만드세요.',
    href: '/creator-apply',
    cta: '크리에이터 시작하기',
  },
  {
    image: '/assets/tornado-hero-mascot-v1.png',
    eyebrow: 'MEET DONAIDO',
    title: '도네이도와 함께\n응원이 주인공이 됩니다',
    description: '마음을 담은 문자 한 통이 도네이도 캐릭터와 방송 효과로 살아납니다.',
    href: '/how-it-works',
    cta: '도네이도 경험하기',
  },
];

export function HeroSlider({ bannerImage }: { bannerImage?: string }) {
  const [current, setCurrent] = React.useState(0);
  const [paused, setPaused] = React.useState(false);

  const move = React.useCallback((next: number) => {
    setCurrent((next + slides.length) % slides.length);
  }, []);

  React.useEffect(() => {
    if (paused) return;
    // 시스템의 동작 줄이기 설정을 존중해 자동 전환을 멈춘다
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setCurrent((value) => (value + 1) % slides.length), 5600);
    return () => window.clearInterval(timer);
  }, [paused]);

  return (
    <section
      className="hero-slider group relative isolate overflow-hidden rounded-[30px] bg-ink-900 shadow-[0_24px_70px_rgba(23,18,54,0.22)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="도네이도 주요 서비스"
    >
      {/* 이미지 영역.
          모바일: 원본 비율(3:2)에 맞춰 이미지가 잘리지 않게 보여주고, 텍스트는 이미지 아래에 배치한다.
          PC(sm+): 기존처럼 와이드 비율 + 좌측 텍스트 오버레이. */}
      <div className="relative aspect-[3/2] sm:aspect-[16/11]">
        {slides.map((slide, index) => (
          <div
            key={slide.image}
            className={cx(
              'absolute inset-0 transition-[opacity,transform] duration-700 ease-out',
              current === index ? 'scale-100 opacity-100' : 'pointer-events-none scale-[1.025] opacity-0',
            )}
            aria-hidden={current !== index}
          >
            <Image src={index === 0 && bannerImage ? bannerImage : slide.image} alt="" fill priority={index === 0} sizes="(min-width: 768px) 640px, 100vw" className="object-cover" />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(23,22,26,0)_58%,rgba(23,22,26,0.6)_88%,rgba(23,22,26,1)_100%)] sm:bg-[linear-gradient(90deg,rgba(23,22,26,0.9)_0%,rgba(23,22,26,0.6)_48%,rgba(23,22,26,0.1)_100%)]" />
          </div>
        ))}

        <div className="absolute right-4 top-4 z-20 hidden gap-1 sm:flex">
          <button type="button" aria-label="이전 배너" onClick={() => move(current - 1)} className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/15 text-white backdrop-blur transition-colors hover:bg-black/35">
            <ChevronLeft size={17} strokeWidth={1.7} />
          </button>
          <button type="button" aria-label="다음 배너" onClick={() => move(current + 1)} className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/15 text-white backdrop-blur transition-colors hover:bg-black/35">
            <ChevronRight size={17} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      {/* 텍스트 영역. 모바일은 이미지 아래 일반 흐름, sm+ 는 이미지 위 오버레이 */}
      <div className="relative z-10 -mt-2 px-6 pb-6 pt-0 sm:absolute sm:inset-y-0 sm:left-0 sm:mt-0 sm:flex sm:w-[72%] sm:flex-col sm:justify-end sm:p-9 sm:pb-9">
        <p className="text-[10px] font-bold tracking-[0.22em] text-white/65">{slides[current].eyebrow}</p>
        <h1 className="mt-2.5 whitespace-pre-line text-[26px] font-black leading-[1.16] tracking-[-0.045em] text-white sm:mt-3 sm:text-[36px]">
          {slides[current].title}
        </h1>
        <p className="mt-2.5 max-w-[430px] text-[13px] leading-relaxed text-white/72 sm:mt-3 sm:text-[14px]">
          {slides[current].description}
        </p>
        <Link
          href={slides[current].href}
          className="mt-4 inline-flex h-11 w-fit items-center gap-2 rounded-full bg-white px-5 text-[13px] font-extrabold text-ink-900 shadow-lg shadow-black/10 transition-transform hover:-translate-y-0.5 sm:mt-5"
        >
          {slides[current].cta}
          <ArrowRight size={15} strokeWidth={1.8} />
        </Link>

        <div className="mt-5 flex items-center gap-2 sm:mt-6">
          {slides.map((slide, index) => (
            <button
              key={slide.image}
              type="button"
              aria-label={`${index + 1}번 배너 보기`}
              onClick={() => move(index)}
              className={cx(
                'h-1.5 rounded-full transition-all',
                current === index ? 'w-9 bg-white' : 'w-2.5 bg-white/35 hover:bg-white/65',
              )}
            />
          ))}
          <span className="ml-1 text-[10px] font-semibold tabular-nums text-white/55">0{current + 1} / 0{slides.length}</span>
        </div>
      </div>
    </section>
  );
}
