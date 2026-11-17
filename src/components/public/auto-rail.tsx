'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from '@/components/brand/icons';
import { cx } from '@/components/ui';

/**
 * 자동으로 천천히 흐르는 가로 선반 (2026-11-17). 메인 [구독자 전용] 탭 · 방송국 페이지 공용.
 *
 * - 카드가 화면보다 넓을 때만 흐른다. 넘치지 않으면 일반 선반처럼 멈춰 있다.
 * - 카드 묶음을 몇 번 더 이어 붙여 끝에서 처음으로 끊김 없이 이어진다(복제본은 스크린리더·탭 이동에서 제외).
 * - 손가락·마우스로 직접 넘길 수 있다. 마우스를 올리거나 누르거나 키보드로 들어오면 멈추고,
 *   손을 떼면 잠시 뒤 다시 흐른다.
 * - 화면 밖이거나 탭이 숨겨졌거나 "동작 줄이기" 설정이면 흐르지 않는다.
 * - controls: 마우스를 쓰는 PC 화면에서 좌우 넘김 버튼을 보여 준다(터치 기기에서는 숨김).
 * - fill: 항목이 적어 화면보다 좁아도 흐르게 한다. 넘칠 때까지 항목을 반복해 채운다(반복본은 스크린리더·탭 이동에서 제외).
 */
/**
 * 복제본 묶음 수. 손으로 넘기는 동안에는 위치를 옮기지 않으므로(아이폰 빈 화면 방지),
 * 쉬지 않고 계속 넘겨도 끝에 닿지 않도록 앞뒤 여유를 넉넉히 둔다.
 */
const CLONES = 3;

export function AutoRail({
  children,
  className,
  speed = 24,
  bleed = true,
  gap = 'gap-2.5 pr-2.5',
  controls = false,
  label,
  fill = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** 초당 이동 픽셀 */
  speed?: number;
  /** 화면 가장자리까지 넓혀 보여 줄지 (앱 패널 좌우 여백을 상쇄) */
  bleed?: boolean;
  /** 카드 사이 간격 클래스 (같은 값의 pr-* 를 함께 줘야 이음매가 맞는다) */
  gap?: string;
  controls?: boolean;
  /** 넘김 버튼 이름에 붙일 섹션 이름 */
  label?: string;
  /** 짧은 목록도 넘칠 때까지 반복해 채워서 흐르게 한다 */
  fill?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const cloneRef = useRef<HTMLDivElement>(null);
  const nudgeRef = useRef<((dir: 1 | -1) => void) | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [loop, setLoop] = useState(false);
  const [reps, setReps] = useState(1);

  // 넘치는지 확인 → 넘칠 때만 복제본을 붙여 흐르게 한다
  useEffect(() => {
    const scroller = scrollerRef.current;
    const first = firstRef.current;
    if (!scroller || !first) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const check = () => {
      const over = first.offsetWidth > scroller.clientWidth + 8;
      // fill: 넘치지 않으면 반복 횟수를 늘려 다시 잰다(최대 8번)
      if (fill && !over && !reduce?.matches && first.offsetWidth > 0) {
        setReps((r) => (r < 8 ? r + 1 : r));
        return;
      }
      setOverflow(over);
      setLoop(over && !reduce?.matches);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(scroller);
    ro.observe(first);
    reduce?.addEventListener?.('change', check);
    return () => {
      ro.disconnect();
      reduce?.removeEventListener?.('change', check);
    };
  }, [fill, reps]);

  // 복제본 안의 링크·버튼은 탭 이동에서 뺀다
  useEffect(() => {
    if (!loop) return;
    scrollerRef.current?.querySelectorAll<HTMLElement>('[data-auto-rail-clone] a, [data-auto-rail-clone] button, [data-auto-rail-clone] [tabindex]').forEach((el) => el.setAttribute('tabindex', '-1'));
    firstRef.current?.querySelectorAll<HTMLElement>('[data-auto-rail-repeat] a, [data-auto-rail-repeat] button, [data-auto-rail-repeat] [tabindex]').forEach((el) => el.setAttribute('tabindex', '-1'));
  }, [loop, children, reps]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const step = () => Math.max(160, Math.round(scroller.clientWidth * 0.8));

    // 흐르지 않는 선반(넘치지만 동작 줄이기 등): 버튼은 일반 스크롤로
    if (!loop) {
      nudgeRef.current = (dir) => {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollBy({ left: dir * step(), behavior: reduce ? 'instant' : 'smooth' });
      };
      return () => { nudgeRef.current = null; };
    }

    const wrap = wrapRef.current;
    const first = firstRef.current;
    const clone = cloneRef.current;
    if (!wrap || !first || !clone) return;

    let raf = 0;
    let last = 0;
    let pos = scroller.scrollLeft;
    let target: number | null = null;
    let hover = false;
    let holding = false;
    let focused = false;
    let visible = true;
    let resumeAt = 0;
    // 코드가 마지막으로 넣은 스크롤 위치 · 사람이 마지막으로 스크롤한 시각
    let written = -1;
    let userAt = 0;

    const span = () => clone.offsetLeft - first.offsetLeft;
    const later = () => { resumeAt = performance.now() + 2500; };
    // 같은 모양이 w 간격으로 (1 + CLONES)번 있으니, 위치를 [lo, lo + w) 안에 두면 양옆에 같은 여유가 남는다.
    // 쉬지 않고 계속 넘겨도 이 여유(약 1.5묶음)를 다 쓰기 전에는 끝에 닿지 않는다.
    const lo = (w: number) => Math.max(0, (CLONES * w - scroller.clientWidth) / 2);
    const write = (v: number) => {
      written = v;
      scroller.scrollLeft = v;
    };

    nudgeRef.current = (dir) => {
      if (span() <= 0) return;
      target = (target ?? pos) + dir * step();
      later();
    };

    /**
     * 2026-11-18 수정: 아이폰에서 손으로 쭉쭉 넘기다 보면 선반이 통째로 비던 문제.
     * 예전에는 손가락이 닿아 있거나 관성으로 미끄러지는 중에도 스크롤 위치를 강제로 옮겨(끝 → 처음)
     * 브라우저 관성 스크롤과 충돌했다. 이제 사람이 넘기는 동안(손가락이 닿아 있거나, 스크롤이 멈춘 지
     * 0.2초가 안 됐을 때)에는 위치를 전혀 건드리지 않고, 완전히 멈춘 뒤에만 같은 모양 위치로 옮긴다.
     */
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min(t - last, 64) : 0;
      last = t;
      const w = span();
      if (w <= 0) return;
      // 사용자가 직접 넘겼으면 그 위치에서 이어 간다
      if (target == null && Math.abs(scroller.scrollLeft - pos) > 2) pos = scroller.scrollLeft;
      if (holding || t - userAt < 200) {
        pos = scroller.scrollLeft;
        target = null;
        return;
      }
      if (target != null) {
        const d = target - pos;
        if (Math.abs(d) < 0.5) {
          pos = target;
          target = null;
          later();
        } else {
          pos += d * Math.min(1, dt / 110);
        }
      } else {
        const paused = hover || focused || !visible || document.hidden || t < resumeAt;
        if (!paused) pos += (speed * dt) / 1000;
      }
      // 같은 모양 위치로 옮기기 (앞으로 · 뒤로 모두 끊김 없이)
      const l = lo(w);
      while (pos >= l + w) {
        pos -= w;
        if (target != null) target -= w;
      }
      while (pos < l) {
        pos += w;
        if (target != null) target += w;
      }
      if (Math.abs(scroller.scrollLeft - pos) >= 0.5) write(pos);
    };
    raf = requestAnimationFrame(tick);

    const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse') hover = true; };
    const onLeave = (e: PointerEvent) => { if (e.pointerType === 'mouse') { hover = false; later(); } };
    const onDown = () => { holding = true; target = null; };
    const onUp = () => { if (holding) { holding = false; later(); } };
    const onWheel = () => { target = null; later(); };
    // 코드가 넣은 위치가 아닌 스크롤(손가락 · 관성 · 휠 · 트랙패드)은 사람이 넘기는 중으로 본다
    const onScroll = () => {
      if (Math.abs(scroller.scrollLeft - written) > 1.5) {
        userAt = performance.now();
        later();
      }
    };
    const onFocusIn = () => { focused = true; };
    const onFocusOut = () => { focused = false; later(); };

    wrap.addEventListener('pointerenter', onEnter);
    wrap.addEventListener('pointerleave', onLeave);
    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchend', onUp);
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('focusin', onFocusIn);
    scroller.addEventListener('focusout', onFocusOut);
    const io = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
    io.observe(scroller);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      nudgeRef.current = null;
      wrap.removeEventListener('pointerenter', onEnter);
      wrap.removeEventListener('pointerleave', onLeave);
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('touchstart', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchend', onUp);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('focusin', onFocusIn);
      scroller.removeEventListener('focusout', onFocusOut);
    };
  }, [loop, speed]);

  const arrow =
    'absolute top-1/2 z-[3] hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-ink-100 bg-white/95 text-ink-800 shadow-[0_6px_18px_rgba(45,28,103,0.16)] transition hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-brand-500 [@media(hover:hover)_and_(pointer:fine)]:grid';

  return (
    <div ref={wrapRef} className="relative">
      <div
        ref={scrollerRef}
        data-auto-rail={loop ? 'on' : 'off'}
        className={cx(
          'relative flex overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          bleed && '-mx-4 px-4 sm:-mx-6 sm:px-6',
          className,
        )}
      >
        <div ref={firstRef} className={cx('flex shrink-0', gap)}>
          {children}
          {Array.from({ length: reps - 1 }, (_, i) => (
            <div key={i} aria-hidden data-auto-rail-repeat className="contents">{children}</div>
          ))}
        </div>
        {loop
          ? Array.from({ length: CLONES }, (_, c) => (
              <div key={c} ref={c === 0 ? cloneRef : undefined} aria-hidden data-auto-rail-clone className={cx('flex shrink-0', gap)}>
                {children}
                {Array.from({ length: reps - 1 }, (_, i) => (
                  <div key={i} className="contents">{children}</div>
                ))}
              </div>
            ))
          : null}
      </div>
      {controls && overflow ? (
        <>
          <button type="button" aria-label={`${label ?? '목록'} 이전으로 넘기기`} onClick={() => nudgeRef.current?.(-1)} className={cx(arrow, 'left-1')}>
            <ChevronLeft size={20} strokeWidth={2} aria-hidden />
          </button>
          <button type="button" aria-label={`${label ?? '목록'} 다음으로 넘기기`} onClick={() => nudgeRef.current?.(1)} className={cx(arrow, 'right-1')}>
            <ChevronRight size={20} strokeWidth={2} aria-hidden />
          </button>
        </>
      ) : null}
    </div>
  );
}
