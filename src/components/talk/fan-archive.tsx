'use client';

import * as React from 'react';
import { Heart, Loader2, Search } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { searchArchiveAction, toggleFanReactionAction } from '@/app/actions/talk';
import type { ThreadMessage } from '@/server/services/talk/talk';
import { TalkMedia } from './fan-chat';

const TABS = [
  { k: 'all', l: '전체' },
  { k: 'photo', l: '사진' },
  { k: 'voice', l: '음성' },
  { k: 'video', l: '영상' },
] as const;

/** 팬챗 보관함 — 크리에이터 메시지만 모아 보기 · 검색 · 사진/음성/영상 */
export function FanArchive({ creatorId, initial }: { creatorId: string; initial: ThreadMessage[] }) {
  const [items, setItems] = React.useState(initial);
  const [q, setQ] = React.useState('');
  const [tab, setTab] = React.useState<(typeof TABS)[number]['k']>('all');
  const [busy, setBusy] = React.useState(false);

  const run = async (nextQ: string, nextTab: typeof tab) => {
    setBusy(true);
    const r = await searchArchiveAction(creatorId, nextQ, nextTab).catch(() => null);
    setBusy(false);
    if (r?.allowed) setItems(r.messages);
  };

  const react = async (id: string) => {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, reacted: !m.reacted } : m)));
    const r = await toggleFanReactionAction(id).catch(() => null);
    if (!r?.ok) setItems((prev) => prev.map((m) => (m.id === id ? { ...m, reacted: !m.reacted } : m)));
  };

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(q, tab);
        }}
        className="flex h-11 items-center gap-2 rounded-2xl border border-ink-200 bg-white px-3.5"
      >
        <Search size={16} className="text-ink-400" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value.slice(0, 40))} placeholder="메시지 검색" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
        {busy ? <Loader2 size={16} className="animate-spin text-ink-400" aria-hidden /> : null}
      </form>
      <div className="mt-3 grid grid-cols-4 gap-1 rounded-2xl bg-white p-1 shadow-card">
        {TABS.map((t) => (
          <button
            key={t.k}
            type="button"
            onClick={() => {
              setTab(t.k);
              void run(q, t.k);
            }}
            aria-pressed={tab === t.k}
            className={cx('h-9 rounded-xl text-[13px] font-extrabold', tab === t.k ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-warm-100')}
          >
            {t.l}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="mt-6 rounded-2xl bg-white p-8 text-center text-[13px] font-bold text-ink-400 shadow-card">찾는 메시지가 없어요.</p>
      ) : tab === 'photo' ? (
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {items.map((m) =>
            m.imageUrl ? (
              <a key={m.id} href={m.imageUrl} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded-xl bg-warm-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.imageUrl} alt="" className="h-full w-full object-cover" />
              </a>
            ) : null,
          )}
        </div>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {items.map((m) => (
            <li key={m.id} className="rounded-2xl bg-white p-3.5 shadow-card">
              <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-ink-400">
                <span>
                  {new Date(m.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {m.kind === 'DIRECT' ? <span className="ml-1 rounded bg-brand-100 px-1 text-brand-800">나에게만</span> : null}
                </span>
                <button type="button" onClick={() => void react(m.id)} aria-pressed={m.reacted} aria-label={m.reacted ? '하트 취소' : '하트 보내기'} className="grid h-7 w-7 place-items-center rounded-full hover:bg-warm-100">
                  <Heart size={15} className={m.reacted ? 'fill-danger-500 text-danger-600' : 'text-ink-300'} />
                </button>
              </div>
              <TalkMedia m={m} />
              {m.body ? <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-900">{m.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
