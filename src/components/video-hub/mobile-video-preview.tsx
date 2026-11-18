'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Clapperboard, X } from '@/components/brand/icons';

export function MobileVideoPreview({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const closeOnDesktop = () => {
      if (desktop.matches) dialog.current?.close();
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-controls={id}
        aria-expanded={open}
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
        className="pointer-events-auto flex h-[52px] min-w-[52px] flex-col items-center justify-center gap-0.5 rounded-full border border-brand-300 bg-brand-400 text-ink-900 shadow-[0_6px_20px_rgba(104,74,18,0.22)]"
      >
        <Clapperboard size={19} aria-hidden />
        <span className="text-[10px] font-extrabold">방송국</span>
      </button>
      <dialog
        ref={dialog}
        id={id}
        aria-labelledby={`${id}-title`}
        onClose={() => setOpen(false)}
        className="pointer-events-auto fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] top-auto mx-auto mb-0 max-h-[calc(100dvh-92px-env(safe-area-inset-bottom))] w-[min(24rem,calc(100%-24px))] max-w-none overflow-y-auto overscroll-contain rounded-[24px] border border-warm-200 bg-white text-ink-900 shadow-lift backdrop:bg-ink-900/40"
      >
        <div className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-warm-100 bg-white px-3.5 py-1.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-800">
              <Clapperboard size={17} aria-hidden />
            </span>
            <h2 id={`${id}-title`} className="text-[15px] font-extrabold tracking-tight">방송국 미리보기</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              dialog.current?.close();
              setOpen(false);
            }}
            aria-label="방송국 미리보기 닫기"
            className="grid size-11 shrink-0 place-items-center rounded-full text-ink-600 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            <X size={19} aria-hidden />
          </button>
        </div>
        {open ? <div className="px-3.5 pb-3 pt-3">{children}</div> : null}
      </dialog>
    </div>
  );
}
