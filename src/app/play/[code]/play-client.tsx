'use client';

import * as React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button, Card, Input, Notice } from '@/components/ui';
import { MAX_NICKNAME_LEN } from '@/lib/game-catalog';

/**
 * 참여 입력 화면.
 *
 * 규칙
 *  - 한 화면에 입력 하나. 방송을 보면서 한 손으로 끝나야 한다.
 *  - 참여 후에는 결과를 조회하지 않는다. 결과는 방송 화면에서 발표된다.
 *    (시청자 수천 명이 각자 폴링하면 참여 API 보다 결과 조회가 서버를 먼저 무너뜨린다)
 *  - 기기 식별값은 브라우저가 만들어 보관한다. IP 만으로 묶으면 이동통신망 NAT 때문에
 *    서로 다른 시청자가 한 사람으로 취급되어 정상 참여가 막힌다.
 *    (중복 방지의 두 번째 겹인 네트워크 지문 단위 상한은 서버가 처리한다)
 *  - 정답 여부는 서버가 알려 주지 않는다. 응답으로 알려 주면 참여 API 가 정답 오라클이 된다.
 */

const CLIENT_KEY = 'donaido_play_id';

/** localStorage 를 쓸 수 없는 브라우저용 폴백. 탭이 살아 있는 동안 값을 유지한다. */
let memoryClientId = '';

function clientId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const saved = window.localStorage.getItem(CLIENT_KEY);
    if (saved) return saved;
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    // 저장이 막힌 브라우저(사생활 보호 모드 등). 매번 새 값을 만들면 새로고침만으로
    // 반복 참여가 되므로, 이 세션 안에서는 같은 값을 유지한다.
    // (그래도 서버가 네트워크 지문 단위 상한을 따로 걸고 있다)
    if (!memoryClientId) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      memoryClientId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return memoryClientId;
  }
}

export function PlayClient({
  code,
  status,
  type,
  typeLabel,
  title,
  creatorName,
  entryMode,
  needsNickname,
  choices,
  topic,
  question,
  range,
  prize,
  closesAt,
  participantCount,
}: {
  code: string;
  status: string;
  type: string;
  typeLabel: string;
  title: string;
  creatorName: string;
  entryMode: string;
  needsNickname: boolean;
  choices: string[];
  topic: string;
  question: string;
  range: { min: number; max: number } | null;
  prize: string;
  closesAt: string | null;
  participantCount: number;
}) {
  const [name, setName] = React.useState('');
  const [entry, setEntry] = React.useState('');
  const [choice, setChoice] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [done, setDone] = React.useState<{ count: number } | null>(null);
  const [left, setLeft] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!closesAt) return;
    const end = new Date(closesAt).getTime();
    const tick = () => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [closesAt]);

  const closed = status !== 'OPEN' || (left != null && left <= 0);

  const submit = async () => {
    setError('');
    if (needsNickname && !name.trim()) {
      setError('닉네임을 입력해 주세요.');
      return;
    }
    if (choices.length > 0 && choice == null) {
      setError('선택지를 골라 주세요.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/play/${code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: clientId(),
          name: name.trim(),
          entry: choices.length > 0 ? String(choice) : entry.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '참여에 실패했습니다.');
        return;
      }
      setDone({ count: data.participantCount ?? participantCount + 1 });
    } catch {
      setError('네트워크 오류입니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card>
        <div className="py-4 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-100 text-brand-700">
            <Check size={28} strokeWidth={2} />
          </span>
          <p className="mt-3 text-[18px] font-black text-ink-900">참여했습니다</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
            지금까지 {done.count.toLocaleString()}명이 참여했습니다.
            <br />
            결과는 방송 화면에서 발표됩니다.
          </p>
          {type === 'QUIZ' || type === 'KEYWORD' || type === 'NUMBER_GUESS' ? (
            <p className="mt-3 text-[13px] font-bold text-ink-400">
              답안이 접수되었습니다. 정답은 방송에서 공개됩니다.
            </p>
          ) : null}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <p className="text-[12px] font-extrabold tracking-[0.14em] text-brand-600">{typeLabel}</p>
      <h1 className="mt-1 text-[22px] font-black leading-tight tracking-[-0.02em] text-ink-900">{title}</h1>
      <p className="mt-1 text-[13px] text-ink-400">{creatorName} 님의 방송</p>

      {prize ? (
        <p className="mt-3 inline-block rounded-lg bg-brand-50 px-3 py-1.5 text-[13px] font-bold text-brand-800">
          보상 · {prize}
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        {closed ? (
          <Notice tone="warning" title="지금은 참여를 받지 않습니다">
            참여가 마감되었거나 아직 열리지 않았습니다. 방송 화면의 안내를 확인해 주세요.
          </Notice>
        ) : (
          <>
            {left != null ? (
              <p className="text-[13px] font-bold text-ink-500 tabular-nums">
                마감까지 {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
              </p>
            ) : null}

            {question ? <p className="text-[16px] font-bold leading-snug text-ink-900">{question}</p> : null}
            {topic ? <p className="text-[16px] font-bold leading-snug text-ink-900">{topic}</p> : null}

            {needsNickname ? (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-semibold text-ink-700">닉네임</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX_NICKNAME_LEN}
                  placeholder="방송에 표시될 이름"
                  autoComplete="off"
                />
                <span className="mt-1.5 block text-[12px] text-ink-400">
                  방송 화면에 그대로 표시됩니다. 전화번호·주소 등 개인정보는 넣지 마세요.
                </span>
              </label>
            ) : (
              <p className="text-[13px] text-ink-400">닉네임 없이 익명으로 참여합니다.</p>
            )}

            {choices.length > 0 ? (
              <div className="grid gap-2">
                {choices.map((c, i) => (
                  <button
                    key={`${c}-${i}`}
                    type="button"
                    onClick={() => setChoice(i)}
                    className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left text-[15px] font-bold transition-colors ${
                      choice === i
                        ? 'border-brand-400 bg-brand-50 text-ink-900'
                        : 'border-ink-200 bg-white text-ink-700'
                    }`}
                  >
                    <span
                      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-black ${
                        choice === i ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-500'
                      }`}
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    {c}
                  </button>
                ))}
              </div>
            ) : null}

            {type === 'KEYWORD' ? (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-semibold text-ink-700">키워드</span>
                <Input
                  value={entry}
                  onChange={(e) => setEntry(e.target.value)}
                  maxLength={20}
                  placeholder="방송에서 알려 준 단어"
                  autoComplete="off"
                />
              </label>
            ) : null}

            {type === 'NUMBER_GUESS' ? (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-semibold text-ink-700">숫자</span>
                <Input
                  value={entry}
                  onChange={(e) => setEntry(e.target.value.replace(/[^\d-]/g, ''))}
                  inputMode="numeric"
                  placeholder={range ? `${range.min} ~ ${range.max}` : ''}
                  className="tabular-nums"
                />
              </label>
            ) : null}

            {error ? <Notice tone="danger">{error}</Notice> : null}

            <Button size="lg" onClick={submit} disabled={busy}>
              {busy ? <Loader2 size={18} strokeWidth={1.8} className="animate-spin" /> : null}
              {busy ? '참여 중' : '참여하기'}
            </Button>

            {entryMode === 'BOTH' ? (
              <p className="text-center text-[12px] leading-relaxed text-ink-400">
                후원하신 분은 자동으로 참여됩니다. 후원 없이 이 화면으로 참여해도 동일하게 응모됩니다.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
