'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Heart, Loader2, Ticket, X } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { castVoteAction, type VoteActionState } from '@/app/actions/vote';
import { categoryLabel, isVideoCategory } from '@/lib/video-hub';

/**
 * [투표] 버튼 + 투표 창 (2026-11-17).
 * 표 수를 고르면 소진될 투표권을 미리 보여 주고, 보내면 화면을 새로 고친다.
 */

export interface VoteButtonProps {
  /** category: 크리에이터 활동 카테고리 slug — 이 표가 그 카테고리 랭킹에도 함께 들어간다는 것을 보여 준다 */
  creator: { id: string; name: string; code: string; avatarUrl: string | null; avatarIndex: number; category?: string | null };
  loggedIn: boolean;
  balance: number;
  ticketsPerVote: number;
  quickVotes: number[];
  maxVotesPerAction: number;
  roundId?: string | null;
  /** 투표가 꺼져 있으면 사유 */
  disabledReason?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
  /**
   * 좁은 카드 안에서는 글자를 접고 동그란 아이콘 버튼으로 줄인다 (이름을 가리지 않게).
   * 가장 가까운 @container 폭이 13.5rem 미만일 때 적용된다.
   */
  collapseNarrow?: boolean;
  /** 처음부터 창을 열어 둔다 (/vote?vote=코드) */
  autoOpen?: boolean;
}

const initial: VoteActionState = { ok: false };

const SIZE: Record<NonNullable<VoteButtonProps['size']>, string> = {
  xs: 'h-7 px-2.5 text-[11.5px] rounded-full',
  sm: 'h-8 px-3 text-[12.5px] rounded-full',
  md: 'h-10 px-4 text-[13.5px] rounded-xl',
  lg: 'h-12 px-5 text-[15px] rounded-2xl w-full',
};

export function VoteButton(props: VoteButtonProps) {
  const { creator, size = 'sm', label = '투표', className, collapseNarrow = false } = props;
  const [open, setOpen] = React.useState(false);
  // /vote?vote=코드 로 들어오면 창을 바로 연다 (서버 렌더와 어긋나지 않도록 화면이 뜬 뒤에 연다)
  React.useEffect(() => {
    if (!props.autoOpen) return;
    const t = window.setTimeout(() => setOpen(true), 0);
    return () => window.clearTimeout(t);
  }, [props.autoOpen]);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          'inline-flex shrink-0 items-center justify-center gap-1 bg-ink-900 font-extrabold text-white shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-brand-500',
          SIZE[size],
          collapseNarrow ? 'w-8 !px-0 @[13.5rem]:w-auto @[13.5rem]:!px-3' : '',
          className,
        )}
        aria-label={`${creator.name} 에게 투표하기`}
      >
        <Heart size={size === 'xs' ? 12 : 14} strokeWidth={2} aria-hidden />
        <span className={collapseNarrow ? 'hidden @[13.5rem]:inline' : undefined}>{label}</span>
      </button>
      {/* 하단 메뉴·고정 헤더 위로 뜨도록 body 에 바로 붙인다 */}
      {open ? createPortal(<VoteSheet {...props} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function VoteSheet({ creator, loggedIn, balance, ticketsPerVote, quickVotes, maxVotesPerAction, roundId, disabledReason, onClose }: VoteButtonProps & { onClose: () => void }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(castVoteAction, initial);
  const [votes, setVotes] = React.useState<number>(quickVotes[0] ?? 1);
  const live = state.balance ?? balance;
  const maxByBalance = Math.floor(live / Math.max(ticketsPerVote, 1));
  const maxVotes = Math.max(0, Math.min(maxByBalance, maxVotesPerAction));
  const need = votes * ticketsPerVote;
  const lack = need > live;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-ink-900/45 backdrop-blur-[2px] sm:items-center" role="dialog" aria-modal="true" aria-label={`${creator.name} 투표`} onClick={onClose}>
      <div className="w-full max-w-[440px] rounded-t-[28px] bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl sm:rounded-[28px]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink-100 sm:hidden" aria-hidden />
        <div className="flex items-center gap-3">
          <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={creator.name} imageUrl={creator.avatarUrl} className="h-12 w-12" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-black tracking-[-0.02em] text-ink-900">{creator.name}</p>
            <p className="text-[12px] text-ink-400">
              {roundId ? (
                '왕중왕전 투표'
              ) : creator.category && isVideoCategory(creator.category) && creator.category !== 'other' ? (
                <>
                  전체 랭킹 + <b className="font-extrabold text-brand-700">{categoryLabel(creator.category)}</b> 카테고리 랭킹에 함께 반영돼요
                </>
              ) : (
                '실시간 · 주간 · 월간 랭킹에 함께 반영돼요'
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-ink-400 hover:bg-ink-50" aria-label="닫기">
            <X size={18} aria-hidden />
          </button>
        </div>

        {state.ok ? (
          <div className="py-8 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-100 text-brand-700">
              <Check size={26} strokeWidth={2.4} aria-hidden />
            </span>
            <p className="mt-3 text-[16px] font-black text-ink-900">{state.message}</p>
            <p className="mt-1 text-[13px] text-ink-500">남은 투표권 {live.toLocaleString('ko-KR')}개</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={onClose} className="h-11 rounded-xl border border-ink-200 text-[13.5px] font-bold text-ink-700">닫기</button>
              <Link href="/vote/charge" className="grid h-11 place-items-center rounded-xl bg-brand-400 text-[13.5px] font-extrabold text-ink-900">투표권 더 받기</Link>
            </div>
          </div>
        ) : !loggedIn ? (
          <div className="py-6 text-center">
            <p className="text-[14px] font-bold text-ink-800">로그인하면 투표할 수 있어요</p>
            <p className="mt-1 text-[12.5px] text-ink-500">광고를 보거나 퀴즈를 풀면 투표권을 무료로 받을 수 있어요.</p>
            <Link href={`/login?next=${encodeURIComponent(`/vote?vote=${creator.code}`)}`} className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-ink-900 px-6 text-[13.5px] font-extrabold text-white">
              로그인하고 투표하기
            </Link>
          </div>
        ) : disabledReason ? (
          <p className="py-8 text-center text-[13.5px] font-bold text-ink-500">{disabledReason}</p>
        ) : (
          <form action={action} className="mt-4">
            <input type="hidden" name="creatorId" value={creator.id} />
            {roundId ? <input type="hidden" name="roundId" value={roundId} /> : null}
            <div className="flex items-center justify-between rounded-2xl bg-warm-100 px-4 py-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-700">
                <Ticket size={16} strokeWidth={1.8} className="text-brand-700" aria-hidden />
                내 투표권
              </span>
              <span className="text-[16px] font-black tabular-nums text-ink-900">{live.toLocaleString('ko-KR')}개</span>
            </div>

            <p className="mb-2 mt-4 text-[12.5px] font-bold text-ink-500">몇 표를 보낼까요?</p>
            <div className="grid grid-cols-4 gap-1.5">
              {[...quickVotes.slice(0, 3), -1].map((q) => {
                const value = q === -1 ? maxVotes : q;
                const active = votes === value && value > 0;
                return (
                  <button
                    key={q}
                    type="button"
                    disabled={value <= 0}
                    onClick={() => setVotes(value)}
                    className={cx(
                      'h-11 rounded-xl border text-[13.5px] font-extrabold tabular-nums transition-colors disabled:opacity-40',
                      active ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:border-brand-300',
                    )}
                  >
                    {q === -1 ? '전부' : `${q.toLocaleString('ko-KR')}표`}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className="h-11 w-11 rounded-xl border border-ink-200 text-[18px] font-black text-ink-700" onClick={() => setVotes((v) => Math.max(1, v - 1))} aria-label="한 표 줄이기">-</button>
              <input
                name="votes"
                inputMode="numeric"
                value={votes}
                onChange={(e) => setVotes(Math.max(1, Math.min(maxVotesPerAction, Number(e.target.value.replace(/[^\d]/g, '')) || 1)))}
                className="h-11 min-w-0 flex-1 rounded-xl border border-ink-200 text-center text-[16px] font-black tabular-nums text-ink-900"
                aria-label="표 수"
              />
              <button type="button" className="h-11 w-11 rounded-xl border border-ink-200 text-[18px] font-black text-ink-700" onClick={() => setVotes((v) => Math.min(maxVotesPerAction, v + 1))} aria-label="한 표 늘리기">+</button>
            </div>
            <p className={cx('mt-2 text-[12px]', lack ? 'font-bold text-danger-600' : 'text-ink-500')}>
              투표권 {need.toLocaleString('ko-KR')}개가 사용돼요{ticketsPerVote > 1 ? ` (1표 = 투표권 ${ticketsPerVote}개)` : ''}.{lack ? ' 투표권이 부족해요.' : ''}
            </p>
            {state.message && !state.ok ? <p className="mt-2 rounded-xl bg-danger-50 px-3 py-2 text-[12.5px] font-bold text-danger-600">{state.message}</p> : null}
            {lack ? (
              <Link href="/vote/charge" className="mt-4 grid h-12 place-items-center rounded-2xl bg-brand-400 text-[15px] font-black text-ink-900">투표권 충전하러 가기</Link>
            ) : (
              <button type="submit" disabled={pending || votes < 1} className="mt-4 flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white disabled:opacity-60">
                {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Heart size={18} strokeWidth={2} aria-hidden />}
                {votes.toLocaleString('ko-KR')}표 보내기
              </button>
            )}
            <p className="mt-2 text-center text-[11px] text-ink-400">투표권은 투표 전용이며 현금으로 바꾸거나 다른 회원에게 줄 수 없어요.</p>
          </form>
        )}
      </div>
    </div>
  );
}
