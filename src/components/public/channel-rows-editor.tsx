'use client';

import * as React from 'react';
import { Plus, Star, Trash2 } from '@/components/brand/icons';
import { Input, Select, cx } from '@/components/ui';
import { CHANNEL_PLATFORMS, MAX_CHANNELS, platformCountLabel } from '@/lib/creator-channels';

/**
 * 크리에이터 채널 입력 (여러 개). 크리에이터 가입·전환 신청·재제출·샵 관리에서 같이 쓴다.
 * 서버로는 channelPlatform[] / channelUrl[] / channelTitle[] / channelFollowers[] / primaryChannel 로 보낸다.
 */
export interface ChannelRowValue {
  platform: string;
  url: string;
  title: string;
  followers: string;
}

const EMPTY: ChannelRowValue = { platform: 'YOUTUBE', url: '', title: '', followers: '' };

export function ChannelRowsEditor({
  initial,
  initialPrimary = 0,
  showFollowers = true,
}: {
  initial?: ChannelRowValue[];
  initialPrimary?: number;
  showFollowers?: boolean;
}) {
  const [rows, setRows] = React.useState<ChannelRowValue[]>(initial && initial.length > 0 ? initial : [{ ...EMPTY }]);
  const [primary, setPrimary] = React.useState(Math.min(initialPrimary, Math.max(0, (initial?.length ?? 1) - 1)));

  const update = (i: number, patch: Partial<ChannelRowValue>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => {
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, idx) => idx !== i)));
    setPrimary((p) => (p === i ? 0 : p > i ? p - 1 : p));
  };

  return (
    <div className="space-y-3">
      <input type="hidden" name="primaryChannel" value={primary} />
      {rows.map((r, i) => {
        const meta = CHANNEL_PLATFORMS.find((p) => p.value === r.platform) ?? CHANNEL_PLATFORMS[0];
        return (
          <div key={i} className="rounded-2xl border border-warm-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setPrimary(i)}
                aria-pressed={primary === i}
                className={cx(
                  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-bold',
                  primary === i ? 'bg-brand-100 text-brand-800' : 'text-ink-400 hover:bg-ink-50',
                )}
              >
                <Star size={13} strokeWidth={2} className={primary === i ? 'fill-current' : ''} />
                {primary === i ? '대표 채널' : '대표로 지정'}
              </button>
              {rows.length > 1 ? (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`${i + 1}번째 채널 삭제`}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-400 hover:bg-ink-50 hover:text-danger-600"
                >
                  <Trash2 size={15} strokeWidth={1.8} />
                </button>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
              <Select name="channelPlatform" value={r.platform} onChange={(e) => update(i, { platform: e.target.value })} aria-label="플랫폼">
                {CHANNEL_PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <Input
                name="channelUrl"
                type="url"
                inputMode="url"
                maxLength={300}
                value={r.url}
                onChange={(e) => update(i, { url: e.target.value })}
                placeholder={meta.placeholder}
                aria-label="채널 주소"
              />
            </div>
            <div className={cx('mt-2 grid gap-2', showFollowers ? 'grid-cols-2' : 'grid-cols-1')}>
              <Input
                name="channelTitle"
                maxLength={60}
                value={r.title}
                onChange={(e) => update(i, { title: e.target.value })}
                placeholder="채널명"
                aria-label="채널명"
              />
              {showFollowers ? (
                <Input
                  name="channelFollowers"
                  inputMode="decimal"
                  maxLength={20}
                  value={r.followers}
                  onChange={(e) => update(i, { followers: e.target.value })}
                  placeholder={`${platformCountLabel(r.platform)} 수 (예: 1.2만)`}
                  aria-label={`${platformCountLabel(r.platform)} 수`}
                />
              ) : (
                <input type="hidden" name="channelFollowers" value={r.followers} />
              )}
            </div>
          </div>
        );
      })}
      {rows.length < MAX_CHANNELS ? (
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, { ...EMPTY, platform: 'TIKTOK' }])}
          className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-200 text-[13px] font-bold text-ink-600 hover:bg-ink-50"
        >
          <Plus size={15} strokeWidth={2} />
          채널 추가 (최대 {MAX_CHANNELS}개)
        </button>
      ) : null}
    </div>
  );
}
