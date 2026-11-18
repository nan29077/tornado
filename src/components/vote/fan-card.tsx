'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Medal } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { setFeaturedBadgeAction } from '@/app/actions/fanvote';
import type { VoteActionState } from '@/app/actions/vote';

export interface FanCardView {
  level: { level: number; name: string; xpTotal: number; progress: number; next: { level: number; name: string; xp: number } | null };
  featuredBadge: string | null;
  badges: Array<{ key: string; title: string; desc: string; earned: boolean }>;
  stats: { votes: number; attendanceDays: number; maxStreak: number; cheers: number; supportCount: number; invited: number };
}

/** 마이페이지 팬 카드 — 팬 레벨 · 경험치 · 배지(대표 배지 고르기) */
export function FanCard({ card }: { card: FanCardView }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(setFeaturedBadgeAction, { ok: false } as VoteActionState);
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
  const { level } = card;
  const earned = card.badges.filter((b) => b.earned).length;
  return (
    <div className="rounded-[22px] bg-ink-900 p-4 text-white shadow-card">
      <div className="flex items-center gap-3">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-400 text-ink-900">
          <span className="text-center leading-none">
            <span className="block text-[10px] font-black">Lv.</span>
            <span className="block text-[22px] font-black">{level.level}</span>
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-black">{level.name}</p>
          <p className="text-[11.5px] text-white/60">
            {level.xpTotal.toLocaleString('ko-KR')} XP{level.next ? ` · 다음 ${level.next.name}까지 ${(level.next.xp - level.xpTotal).toLocaleString('ko-KR')} XP` : ' · 최고 레벨'}
          </p>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/15">
            <span className="block h-full rounded-full bg-brand-400" style={{ width: `${Math.round(level.progress * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1.5 text-center sm:grid-cols-6">
        {[
          { l: '팬투표', v: `${card.stats.votes.toLocaleString('ko-KR')}표` },
          { l: '출석', v: `${card.stats.attendanceDays}일` },
          { l: '최고 연속', v: `${card.stats.maxStreak}일` },
          { l: '응원', v: `${card.stats.cheers}개` },
          { l: '서포트', v: `${card.stats.supportCount}회` },
          { l: '초대', v: `${card.stats.invited}명` },
        ].map((x) => (
          <div key={x.l} className="rounded-xl bg-white/10 px-1.5 py-2">
            <p className="text-[10px] font-bold text-white/55">{x.l}</p>
            <p className="text-[13px] font-black tabular-nums">{x.v}</p>
          </div>
        ))}
      </div>
      <p className="mb-2 mt-4 flex items-center gap-1 text-[12.5px] font-black text-brand-200">
        <Medal size={14} aria-hidden />
        배지 {earned}/{card.badges.length} · 눌러서 대표 배지로 정하기
      </p>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
        {card.badges.map((b) => (
          <form key={b.key} action={action}>
            <input type="hidden" name="badge" value={card.featuredBadge === b.key ? '' : b.key} />
            <button
              type="submit"
              disabled={!b.earned || pending}
              title={b.desc}
              className={cx(
                'flex h-full w-full flex-col items-center rounded-xl px-1.5 py-2 text-center',
                b.earned ? 'bg-white/10 hover:bg-white/20' : 'bg-white/[0.04] opacity-50',
                card.featuredBadge === b.key && 'ring-2 ring-brand-400',
              )}
            >
              {b.earned ? <Medal size={18} className="text-brand-300" aria-hidden /> : <Lock size={16} className="text-white/40" aria-hidden />}
              <span className="mt-1 text-[11px] font-extrabold leading-tight">{b.title}</span>
              {card.featuredBadge === b.key ? <span className="mt-0.5 text-[9.5px] font-black text-brand-300">대표</span> : null}
            </button>
          </form>
        ))}
      </div>
      {state.message && !state.ok ? <p className="mt-2 text-[11.5px] font-bold text-brand-200">{state.message}</p> : null}
    </div>
  );
}
