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
        className="pointer-events-auto fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] top-auto mx-auto mb-0 max-h-[calc(100dvh-92px-env(safe-area-inset-bottom))] w-[min(24rem,calc(100%-24px))] max-w-none overflow-y-auto overscroll-contain rounded-[24px] border border-warm-200 bg-warm-50 text-ink-900 shadow-2xl backdrop:bg-ink-900/35"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between bg-warm-50 px-4 pb-1 pt-2">
          <h2 id={`${id}-title`} className="text-sm font-extrabold">방송국 미리보기</h2>
          <button
            type="button"
            onClick={() => {
              dialog.current?.close();
              setOpen(false);
            }}
            aria-label="방송국 미리보기 닫기"
            className="grid h-10 w-10 place-items-center rounded-full text-ink-600 outline-none hover:bg-ink-100 focus:outline-none focus-visible:bg-ink-100"
          >
            <X size={20} />
          </button>
        </div>
        {open ? <div className="px-2 pb-2">{children}</div> : null}
      </dialog>
    </div>
  );
}
