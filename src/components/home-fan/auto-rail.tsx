'use client';

import { useEffect, useRef, useState } from 'react';
import { cx } from '@/components/ui';

/**
 * 구독자 전용 탭의 자동으로 천천히 흐르는 가로 선반 (2026-11-17).
 *
 * - 카드가 화면보다 넓을 때만 흐른다. 넘치지 않으면 일반 선반처럼 멈춰 있다.
 * - 카드 묶음을 한 번 더 이어 붙여 끝에서 처음으로 끊김 없이 이어진다(복제본은 스크린리더·탭 이동에서 제외).
 * - 손가락·마우스로 직접 넘길 수 있다. 마우스를 올리거나 누르거나 키보드로 들어오면 멈추고,
 *   손을 떼면 잠시 뒤 다시 흐른다.
 * - 화면 밖이거나 탭이 숨겨졌거나 "동작 줄이기" 설정이면 흐르지 않는다.
 */
export function AutoRail({
  children,
  className,
  speed = 24,
}: {
  children: React.ReactNode;
  className?: string;
  /** 초당 이동 픽셀 */
  speed?: number;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const cloneRef = useRef<HTMLDivElement>(null);
  const [loop, setLoop] = useState(false);

  // 넘치는지 확인 → 넘칠 때만 복제본을 붙여 흐르게 한다
  useEffect(() => {
    const scroller = scrollerRef.current;
    const first = firstRef.current;
    if (!scroller || !first) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const check = () => {
      const overflow = first.offsetWidth > scroller.clientWidth + 8;
      setLoop(overflow && !reduce?.matches);
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
  }, []);

  // 복제본 안의 링크·버튼은 탭 이동에서 뺀다
  useEffect(() => {
    if (!loop) return;
    cloneRef.current?.querySelectorAll<HTMLElement>('a, button, [tabindex]').forEach((el) => el.setAttribute('tabindex', '-1'));
  }, [loop, children]);

  useEffect(() => {
    if (!loop) return;
    const scroller = scrollerRef.current;
    const first = firstRef.current;
    const clone = cloneRef.current;
    if (!scroller || !first || !clone) return;

    let raf = 0;
    let last = 0;
    let pos = scroller.scrollLeft;
    let hover = false;
    let holding = false;
    let focused = false;
    let visible = true;
    let resumeAt = 0;

    const span = () => clone.offsetLeft - first.offsetLeft;

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min(t - last, 64) : 0;
      last = t;
      const w = span();
      if (w <= 0) return;
      // 사용자가 직접 넘겼으면 그 위치에서 이어 간다
      if (Math.abs(scroller.scrollLeft - pos) > 2) pos = scroller.scrollLeft;
      if (pos >= w) pos -= w;
      const paused = hover || holding || focused || !visible || document.hidden || t < resumeAt;
      if (!paused) pos += (speed * dt) / 1000;
      if (pos >= w) pos -= w;
      if (Math.abs(scroller.scrollLeft - pos) >= 0.5) scroller.scrollLeft = pos;
    };
    raf = requestAnimationFrame(tick);

    const later = () => { resumeAt = performance.now() + 2500; };
    const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse') hover = true; };
    const onLeave = (e: PointerEvent) => { if (e.pointerType === 'mouse') { hover = false; later(); } };
    const onDown = () => { holding = true; };
    const onUp = () => { if (holding) { holding = false; later(); } };
    const onWheel = () => later();
    const onFocusIn = () => { focused = true; };
    const onFocusOut = () => { focused = false; later(); };

    scroller.addEventListener('pointerenter', onEnter);
    scroller.addEventListener('pointerleave', onLeave);
    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchend', onUp);
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('focusin', onFocusIn);
    scroller.addEventListener('focusout', onFocusOut);
    const io = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
    io.observe(scroller);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      scroller.removeEventListener('pointerenter', onEnter);
      scroller.removeEventListener('pointerleave', onLeave);
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('touchstart', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchend', onUp);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('focusin', onFocusIn);
      scroller.removeEventListener('focusout', onFocusOut);
    };
  }, [loop, speed]);

  return (
    <div
      ref={scrollerRef}
      data-auto-rail={loop ? 'on' : 'off'}
      className={cx(
        'relative -mx-4 flex overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      <div ref={firstRef} className="flex shrink-0 gap-2.5 pr-2.5">{children}</div>
      {loop ? (
        <div ref={cloneRef} aria-hidden data-auto-rail-clone className="flex shrink-0 gap-2.5 pr-2.5">{children}</div>
      ) : null}
    </div>
  );
}
