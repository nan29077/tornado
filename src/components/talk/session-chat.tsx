'use client';

import * as React from 'react';
import { Loader2, SendHorizontal } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { pollSessionAction, sendSessionMessageAction, type SessionPoll, type TalkActionState } from '@/app/actions/talk';

/** 1:1 예약 채팅방 (구독자 · 크리에이터 공용). 3초마다 새 메시지를 받아 온다. */
export function SessionChat({
  sessionId,
  role,
  otherName,
  initial,
  phase: initialPhase,
  startsAt,
  endsAt,
}: {
  sessionId: string;
  role: 'FAN' | 'CREATOR';
  otherName: string;
  initial: SessionPoll['messages'];
  phase: SessionPoll['phase'];
  startsAt: string;
  endsAt: string;
}) {
  const [messages, setMessages] = React.useState(initial);
  const [phase, setPhase] = React.useState(initialPhase);
  const [body, setBody] = React.useState('');
  const [now, setNow] = React.useState<number | null>(null);
  const [state, action, pending] = React.useActionState(sendSessionMessageAction, { ok: false } as TalkActionState);
  const lastRef = React.useRef<string | null>(initial.length ? initial[initial.length - 1].createdAt : null);
  const endRef = React.useRef<HTMLDivElement>(null);

  const pull = React.useCallback(async () => {
    const r = await pollSessionAction(sessionId, lastRef.current).catch(() => null);
    if (!r) return;
    setPhase(r.phase);
    if (r.messages.length) {
      lastRef.current = r.messages[r.messages.length - 1].createdAt;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...r.messages.filter((m) => !seen.has(m.id))];
      });
    }
  }, [sessionId]);

  React.useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const t = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible') void pull();
    }, 3000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [pull]);

  const [seenNonce, setSeenNonce] = React.useState<number | undefined>(undefined);
  if (state.nonce !== seenNonce) {
    setSeenNonce(state.nonce);
    if (state.ok) setBody('');
  }

  React.useEffect(() => {
    if (state.nonce) void pull();
  }, [state.nonce, pull]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const leftMs = now ? new Date(endsAt).getTime() - now : 0;
  const untilMs = now ? new Date(startsAt).getTime() - now : 0;
  const mm = (ms: number) => `${Math.max(0, Math.floor(ms / 60000))}분 ${Math.max(0, Math.floor((ms % 60000) / 1000))}초`;

  return (
    <div className="flex flex-col overflow-hidden rounded-[24px] bg-[#f4efe6] shadow-card ring-1 ring-warm-300/60">
      <div className={cx('px-4 py-2 text-center text-[12.5px] font-extrabold', phase === 'LIVE' ? 'bg-ink-900 text-white' : 'bg-warm-200 text-ink-600')}>
        {phase === 'LIVE' ? `대화 중 · 남은 시간 ${mm(leftMs)}` : phase === 'BEFORE' ? `시작까지 ${untilMs > 3600_000 ? `${Math.floor(untilMs / 3600_000)}시간 ` : ''}${mm(untilMs % 3600_000)}` : phase === 'AFTER' ? '대화 시간이 끝났어요 · 기록은 읽기만 할 수 있어요' : '진행하지 않는 예약입니다'}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4" style={{ minHeight: '40vh', maxHeight: '60vh' }}>
        {messages.length === 0 ? <p className="py-10 text-center text-[13px] text-ink-400">{phase === 'LIVE' ? '먼저 인사를 건네 보세요.' : '아직 메시지가 없어요.'}</p> : null}
        {messages.map((m) => {
          const mine = m.senderType === role;
          if (m.senderType === 'SYSTEM') return <p key={m.id} className="text-center text-[11.5px] text-ink-400">{m.body}</p>;
          return (
            <div key={m.id} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className="max-w-[78%]">
                {!mine ? <p className="mb-0.5 text-[11px] font-bold text-ink-500">{otherName}</p> : null}
                <p className={cx('whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed', mine ? 'rounded-br-md bg-brand-300 text-ink-900' : 'rounded-tl-md bg-white text-ink-900 shadow-sm')}>{m.body}</p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {phase === 'LIVE' ? (
        <form action={action} className="border-t border-warm-300/70 bg-white p-2.5">
          <input type="hidden" name="sessionId" value={sessionId} />
          {state.message ? <p className={cx('mb-1 px-1 text-[12px] font-bold', state.ok ? 'text-ink-400' : 'text-danger-600')}>{state.message}</p> : null}
          <div className="flex items-end gap-2">
            <textarea
              name="body"
              value={body}
              rows={1}
              onChange={(e) => setBody(e.target.value.slice(0, 500))}
              placeholder="메시지 입력"
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
          <p className="mt-1 px-1 text-[10.5px] text-ink-400">연락처 · 계좌 · 외부 메신저 아이디 · 링크는 자동으로 가려져요. 불편한 메시지는 신고해 주세요.</p>
        </form>
      ) : null}
    </div>
  );
}
