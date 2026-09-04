'use client';

import * as React from 'react';
import { Loader, MonitorPlay, Play, PlugZap, Plus, Trash2, Volume2, Wifi, X } from 'lucide-react';
import { Badge, Button, Checkbox, Field, Input, Notice, Select, cx } from '@/components/ui';
import { SaveButtonLabel, SaveToast, useSaveFeedback } from '@/components/studio/save-feedback';
import { previewOverlayTierAction, saveOverlayTiersAction } from '@/app/actions/studio';
import type { StudioActionState } from '@/app/actions/studio';
import { DONAIDO_CHARACTER_STICKERS } from '@/lib/overlay-effect-catalog';

/**
 * 금액 구간별 오버레이 효과 편집기 + 미리보기.
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - 저장은 전체 목록을 통째로 보낸다(서버가 삭제 후 삽입).
 *  - 미리보기는 저장된 구간을 금액으로 다시 찾아 재생한다. 그래서 수정 직후에는
 *    먼저 저장해야 바뀐 효과가 보인다. 화면에도 그렇게 안내한다.
 *  - 미리보기 창은 실제 오버레이 페이지를 iframe 으로 그대로 띄운다.
 */

export interface TierDraft {
  key: string;
  minAmount: string;
  label: string;
  effect: string;
  banner: boolean;
  durationMs: string;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsSpeed: string;
  ttsPitch: string;
}

export interface TierInput {
  minAmount: number;
  label: string;
  effect: string;
  banner: boolean;
  durationMs: number;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsSpeed: number;
  ttsPitch: number;
}

const EFFECT_OPTIONS = [
  { value: 'HEART', label: '하트' },
  { value: 'STAR', label: '별' },
  { value: 'FIREWORK', label: '폭죽' },
  { value: 'CONFETTI', label: '꽃가루' },
  { value: 'COIN', label: '동전' },
  ...DONAIDO_CHARACTER_STICKERS.map((sticker) => ({ value: sticker.value, label: `캐릭터 · ${sticker.label}` })),
  { value: 'NONE', label: '효과 없음' },
];

const SUGGESTED: TierInput[] = [
  { minAmount: 1000, label: '기본', effect: 'HEART', banner: true, durationMs: 5000, ttsEnabled: false, ttsVoice: '', ttsSpeed: 1, ttsPitch: 1 },
  { minAmount: 5000, label: '감사', effect: 'STAR', banner: true, durationMs: 7000, ttsEnabled: true, ttsVoice: '', ttsSpeed: 1, ttsPitch: 1 },
  { minAmount: 10000, label: '최고', effect: 'FIREWORK', banner: true, durationMs: 10000, ttsEnabled: true, ttsVoice: '', ttsSpeed: 1, ttsPitch: 1.1 },
];

const MAX_TIERS = 6;
/** 서버(tierSchema)의 시작 금액 상한과 같아야 한다. */
const MAX_TIER_AMOUNT = 10_000_000;

let keySeq = 0;
function nextKey() {
  keySeq += 1;
  return `tier-${keySeq}`;
}

function toDraft(t: TierInput): TierDraft {
  return {
    key: nextKey(),
    minAmount: String(t.minAmount),
    label: t.label,
    effect: t.effect,
    banner: t.banner,
    durationMs: String(t.durationMs),
    ttsEnabled: t.ttsEnabled,
    ttsVoice: t.ttsVoice,
    ttsSpeed: String(t.ttsSpeed),
    ttsPitch: String(t.ttsPitch),
  };
}

function won(v: string) {
  const n = Number(v.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '0';
}

/** 서버로 보낼 형태. 저장 여부 비교에도 같은 함수를 쓴다. */
function serialize(list: TierDraft[]): string {
  return JSON.stringify(
    list.map((t) => ({
      minAmount: Number(String(t.minAmount).replace(/[^\d]/g, '')) || 0,
      label: t.label.trim(),
      effect: t.effect,
      banner: t.banner,
      durationMs: Number(t.durationMs) || 7000,
      ttsEnabled: t.ttsEnabled,
      ttsVoice: t.ttsVoice,
      ttsSpeed: Number(t.ttsSpeed) || 1,
      ttsPitch: Number(t.ttsPitch) || 1,
    })),
  );
}

export function OverlayTiersEditor({
  creatorId,
  initialTiers,
}: {
  creatorId: string;
  initialTiers: TierInput[];
}) {
  const [tiers, setTiers] = React.useState<TierDraft[]>(() => initialTiers.map(toDraft));
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([]);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  /** 마지막으로 [구간 저장]에 실제로 제출한 값. 저장 성공 시에만 "저장된 값"으로 취급한다. */
  const [submittedPayload, setSubmittedPayload] = React.useState<string | null>(null);
  const [pendingAmount, setPendingAmount] = React.useState<string | null>(null);

  const [saveState, saveAction, saving] = React.useActionState<StudioActionState, FormData>(
    saveOverlayTiersAction,
    { ok: false },
  );

  // [설정 저장]과 같은 방식으로 저장 결과를 확실히 보여 준다.
  const saveFeedback = useSaveFeedback(saveState, saving);

  // 브라우저에 설치된 음성 목록. 한국어 음성을 앞으로 정렬한다.
  React.useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      const ko = list.filter((v) => v.lang?.toLowerCase().startsWith('ko'));
      const rest = list.filter((v) => !v.lang?.toLowerCase().startsWith('ko'));
      setVoices([...ko, ...rest]);
    };
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  const update = (key: string, patch: Partial<TierDraft>) => {
    setTiers((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };

  const remove = (key: string) => {
    setTiers((prev) => prev.filter((t) => t.key !== key));
  };

  const add = () => {
    if (tiers.length >= MAX_TIERS) return;
    const highest = tiers.reduce((max, t) => Math.max(max, Number(t.minAmount) || 0), 0);
    setTiers((prev) => [
      ...prev,
      toDraft({
        minAmount: highest > 0 ? Math.min(highest * 2, MAX_TIER_AMOUNT) : 1000,
        label: `구간 ${prev.length + 1}`,
        effect: 'HEART',
        banner: true,
        durationMs: 7000,
        ttsEnabled: false,
        ttsVoice: '',
        ttsSpeed: 1,
        ttsPitch: 1,
      }),
    ]);
  };

  const applySuggested = () => {
    setTiers(SUGGESTED.map(toDraft));
  };

  /** 로컬에서 목소리만 들어본다. 오버레이로 이벤트를 보내지 않는다. */
  const speakSample = (t: TierDraft) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(
        `테스트 후원자님이 ${won(t.minAmount)}원 후원하셨습니다. 오늘 방송 재미있어요.`,
      );
      const matched = voices.find((v) => v.name === t.ttsVoice) ?? voices.find((v) => v.lang?.toLowerCase().startsWith('ko'));
      if (matched) utter.voice = matched;
      utter.lang = matched?.lang ?? 'ko-KR';
      utter.rate = Math.min(2, Math.max(0.5, Number(t.ttsSpeed) || 1));
      utter.pitch = Math.min(2, Math.max(0, Number(t.ttsPitch) || 1));
      synth.speak(utter);
    } catch {
      /* 음성 미지원 브라우저는 무시한다 */
    }
  };

  const openPreview = (amount?: string) => {
    setPendingAmount(amount ?? null);
    setPreviewOpen(true);
  };

  const payload = serialize(tiers);

  // 처음 불러온 구간과 같은 형태로 직렬화해 두고, 저장 여부 판단에만 쓴다.
  const initialPayload = React.useMemo(() => serialize(initialTiers.map(toDraft)), [initialTiers]);
  // 마지막으로 저장에 성공한 값. 이후 저장이 실패해도 기준이 초기값으로 되돌아가지 않는다.
  // (렌더 중 파생 상태 갱신 패턴 — 액션 결과 객체가 바뀐 시점에만 한 번 기록한다)
  const [lastSaved, setLastSaved] = React.useState<{ state: StudioActionState; payload: string } | null>(null);
  if (saveState.ok && submittedPayload !== null && lastSaved?.state !== saveState) {
    setLastSaved({ state: saveState, payload: submittedPayload });
  }
  const savedPayload = lastSaved?.payload ?? initialPayload;
  const dirty = payload !== savedPayload;

  const sorted = [...tiers].sort((a, b) => (Number(a.minAmount) || 0) - (Number(b.minAmount) || 0));

  return (
    <div className="space-y-4">
      <Notice tone="brand" title="구간은 큰 금액이 우선입니다">
        후원 금액 이하인 구간 중 시작 금액이 가장 큰 구간 하나만 재생됩니다. 예를 들어 1,000원 / 5,000원 / 10,000원
        구간을 만들어 두면 7,000원 후원은 5,000원 구간으로 재생됩니다. 구간을 하나도 만들지 않으면 아래 전역 표시
        설정만으로 동작합니다.
      </Notice>

      {tiers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center">
          <p className="text-[14px] font-semibold text-ink-700">아직 만든 금액 구간이 없습니다</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-400">
            추천 구간(1,000원 / 5,000원 / 10,000원)으로 시작하거나 직접 추가해 주세요.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button type="button" variant="primary" size="sm" onClick={applySuggested}>
              추천 구간 불러오기
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={add}>
              <Plus size={16} strokeWidth={1.7} />
              구간 추가
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {tiers.map((t, i) => (
          <TierRow
            key={t.key}
            tier={t}
            index={i}
            voices={voices}
            onChange={(patch) => update(t.key, patch)}
            onRemove={() => remove(t.key)}
            onSpeak={() => speakSample(t)}
            onPreview={() => openPreview(t.minAmount)}
          />
        ))}
      </div>

      {tiers.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={tiers.length >= MAX_TIERS}>
            <Plus size={16} strokeWidth={1.7} />
            구간 추가
          </Button>
          {tiers.length >= MAX_TIERS ? (
            <span className="text-[12px] text-ink-400">구간은 최대 {MAX_TIERS}개까지 만들 수 있습니다.</span>
          ) : null}
        </div>
      ) : null}

      <form action={saveAction} onSubmit={() => setSubmittedPayload(payload)} className="space-y-3">
        <input type="hidden" name="tiers" value={payload} />

        <SaveToast feedback={saveFeedback} />

        {saveFeedback.toast ? (
          <Notice tone={saveFeedback.toast.ok ? 'success' : 'danger'}>
            {saveFeedback.toast.message} <span className="text-ink-400">({saveFeedback.toast.at})</span>
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={saving}
            aria-busy={saving}
            className={cx(
              'min-w-[132px] justify-center transition-colors',
              saveFeedback.justSaved && 'bg-success-500 hover:bg-success-500',
            )}
          >
            <SaveButtonLabel pending={saving} justSaved={saveFeedback.justSaved} label="구간 저장" />
          </Button>
          <Button type="button" variant="accent" size="md" onClick={() => openPreview()}>
            <MonitorPlay size={17} strokeWidth={1.7} />
            미리보기 열기
          </Button>
          {dirty ? (
            <span className="text-[12px] font-semibold text-accent-500">
              저장하지 않은 변경이 있습니다. 미리보기는 저장된 구간으로 재생됩니다.
            </span>
          ) : null}
        </div>
      </form>

      {previewOpen ? (
        <PreviewModal
          creatorId={creatorId}
          tiers={sorted}
          initialAmount={pendingAmount}
          onClose={() => {
            setPreviewOpen(false);
            setPendingAmount(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- 구간 행

function TierRow({
  tier,
  index,
  voices,
  onChange,
  onRemove,
  onSpeak,
  onPreview,
}: {
  tier: TierDraft;
  index: number;
  voices: SpeechSynthesisVoice[];
  onChange: (patch: Partial<TierDraft>) => void;
  onRemove: () => void;
  onSpeak: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone="brand">구간 {index + 1}</Badge>
          <span className="text-[13px] font-bold text-ink-900">{won(tier.minAmount)}원 이상</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={onPreview}>
            <Play size={15} strokeWidth={1.7} />
            미리보기
          </Button>
          <button
            type="button"
            onClick={onRemove}
            aria-label="구간 삭제"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-ink-200 text-ink-400 hover:bg-danger-50 hover:text-danger-600"
          >
            <Trash2 size={16} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Field label="시작 금액 (원)" hint="이 금액 이상부터 적용">
          <Input
            inputMode="numeric"
            className="tabular-nums"
            value={tier.minAmount}
            onChange={(e) => onChange({ minAmount: e.target.value.replace(/[^\d]/g, '') })}
          />
        </Field>
        <Field label="구간 이름" hint="20자 이내">
          <Input maxLength={20} value={tier.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Field>
        <Field label="스티커 효과">
          <Select value={tier.effect} onChange={(e) => onChange({ effect: e.target.value })}>
            {EFFECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="효과 지속시간 (ms)" hint="2000~30000ms">
          <Input
            type="number"
            min={2000}
            max={30000}
            step={500}
            value={tier.durationMs}
            onChange={(e) => onChange({ durationMs: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-2 rounded-xl border border-ink-100 bg-ink-50 px-3 py-1">
        <Checkbox
          checked={tier.banner}
          onChange={(e) => onChange({ banner: e.target.checked })}
          label="배너 표시"
          description="후원자명과 메시지를 화면에 띄웁니다. 끄면 스티커 효과만 재생됩니다."
        />
        <Checkbox
          checked={tier.ttsEnabled}
          onChange={(e) => onChange({ ttsEnabled: e.target.checked })}
          label="TTS 읽어주기"
          description="후원자명과 금액, 메시지를 음성으로 읽습니다."
        />
      </div>

      {tier.ttsEnabled ? (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field label="목소리" hint={voices.length === 0 ? '브라우저 음성 목록을 불러오는 중입니다.' : '오버레이를 여는 브라우저에 설치된 음성입니다.'}>
            <Select value={tier.ttsVoice} onChange={(e) => onChange({ ttsVoice: e.target.value })}>
              <option value="">기본 (한국어 자동 선택)</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`속도 ${Number(tier.ttsSpeed).toFixed(2)}배`} hint="0.5 ~ 2.0">
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={tier.ttsSpeed}
              onChange={(e) => onChange({ ttsSpeed: e.target.value })}
              className="h-12 w-full accent-brand-500"
            />
          </Field>
          <Field label={`피치 ${Number(tier.ttsPitch).toFixed(2)}`} hint="0 ~ 2.0 (낮을수록 저음)">
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={tier.ttsPitch}
              onChange={(e) => onChange({ ttsPitch: e.target.value })}
              className="h-12 w-full accent-brand-500"
            />
          </Field>
          <div className="md:col-span-3">
            <Button type="button" variant="ghost" size="sm" onClick={onSpeak}>
              <Volume2 size={16} strokeWidth={1.7} />
              이 목소리로 들어보기
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 미리보기 창

/**
 * 오버레이 연결 상태 배지.
 *
 * 방송 화면(OBS 브라우저 소스)에는 어떤 상태도 그리지 않는다. 크리에이터가 연결 문제를
 * 확인할 수 있는 곳은 이 미리보기 창뿐이므로 여기에만 표시한다.
 */
function ConnectionBadge({ link }: { link: { phase: string; retrySec?: number; recovered?: number } | null }) {
  if (!link || link.phase === 'connecting') {
    return (
      <Badge tone="neutral">
        <Loader size={13} strokeWidth={1.7} className="mr-1 inline-block animate-spin align-[-2px]" />
        연결 중
      </Badge>
    );
  }
  if (link.phase === 'retrying') {
    return (
      <Badge tone="warning">
        <PlugZap size={13} strokeWidth={1.7} className="mr-1 inline-block align-[-2px]" />
        재연결 중{link.retrySec ? ` (${link.retrySec}초 후 재시도)` : ''}
      </Badge>
    );
  }
  return (
    <Badge tone="success">
      <Wifi size={13} strokeWidth={1.7} className="mr-1 inline-block align-[-2px]" />
      연결됨{link.recovered ? ` · 놓친 알림 ${link.recovered}건 복구` : ''}
    </Badge>
  );
}


function PreviewModal({
  creatorId,
  tiers,
  initialAmount,
  onClose,
}: {
  creatorId: string;
  tiers: TierDraft[];
  initialAmount: string | null;
  onClose: () => void;
}) {
  const [ready, setReady] = React.useState(false);
  const [link, setLink] = React.useState<{ phase: string; retrySec?: number; recovered?: number } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [amount, setAmount] = React.useState(initialAmount ?? '5000');
  const [donorName, setDonorName] = React.useState('테스트 후원자');
  const [message, setMessage] = React.useState('오늘 방송 재미있어요');
  const fired = React.useRef(false);

  const send = React.useCallback(
    async (value: string) => {
      setSending(true);
      setNote(null);
      try {
        const fd = new FormData();
        fd.set('amount', value);
        fd.set('donorName', donorName);
        fd.set('message', message);
        const res = await previewOverlayTierAction({ ok: false }, fd);
        setNote(res.message ?? null);
      } catch {
        setNote('미리보기 전송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      } finally {
        setSending(false);
      }
    },
    [donorName, message],
  );

  // 오버레이 클라이언트가 SSE 구독을 마치면 iframe 에서 준비 신호를 보낸다.
  // onLoad 만으로는 구독 전에 이벤트를 보내 유실될 수 있어 이 신호를 우선한다.
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as
        | { type?: string; creatorId?: string; phase?: string; retrySec?: number; recovered?: number }
        | null;
      if (!data || data.creatorId !== creatorId) return;
      if (data.type === 'donaido-overlay-ready') setReady(true);
      // 오버레이가 알려 주는 연결 상태. OBS 에서도 같은 방식으로 붙으므로
      // 여기서 '연결됨'이 보이면 브라우저 소스 설정 문제는 아니라고 판단할 수 있다.
      if (data.type === 'donaido-overlay-status' && data.phase) {
        setLink({ phase: data.phase, retrySec: data.retrySec, recovered: data.recovered });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [creatorId]);

  // 행의 [미리보기] 로 열었으면 오버레이가 연결된 뒤 한 번만 자동 발동한다.
  React.useEffect(() => {
    if (!ready || !initialAmount || fired.current) return;
    fired.current = true;
    const t = setTimeout(() => void send(initialAmount), 300);
    return () => clearTimeout(t);
  }, [ready, initialAmount, send]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/60 p-4">
      <div className="flex max-h-[92vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3.5">
          <div>
            <p className="text-[15px] font-bold text-ink-900">오버레이 미리보기</p>
            <p className="mt-0.5 text-[12px] text-ink-400">
              실제 오버레이 페이지를 그대로 띄웁니다. 저장된 구간 설정으로 재생됩니다.
            </p>
            <div className="mt-1.5">
              <ConnectionBadge link={link} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="미리보기 닫기"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-ink-200 text-ink-500 hover:bg-ink-50"
          >
            <X size={18} strokeWidth={1.7} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {/* 투명 배경임을 보여주기 위해 체커보드 위에 올린다 */}
          <div
            className="relative w-full overflow-hidden rounded-xl border border-ink-200"
            style={{
              aspectRatio: '16 / 9',
              backgroundColor: '#2b2b31',
              backgroundImage:
                'linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%), linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%)',
              backgroundSize: '32px 32px',
              backgroundPosition: '0 0, 16px 16px',
            }}
          >
            <iframe
              title="오버레이 미리보기"
              src={`/overlay/${encodeURIComponent(creatorId)}?preview=1`}
              onLoad={() => {
                // 준비 신호가 오지 않는 환경을 위한 보조 경로
                setTimeout(() => setReady(true), 2500);
              }}
              className="absolute inset-0 h-full w-full border-0"
              style={{ background: 'transparent' }}
            />
          </div>

          <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
            체커보드 무늬는 투명 배경을 보여 주기 위한 것으로, OBS·PRISM 에서는 방송 화면이 그대로 비칩니다. 브라우저
            정책에 따라 미리보기 창에서는 음성이 나오지 않을 수 있습니다. 음성은 각 구간의 [이 목소리로 들어보기]로
            확인해 주세요.
          </p>

          <div className="mt-4 rounded-xl border border-ink-100 bg-ink-50 p-3.5">
            <p className="mb-2.5 text-[13px] font-bold text-ink-900">구간별 테스트 발동</p>
            {tiers.length === 0 ? (
              <p className="text-[12.5px] text-ink-400">저장된 구간이 없습니다. 아래에서 금액을 직접 넣어 확인해 주세요.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tiers.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    disabled={sending}
                    onClick={() => {
                      setAmount(t.minAmount);
                      void send(t.minAmount);
                    }}
                    className={cx(
                      'inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 text-[12.5px] font-semibold text-ink-700',
                      'hover:bg-brand-50 disabled:opacity-50',
                    )}
                  >
                    <Play size={14} strokeWidth={1.7} />
                    {t.label} · {won(t.minAmount)}원
                  </button>
                ))}
              </div>
            )}

            <div className="mt-3.5 grid gap-3 md:grid-cols-3">
              <Field label="표시명">
                <Input maxLength={20} value={donorName} onChange={(e) => setDonorName(e.target.value)} />
              </Field>
              <Field label="금액 (원)">
                <Input
                  inputMode="numeric"
                  className="tabular-nums"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                />
              </Field>
              <Field label="메시지">
                <Input maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" variant="primary" size="sm" disabled={sending} onClick={() => void send(amount)}>
                <Play size={15} strokeWidth={1.7} />
                {sending ? '전송 중' : '이 금액으로 발동'}
              </Button>
              {note ? <span className="text-[12px] font-semibold text-ink-500">{note}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
