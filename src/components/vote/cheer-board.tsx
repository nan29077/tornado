'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareHeart, Send } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { deleteCheerAction, postCheerAction } from '@/app/actions/fanvote';
import type { VoteActionState } from '@/app/actions/vote';

export interface CheerView {
  id: string;
  body: string;
  createdAt: string;
  name: string;
  avatarIndex: number;
  mine: boolean;
  creatorName?: string;
}

const initial: VoteActionState = { ok: false };

/** 응원 댓글 (크리에이터 · 이벤트 후보) */
export function CheerBoard({ creatorId, roundId, path, cheers, loggedIn, maxLength, enabled, title = '응원 한마디' }: {
  creatorId: string;
  roundId?: string | null;
  path: string;
  cheers: CheerView[];
  loggedIn: boolean;
  maxLength: number;
  enabled: boolean;
  title?: string;
}) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(postCheerAction, initial);
  const [body, setBody] = React.useState('');
  const [seen, setSeen] = React.useState<number | undefined>(undefined);
  if (state.nonce !== seen) {
    setSeen(state.nonce);
    if (state.ok) setBody('');
  }
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
  return (
    <section id="cheer" className="scroll-mt-24 rounded-[22px] bg-white p-4 shadow-card">
      <p className="mb-3 flex items-center gap-1.5 text-[15px] font-black text-ink-900">
        <MessageSquareHeart size={17} className="text-brand-700" aria-hidden />
        {title}
      </p>
      {enabled ? (
        loggedIn ? (
          <form action={action} className="flex items-center gap-2">
            <input type="hidden" name="creatorId" value={creatorId} />
            {roundId ? <input type="hidden" name="roundId" value={roundId} /> : null}
            <input type="hidden" name="path" value={path} />
            <input
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, maxLength))}
              maxLength={maxLength}
              placeholder="응원 한마디를 남겨 주세요"
              className="h-11 min-w-0 flex-1 rounded-xl border border-ink-200 px-3.5 text-[13.5px] outline-none focus:border-brand-400"
            />
            <button type="submit" disabled={pending || body.trim().length < 2} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink-900 text-white disabled:opacity-40" aria-label="응원 남기기">
              {pending ? <Loader2 size={17} className="animate-spin" aria-hidden /> : <Send size={17} aria-hidden />}
            </button>
          </form>
        ) : (
          <a href={`/login?next=${encodeURIComponent(path)}`} className="block rounded-xl bg-warm-100 px-4 py-3 text-center text-[13px] font-bold text-ink-600">
            로그인하고 응원 남기기
          </a>
        )
      ) : (
        <p className="rounded-xl bg-warm-100 px-4 py-3 text-center text-[12.5px] font-bold text-ink-500">지금은 응원 댓글을 받지 않아요.</p>
      )}
      {state.message ? <p className={cx('mt-2 text-[12px] font-bold', state.ok ? 'text-success-600' : 'text-danger-600')}>{state.message}</p> : null}
      {cheers.length === 0 ? (
        <p className="mt-4 text-center text-[12.5px] text-ink-400">첫 응원을 남겨 주세요.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {cheers.map((c) => (
            <li key={c.id} className="flex items-start gap-2">
              <ProfileAvatar seed={`cheer-${c.name}`} avatarIndex={c.avatarIndex} name={c.name} className="h-8 w-8 shrink-0" />
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-warm-50 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-ink-400">
                  <span className="text-ink-700">{c.name}</span>
                  {c.creatorName ? <span>→ {c.creatorName}</span> : null}
                  <span>{new Date(c.createdAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })}</span>
                  {c.mine ? <DeleteCheer id={c.id} path={path} /> : null}
                </div>
                <p className="break-words text-[13.5px] text-ink-800">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeleteCheer({ id, path }: { id: string; path: string }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(deleteCheerAction, initial);
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
  return (
    <form action={action} className="ml-auto">
      <input type="hidden" name="cheerId" value={id} />
      <input type="hidden" name="path" value={path} />
      <button type="submit" disabled={pending} className="text-[11px] font-bold text-ink-400 hover:text-danger-600">
        지우기
      </button>
    </form>
  );
}
