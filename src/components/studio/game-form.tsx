'use client';

import * as React from 'react';
import {
  BarChart3,
  Disc3,
  Hash,
  HelpCircle,
  ListOrdered,
  Loader2,
  Network,
  Plus,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { Button, Card, Field, Input, Notice, Select, Textarea, cx } from '@/components/ui';
import { ConfirmDialog } from '@/components/studio/confirm-dialog';
import {
  ENTRY_MODES,
  ENTRY_MODE_HINT,
  ENTRY_MODE_LABEL,
  GAME_TYPES,
  GAME_TYPE_META,
  MAX_CHOICES,
  MAX_ITEMS,
  MAX_TITLE_LEN,
  defaultConfig,
  usesEntries,
  usesItems,
  validateGameInput,
  type EntryMode,
  type GameType,
} from '@/lib/game-catalog';

/**
 * 게임 만들기 · 수정 폼.
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - 종류를 고르면 필요한 입력만 나타난다. 쓰지 않는 칸을 보여 주지 않는다.
 *  - 참여 방식은 "무료 참여 경로"를 기본값으로 둔다. 후원해야만 참여할 수 있는 구성은
 *    크리에이터가 명시적으로 고를 때만 적용된다.
 */

const ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>> = {
  Disc3,
  Network,
  ListOrdered,
  BarChart3,
  HelpCircle,
  Zap,
  Hash,
  Target,
};

export interface GameFormValue {
  type: GameType;
  title: string;
  items: string[];
  config: Record<string, unknown>;
  entryMode: EntryMode;
  donationMinAmount: number;
  autoCloseSec: number;
}

export function emptyGameForm(type: GameType = 'ROULETTE'): GameFormValue {
  return {
    type,
    title: '',
    items: usesItems(type) ? ['', ''] : [],
    config: defaultConfig(type),
    entryMode: 'LINK',
    donationMinAmount: 0,
    autoCloseSec: 0,
  };
}

export function GameForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  mode,
}: {
  value: GameFormValue;
  onChange: (v: GameFormValue) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  mode: 'create' | 'edit';
}) {
  const meta = GAME_TYPE_META[value.type];
  // 후원 자동 참여는 이름만으로 참여하는 게임에서만 성립한다.
  const canDonationJoin = value.type === 'RANKING';
  const error = validateGameInput(value.type, value.title, value.items, value.config);

  const set = (patch: Partial<GameFormValue>) => onChange({ ...value, ...patch });
  const setConfig = (patch: Record<string, unknown>) => set({ config: { ...value.config, ...patch } });

  const pickType = (type: GameType) => {
    onChange({ ...emptyGameForm(type), title: value.title });
  };

  /**
   * 나가는 길.
   *
   * 예전에는 폼 맨 아래 [취소] 하나뿐이었다. 폼이 화면 한 장을 넘겨서, 닫으려면 끝까지
   * 스크롤을 내려야 했다. 위쪽 헤더의 X 와 Esc 를 함께 둔다.
   * 다만 작성 중인 내용을 말없이 버리지는 않는다 — 고친 게 있으면 한 번 물어본다.
   */
  const [initialSnapshot] = React.useState(() => JSON.stringify(value));
  const [askClose, setAskClose] = React.useState(false);
  const dirty = JSON.stringify(value) !== initialSnapshot;

  const requestClose = React.useCallback(() => {
    if (busy) return;
    if (dirty) setAskClose(true);
    else onCancel();
  }, [busy, dirty, onCancel]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 확인창이 떠 있으면 그쪽 Esc 가 먼저다. 여기서 다시 열지 않는다.
      if (askClose) return;
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askClose, requestClose]);

  return (
    <Card>
      <div className="space-y-5">
        {/* 헤더 — 지금 무슨 화면인지 알려 주고, 여기서 바로 닫을 수 있게 한다. */}
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 pb-4">
          <div className="min-w-0">
            <p className="text-[15px] font-black tracking-[-0.02em] text-ink-900">
              {mode === 'create' ? '새 게임 만들기' : '게임 수정'}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-400">
              {mode === 'create'
                ? '종류를 고르면 필요한 칸만 나타납니다. 닫으려면 오른쪽 X 또는 Esc.'
                : '바꾼 내용은 [저장]을 눌러야 반영됩니다. 닫으려면 오른쪽 X 또는 Esc.'}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            aria-label="새 게임 만들기 닫기"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-200 text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700 disabled:opacity-40"
          >
            <X size={18} strokeWidth={1.7} />
          </button>
        </div>

        {mode === 'create' ? (
          <div>
            <p className="mb-2 text-[13px] font-semibold text-ink-700">게임 종류</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {GAME_TYPES.map((t) => {
                const m = GAME_TYPE_META[t];
                const Icon = ICONS[m.icon] ?? Disc3;
                const on = value.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => pickType(t)}
                    className={cx(
                      'flex flex-col items-start gap-1.5 rounded-xl border px-3 py-3 text-left transition-colors',
                      on ? 'border-brand-400 bg-brand-50' : 'border-ink-200 bg-white hover:bg-ink-50',
                    )}
                  >
                    <Icon size={18} strokeWidth={1.7} className={on ? 'text-brand-700' : 'text-ink-400'} />
                    <span className="text-[13px] font-bold text-ink-900">{m.label}</span>
                    <span className="text-[11.5px] leading-snug text-ink-400">{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <Notice tone="brand" title={meta.label}>
          {meta.guide}
          <span className="mt-1.5 block text-ink-500">활용 · {meta.tip}</span>
        </Notice>

        <Field label="게임 이름" hint={`방송 화면에 그대로 표시됩니다. ${MAX_TITLE_LEN}자 이내`} required>
          <Input
            value={value.title}
            onChange={(e) => set({ title: e.target.value })}
            maxLength={MAX_TITLE_LEN}
            placeholder="예) 오늘의 선물 추첨"
          />
        </Field>

        {usesItems(value.type) ? (
          <ListField
            label={value.type === 'LADDER' ? '출발 항목' : '항목'}
            hint={
              value.type === 'LADDER'
                ? '사다리 위쪽에 놓일 이름입니다. 2개 이상 입력하세요.'
                : '룰렛에 들어갈 항목입니다. 2개 이상 입력하세요.'
            }
            values={value.items}
            onChange={(items) => set({ items })}
            max={MAX_ITEMS}
          />
        ) : null}

        {value.type === 'LADDER' ? (
          <ListField
            label="도착 항목 (보상)"
            hint="사다리 아래쪽에 놓일 보상입니다. 출발 항목 수와 같게 맞추면 가장 깔끔합니다."
            values={(value.config.destinations as string[]) ?? []}
            onChange={(destinations) => setConfig({ destinations })}
            max={MAX_ITEMS}
          />
        ) : null}

        {value.type === 'ROULETTE' ? (
          <Field label="보상 (선택)" hint="당첨자에게 줄 것을 적어 두면 방송 화면에 함께 표시됩니다.">
            <Input
              value={String(value.config.prize ?? '')}
              onChange={(e) => setConfig({ prize: e.target.value })}
              maxLength={30}
              placeholder="예) 신청곡 1곡"
            />
          </Field>
        ) : null}

        {value.type === 'RANKING' ? (
          <>
            <Field label="뽑을 인원" hint="1등부터 순서대로 공개됩니다. 최대 10명">
              <Input
                value={String(value.config.rankCount ?? 3)}
                onChange={(e) => {
                  const n = Math.min(10, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1));
                  const prizes = [...((value.config.prizes as string[]) ?? [])];
                  while (prizes.length < n) prizes.push('');
                  prizes.length = n;
                  setConfig({ rankCount: n, prizes });
                }}
                inputMode="numeric"
                className="tabular-nums"
              />
            </Field>
            <div className="space-y-2">
              <p className="text-[13px] font-semibold text-ink-700">등수별 보상 (선택)</p>
              {Array.from({ length: Number(value.config.rankCount ?? 3) }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[13px] font-bold text-ink-500">{i + 1}등</span>
                  <Input
                    value={((value.config.prizes as string[]) ?? [])[i] ?? ''}
                    onChange={(e) => {
                      const prizes = [...((value.config.prizes as string[]) ?? [])];
                      prizes[i] = e.target.value;
                      setConfig({ prizes });
                    }}
                    maxLength={30}
                    placeholder="예) 샤라웃"
                  />
                </div>
              ))}
            </div>
          </>
        ) : null}

        {value.type === 'VOTE' ? (
          <>
            <Field label="투표 주제" required>
              <Input
                value={String(value.config.topic ?? '')}
                onChange={(e) => setConfig({ topic: e.target.value })}
                maxLength={40}
                placeholder="예) 다음 곡은?"
              />
            </Field>
            <ChoiceField
              values={(value.config.choices as string[]) ?? []}
              onChange={(choices) => setConfig({ choices })}
            />
          </>
        ) : null}

        {value.type === 'QUIZ' ? (
          <>
            <Field label="문제" required>
              <Textarea
                value={String(value.config.question ?? '')}
                onChange={(e) => setConfig({ question: e.target.value })}
                maxLength={80}
                rows={2}
                placeholder="예) 제 채널 개설일은 몇 년도일까요?"
              />
            </Field>
            <ChoiceField
              values={(value.config.choices as string[]) ?? []}
              onChange={(choices) => setConfig({ choices })}
              answerIndex={Number(value.config.answerIndex ?? 0)}
              onAnswer={(answerIndex) => setConfig({ answerIndex })}
            />
            <Field label="보상 (선택)">
              <Input
                value={String(value.config.prize ?? '')}
                onChange={(e) => setConfig({ prize: e.target.value })}
                maxLength={30}
              />
            </Field>
            <Notice tone="neutral">
              정답은 결과를 발표하기 전까지 방송 화면과 참여 페이지 어디에도 나가지 않습니다.
            </Notice>
          </>
        ) : null}

        {value.type === 'KEYWORD' ? (
          <>
            <Field label="키워드" hint="대소문자와 띄어쓰기는 자동으로 무시합니다." required>
              <Input
                value={String(value.config.keyword ?? '')}
                onChange={(e) => setConfig({ keyword: e.target.value })}
                maxLength={20}
                placeholder="예) 도네이도"
              />
            </Field>
            <Field label="당첨 인원" hint="먼저 맞힌 순서대로 뽑습니다.">
              <Input
                value={String(value.config.winnerCount ?? 1)}
                onChange={(e) =>
                  setConfig({ winnerCount: Math.min(20, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) })
                }
                inputMode="numeric"
                className="tabular-nums"
              />
            </Field>
            <Field label="보상 (선택)">
              <Input
                value={String(value.config.prize ?? '')}
                onChange={(e) => setConfig({ prize: e.target.value })}
                maxLength={30}
              />
            </Field>
          </>
        ) : null}

        {value.type === 'NUMBER_GUESS' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="최솟값">
                <Input
                  value={String(value.config.min ?? 1)}
                  onChange={(e) => setConfig({ min: Number(e.target.value.replace(/[^\d-]/g, '')) || 0 })}
                  inputMode="numeric"
                  className="tabular-nums"
                />
              </Field>
              <Field label="최댓값">
                <Input
                  value={String(value.config.max ?? 100)}
                  onChange={(e) => setConfig({ max: Number(e.target.value.replace(/[^\d-]/g, '')) || 0 })}
                  inputMode="numeric"
                  className="tabular-nums"
                />
              </Field>
              <Field label="정답">
                <Input
                  value={String(value.config.answer ?? 50)}
                  onChange={(e) => setConfig({ answer: Number(e.target.value.replace(/[^\d-]/g, '')) || 0 })}
                  inputMode="numeric"
                  className="tabular-nums"
                />
              </Field>
            </div>
            <Field label="판정 방식">
              <Select
                value={String(value.config.mode ?? 'closest')}
                onChange={(e) => setConfig({ mode: e.target.value })}
              >
                <option value="closest">가장 가까운 사람 (권장)</option>
                <option value="exact">정확히 맞힌 사람만</option>
              </Select>
            </Field>
            <Field label="보상 (선택)">
              <Input
                value={String(value.config.prize ?? '')}
                onChange={(e) => setConfig({ prize: e.target.value })}
                maxLength={30}
              />
            </Field>
          </>
        ) : null}

        {value.type === 'GOAL_GAUGE' ? (
          <>
            <Field label="목표 금액 (원)" hint="게임을 시작한 뒤 들어온 후원 금액이 쌓입니다." required>
              <Input
                value={String(value.config.target ?? 100000)}
                onChange={(e) => setConfig({ target: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                inputMode="numeric"
                className="tabular-nums"
              />
            </Field>
            <Field label="공약 (선택)" hint="목표를 채우면 무엇을 할지 적어 두면 달성이 빨라집니다.">
              <Input
                value={String(value.config.reward ?? '')}
                onChange={(e) => setConfig({ reward: e.target.value })}
                maxLength={60}
                placeholder="예) 목표 달성하면 노래 한 곡"
              />
            </Field>
          </>
        ) : null}

        {usesEntries(value.type) ? (
          <>
            {canDonationJoin ? (
              <Field label="참여 방식" hint={ENTRY_MODE_HINT[value.entryMode]}>
                <Select value={value.entryMode} onChange={(e) => set({ entryMode: e.target.value as EntryMode })}>
                  {ENTRY_MODES.map((m) => (
                    <option key={m} value={m}>
                      {ENTRY_MODE_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Notice tone="neutral" title="참여는 링크·QR 로만 받습니다">
                이 게임은 시청자가 선택지나 값을 직접 입력해야 해서, 후원만으로는 참여시킬 수 없습니다.
                무엇을 골랐는지 알 수 없기 때문입니다. 후원한 분을 자동으로 참여시키려면 [순위 추첨]을 쓰세요.
              </Notice>
            )}

            {canDonationJoin && value.entryMode !== 'LINK' ? (
              <>
                <Field label="자동 참여 최소 후원 금액 (원)" hint="0 이면 금액 제한 없이 후원한 분 모두 참여됩니다.">
                  <Input
                    value={String(value.donationMinAmount)}
                    onChange={(e) => set({ donationMinAmount: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                    inputMode="numeric"
                    className="tabular-nums"
                  />
                </Field>
                {value.entryMode === 'DONATION' ? (
                  <Notice tone="warning" title="무료 참여 경로가 없는 구성입니다">
                    후원한 분만 참여할 수 있는 방식입니다. 유료 응모로 볼 여지가 있어, 보상이 큰 게임에는
                    [링크 + 후원 자동 참여]를 권합니다.
                  </Notice>
                ) : null}
              </>
            ) : null}

            <Field label="자동 마감 (초)" hint="0 이면 크리에이터가 직접 마감합니다. 30~60초를 권합니다.">
              <Input
                value={String(value.autoCloseSec)}
                onChange={(e) =>
                  set({ autoCloseSec: Math.min(600, Number(e.target.value.replace(/\D/g, '')) || 0) })
                }
                inputMode="numeric"
                className="tabular-nums"
              />
            </Field>
          </>
        ) : null}

        {error ? <Notice tone="warning">{error}</Notice> : null}

        <div className="flex gap-2">
          <Button onClick={onSubmit} disabled={busy || Boolean(error)}>
            {busy ? <Loader2 size={16} strokeWidth={1.8} className="animate-spin" /> : null}
            {mode === 'create' ? '게임 만들기' : '저장'}
          </Button>
          <Button variant="secondary" onClick={requestClose} disabled={busy}>
            취소
          </Button>
        </div>
      </div>

      <ConfirmDialog
        phase={askClose ? 'ask' : 'closed'}
        title="작성 중인 내용을 버릴까요?"
        description="지금까지 입력한 내용은 저장되지 않습니다."
        confirmLabel="버리고 닫기"
        cancelLabel="계속 작성"
        variant="danger"
        onConfirm={() => {
          setAskClose(false);
          onCancel();
        }}
        onClose={() => setAskClose(false)}
      />
    </Card>
  );
}

function ListField({
  label,
  hint,
  values,
  onChange,
  max,
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (v: string[]) => void;
  max: number;
}) {
  const rows = values.length > 0 ? values : ['', ''];
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-semibold text-ink-700">{label}</p>
      <div className="space-y-2">
        {rows.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-[12px] font-bold text-ink-400 tabular-nums">{i + 1}</span>
            <Input
              value={v}
              onChange={(e) => {
                const next = [...rows];
                next[i] = e.target.value;
                onChange(next);
              }}
              maxLength={24}
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              disabled={rows.length <= 2}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ink-200 text-ink-400 disabled:opacity-40"
              aria-label={`${i + 1}번 항목 삭제`}
            >
              <Trash2 size={16} strokeWidth={1.7} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, ''])}
        disabled={rows.length >= max}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-[13px] font-bold text-ink-700 disabled:opacity-40"
      >
        <Plus size={15} strokeWidth={1.8} /> 항목 추가
      </button>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{hint}</p>
    </div>
  );
}

function ChoiceField({
  values,
  onChange,
  answerIndex,
  onAnswer,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  answerIndex?: number;
  onAnswer?: (i: number) => void;
}) {
  const rows = values.length > 0 ? values : ['', ''];
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-semibold text-ink-700">
        선택지{onAnswer ? ' (정답을 골라 주세요)' : ''}
      </p>
      <div className="space-y-2">
        {rows.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            {onAnswer ? (
              <button
                type="button"
                onClick={() => onAnswer(i)}
                className={cx(
                  'grid h-11 w-11 shrink-0 place-items-center rounded-xl border text-[13px] font-black',
                  answerIndex === i
                    ? 'border-brand-400 bg-brand-500 text-ink-900'
                    : 'border-ink-200 bg-white text-ink-400',
                )}
                aria-label={`${String.fromCharCode(65 + i)} 를 정답으로 지정`}
              >
                {String.fromCharCode(65 + i)}
              </button>
            ) : (
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink-100 text-[13px] font-black text-ink-500">
                {String.fromCharCode(65 + i)}
              </span>
            )}
            <Input
              value={v}
              onChange={(e) => {
                const next = [...rows];
                next[i] = e.target.value;
                onChange(next);
              }}
              maxLength={24}
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              disabled={rows.length <= 2}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ink-200 text-ink-400 disabled:opacity-40"
              aria-label={`${String.fromCharCode(65 + i)} 선택지 삭제`}
            >
              <Trash2 size={16} strokeWidth={1.7} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, ''])}
        disabled={rows.length >= MAX_CHOICES}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-[13px] font-bold text-ink-700 disabled:opacity-40"
      >
        <Plus size={15} strokeWidth={1.8} /> 선택지 추가
      </button>
    </div>
  );
}
