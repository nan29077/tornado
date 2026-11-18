'use client';

import * as React from 'react';
import { Clock3, Image as ImageIcon, Loader2, Mic, Send, Square, Trash2, Upload, Video, X } from '@/components/brand/icons';
import { cx } from '@/components/ui';
import { sendBroadcastAction } from '@/app/actions/studio-engage';
import type { StudioActionState } from '@/app/actions/studio';

type Attach = 'NONE' | 'IMAGE' | 'VOICE' | 'VIDEO';

/**
 * 크리에이터 팬챗 메시지 보내기 (2026-11-18)
 * - 글 + 사진 / 음성(녹음 또는 파일) / 영상 중 하나
 * - 예약 발송 (최대 30일 뒤)
 * 파일은 먼저 저장소에 올리고(사진 /api/upload · 음성·영상 /api/talk/upload) 주소만 서버 액션으로 보낸다.
 */
export function BroadcastComposer({ subscribers, roomOpen, voiceMaxSeconds }: { subscribers: number; roomOpen: boolean; voiceMaxSeconds: number }) {
  // 결과마다 nonce 를 붙여 "새 결과" 를 원시값으로 비교한다 (객체 비교는 서버 렌더에서 끝없이 다시 그리게 된다)
  const [state, action, pending] = React.useActionState(
    async (prev: StudioActionState & { nonce?: number }, fd: FormData) => ({ ...(await sendBroadcastAction(prev, fd)), nonce: Date.now() }),
    { ok: false } as StudioActionState & { nonce?: number },
  );
  const [body, setBody] = React.useState('');
  const [attach, setAttach] = React.useState<Attach>('NONE');
  const [url, setUrl] = React.useState('');
  const [duration, setDuration] = React.useState<number | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [schedule, setSchedule] = React.useState(false);
  const [when, setWhen] = React.useState('');
  const [recording, setRecording] = React.useState(false);
  const [recSec, setRecSec] = React.useState(0);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const timerRef = React.useRef<number | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [seen, setSeen] = React.useState<number | undefined>(undefined);
  if (state.nonce !== seen) {
    setSeen(state.nonce);
    if (state.ok) {
      setBody('');
      setAttach('NONE');
      setUrl('');
      setDuration(null);
      setSchedule(false);
      setWhen('');
    }
  }

  React.useEffect(
    () => () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const reset = (next: Attach) => {
    setAttach(next);
    setUrl('');
    setDuration(null);
    setError('');
  };

  const measure = (src: string, kind: 'VOICE' | 'VIDEO') =>
    new Promise<number | null>((resolve) => {
      const el = document.createElement(kind === 'VOICE' ? 'audio' : 'video');
      el.preload = 'metadata';
      const done = (v: number | null) => resolve(v != null && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
      el.onloadedmetadata = () => done(el.duration);
      el.onerror = () => done(null);
      window.setTimeout(() => done(null), 4000);
      el.src = src;
    });

  const upload = async (file: Blob, kind: 'IMAGE' | 'VOICE' | 'VIDEO', name = 'file') => {
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file, name);
      if (kind !== 'IMAGE') fd.append('kind', kind);
      const res = await fetch(kind === 'IMAGE' ? '/api/upload' : '/api/talk/upload', { method: 'POST', body: fd });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; message?: string } | null;
      if (!res.ok || !data?.ok || !data.url) throw new Error(data?.message ?? '올리지 못했어요. 다시 시도해 주세요.');
      setUrl(data.url);
      if (kind !== 'IMAGE') {
        const local = URL.createObjectURL(file);
        const d = await measure(local, kind);
        URL.revokeObjectURL(local);
        setDuration((prev) => prev ?? d);
      }
    } catch (e) {
      setError((e as Error).message);
      setUrl('');
    } finally {
      setUploading(false);
    }
  };

  const stopRecord = (sec?: number) => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setRecording(false);
    setDuration(Math.max(1, sec ?? recSec));
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  };

  const startRecord = async () => {
    setError('');
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('이 브라우저에서는 녹음을 할 수 없어요. 음성 파일을 올려 주세요.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : (rec.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
        void upload(blob, 'VOICE', `voice.${ext}`);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecSec(0);
      const started = Date.now();
      timerRef.current = window.setInterval(() => {
        const sec = Math.floor((Date.now() - started) / 1000);
        setRecSec(sec);
        if (sec >= voiceMaxSeconds) stopRecord(sec);
      }, 250);
    } catch {
      setError('마이크를 쓸 수 없어요. 브라우저 설정에서 마이크 권한을 허용해 주세요.');
    }
  };

  const accept = attach === 'IMAGE' ? 'image/jpeg,image/png,image/webp,image/gif' : attach === 'VOICE' ? 'audio/*' : attach === 'VIDEO' ? 'video/mp4,video/webm,video/quicktime' : '';
  const canSend = !pending && !uploading && !recording && (body.trim().length > 0 || (attach !== 'NONE' && url)) && (!schedule || when);

  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="imageUrl" value={attach === 'IMAGE' ? url : ''} />
      <input type="hidden" name="mediaType" value={attach === 'VOICE' || attach === 'VIDEO' ? attach : ''} />
      <input type="hidden" name="mediaUrl" value={attach === 'VOICE' || attach === 'VIDEO' ? url : ''} />
      <input type="hidden" name="mediaDuration" value={duration ?? ''} />
      <input type="hidden" name="scheduleOn" value={schedule ? 'on' : ''} />
      <input type="hidden" name="scheduledAt" value={schedule ? when : ''} />
      {!roomOpen ? <p className="rounded-lg bg-warning-50 px-3 py-2 text-[12px] font-bold text-warning-600">팬챗방이 닫혀 있어요. 아래 설정에서 팬챗방을 열어 주세요.</p> : null}
      <textarea
        name="body"
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, 1000))}
        rows={4}
        maxLength={1000}
        placeholder="{닉네임}님, 오늘 방송 와 줘서 고마워요!"
        className="w-full rounded-xl border border-ink-200 px-3.5 py-2.5 text-[14px] outline-none focus:border-brand-400"
      />
      <div className="flex flex-wrap gap-1.5">
        {([
          { k: 'IMAGE', l: '사진', Icon: ImageIcon },
          { k: 'VOICE', l: '음성', Icon: Mic },
          { k: 'VIDEO', l: '영상', Icon: Video },
        ] as const).map((t) => (
          <button
            key={t.k}
            type="button"
            onClick={() => reset(attach === t.k ? 'NONE' : t.k)}
            aria-pressed={attach === t.k}
            className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-bold', attach === t.k ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-600')}
          >
            <t.Icon size={15} aria-hidden />
            {t.l}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSchedule((v) => !v)}
          aria-pressed={schedule}
          className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-bold', schedule ? 'border-accent-500 bg-warning-50 text-accent-600' : 'border-ink-200 bg-white text-ink-600')}
        >
          <Clock3 size={15} aria-hidden />
          예약 발송
        </button>
      </div>

      {attach !== 'NONE' ? (
        <div className="rounded-xl border border-dashed border-ink-200 bg-warm-50 p-3">
          {url ? (
            <div className="flex items-center gap-2">
              {attach === 'IMAGE' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt="" className="h-20 rounded-lg object-cover" />
              ) : attach === 'VOICE' ? (
                <audio src={url} controls preload="metadata" className="h-10 w-full max-w-[280px]" />
              ) : (
                <video src={url} controls playsInline preload="metadata" className="max-h-40 rounded-lg bg-black" />
              )}
              <button type="button" onClick={() => reset(attach)} aria-label="첨부 지우기" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-white">
                <Trash2 size={15} />
              </button>
            </div>
          ) : uploading ? (
            <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-500">
              <Loader2 size={15} className="animate-spin" aria-hidden />
              올리는 중이에요
            </p>
          ) : recording ? (
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger-500" aria-hidden />
              <span className="text-[13px] font-black tabular-nums text-ink-900">
                {Math.floor(recSec / 60)}:{String(recSec % 60).padStart(2, '0')} / {Math.floor(voiceMaxSeconds / 60)}:{String(voiceMaxSeconds % 60).padStart(2, '0')}
              </span>
              <button type="button" onClick={() => stopRecord()} className="inline-flex h-9 items-center gap-1 rounded-full bg-danger-500 px-3.5 text-[12.5px] font-extrabold text-white">
                <Square size={13} aria-hidden />
                녹음 끝내기
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {attach === 'VOICE' ? (
                <button type="button" onClick={() => void startRecord()} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink-900 px-3.5 text-[12.5px] font-extrabold text-white">
                  <Mic size={14} aria-hidden />
                  바로 녹음
                </button>
              ) : null}
              <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-ink-200 bg-white px-3.5 text-[12.5px] font-extrabold text-ink-700">
                <Upload size={14} aria-hidden />
                {attach === 'IMAGE' ? '사진 올리기' : attach === 'VOICE' ? '음성 파일 올리기' : '영상 올리기'}
              </button>
              <span className="text-[11px] text-ink-400">{attach === 'IMAGE' ? 'JPG · PNG · WEBP · GIF, 5MB까지' : attach === 'VOICE' ? `MP3 · M4A · WEBM · OGG · WAV, ${voiceMaxSeconds}초 · 15MB까지` : 'MP4 · MOV · WEBM, 80MB까지'}</span>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f, attach, f.name);
            }}
          />
        </div>
      ) : null}

      {schedule ? (
        <label className="flex flex-wrap items-center gap-2 rounded-xl bg-warning-50 px-3 py-2.5 text-[12.5px] font-bold text-ink-700">
          <Clock3 size={15} className="text-accent-600" aria-hidden />
          보낼 시각
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-9 rounded-lg border border-ink-200 bg-white px-2 text-[13px]" />
          <button type="button" onClick={() => { setSchedule(false); setWhen(''); }} aria-label="예약 취소" className="grid h-7 w-7 place-items-center rounded-full hover:bg-white">
            <X size={14} />
          </button>
        </label>
      ) : null}

      {error ? <p className="rounded-lg bg-danger-50 px-3 py-2 text-[12.5px] font-bold text-danger-600">{error}</p> : null}
      {state.message ? <p className={cx('rounded-lg px-3 py-2 text-[12.5px] font-bold', state.ok ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600')}>{state.message}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-400">구독 중인 팬 {subscribers.toLocaleString('ko-KR')}명 · {body.length}/1000자</span>
        <button type="submit" disabled={!canSend} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-ink-900 px-4 text-[13px] font-extrabold text-white disabled:opacity-40">
          {pending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Send size={15} aria-hidden />}
          {schedule ? '예약하기' : '보내기'}
        </button>
      </div>
    </form>
  );
}
