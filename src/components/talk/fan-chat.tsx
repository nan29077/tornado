'use client';

import * as React from 'react';
import { Heart, Loader2, SendHorizontal } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import { pollFanThreadAction, sendFanReplyAction, type TalkActionState } from '@/app/actions/talk';
import type { ThreadMessage } from '@/server/services/talk/talk';

/**
 * 구독자 소통방 — 크리에이터별 1:N 단체방(기본) 또는 버블형.
 * 크리에이터 메시지는 왼쪽(강조), 다른 구독자 메시지는 왼쪽(이름 표시), 내 메시지는 오른쪽.
 * 4초마다 새 메시지를 받아 온다(화면이 보일 때만).
 */
export function FanChat({
  creatorId,
  creator,
  initial,
  maxLength,
  welcome,
  groupMode = true,
}: {
  creatorId: string;
  creator: { name: string; code: string; avatarUrl: string | null; avatarIndex: number };
  initial: ThreadMessage[];
  maxLength: number;
  welcome: string | null;
  groupMode?: boolean;
}) {
  const [messages, setMessages] = React.useState<ThreadMessage[]>(initial);
  const [state, action, pending] = React.useActionState(sendFanReplyAction, { ok: false } as TalkActionState);
  const [body, setBody] = React.useState('');
  const endRef = React.useRef<HTMLDivElement>(null);
  const lastAt = messages.length > 0 ? messages[messages.length - 1].createdAt : null;
  const lastRef = React.useRef(lastAt);
  React.useEffect(() => {
    lastRef.current = lastAt;
  }, [lastAt]);
  // 보내기 성공 시 입력칸 비우기 (렌더 중 상태 맞추기 — 효과 안에서 setState 하지 않는다)
  const [seenNonce, setSeenNonce] = React.useState<number | undefined>(undefined);
  if (state.nonce !== seenNonce) {
    setSeenNonce(state.nonce);
    if (state.ok) setBody('');
  }

  const pull = React.useCallback(async () => {
    const r = await pollFanThreadAction(creatorId, lastRef.current).catch(() => null);
    if (!r || !r.allowed || r.messages.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...r.messages.filter((m) => !seen.has(m.id))];
    });
  }, [creatorId]);

  React.useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pull();
    }, 4000);
    return () => window.clearInterval(t);
  }, [pull]);

  React.useEffect(() => {
    if (state.ok && state.nonce) void pull();
  }, [state.ok, state.nonce, pull]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const dayOf = (iso: string) => new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });
  return (
    <div className="flex min-h-[60vh] flex-col overflow-hidden rounded-[26px] bg-[#f4efe6] shadow-card ring-1 ring-warm-300/60">
      <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-4 sm:px-4" style={{ maxHeight: '64vh' }}>
        {welcome ? <p className="mx-auto max-w-[85%] rounded-2xl bg-white/70 px-3 py-2 text-center text-[12px] text-ink-500">{welcome}</p> : null}
        {messages.length === 0 ? <p className="py-10 text-center text-[13px] text-ink-400">아직 메시지가 없어요. 먼저 인사를 건네 보세요.</p> : null}
        {messages.map((m, i) => {
          const d = new Date(m.createdAt);
          const day = dayOf(m.createdAt);
          const showDay = i === 0 || dayOf(messages[i - 1].createdAt) !== day;
          const time = d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' });
          return (
            <React.Fragment key={m.id}>
              {showDay ? <p className="py-1 text-center text-[11px] font-bold text-ink-400">{day}</p> : null}
              {m.mine ? (
                <div className="flex items-end justify-end gap-1.5">
                  <span className="flex flex-col items-end text-[10px] text-ink-400">
                    {m.hearted ? <Heart size={12} className="fill-danger-500 text-danger-600" aria-label="크리에이터가 하트를 눌렀어요" /> : null}
                    {time}
                  </span>
                  <p className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-300 px-3.5 py-2 text-[14px] leading-relaxed text-ink-900">{m.body}</p>
                </div>
              ) : m.kind === 'FAN_REPLY' ? (
                <div className="flex items-start gap-2">
                  <ProfileAvatar seed={`fan-${m.authorName ?? ''}`} avatarIndex={m.authorAvatarIndex ?? 0} name={m.authorName ?? '팬'} className="h-8 w-8 shrink-0" />
                  <div className="min-w-0 max-w-[78%]">
                    <p className="mb-0.5 text-[11px] font-bold text-ink-500">{m.authorName ?? '팬'}</p>
                    <div className="flex items-end gap-1.5">
                      <p className="whitespace-pre-wrap break-words rounded-2xl rounded-tl-md bg-white/80 px-3.5 py-2 text-[13.5px] leading-relaxed text-ink-800">{m.body}</p>
                      <span className="shrink-0 text-[10px] text-ink-400">{time}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={creator.name} imageUrl={creator.avatarUrl} className="h-9 w-9 shrink-0" />
                  <div className="min-w-0 max-w-[78%]">
                    <p className="mb-0.5 text-[11.5px] font-bold text-ink-600"><span className="mr-1 rounded bg-ink-900 px-1 py-px text-[9.5px] font-black text-brand-200">크리에이터</span>{creator.name}{m.kind === 'DIRECT' ? <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] text-brand-800">나에게만</span> : null}</p>
                    <div className="flex items-end gap-1.5">
                      <div className="rounded-2xl rounded-tl-md bg-white px-3.5 py-2 shadow-sm ring-1 ring-brand-200">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {m.imageUrl ? <img src={m.imageUrl} alt="" className="mb-1.5 max-h-72 rounded-xl object-cover" /> : null}
                        <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-900">{m.body}</p>
                      </div>
                      <span className="shrink-0 text-[10px] text-ink-400">{time}</span>
                    </div>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        <div ref={endRef} />
      </div>
      <form action={action} className="border-t border-warm-300/70 bg-white p-2.5">
        <input type="hidden" name="creatorId" value={creatorId} />
        {state.message ? <p className={cx('mb-1.5 px-1 text-[12px] font-bold', state.ok ? 'text-ink-400' : 'text-danger-600')}>{state.message}</p> : null}
        <div className="flex items-end gap-2">
          <textarea
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, maxLength))}
            rows={1}
            placeholder={groupMode ? '소통방에 메시지 보내기' : `${creator.name} 님에게 메시지 보내기`}
            className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-ink-200 px-3.5 py-2.5 text-[14px] outline-none focus:border-brand-400"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
              }
            }}
          />
          <button type="submit" disabled={pending || !body.trim()} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink-900 text-white disabled:opacity-40" aria-label="보내기">
            {pending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <SendHorizontal size={18} aria-hidden />}
          </button>
        </div>
        <p className="mt-1 px-1 text-[10.5px] text-ink-400">{groupMode ? '크리에이터와 구독자 모두에게 보여요' : '내 메시지는 크리에이터에게만 보여요'} · {body.length}/{maxLength}자 · 연락처·링크는 자동으로 가려져요</p>
      </form>
    </div>
  );
}
