'use client';

import * as React from 'react';
import Link from 'next/link';
import { Archive, Bell, BellOff, ChevronUp, Heart, Loader2, Mail, Mic, SendHorizontal, Settings2, Sparkles, X } from '@/components/brand/icons';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { cx } from '@/components/ui';
import {
  checkRemovedAction, loadOlderThreadAction, pollFanThreadAction, sendFanReplyAction, setRoomMutedAction, setRoomNicknameAction, toggleFanReactionAction,
  type TalkActionState,
} from '@/app/actions/talk';
import type { ComposerState, ThreadMessage } from '@/server/services/talk/talk';

/**
 * 구독자 팬챗방 — 버블형(기본) 또는 단체방.
 *
 * - 크리에이터 메시지는 왼쪽(사진 · 음성 · 영상), 내 답장은 오른쪽. 단체방이면 다른 구독자 메시지도 왼쪽에 이름과 함께.
 * - 실시간: /api/talk/stream 신호를 받으면 새 메시지를 가져온다. 신호가 끊겨도 20초마다(화면이 보일 때) 보충 조회한다.
 * - 입력창: 구독 D+N 에 맞는 글자 수, 크리에이터 메시지 1개당 남은 답장 수를 보여 준다.
 */
export function FanChat({
  creatorId,
  creator,
  initial,
  initialHasMore,
  composer: initialComposer,
  welcome,
  groupMode = false,
  archiveHref,
  lettersHref,
}: {
  creatorId: string;
  creator: { name: string; code: string; avatarUrl: string | null; avatarIndex: number };
  initial: ThreadMessage[];
  initialHasMore?: boolean;
  composer: ComposerState;
  welcome: string | null;
  groupMode?: boolean;
  archiveHref?: string;
  lettersHref?: string;
}) {
  const [messages, setMessages] = React.useState<ThreadMessage[]>(initial);
  const [hasMore, setHasMore] = React.useState(Boolean(initialHasMore));
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [composer, setComposer] = React.useState<ComposerState>(initialComposer);
  const [state, action, pending] = React.useActionState(sendFanReplyAction, { ok: false } as TalkActionState);
  const [body, setBody] = React.useState('');
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [live, setLive] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickToBottom = React.useRef(true);
  const lastAt = messages.length > 0 ? messages[messages.length - 1].createdAt : null;
  const lastRef = React.useRef(lastAt);
  const idsRef = React.useRef<string[]>(initial.map((m) => m.id));
  React.useEffect(() => {
    lastRef.current = lastAt;
    idsRef.current = messages.map((m) => m.id);
  }, [lastAt, messages]);

  // 보내기 성공 시 입력칸 비우기 (렌더 중 상태 맞추기 — 효과 안에서 setState 하지 않는다)
  const [seenNonce, setSeenNonce] = React.useState<number | undefined>(undefined);
  if (state.nonce !== seenNonce) {
    setSeenNonce(state.nonce);
    if (state.ok) setBody('');
  }

  const pull = React.useCallback(async () => {
    const r = await pollFanThreadAction(creatorId, lastRef.current).catch(() => null);
    if (!r || !r.allowed) return;
    if (r.composer) setComposer(r.composer);
    if (r.messages.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...r.messages.filter((m) => !seen.has(m.id))];
    });
  }, [creatorId]);

  const pruneRemoved = React.useCallback(async () => {
    const gone: string[] = await checkRemovedAction(creatorId, idsRef.current.slice(-200)).catch(() => [] as string[]);
    if (gone.length > 0) setMessages((prev) => prev.filter((m) => !gone.includes(m.id)));
  }, [creatorId]);

  // 실시간 신호 (SSE). 끊기면 브라우저가 3초 뒤 다시 붙는다.
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/talk/stream?c=${encodeURIComponent(creatorId)}`);
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('talk', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent<string>).data) as { kind?: string };
        if (d.kind === 'DELETE') void pruneRemoved();
        else void pull();
      } catch {
        void pull();
      }
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [creatorId, pull, pruneRemoved]);

  // 보충 조회: 실시간 연결이 있으면 20초, 없으면 6초마다 (화면이 보일 때만)
  React.useEffect(() => {
    const t = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void pull();
      },
      live ? 20_000 : 6_000,
    );
    return () => window.clearInterval(t);
  }, [pull, live]);

  React.useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [pull]);

  React.useEffect(() => {
    if (state.ok && state.nonce) {
      stickToBottom.current = true;
      void pull();
    }
  }, [state.ok, state.nonce, pull]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const loadOlder = async () => {
    if (loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const r = await loadOlderThreadAction(creatorId, messages[0].createdAt).catch(() => null);
    setLoadingOlder(false);
    if (!r || !r.allowed) return;
    setHasMore(Boolean(r.hasMore));
    stickToBottom.current = false;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...r.messages.filter((m) => !seen.has(m.id)), ...prev];
    });
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - prevHeight;
    });
  };

  const react = async (id: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reacted: !m.reacted } : m)));
    const r = await toggleFanReactionAction(id).catch(() => null);
    if (!r?.ok) setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reacted: !m.reacted } : m)));
  };

  const maxLength = composer.maxLength;
  const outOfReplies = composer.repliesLeft === 0 || composer.dailyLeft === 0;
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });

  return (
    <div className="flex min-h-[62vh] flex-col overflow-hidden rounded-[26px] bg-[#f4efe6] shadow-card ring-1 ring-warm-300/60">
      {/* 머리: 크리에이터 · D+N · 보관함 · 팬레터 · 설정 */}
      <div className="flex items-center gap-2.5 border-b border-warm-300/60 bg-white/85 px-3 py-2.5 backdrop-blur">
        <ProfileAvatar seed={creator.code} avatarIndex={creator.avatarIndex} name={creator.name} imageUrl={creator.avatarUrl} className="h-9 w-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-black text-ink-900">{creator.name}</p>
          <p className="flex items-center gap-1.5 text-[11px] font-bold text-ink-400">
            <span className="rounded-full bg-ink-900 px-1.5 py-px text-[10.5px] font-black tabular-nums text-brand-200">D+{composer.days.toLocaleString('ko-KR')}</span>
            <span className={cx('inline-flex items-center gap-1', live ? 'text-success-600' : 'text-ink-400')}>
              <span className={cx('h-1.5 w-1.5 rounded-full', live ? 'bg-success-500' : 'bg-ink-300')} aria-hidden />
              {live ? '실시간' : '자동 새로고침'}
            </span>
          </p>
        </div>
        {archiveHref ? (
          <Link href={archiveHref} aria-label="보관함" className="grid h-9 w-9 place-items-center rounded-full text-ink-600 hover:bg-warm-100">
            <Archive size={18} strokeWidth={1.7} />
          </Link>
        ) : null}
        {lettersHref && composer.letterEnabled ? (
          <Link href={lettersHref} aria-label="팬레터" className="grid h-9 w-9 place-items-center rounded-full text-ink-600 hover:bg-warm-100">
            <Mail size={18} strokeWidth={1.7} />
          </Link>
        ) : null}
        <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen} aria-label="팬챗방 설정" className="grid h-9 w-9 place-items-center rounded-full text-ink-600 hover:bg-warm-100">
          <Settings2 size={18} strokeWidth={1.7} />
        </button>
      </div>

      {settingsOpen ? <RoomSettings creatorId={creatorId} composer={composer} onChange={setComposer} onClose={() => setSettingsOpen(false)} /> : null}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 space-y-2.5 overflow-y-auto px-3 py-4 sm:px-4"
        style={{ maxHeight: '64vh' }}
      >
        {hasMore ? (
          <button type="button" onClick={loadOlder} disabled={loadingOlder} className="mx-auto flex items-center gap-1 rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-bold text-ink-500 shadow-sm">
            {loadingOlder ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ChevronUp size={13} aria-hidden />}
            지난 대화 더 보기
          </button>
        ) : null}
        {composer.milestone ? (
          <div className="mx-auto flex max-w-[92%] items-center gap-2 rounded-2xl bg-gradient-to-r from-brand-200 to-brand-300 px-3.5 py-2.5 text-[12.5px] font-extrabold text-ink-900">
            <Sparkles size={16} aria-hidden />
            오늘은 {creator.name} 님과 함께한 지 {composer.milestone.toLocaleString('ko-KR')}일째 되는 날이에요!
          </div>
        ) : null}
        {welcome ? <p className="mx-auto max-w-[85%] rounded-2xl bg-white/70 px-3 py-2 text-center text-[12px] text-ink-500">{welcome}</p> : null}
        {messages.length === 0 ? <p className="py-10 text-center text-[13px] text-ink-400">아직 메시지가 없어요. 크리에이터의 첫 메시지를 기다려 보세요.</p> : null}
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
                  <div className="min-w-0 max-w-[80%]">
                    <p className="mb-0.5 text-[11.5px] font-bold text-ink-600">
                      {creator.name}
                      {m.kind === 'DIRECT' ? <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] text-brand-800">나에게만</span> : null}
                    </p>
                    <div className="flex items-end gap-1.5">
                      <div className="min-w-0 rounded-2xl rounded-tl-md bg-white px-3.5 py-2 shadow-sm ring-1 ring-brand-200">
                        <TalkMedia m={m} />
                        {m.body ? <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-900">{m.body}</p> : null}
                      </div>
                      <span className="flex shrink-0 flex-col items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => void react(m.id)}
                          aria-pressed={m.reacted}
                          aria-label={m.reacted ? '하트 취소' : '하트 보내기'}
                          className="grid h-7 w-7 place-items-center rounded-full hover:bg-white/70"
                        >
                          <Heart size={15} strokeWidth={1.8} className={m.reacted ? 'fill-danger-500 text-danger-600' : 'text-ink-300'} />
                        </button>
                        <span className="text-[10px] text-ink-400">{time}</span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <form action={action} className="border-t border-warm-300/70 bg-white p-2.5">
        <input type="hidden" name="creatorId" value={creatorId} />
        {state.message ? <p className={cx('mb-1.5 px-1 text-[12px] font-bold', state.ok ? 'text-ink-400' : 'text-danger-600')}>{state.message}</p> : null}
        {outOfReplies ? (
          <p className="rounded-2xl bg-warm-100 px-3.5 py-3 text-center text-[12.5px] font-bold text-ink-500">
            {composer.dailyLeft === 0 ? '오늘 보낼 수 있는 답장을 모두 보냈어요. 내일 다시 보내 주세요.' : '이 메시지에 보낼 수 있는 답장을 모두 보냈어요. 새 메시지가 오면 다시 보낼 수 있어요.'}
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, maxLength))}
              rows={1}
              maxLength={maxLength}
              placeholder={groupMode ? '팬챗방에 메시지 보내기' : `${creator.name} 님에게 답장하기`}
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
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 px-1 text-[10.5px] text-ink-400">
          <span>{groupMode ? '크리에이터와 구독자 모두에게 보여요' : '내 답장은 크리에이터에게만 보여요'}</span>
          {composer.repliesLeft != null ? (
            <span className="font-bold text-ink-600">
              답장 {composer.repliesLeft}/{composer.replyPerMessage}
            </span>
          ) : null}
          <span>
            {body.length}/{maxLength}자
          </span>
          {composer.nextTier ? <span>D+{composer.nextTier.days}부터 {composer.nextTier.length}자</span> : null}
        </p>
      </form>
    </div>
  );
}

/** 사진 · 음성 · 영상 */
export function TalkMedia({ m }: { m: Pick<ThreadMessage, 'imageUrl' | 'mediaType' | 'mediaUrl' | 'mediaDuration'> }) {
  if (m.mediaType === 'VOICE' && m.mediaUrl) {
    return (
      <div className="mb-1.5 flex items-center gap-2 rounded-xl bg-brand-50 px-2 py-1.5">
        <Mic size={16} className="shrink-0 text-brand-700" aria-hidden />
        <audio src={m.mediaUrl} controls preload="metadata" className="h-9 w-full min-w-[180px] max-w-[240px]" />
        {m.mediaDuration ? <span className="shrink-0 text-[10.5px] font-bold tabular-nums text-ink-500">{fmtDuration(m.mediaDuration)}</span> : null}
      </div>
    );
  }
  if (m.mediaType === 'VIDEO' && m.mediaUrl) {
    return <video src={m.mediaUrl} controls playsInline preload="metadata" className="mb-1.5 max-h-80 w-full max-w-[280px] rounded-xl bg-black" />;
  }
  if (m.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={m.imageUrl} alt="" className="mb-1.5 max-h-72 rounded-xl object-cover" />;
  }
  return null;
}

export function fmtDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function RoomSettings({ creatorId, composer, onChange, onClose }: { creatorId: string; composer: ComposerState; onChange: (c: ComposerState) => void; onClose: () => void }) {
  const [state, action, pending] = React.useActionState(setRoomNicknameAction, { ok: false } as TalkActionState);
  const [muteBusy, setMuteBusy] = React.useState(false);
  const [nick, setNick] = React.useState(composer.nickname ?? '');
  // 저장 성공을 부모에 알린다 (부모 상태는 렌더 중이 아니라 효과에서 바꾼다)
  const handled = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (!state.nonce || handled.current === state.nonce) return;
    handled.current = state.nonce;
    if (state.ok) onChange({ ...composer, nickname: nick.trim() || null });
  }, [state.nonce, state.ok, composer, nick, onChange]);
  const toggleMute = async () => {
    setMuteBusy(true);
    const r = await setRoomMutedAction(creatorId, !composer.muted).catch(() => null);
    setMuteBusy(false);
    if (r?.ok) onChange({ ...composer, muted: !composer.muted });
  };
  return (
    <div className="border-b border-warm-300/60 bg-white px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] font-black text-ink-900">팬챗방 설정</p>
        <button type="button" onClick={onClose} aria-label="닫기" className="grid h-7 w-7 place-items-center rounded-full hover:bg-warm-100">
          <X size={15} />
        </button>
      </div>
      <form action={action} className="flex items-end gap-2">
        <input type="hidden" name="creatorId" value={creatorId} />
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-[11.5px] font-bold text-ink-500">크리에이터가 불러 줄 내 이름 (2~12자 · 비우면 기본 이름)</span>
          <input name="nickname" value={nick} onChange={(e) => setNick(e.target.value.slice(0, 12))} maxLength={12} className="h-10 w-full rounded-xl border border-ink-200 px-3 text-[13.5px]" placeholder="예) 민트초코" />
        </label>
        <button type="submit" disabled={pending} className="h-10 shrink-0 rounded-xl bg-ink-900 px-3.5 text-[12.5px] font-extrabold text-white disabled:opacity-50">
          저장
        </button>
      </form>
      {state.message ? <p className={cx('mt-1 text-[11.5px] font-bold', state.ok ? 'text-success-600' : 'text-danger-600')}>{state.message}</p> : null}
      <button type="button" onClick={toggleMute} disabled={muteBusy} className="mt-2.5 flex w-full items-center justify-between rounded-xl bg-warm-100 px-3 py-2.5 text-[13px] font-bold text-ink-700">
        <span className="flex items-center gap-1.5">
          {composer.muted ? <BellOff size={16} aria-hidden /> : <Bell size={16} aria-hidden />}새 메시지 알림
        </span>
        <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-black', composer.muted ? 'bg-ink-200 text-ink-600' : 'bg-success-500 text-white')}>{composer.muted ? '꺼짐' : '켜짐'}</span>
      </button>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
        구독 D+{composer.days}일째예요. 답장 글자 수는 구독 일수에 따라 늘어나요{composer.nextTier ? ` (D+${composer.nextTier.days}부터 ${composer.nextTier.length}자)` : ' (최고 단계)'}.
      </p>
    </div>
  );
}
