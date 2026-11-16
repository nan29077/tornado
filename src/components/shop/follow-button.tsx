'use client';

import Link from 'next/link';
import { BellPlus, Check } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { toggleFollowAction } from '@/app/actions/shop';
import { ShopActionForm } from './shop-action-form';

/** 도네이도 구독 버튼 (비로그인이면 샵 로그인으로) */
export function FollowButton({
  creatorId,
  following,
  loginHref,
  loggedIn,
  count,
}: {
  creatorId: string;
  following: boolean;
  loginHref: string;
  loggedIn: boolean;
  count: number;
}) {
  const cls = cx(
    'inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-extrabold transition-colors',
    following ? 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-50' : 'bg-ink-900 text-white hover:opacity-90',
  );
  const label = (
    <>
      {following ? <Check size={15} strokeWidth={2} /> : <BellPlus size={15} strokeWidth={1.9} />}
      {following ? '구독중' : '구독하기'}
      <span className={cx('tabular-nums', following ? 'text-ink-400' : 'text-white/70')}>{count.toLocaleString('ko-KR')}</span>
    </>
  );
  if (!loggedIn) {
    return (
      <Link href={loginHref} className={cls}>
        {label}
      </Link>
    );
  }
  return (
    <ShopActionForm action={toggleFollowAction} hideMessage>
      {(pending) => (
        <>
          <input type="hidden" name="creatorId" value={creatorId} />
          <input type="hidden" name="on" value={following ? '0' : '1'} />
          <button type="submit" disabled={pending} className={cls} aria-pressed={following}>
            {label}
          </button>
        </>
      )}
    </ShopActionForm>
  );
}
