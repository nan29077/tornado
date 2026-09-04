'use client';

import * as React from 'react';
import Image from 'next/image';
import { AudioLines, Ban, ChevronDown, Coins, Globe, Heart, KeyRound, PartyPopper, Server, Shapes, Sparkles, Star, Volume2 } from 'lucide-react';
import { Button, Checkbox, Field, Input, Notice, SectionTitle, Select, cx } from '@/components/ui';
import { playEffectSound } from '@/components/overlay/overlay-sound';
import { ConfirmDialog, useConfirmSubmit } from '@/components/studio/confirm-dialog';
import { SaveButtonLabel, useSaveFeedback } from '@/components/studio/save-feedback';
import { updateOverlaySettingAction } from '@/app/actions/studio';
import type { StudioActionState } from '@/app/actions/studio';
import { DONAIDO_CHARACTER_STICKERS } from '@/lib/overlay-effect-catalog';

/**
 * 오버레이 간편 설정 (효과 + 테마 + TTS + 세부 표시 설정).
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - 저장은 기존 updateOverlaySettingAction 하나로 처리한다(withTts=1 로 TTS 값 동봉).
 *  - 효과 값은 OverlaySetting.stickerSet 에 그대로 저장된다. 금액 구간이 없을 때
 *    모든 후원에 이 효과가 재생된다(broadcast-dispatch 의 mergeTier 참고).
 *  - TTS 목소리는 오버레이를 여는 브라우저(OBS)에 설치된 음성 기준이다.
 *    스튜디오에서는 ko(한국어) 음성만 골라 보여 준다.
 *  - 외부 TTS(네이버 클로바 Voice)를 고르면 목소리 목록이 클로바 화자로 바뀌고,
 *    Client ID/Secret 은 서버에서 암호화 저장된다. 저장된 원문은 다시 표시하지 않는다.
 *  - 효과음은 오버레이가 Web Audio 로 직접 합성한다(음원 파일 없음).
 */

export interface OverlaySettingInput {
  enabled: boolean;
  showAmount: boolean;
  showMessage: boolean;
  anonymize: boolean;
  maxMessageLen: number;
  durationMs: number;
  position: string;
  theme: string;
  stickerSet: string;
  soundEnabled: boolean;
  soundVolume: number;
}

export interface TtsSettingInput {
  enabled: boolean;
  voice: string;
  speed: number;
  /** browser = 오버레이 브라우저 음성, naver = 네이버 클로바 Voice */
  provider: string;
  /** 저장된 Client ID 의 마스킹 값. 없으면 null */
  naverClientIdMasked: string | null;
  /** 서버에 저장된 인증 정보가 있는지 */
  hasNaverKey: boolean;
}

const POSITIONS = [
  { value: 'TOP_LEFT', label: '좌측 상단' },
  { value: 'TOP_CENTER', label: '중앙 상단' },
  { value: 'TOP_RIGHT', label: '우측 상단' },
  { value: 'BOTTOM_LEFT', label: '좌측 하단' },
  { value: 'BOTTOM_CENTER', label: '중앙 하단' },
  { value: 'BOTTOM_RIGHT', label: '우측 하단' },
];

interface EffectOption {
  value: string;
  label: string;
  desc: string;
  Icon?: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  image?: string;
  animationClass?: string;
  tint: string;
}

const EFFECTS: EffectOption[] = [
  { value: 'DEFAULT', label: '기본', desc: '하트 + 별 혼합', Icon: Shapes, tint: 'bg-brand-50 text-brand-700' },
  { value: 'HEART', label: '하트', desc: '하트가 떠오름', Icon: Heart, tint: 'bg-danger-50 text-danger-600' },
  { value: 'STAR', label: '별', desc: '별이 떠오름', Icon: Star, tint: 'bg-brand-50 text-brand-600' },
  { value: 'COIN', label: '코인', desc: '동전이 떠오름', Icon: Coins, tint: 'bg-brand-50 text-brand-700' },
  { value: 'FIREWORK', label: '폭죽', desc: '폭죽이 터짐', Icon: Sparkles, tint: 'bg-warning-50 text-accent-600' },
  { value: 'CONFETTI', label: '꽃가루', desc: '꽃가루가 내림', Icon: PartyPopper, tint: 'bg-ink-100 text-ink-700' },
  { value: 'NONE', label: '없음', desc: '배너만 표시', Icon: Ban, tint: 'bg-ink-50 text-ink-400' },
  ...DONAIDO_CHARACTER_STICKERS.map((sticker) => ({
    value: sticker.value,
    label: sticker.label,
    desc: sticker.description,
    image: sticker.image,
    animationClass: sticker.animationClass,
    tint: 'bg-[linear-gradient(145deg,#fff9e9,#fff2bf)]',
  })),
];

const THEMES = [
  { value: 'TORNADO', label: '도네이도 기본', desc: '밝은 카드형 배너' },
  { value: 'MINIMAL', label: '미니멀', desc: '반투명 검정 + 흰 글자, 절제된 효과' },
  { value: 'NEON', label: '네온', desc: '형광빛 글로우 효과' },
];

const TTS_PROVIDERS = [
  {
    value: 'browser',
    label: '브라우저 기본',
    desc: 'OBS 브라우저에 설치된 음성으로 읽습니다. 추가 비용이 없습니다.',
    Icon: Globe,
  },
  {
    value: 'naver',
    label: '네이버 클로바 Voice',
    desc: '서버에서 합성한 음성으로 읽습니다. 네이버 클라우드 플랫폼 이용료가 발생합니다.',
    Icon: Server,
  },
];

/** 클로바 Voice 화자. 값은 네이버가 정한 speaker 이름 그대로다. */
const CLOVA_SPEAKERS = [
  { value: 'nara', label: '아라 (여성)' },
  { value: 'nminyoung', label: '민영 (여성)' },
  { value: 'nyejin', label: '예진 (여성)' },
  { value: 'njihun', label: '지훈 (남성)' },
  { value: 'nsinu', label: '신우 (남성)' },
  { value: 'ngaram', label: '가람 (어린이)' },
];

function clampVolume(v: number) {
  const n = Number(v);
  return Math.min(100, Math.max(0, Number.isFinite(n) ? Math.round(n) : 80));
}

function clampSpeed(v: number) {
  return Math.min(2, Math.max(0.5, Number.isFinite(v) ? v : 1));
}

export function OverlayQuickSettings({
  setting,
  tts,
}: {
  setting: OverlaySettingInput;
  tts: TtsSettingInput | null;
}) {
  const [effect, setEffect] = React.useState(setting.stickerSet || 'DEFAULT');
  const [theme, setTheme] = React.useState(setting.theme || 'TORNADO');
  const [ttsOn, setTtsOn] = React.useState(Boolean(tts?.enabled));
  const [ttsVoice, setTtsVoice] = React.useState(tts?.voice ?? '');
  const [ttsSpeed, setTtsSpeed] = React.useState(String(clampSpeed(tts?.speed ?? 1)));
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([]);
  const [ttsProvider, setTtsProvider] = React.useState(tts?.provider === 'naver' ? 'naver' : 'browser');
  const [clovaSpeaker, setClovaSpeaker] = React.useState(
    CLOVA_SPEAKERS.some((sp) => sp.value === tts?.voice) ? (tts?.voice as string) : 'nara',
  );
  const [naverClientId, setNaverClientId] = React.useState('');
  const [naverClientSecret, setNaverClientSecret] = React.useState('');
  const [soundOn, setSoundOn] = React.useState(setting.soundEnabled);
  const [soundVolume, setSoundVolume] = React.useState(String(clampVolume(setting.soundVolume)));

  const [state, formAction, pending] = React.useActionState<StudioActionState, FormData>(
    updateOverlaySettingAction,
    { ok: false },
  );

  // 저장이 눌렸는지 확실히 보이게 한다. 버튼은 [저장 중] → [저장됨] → [설정 저장] 3단계.
  const feedback = useSaveFeedback(state, pending);

  // [설정 저장]은 확인 알림창을 거친다. 실제 저장은 알림창의 [확인] 에서 일어난다.
  const formRef = React.useRef<HTMLFormElement>(null);
  const confirm = useConfirmSubmit(formRef, state, pending);

  // 브라우저에 설치된 한국어 음성만 수집한다.
  React.useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      setVoices(list.filter((v) => v.lang?.toLowerCase().startsWith('ko')));
    };
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  /** 저장된 목소리가 이 브라우저에 없으면 '기본(자동 선택)'이 선택된 것으로 본다. */
  const voiceKnown = voices.some((v) => v.name === ttsVoice);
  const autoSelected = !ttsVoice || !voiceKnown;

  const speakPreview = (voiceName: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance('테스트 후원입니다');
      const matched = voices.find((v) => v.name === voiceName) ?? voices[0] ?? null;
      if (matched) utter.voice = matched;
      utter.lang = 'ko-KR';
      utter.rate = clampSpeed(Number(ttsSpeed));
      synth.speak(utter);
    } catch {
      /* 음성 미지원 브라우저는 무시한다 */
    }
  };

  return (
    <form ref={formRef} action={formAction} onSubmit={confirm.onSubmit} className="space-y-5">
      {/* 서버 액션이 TTS 값을 함께 저장하도록 표시한다 */}
      <input type="hidden" name="withTts" value="1" />
      <input type="hidden" name="stickerSet" value={effect} />
      <input type="hidden" name="theme" value={theme} />
      <input
        type="hidden"
        name="ttsVoice"
        value={ttsProvider === 'naver' ? clovaSpeaker : autoSelected ? '' : ttsVoice}
      />
      <input type="hidden" name="ttsProvider" value={ttsProvider} />
      <input type="hidden" name="soundVolume" value={soundVolume} />
      {ttsOn ? <input type="hidden" name="ttsEnabled" value="on" /> : null}
      {soundOn ? <input type="hidden" name="soundEnabled" value="on" /> : null}

      {/* ── 효과 선택 ─────────────────────────────────────────── */}
      <section>
        <SectionTitle
          title="효과 선택"
          description="기본 파티클 또는 도네이도 캐릭터 스티커를 고르세요. 모든 후원에 적용됩니다."
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {EFFECTS.map((o) => {
            const active = effect === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setEffect(o.value)}
                aria-pressed={active}
                className={cx(
                  'relative flex min-h-[154px] flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border px-3 py-4 text-center transition-all',
                  active
                    ? 'border-brand-400 bg-brand-50 shadow-[0_6px_16px_rgba(237,166,0,0.18)]'
                    : 'border-ink-100 bg-white hover:border-ink-200 hover:bg-ink-50',
                )}
              >
                {o.image ? (
                  <span className="absolute right-2 top-2 rounded-full bg-brand-500 px-2 py-0.5 text-[9px] font-extrabold text-ink-900 shadow-sm">
                    캐릭터
                  </span>
                ) : null}
                <span className={cx('grid place-items-center rounded-xl', o.image ? 'h-20 w-20' : 'h-11 w-11', o.tint)}>
                  {o.image ? (
                    <Image
                      src={o.image}
                      alt=""
                      width={96}
                      height={96}
                      className={cx('h-[76px] w-[76px] object-contain', active && o.animationClass)}
                    />
                  ) : o.Icon ? (
                    <o.Icon size={20} strokeWidth={1.7} />
                  ) : null}
                </span>
                <span className="text-[13px] font-bold text-ink-900">{o.label}</span>
                <span className="text-[11px] leading-tight text-ink-400">{o.desc}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] text-ink-400">
          금액대별로 다른 효과를 쓰고 싶다면 아래 [고급 설정]의 금액 구간에서 정할 수 있습니다. 구간이 있으면 구간
          설정이 우선합니다.
        </p>
      </section>

      {/* ── 효과음 ───────────────────────────────────────────── */}
      <section>
        <SectionTitle
          title="효과음"
          description="효과가 재생될 때 함께 나오는 소리입니다. 효과 종류에 맞는 소리가 자동으로 재생됩니다."
        />
        <div className="rounded-2xl border border-ink-100 bg-white p-4">
          <button
            type="button"
            role="switch"
            aria-checked={soundOn}
            onClick={() => setSoundOn((v) => !v)}
            className="flex w-full items-center justify-between gap-3"
          >
            <span className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-ink-50 text-ink-700">
                <AudioLines size={18} strokeWidth={1.7} />
              </span>
              <span className="text-left">
                <span className="block text-[14px] font-bold text-ink-900">효과음 {soundOn ? '켜짐' : '꺼짐'}</span>
                <span className="block text-[12px] text-ink-400">
                  {soundOn ? '후원 알림과 함께 효과음이 재생됩니다.' : '켜면 후원 알림과 함께 효과음이 재생됩니다.'}
                </span>
              </span>
            </span>
            <span
              className={cx(
                'relative h-7 w-12 shrink-0 rounded-full transition-colors',
                soundOn ? 'bg-brand-400' : 'bg-ink-200',
              )}
            >
              <span
                className={cx(
                  'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
                  soundOn ? 'left-6' : 'left-1',
                )}
              />
            </span>
          </button>

          {soundOn ? (
            <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
              <Field label={`음량 ${clampVolume(Number(soundVolume))}`}>
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-ink-400">작게</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={soundVolume}
                    onChange={(e) => setSoundVolume(e.target.value)}
                    className="h-10 w-full accent-brand-500"
                    aria-label="효과음 음량"
                  />
                  <span className="text-[12px] text-ink-400">크게</span>
                </div>
              </Field>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[12px] leading-relaxed text-ink-400">
                  효과음은 방송 화면(OBS 브라우저 소스)에서 재생됩니다. 소리가 나지 않으면 브라우저 소스의 음소거
                  설정을 확인해 주세요.
                </p>
                <button
                  type="button"
                  onClick={() => playEffectSound(effect, clampVolume(Number(soundVolume)))}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-ink-50"
                >
                  <Volume2 size={16} strokeWidth={1.7} />
                  효과음 미리듣기
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── 테마 ─────────────────────────────────────────────── */}
      <section>
        <SectionTitle title="테마" description="알림 배너의 분위기를 고릅니다. 방송 화면 톤에 맞춰 주세요." />
        <div className="grid gap-2 sm:grid-cols-3">
          {THEMES.map((t) => {
            const active = theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setTheme(t.value)}
                aria-pressed={active}
                className={cx(
                  'overflow-hidden rounded-2xl border text-left transition-all',
                  active
                    ? 'border-brand-400 shadow-[0_6px_16px_rgba(237,166,0,0.18)]'
                    : 'border-ink-100 hover:border-ink-200',
                )}
              >
                <ThemePreview theme={t.value} />
                <span className="block px-3.5 py-2.5">
                  <span className="block text-[13px] font-bold text-ink-900">{t.label}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-400">{t.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── TTS ──────────────────────────────────────────────── */}
      <section>
        <SectionTitle title="TTS 읽어주기" description="후원자명과 메시지를 음성으로 읽습니다." />
        <div className="rounded-2xl border border-ink-100 bg-white p-4">
          <button
            type="button"
            role="switch"
            aria-checked={ttsOn}
            onClick={() => setTtsOn((v) => !v)}
            className="flex w-full items-center justify-between gap-3"
          >
            <span className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-ink-50 text-ink-700">
                <Volume2 size={18} strokeWidth={1.7} />
              </span>
              <span className="text-left">
                <span className="block text-[14px] font-bold text-ink-900">TTS {ttsOn ? '켜짐' : '꺼짐'}</span>
                <span className="block text-[12px] text-ink-400">
                  {ttsOn ? '후원 알림을 음성으로 읽어 줍니다.' : '켜면 후원 알림을 음성으로 읽어 줍니다.'}
                </span>
              </span>
            </span>
            <span
              className={cx(
                'relative h-7 w-12 shrink-0 rounded-full transition-colors',
                ttsOn ? 'bg-brand-400' : 'bg-ink-200',
              )}
            >
              <span
                className={cx(
                  'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
                  ttsOn ? 'left-6' : 'left-1',
                )}
              />
            </span>
          </button>

          {ttsOn ? (
            <div className="mt-4 space-y-4 border-t border-ink-100 pt-4">
              <div>
                <p className="mb-1.5 text-[13px] font-semibold text-ink-700">TTS 제공사</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {TTS_PROVIDERS.map((o) => {
                    const active = ttsProvider === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setTtsProvider(o.value)}
                        aria-pressed={active}
                        className={cx(
                          'flex items-start gap-2.5 rounded-2xl border px-3.5 py-3 text-left transition-all',
                          active
                            ? 'border-brand-400 bg-brand-50 shadow-[0_6px_16px_rgba(237,166,0,0.18)]'
                            : 'border-ink-100 bg-white hover:border-ink-200 hover:bg-ink-50',
                        )}
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-ink-700">
                          <o.Icon size={18} strokeWidth={1.7} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-bold text-ink-900">{o.label}</span>
                          <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-400">{o.desc}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {ttsProvider === 'naver' ? (
                <div className="space-y-3">
                  <div>
                    <p className="mb-1.5 text-[13px] font-semibold text-ink-700">클로바 화자</p>
                    <Select value={clovaSpeaker} onChange={(e) => setClovaSpeaker(e.target.value)}>
                      {CLOVA_SPEAKERS.map((sp) => (
                        <option key={sp.value} value={sp.value}>
                          {sp.label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1.5 text-[12px] text-ink-400">
                      네이버 클라우드 플랫폼 [Clova Voice Premium] 에서 사용 가능한 화자입니다.
                    </p>
                  </div>

                  <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3.5">
                    <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
                      <KeyRound size={16} strokeWidth={1.7} className="text-ink-500" />
                      API 인증 정보
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
                      네이버 클라우드 플랫폼 콘솔 &gt; AI·Application Service &gt; Clova Voice 에서 발급한 값을
                      입력하세요. 저장하면 암호화되어 보관되며 원문은 다시 표시되지 않습니다.
                    </p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <Field
                        label="Client ID"
                        hint={tts?.hasNaverKey ? `저장됨 ${tts.naverClientIdMasked ?? ''}` : '영문/숫자 8~64자'}
                      >
                        <Input
                          name="naverClientId"
                          value={naverClientId}
                          onChange={(e) => setNaverClientId(e.target.value)}
                          placeholder={tts?.hasNaverKey ? '변경할 때만 입력' : 'X-NCP-APIGW-API-KEY-ID'}
                          autoComplete="off"
                          maxLength={64}
                        />
                      </Field>
                      <Field label="Client Secret" hint={tts?.hasNaverKey ? '변경할 때만 입력' : '발급받은 비밀키'}>
                        <Input
                          name="naverClientSecret"
                          type="password"
                          value={naverClientSecret}
                          onChange={(e) => setNaverClientSecret(e.target.value)}
                          placeholder={tts?.hasNaverKey ? '변경할 때만 입력' : 'X-NCP-APIGW-API-KEY'}
                          autoComplete="new-password"
                          maxLength={200}
                        />
                      </Field>
                    </div>
                    <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
                      두 칸을 비워 두면 이미 저장된 키를 그대로 사용합니다. 서버 합성에 실패하면 방송이 끊기지 않도록
                      브라우저 음성으로 자동 대체됩니다.
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="mb-1.5 text-[13px] font-semibold text-ink-700">목소리</p>
                  {voices.length === 0 ? (
                    <p className="rounded-xl bg-ink-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-500">
                      이 브라우저에서 한국어 음성을 찾지 못했습니다. 저장하면 오버레이를 여는 브라우저(OBS)의 기본
                      한국어 음성으로 재생됩니다.
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-ink-100">
                      <VoiceRow
                        name="기본 (한국어 자동 선택)"
                        lang=""
                        selected={autoSelected}
                        onSelect={() => setTtsVoice('')}
                        onPreview={() => speakPreview('')}
                      />
                      {voices.map((v) => (
                        <VoiceRow
                          key={v.voiceURI}
                          name={v.name}
                          lang={v.lang}
                          selected={!autoSelected && ttsVoice === v.name}
                          onSelect={() => setTtsVoice(v.name)}
                          onPreview={() => speakPreview(v.name)}
                        />
                      ))}
                    </div>
                  )}
                  <p className="mt-1.5 text-[12px] text-ink-400">
                    목소리는 오버레이를 여는 브라우저(OBS 브라우저 소스)에 설치된 음성 기준입니다. 선택한 목소리가
                    없으면 한국어 첫 번째 음성으로 재생됩니다.
                  </p>
                  <Notice tone="warning">
                    OBS 기본 브라우저(CEF)에는 한국어 TTS 음성이 없을 수 있습니다. TTS를 켠 뒤 실제 OBS에서 음성이
                    나오는지 확인해 주세요. 음성이 나오지 않으면 [네이버 클로바 Voice]로 전환하거나 TTS를 꺼 주세요.
                  </Notice>
                </div>
              )}

              <Field label={`속도 ${Number(ttsSpeed).toFixed(2)}배`}>
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-ink-400">느리게</span>
                  <input
                    type="range"
                    name="ttsSpeed"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={ttsSpeed}
                    onChange={(e) => setTtsSpeed(e.target.value)}
                    className="h-10 w-full accent-brand-500"
                  />
                  <span className="text-[12px] text-ink-400">빠르게</span>
                </div>
              </Field>
            </div>
          ) : (
            /* 꺼져 있어도 저장값이 초기화되지 않도록 속도를 함께 보낸다 */
            <input type="hidden" name="ttsSpeed" value={ttsSpeed} />
          )}
        </div>
      </section>

      {/* ── 세부 표시 설정 ───────────────────────────────────── */}
      <details className="group rounded-2xl border border-ink-100 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-[14px] font-bold text-ink-900">세부 표시 설정</span>
            <span className="block text-[12px] text-ink-400">표시 위치 · 시간 · 금액과 메시지 노출 여부</span>
          </span>
          <ChevronDown size={18} strokeWidth={1.7} className="text-ink-400 transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-3 border-t border-ink-100 px-4 py-4">
          <div className="rounded-xl border border-ink-100 px-3 py-1">
            <Checkbox
              name="enabled"
              defaultChecked={setting.enabled}
              label="방송 화면에 보이기"
              description="끄면 후원 알림이 방송 화면에 표시되지 않습니다."
            />
            <Checkbox name="showAmount" defaultChecked={setting.showAmount} label="후원금 표시" />
            <Checkbox name="showMessage" defaultChecked={setting.showMessage} label="메시지 표시" />
            <Checkbox
              name="anonymize"
              defaultChecked={setting.anonymize}
              label="익명 처리"
              description="모든 후원자를 '익명의 후원자'로 표시합니다."
            />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="화면 위치">
              <Select name="position" defaultValue={setting.position}>
                {POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="표시 시간 (ms)" hint="2000~30000ms">
              <Input name="durationMs" type="number" min={2000} max={30000} step={500} defaultValue={setting.durationMs} />
            </Field>
            <Field label="최대 글자 수" hint="10~200자">
              <Input name="maxMessageLen" type="number" min={10} max={200} defaultValue={setting.maxMessageLen} />
            </Field>
          </div>
        </div>
      </details>

      {/* 확인 알림창. [확인] 을 눌러야 실제로 저장된다. */}
      <ConfirmDialog
        phase={confirm.phase}
        title="오버레이 설정을 저장할까요?"
        description="효과 · 테마 · TTS · 세부 표시 설정이 함께 저장되고, 다음 후원부터 방송 화면에 곧바로 적용됩니다."
        confirmLabel="저장"
        busyLabel="저장 중"
        doneOk={state.ok}
        doneTitle={state.ok ? '저장되었습니다' : '저장하지 못했습니다'}
        doneDescription={state.message}
        onConfirm={confirm.confirm}
        onClose={confirm.close}
      />

      {/* 폼 안쪽 기록. 시각을 함께 적어 같은 문구를 다시 저장해도 바뀐 것이 보이게 한다. */}
      {feedback.toast ? (
        <Notice tone={feedback.toast.ok ? 'success' : 'danger'}>
          {feedback.toast.message} <span className="text-ink-400">({feedback.toast.at})</span>
        </Notice>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={pending}
        aria-busy={pending}
        className={cx(
          'min-w-[132px] justify-center transition-colors',
          feedback.justSaved && 'bg-success-500 hover:bg-success-500',
        )}
      >
        <SaveButtonLabel pending={pending} justSaved={feedback.justSaved} label="설정 저장" />
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- 목소리 행

function VoiceRow({
  name,
  lang,
  selected,
  onSelect,
  onPreview,
}: {
  name: string;
  lang: string;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  return (
    <div
      className={cx(
        'flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2 last:border-b-0',
        selected ? 'bg-brand-50' : 'bg-white',
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <span
          className={cx(
            'grid h-5 w-5 shrink-0 place-items-center rounded-full border',
            selected ? 'border-brand-500' : 'border-ink-300',
          )}
        >
          {selected ? <span className="h-2.5 w-2.5 rounded-full bg-brand-500" /> : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-ink-900">{name}</span>
          {lang ? <span className="block text-[11px] text-ink-400">{lang}</span> : null}
        </span>
      </button>
      <button
        type="button"
        onClick={onPreview}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 text-[12px] font-semibold text-ink-700 hover:bg-ink-50"
      >
        <Volume2 size={14} strokeWidth={1.7} />
        미리듣기
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 테마 미리보기

function ThemePreview({ theme }: { theme: string }) {
  if (theme === 'MINIMAL') {
    return (
      <span className="grid h-24 place-items-center bg-[#3a3a42] px-3">
        <span className="w-full max-w-[200px] rounded-lg bg-black/60 px-3 py-2 text-center">
          <span className="block text-[11px] font-bold text-white">홍길동님이 5,000원을 후원하셨습니다</span>
        </span>
      </span>
    );
  }
  if (theme === 'NEON') {
    return (
      <span className="grid h-24 place-items-center bg-[#0a0e1f] px-3">
        <span className="w-full max-w-[200px] rounded-lg border border-[#22d3ee]/60 bg-[#101636] px-3 py-2 text-center shadow-[0_0_14px_rgba(34,211,238,0.45)]">
          <span className="block text-[11px] font-bold text-[#a5f3fc] [text-shadow:0_0_8px_rgba(34,211,238,0.9)]">
            홍길동님이 5,000원을 후원하셨습니다
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="grid h-24 place-items-center bg-[#3a3a42] px-3">
      <span className="w-full max-w-[200px] rounded-lg border border-white/40 bg-white/95 px-3 py-2 text-center shadow">
        <span className="block text-[11px] font-extrabold text-ink-900">홍길동님이 5,000원을 후원하셨습니다</span>
      </span>
    </span>
  );
}
