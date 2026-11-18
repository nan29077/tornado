'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Mail } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { deleteMyLetterAction, sendLetterAction, type TalkActionState } from '@/app/actions/talk';
import { LETTER_THEME_STYLE } from '@/lib/letter-themes';


const initial: TalkActionState = { ok: false };

/** 팬레터 쓰기 */
export function LetterComposer({ creatorId, code, creatorName, maxLength, left }: { creatorId: string; code: string; creatorName: string; maxLength: number; left: number }) {
  const router = useRouter();
  const [state, action, pending] = React.useActionState(sendLetterAction, initial);
  const [theme, setTheme] = React.useState('CREAM');
  const [body, setBody] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [seen, setSeen] = React.useState<number | undefined>(undefined);
  if (state.nonce !== seen) {
    setSeen(state.nonce);
    if (state.ok) {
      setBody('');
      setTitle('');
    }
  }
  React.useEffect(() => {
    if (state.ok && state.nonce) router.refresh();
  }, [state.ok, state.nonce, router]);
  const st = LETTER_THEME_STYLE[theme];
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="creatorId" value={creatorId} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="theme" value={theme} />
      <div className="flex gap-1.5">
        {Object.entries(LETTER_THEME_STYLE).map(([k, v]) => (
          <button key={k} type="button" onClick={() => setTheme(k)} aria-pressed={theme === k} className={cx('flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-bold', theme === k ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600')}>
            <span className={cx('h-3.5 w-3.5 rounded-full ring-1', v.paper)} aria-hidden />
            {v.label}
          </button>
        ))}
      </div>
      <div className={cx('rounded-[22px] p-4 ring-1', st.paper)}>
        <p className={cx('mb-2 text-[13px] font-black', st.ink)}>To. {creatorName}</p>
        <input name="title" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 40))} maxLength={40} placeholder="제목 (선택)" className={cx('mb-2 w-full border-b border-current/20 bg-transparent pb-1.5 text-[14px] font-bold outline-none placeholder:opacity-50', st.ink)} />
        <textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, maxLength))}
          rows={9}
          maxLength={maxLength}
          placeholder="마음을 담아 편지를 써 보세요. 크리에이터만 읽을 수 있어요."
          className={cx('w-full resize-none bg-transparent text-[14px] leading-[1.9] outline-none placeholder:opacity-50 [background-image:repeating-linear-gradient(transparent,transparent_25.6px,rgba(0,0,0,0.06)_26.6px)]', st.ink)}
        />
        <p className={cx('text-right text-[11px] opacity-60', st.ink)}>
          {body.length}/{maxLength}자
        </p>
      </div>
      {state.message ? <p className={cx('rounded-xl px-3 py-2 text-[12.5px] font-bold', state.ok ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600')}>{state.message}</p> : null}
      <button type="submit" disabled={pending || left <= 0 || body.trim().length < 10} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-ink-900 text-[15px] font-black text-white disabled:opacity-50">
        {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Mail size={17} aria-hidden />}
        {left > 0 ? `팬레터 보내기 (이번 7일 ${left}통 남음)` : '이번 7일 팬레터를 모두 보냈어요'}
      </button>
    </form>
  );
}

export function DeleteLetterButton({ letterId, code }: { letterId: string; code: string }) {
  const [state, action, pending] = React.useActionState(deleteMyLetterAction, initial);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm('이 편지를 지울까요? 크리에이터도 더 이상 볼 수 없어요.')) e.preventDefault();
      }}
    >
      <input type="hidden" name="letterId" value={letterId} />
      <input type="hidden" name="code" value={code} />
      <button type="submit" disabled={pending} className="text-[11.5px] font-bold text-ink-400 hover:text-danger-600">
        지우기
      </button>
      {state.message && !state.ok ? <span className="ml-1 text-[11px] text-danger-600">{state.message}</span> : null}
    </form>
  );
}
