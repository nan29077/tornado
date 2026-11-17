'use client';

import * as React from 'react';
import Link from 'next/link';
import { HeartHandshake } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { VideoCard } from '@/components/video-hub/video-card';
import { cx } from '@/components/ui';
import { categoryLabel, type VideoItem } from '@/lib/video-hub';
import type { FanChannel, FanCreator, FanLiveItem } from '@/server/services/home-fan';
import { ChannelAvatar, FanLiveCard, UnregisteredBadge, compactKo, newWindowIfShop } from './parts';

type Tab = 'creator' | 'video' | 'live';
type Sort = 'popular' | 'latest';
const PAGE = 8;

/**
 * 전체 둘러보기 — 크리에이터 · 동영상 · 라이브를 조회수 · 시청자수 · 구독자수와 함께 한곳에서.
 * 가입 크리에이터만 후원 표시를 단다. 미가입 채널에는 "미가입" 표기만 한다.
 */
export function BrowseAll({
  creators,
  channels,
  videos,
  live,
  now,
}: {
  creators: FanCreator[];
  channels: FanChannel[];
  videos: VideoItem[];
  live: FanLiveItem[];
  now: number;
}) {
  const [tab, setTab] = React.useState<Tab>('creator');
  const [sort, setSort] = React.useState<Sort>('popular');
  const [limit, setLimit] = React.useState(PAGE);

  const people = React.useMemo(() => {
    const rows = [
      ...creators.map((c) => ({
        key: `c:${c.id}`,
        donatable: true as const,
        name: c.displayName,
        category: c.category,
        subscribers: c.subscribers,
        at: c.approvedAt ? Date.parse(c.approvedAt) : 0,
        href: `/c/${encodeURIComponent(c.code)}`,
        creator: c,
        channel: null as FanChannel | null,
      })),
      ...channels.map((ch) => ({
        key: `y:${ch.channelId}`,
        donatable: false as const,
        name: ch.title,
        category: ch.category,
        subscribers: ch.subscribers ?? 0,
        at: Date.parse(ch.latest.publishedAt),
        href: `/watch/${encodeURIComponent(ch.latest.id)}`,
        creator: null as FanCreator | null,
        channel: ch,
      })),
    ];
    return rows.sort((a, b) => (sort === 'popular' ? b.subscribers - a.subscribers || b.at - a.at : b.at - a.at));
  }, [creators, channels, sort]);

  const vids = React.useMemo(
    () => [...videos].sort((a, b) => (sort === 'popular' ? (b.views ?? -1) - (a.views ?? -1) : Date.parse(b.publishedAt) - Date.parse(a.publishedAt))),
    [videos, sort],
  );
  const lives = React.useMemo(() => [...live].sort((a, b) => (b.viewers ?? -1) - (a.viewers ?? -1)), [live]);

  const total = tab === 'creator' ? people.length : tab === 'video' ? vids.length : lives.length;
  const tabs: Array<{ v: Tab; label: string; count: number }> = [
    { v: 'creator', label: '크리에이터', count: people.length },
    { v: 'video', label: '동영상', count: vids.length },
    { v: 'live', label: '라이브', count: lives.length },
  ];

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div role="tablist" aria-label="둘러보기 종류" className="flex gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.v}
              type="button"
              role="tab"
              aria-selected={tab === t.v}
              onClick={() => {
                setTab(t.v);
                setLimit(PAGE);
              }}
              className={cx(
                'min-h-9 rounded-full border px-3 text-[13px] font-bold transition-colors',
                tab === t.v ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50',
              )}
            >
              {t.label} <span className="tabular-nums opacity-70">{t.count}</span>
            </button>
          ))}
        </div>
        {tab !== 'live' ? (
          <select
            aria-label="정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="min-h-9 rounded-full border border-ink-200 bg-white px-3 text-[12.5px] font-bold text-ink-700"
          >
            <option value="popular">인기순</option>
            <option value="latest">최신순</option>
          </select>
        ) : null}
      </div>

      <div className="mt-3">
        {tab === 'creator' ? (
          <ul className="divide-y divide-ink-100 rounded-2xl border border-warm-200 bg-white">
            {people.slice(0, limit).map((p, i) => (
              <li key={p.key} className="relative flex items-center gap-3 px-3 py-2.5">
                <Link href={p.href} prefetch={false} {...newWindowIfShop(p.href)} aria-label={`${p.name} 보기`} className="absolute inset-0 z-[1] rounded-2xl" />
                <span className="w-5 shrink-0 text-center text-[12px] font-black tabular-nums text-ink-400">{i + 1}</span>
                {p.creator ? (
                  <ProfileAvatar seed={p.creator.code} avatarIndex={p.creator.avatarIndex} name={p.name} imageUrl={p.creator.avatarUrl} className="h-10 w-10" />
                ) : p.channel ? (
                  <ChannelAvatar channel={p.channel} className="h-10 w-10 text-sm" />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <p className="truncate text-[14px] font-extrabold text-ink-900">{p.name}</p>
                    {p.donatable ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-brand-400 px-1.5 py-0.5 text-[10.5px] font-extrabold text-ink-900">
                        <HeartHandshake size={11} strokeWidth={2} aria-hidden />
                        후원 가능
                      </span>
                    ) : (
                      <UnregisteredBadge />
                    )}
                  </div>
                  <p className="truncate text-[12px] text-ink-400">
                    {[p.category ? categoryLabel(p.category) : null, p.channel ? `최근 7일 업로드 ${p.channel.uploads7d}개` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[13px] font-black tabular-nums text-ink-900">{p.subscribers > 0 ? compactKo(p.subscribers) : '-'}</p>
                  <p className="text-[10.5px] text-ink-400">구독자</p>
                </div>
              </li>
            ))}
          </ul>
        ) : tab === 'video' ? (
          <div className="grid grid-cols-1 gap-1">
            {vids.slice(0, limit).map((v) => (
              <VideoCard key={v.id} item={v} now={now} layout="row" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {lives.slice(0, limit).map((l) => (
              <FanLiveCard key={l.key} item={l} wide />
            ))}
          </div>
        )}
        {total === 0 ? <p className="py-6 text-center text-[13px] text-ink-400">아직 보여 드릴 항목이 없어요.</p> : null}
      </div>

      {limit < total ? (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl border border-ink-200 bg-white text-[13.5px] font-bold text-ink-700 hover:bg-ink-50"
        >
          더보기 ({Math.min(limit, total)}/{total})
        </button>
      ) : null}
    </div>
  );
}
