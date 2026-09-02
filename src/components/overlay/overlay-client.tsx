'use client';

import * as React from 'react';
import { formatNumber } from '@/lib/money';
import { EffectLayer, CharacterStickerInline, isCharacterStickerEffect } from '@/components/overlay/overlay-effects';
import { playEffectSound } from '@/components/overlay/overlay-sound';
import { Portal } from '@/components/ui/portal';
import { useStandalone } from '@/components/overlay/use-standalone';
import {
  DEFAULT_OVERLAY_LAYOUT,
  clampOverlayLayout,
  overlayLayoutTransform,
  type OverlayLayout,
} from '@/lib/overlay-layout';

/**
 * OBS / PRISM 브라우저 소스용 오버레이 클라이언트.
 *
 * 규칙
 *  - 서버 모듈을 import 하지 않는다. 페이로드 타입만 재정의해 사용한다.
 *  - 여러 건이 동시에 도착해도 대기열에 넣고 한 건씩 순차 재생한다.
 *  - TTS 재생이 끝나기 전에는 다음 항목으로 넘어가지 않는다(표시시간과 음성 길이 중 긴 쪽 기준).
 *  - 연결 상태는 방송 화면에 표시하지 않는다. 디버그 모드에서만 배지를 노출한다.
 *    스튜디오 미리보기(iframe) 안에서는 배지를 그리지 않고 부모에게 값만 넘긴다.
 *    미리보기는 1920x1080 캔버스를 통째로 축소하는데, transform 이 걸린 조상이
 *    position:fixed 의 기준이 되므로 배지가 "틀의 왼쪽 위"가 아니라 "축소된 방송 화면의
 *    왼쪽 위"에 붙는다. 세로형(휴대폰) 틀에서는 그 자리가 화면 한가운데로 보인다.
 *  - 금액 구간(effect/banner/durationMs)이 없는 예전 이벤트도 그대로 재생돼야 한다.
 *  - TTS 는 ttsMode 로 갈린다. server 면 서버 합성 mp3 를 재생하고, 실패하면 브라우저 음성으로 되돌아간다.
 *  - 효과음은 Web Audio 로 직접 합성한다(overlay-sound.ts). soundEnabled/soundVolume 을 따른다.
 *  - 테마(TORNADO/MINIMAL/NEON) · 표시 위치 · 최대 글자 수는 이벤트 페이로드 값을 우선 적용한다.
 *    브라우저 소스는 방송 내내 열려 있으므로, 페이지를 열 때 받은 prop 만 쓰면 스튜디오에서
 *    설정을 바꿔 저장해도 새로 고침 전까지 반영되지 않는다. prop 은 값이 없는 예전 이벤트용 기본값이다.
 *  - 오버레이 표시가 꺼진 동안 도착한 이벤트는 방송 화면에서 무시한다(미리보기에서는 재생한다).
 */

export interface OverlayTts {
  enabled: boolean;
  text: string;
  voice: string;
  speed: number;
  pitch?: number;
  volume: number;
}

export interface OverlayPayload {
  eventId: string;
  creatorId: string;
  donationId: string | null;
  donorName: string;
  amount: string;
  message: string;
  sticker: string;
  /** 금액 구간에서 고른 파티클 효과. 없으면 sticker 값으로 대체한다. */
  effect?: string;
  /** 배너 표시 여부. 없으면(예전 이벤트) 표시한다. */
  banner?: boolean;
  tierLabel?: string;
  tts: OverlayTts | null;
  /** 음성 합성 위치. 없으면(예전 이벤트) 브라우저 합성으로 본다. */
  ttsMode?: 'browser' | 'server';
  /** 효과음 재생 여부. 없으면 재생한다. */
  soundEnabled?: boolean;
  /** 효과음 음량 0~100. 없으면 80. */
  soundVolume?: number;
  durationMs: number;
  /** 이 이벤트를 재생할 때 쓸 테마. 없으면(예전 이벤트) 페이지 로드 시 값을 쓴다. */
  theme?: string;
  /** 이 이벤트를 재생할 때 쓸 표시 위치. 없으면 페이지 로드 시 값을 쓴다. */
  position?: string;
  /** 이 이벤트의 메시지 최대 글자 수. 없으면 페이지 로드 시 값을 쓴다. */
  maxMessageLen?: number;
  /** 배치 미세 조정. 없으면(예전 이벤트) 페이지 로드 시 값을 쓴다. */
  offsetX?: number;
  offsetY?: number;
  scalePct?: number;
  /** 오버레이 표시 스위치. false 면 방송 화면에서는 재생하지 않는다(미리보기는 재생). */
  enabled?: boolean;
  occurredAt: string;
  isTest: boolean;
}

/**
 * 배치 조정 중에 보여 주는 예시 알림.
 *
 * 후원 알림은 평소에는 아무것도 그리지 않으므로, 위치를 잡으려 해도 잡을 대상이 없다.
 * 스튜디오가 [배치 조정]을 켜면 이 예시를 계속 띄워 두고 그것으로 자리를 잡는다.
 * 방송용(토큰) 경로에는 이 신호가 오지 않으므로 실제 방송에는 나가지 않는다.
 */
const LAYOUT_SAMPLE: OverlayPayload = {
  eventId: 'layout-sample',
  creatorId: '',
  donationId: null,
  donorName: '배치 조정 예시',
  amount: '10000',
  message: '이 자리에 후원 알림이 표시됩니다',
  sticker: 'DEFAULT',
  banner: true,
  tts: null,
  durationMs: 0,
  occurredAt: '',
  isTest: false,
};

const OUT_MS = 360; // globals.css 의 .animate-tornado-out 길이와 맞춘다
const MAX_BACKOFF_MS = 30000;

/**
 * SSE 연결 상태.
 *
 * 방송 화면에는 절대 표시하지 않는다(디버그 배지와 스튜디오 미리보기 전용).
 * 크리에이터는 스튜디오 미리보기 창에서 이 상태를 보고 OBS 연결 문제를 판별한다.
 */
export type LinkPhase = 'connecting' | 'connected' | 'retrying';

interface LinkState {
  phase: LinkPhase;
  /** 재연결까지 남은 대기 시간(초). retrying 일 때만 의미가 있다. */
  retrySec?: number;
  /** 재연결 직후 서버가 다시 보내 준 놓친 알림 수 */
  recovered?: number;
}

const positionClass: Record<string, string> = {
  TOP_LEFT: 'items-start justify-start',
  TOP_CENTER: 'items-start justify-center',
  TOP_RIGHT: 'items-start justify-end',
  MIDDLE_CENTER: 'items-center justify-center',
  CENTER: 'items-center justify-center',
  BOTTOM_LEFT: 'items-end justify-start',
  BOTTOM_CENTER: 'items-end justify-center',
  BOTTOM_RIGHT: 'items-end justify-end',
};

// ------------------------------------------------------------------- 테마

export type OverlayTheme = 'TORNADO' | 'MINIMAL' | 'NEON';

/** DB 에 저장된 문자열을 알고 있는 테마로 좁힌다. 모르는 값은 기본 테마로 동작한다. */
function themeOf(value?: string): OverlayTheme {
  const t = (value || 'TORNADO').toUpperCase();
  return t === 'MINIMAL' || t === 'NEON' ? t : 'TORNADO';
}

interface ThemeClasses {
  card: string;
  title: string;
  message: string;
  swirl: string;
  sticker: string;
  footer: string;
  test: string;
}

const THEME_CLASSES: Record<OverlayTheme, ThemeClasses> = {
  /** 기본: 밝은 카드형 배너 (기존 스타일) */
  TORNADO: {
    card: 'border-white/40 bg-white/95 shadow-[0_18px_48px_rgba(19,26,58,0.28)]',
    title: 'text-ink-900',
    message: 'text-ink-700',
    swirl: 'bg-brand-50 text-brand-700',
    sticker: 'border-brand-200 bg-brand-50 text-brand-700',
    footer: 'text-ink-300',
    test: 'bg-ink-100 text-ink-500',
  },
  /** 미니멀: 반투명 검정 + 흰 텍스트 */
  MINIMAL: {
    card: 'border-white/10 bg-black/60 shadow-[0_12px_36px_rgba(0,0,0,0.4)] backdrop-blur-md',
    title: 'text-white',
    message: 'text-white/80',
    swirl: 'bg-white/10 text-white',
    sticker: 'border-white/25 bg-white/10 text-white',
    footer: 'text-white/40',
    test: 'bg-white/15 text-white/70',
  },
  /** 네온: 어두운 바탕 + 형광 글로우 */
  NEON: {
    card: 'border-[#22d3ee]/50 bg-[#0a0e1f]/90 shadow-[0_0_28px_rgba(34,211,238,0.4)]',
    title: 'text-[#e8fdff] [text-shadow:0_0_12px_rgba(34,211,238,0.85)]',
    message: 'text-[#9be9f5] [text-shadow:0_0_8px_rgba(34,211,238,0.5)]',
    swirl: 'bg-[#22d3ee]/10 text-[#22d3ee] [filter:drop-shadow(0_0_6px_rgba(34,211,238,0.8))]',
    sticker: 'border-[#f0abfc]/40 bg-[#f0abfc]/10 text-[#f0abfc] [filter:drop-shadow(0_0_5px_rgba(240,171,252,0.7))]',
    footer: 'text-[#22d3ee]/60',
    test: 'bg-[#22d3ee]/15 text-[#9be9f5]',
  },
};

/** 배너를 끈 경우에도 효과 재생 시간은 유지된다. */
function effectOf(payload: OverlayPayload): string {
  return payload.effect || payload.sticker || 'DEFAULT';
}

function bannerOf(payload: OverlayPayload): boolean {
  return payload.banner !== false;
}

/** 디버그 배지 문구. 방송 화면(디버그 미사용)에는 나타나지 않는다. */
function linkLabel(link: LinkState): string {
  if (link.phase === 'retrying') {
    return link.retrySec && link.retrySec > 0 ? `재연결 중 ${link.retrySec}초 후` : '재연결 중';
  }
  if (link.phase === 'connecting') return '연결 중';
  return link.recovered ? `연결됨 · 복구 ${link.recovered}건` : '연결됨';
}

export function OverlayClient({
  creatorId,
  token,
  preview = false,
  position = 'BOTTOM_CENTER',
  defaultDurationMs = 7000,
  maxMessageLen = 80,
  theme = 'TORNADO',
  layout = DEFAULT_OVERLAY_LAYOUT,
  debug = false,
}: {
  creatorId: string;
  token: string;
  /** 스튜디오 미리보기 모드. 토큰 대신 세션으로 인증한다. */
  preview?: boolean;
  position?: string;
  defaultDurationMs?: number;
  maxMessageLen?: number;
  /** OverlaySetting.theme 값. TORNADO / MINIMAL / NEON 외의 값은 기본 테마로 동작한다. */
  theme?: string;
  /** 저장된 배치(위치 미세 조정 · 크기 배율). 이벤트에 실려 온 값이 있으면 그쪽이 우선한다. */
  layout?: OverlayLayout;
  debug?: boolean;
}) {
  const [current, setCurrent] = React.useState<OverlayPayload | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const [link, setLink] = React.useState<LinkState>({ phase: 'connecting' });
  const [queueLen, setQueueLen] = React.useState(0);

  const queue = React.useRef<OverlayPayload[]>([]);
  const busy = React.useRef(false);
  const seen = React.useRef<Set<string>>(new Set());
  const playNextRef = React.useRef<() => void>(() => {});
  /**
   * 마지막으로 받은 이벤트 ID.
   * 재연결할 때 서버에 알려 주면 끊긴 사이에 쌓인 후원 알림을 다시 받아 재생한다.
   * (표준 EventSource 는 브라우저가 직접 재연결할 때만 Last-Event-ID 헤더를 보낸다.
   *  여기서는 지수 백오프를 위해 직접 다시 연결하므로 쿼리로 함께 보낸다)
   */
  const lastEventId = React.useRef<string>('');

  // 브라우저 음성 목록은 비동기로 로드되므로 미리 한 번 요청해 둔다.
  React.useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const warm = () => window.speechSynthesis.getVoices();
    warm();
    window.speechSynthesis.addEventListener?.('voiceschanged', warm);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', warm);
  }, []);

  // ------------------------------------------------------------- 재생 파이프라인
  React.useEffect(() => {
    let disposed = false;
    // 파이프라인이 재구성되면 이전 재생 상태를 초기화한다(대기열 정지 방지).
    busy.current = false;

    /**
     * 서버 합성(mp3) 재생. 성공하면 true.
     * 키 미등록·합성 실패·자동재생 차단 등 어떤 이유로든 실패하면 false 를 돌려주고,
     * 호출부가 브라우저 음성으로 되돌아간다.
     */
    const speakServer = (eventId: string, tts: OverlayTts): Promise<boolean> =>
      new Promise((resolve) => {
        try {
          // 읽을 문장은 보내지 않는다. 서버가 발행한 이벤트의 문장만 합성하도록
          // eventId 만 넘긴다. (임의 문장 합성·금칙어 우회 차단)
          const params = new URLSearchParams({ creatorId, eventId });
          if (preview) params.set('preview', '1');
          else params.set('token', token);

          const audio = new Audio(`/api/tts/synthesize?${params.toString()}`);
          audio.volume = Math.min(1, Math.max(0, Number(tts.volume ?? 1)));

          let done = false;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(guard);
            resolve(ok);
          };
          // 재생이 끝나지 않는 경우를 대비한 안전장치
          const guard = setTimeout(() => finish(true), 60000);
          audio.onended = () => finish(true);
          audio.onerror = () => finish(false);
          audio.play().catch(() => finish(false));
        } catch {
          resolve(false);
        }
      });

    const speakBrowser = (tts: OverlayTts): Promise<void> =>
      new Promise((resolve) => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();

        try {
          const synth = window.speechSynthesis;
          const utter = new SpeechSynthesisUtterance(tts.text);
          const voices = synth.getVoices();
          // 저장된 목소리 이름으로 찾되, 한국어(ko) 음성만 허용한다.
          // 이름이 없거나 한국어가 아니면 설치된 첫 번째 한국어 음성으로 폴백한다.
          const isKo = (v: SpeechSynthesisVoice) => v.lang?.toLowerCase().startsWith('ko');
          let matched =
            voices.find((v) => v.name === tts.voice) ??
            voices.find((v) => v.voiceURI === tts.voice) ??
            null;
          if (!matched || !isKo(matched)) {
            matched = voices.find(isKo) ?? matched;
          }
          if (matched) utter.voice = matched;
          utter.lang = 'ko-KR';
          utter.rate = Math.min(2, Math.max(0.5, Number(tts.speed) || 1));
          utter.pitch = Math.min(2, Math.max(0, Number(tts.pitch ?? 1)));
          utter.volume = Math.min(1, Math.max(0, Number(tts.volume ?? 1)));

          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(guard);
            resolve();
          };
          // onend 가 오지 않는 브라우저를 대비한 안전장치
          const guard = setTimeout(finish, 60000);
          utter.onend = finish;
          utter.onerror = finish;
          synth.speak(utter);
        } catch {
          resolve();
        }
      });

    const speak = async (payload: OverlayPayload): Promise<void> => {
      const tts = payload.tts;
      if (!tts || !tts.enabled || !tts.text) return;
      if (
        (payload.ttsMode ?? 'browser') === 'server' &&
        payload.eventId &&
        (await speakServer(payload.eventId, tts))
      ) {
        return;
      }
      await speakBrowser(tts);
    };

    const playNext = () => {
      if (disposed || busy.current) return;
      const next = queue.current.shift();
      if (!next) return;
      setQueueLen(queue.current.length);

      busy.current = true;
      setLeaving(false);
      setCurrent(next);

      // 효과음은 효과 애니메이션과 같은 시점에 시작한다. 실패해도 알림 재생에 영향을 주지 않는다.
      if (next.soundEnabled !== false) playEffectSound(effectOf(next), next.soundVolume ?? 80);

      const duration = Math.max(1500, Number(next.durationMs) || defaultDurationMs);
      const shown = new Promise<void>((r) => setTimeout(r, duration));

      // 표시 시간과 TTS 재생 시간 중 긴 쪽을 기준으로 다음 항목으로 넘어간다.
      Promise.all([shown, speak(next)]).then(() => {
        if (disposed) return;
        setLeaving(true);
        setTimeout(() => {
          if (disposed) return;
          setCurrent(null);
          setLeaving(false);
          busy.current = false;
          playNext();
        }, OUT_MS);
      });
    };

    playNextRef.current = playNext;

    return () => {
      disposed = true;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
    };
  }, [defaultDurationMs, creatorId, token, preview]);

  // --------------------------------------------------------------- SSE 구독
  React.useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let countdown: ReturnType<typeof setInterval> | null = null;
    /** 이번 연결에서 서버가 재전송해 준 알림 수 (재연결 직후에만 올라간다) */
    let recovered = 0;
    let resuming = false;

    /** 부모에게 마지막으로 알린 연결 상태. 부모가 다시 물어보면 이 값을 그대로 돌려준다. */
    let lastStatus: Record<string, unknown> = { phase: 'connecting' };

    /** 스튜디오 미리보기(iframe) 부모 창에 상태를 알린다. 방송 화면에는 아무것도 그리지 않는다. */
    const notifyParent = (type: string, extra?: Record<string, unknown>) => {
      if (type === 'donaido-overlay-status' && extra) lastStatus = extra;
      if (!preview || typeof window === 'undefined' || window.parent === window) return;
      try {
        window.parent.postMessage({ type, creatorId, ...extra }, window.location.origin);
      } catch {
        /* ignore */
      }
    };

    /**
     * 부모(스튜디오 미리보기)의 재문의에 답한다.
     *
     * 이 iframe 이 부모보다 먼저 연결되면 첫 상태 알림이 부모의 message 리스너가 붙기 전에
     * 날아가 버려, 실제로는 연결됐는데도 배지가 [연결 중]에서 멈춘다. 부모가 다시 물어보면
     * 지금 상태를 그대로 돌려준다.
     */
    const onAsk = (e: MessageEvent) => {
      if (typeof window === 'undefined' || e.origin !== window.location.origin) return;
      if ((e.data as { type?: string } | null)?.type !== 'donaido-overlay-hello') return;
      notifyParent('donaido-overlay-status', lastStatus);
    };
    if (preview && typeof window !== 'undefined') window.addEventListener('message', onAsk);

    const clearCountdown = () => {
      if (countdown) clearInterval(countdown);
      countdown = null;
    };

    const connect = () => {
      if (disposed) return;
      clearCountdown();
      recovered = 0;

      const params = new URLSearchParams();
      if (preview) params.set('preview', '1');
      else params.set('token', token);
      // 끊긴 사이에 쌓인 알림을 돌려받기 위해 마지막으로 받은 이벤트 ID 를 함께 보낸다.
      if (lastEventId.current) params.set('lastEventId', lastEventId.current);
      resuming = Boolean(lastEventId.current);

      const url = `/api/overlay/${encodeURIComponent(creatorId)}/stream?${params.toString()}`;
      const es = new EventSource(url);
      source = es;

      const markConnected = () => {
        retry = 0;
        clearCountdown();
        setLink({ phase: 'connected', recovered });
        notifyParent('donaido-overlay-status', { phase: 'connected', recovered });
      };

      es.onopen = () => {
        markConnected();
        console.log('[overlay] 연결됨');
      };

      es.addEventListener('ready', () => {
        markConnected();
        // 스튜디오 미리보기(iframe)에 구독 완료를 알린다. 구독 전에 보낸 테스트 이벤트는
        // 서버가 보관하지 않으므로, 부모 창은 이 신호를 받은 뒤에 자동 발동해야 한다.
        notifyParent('donaido-overlay-ready');
      });

      es.addEventListener('donation', (ev) => {
        try {
          const message = ev as MessageEvent;
          // 서버가 붙인 이벤트 ID. 다음 재연결 때 이 지점부터 다시 받는다.
          if (message.lastEventId) lastEventId.current = message.lastEventId;

          const payload = JSON.parse(message.data) as OverlayPayload;
          if (!payload?.eventId || seen.current.has(payload.eventId)) return;
          seen.current.add(payload.eventId);
          if (seen.current.size > 500) seen.current = new Set();

          // 오버레이 표시를 끈 상태에서 보낸 이벤트(테스트 등)는 방송 화면에 띄우지 않는다.
          // 스튜디오 미리보기는 설정 확인이 목적이므로 그대로 재생한다.
          if (payload.enabled === false && !preview) return;

          // 재연결 직후 되돌려받은 건은 별도로 센다(디버그 배지/미리보기 표시용).
          if (resuming) {
            recovered += 1;
            setLink({ phase: 'connected', recovered });
            notifyParent('donaido-overlay-status', { phase: 'connected', recovered });
          }

          queue.current.push(payload);
          setQueueLen(queue.current.length);
          playNextRef.current();
        } catch (e) {
          console.log('[overlay] 이벤트 파싱 실패', e);
        }
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
        resuming = false;
        // 지수 백오프 (최대 30초). 재연결 상태는 방송 화면에 표시하지 않는다.
        // 첫 재시도는 300ms 로 짧게 잡는다. 순간적인 끊김(모바일 전환·프록시 재시작)은
        // 대부분 바로 복구되는데, 1초를 기다리면 그 사이 [재연결 중] 이 눈에 띄게 뜬다.
        const wait = retry === 0 ? 300 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry);
        retry += 1;

        let remain = Math.round(wait / 1000);
        setLink({ phase: 'retrying', retrySec: remain });
        notifyParent('donaido-overlay-status', { phase: 'retrying', retrySec: remain });
        clearCountdown();
        countdown = setInterval(() => {
          remain = Math.max(0, remain - 1);
          setLink({ phase: 'retrying', retrySec: remain });
          notifyParent('donaido-overlay-status', { phase: 'retrying', retrySec: remain });
        }, 1000);

        console.log(`[overlay] 연결 끊김. ${Math.round(wait / 1000)}초 후 재연결`);
        timer = setTimeout(connect, wait);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearCountdown();
      source?.close();
      if (typeof window !== 'undefined') window.removeEventListener('message', onAsk);
    };
  }, [creatorId, token, preview]);

  // 표시값은 이벤트에 실려 온 현재 설정을 우선 적용한다.
  // (값이 없는 예전 이벤트나 재생 중이 아닐 때는 페이지를 열 때 받은 prop 을 쓴다)
  const align = positionClass[current?.position || position] ?? positionClass.BOTTOM_CENTER;
  const themeName = themeOf(current?.theme || theme);

  /**
   * 스튜디오에서 배치를 드래그하는 동안 실시간으로 받아 보는 임시 값.
   * 저장 전에도 방송 화면과 똑같은 모습으로 확인할 수 있어야 한다.
   * 미리보기에서만 받는다. 방송용(토큰) 경로는 이 메시지를 무시한다.
   */
  const [draftLayout, setDraftLayout] = React.useState<OverlayLayout | null>(null);
  /** 스튜디오가 [배치 조정]을 켠 상태. 켜지면 예시 알림을 계속 띄우고 위치를 보고한다. */
  const [editFrame, setEditFrame] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!preview || typeof window === 'undefined') return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as
        | { type?: string; target?: string; layout?: Partial<OverlayLayout>; on?: boolean; frame?: string }
        | null;
      if (!data || data.target !== 'donation') return;
      if (data.type === 'donaido-overlay-layout') {
        setDraftLayout(data.layout ? clampOverlayLayout(data.layout) : null);
      }
      if (data.type === 'donaido-overlay-edit') {
        setEditFrame(data.on ? String(data.frame ?? '') : null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview]);

  /**
   * 조정 중에는 알림이 실제로 차지하는 자리를 부모에게 계속 알려 준다.
   * 부모는 그 값으로 미리보기 위에 윤곽선과 크기 조절 손잡이를 그린다.
   * 값은 이 화면(iframe) 크기에 대한 비율이라, 부모가 자기 틀 크기에 곱하기만 하면 된다.
   */
  const bannerBoxRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!preview || editFrame === null || typeof window === 'undefined') return;
    let raf = 0;
    const post = () => {
      const el = bannerBoxRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        try {
          window.parent.postMessage(
            {
              type: 'donaido-overlay-rect',
              target: 'donation',
              frame: editFrame,
              creatorId,
              rect: { x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh },
            },
            window.location.origin,
          );
        } catch {
          /* ignore */
        }
      }
      raf = window.requestAnimationFrame(post);
    };
    raf = window.requestAnimationFrame(post);
    return () => window.cancelAnimationFrame(raf);
  }, [preview, editFrame, creatorId]);

  // 재생 중인 알림이 없어도 조정 중에는 예시 알림을 띄워 자리를 잡을 수 있게 한다.
  const shown: OverlayPayload | null = current ?? (editFrame !== null ? LAYOUT_SAMPLE : null);

  // 우선순위: 드래그 중인 임시 값 → 이벤트에 실려 온 값 → 페이지를 열 때 받은 값
  const activeLayout =
    draftLayout ??
    (current && (current.offsetX !== undefined || current.scalePct !== undefined)
      ? clampOverlayLayout({ offsetX: current.offsetX, offsetY: current.offsetY, scalePct: current.scalePct })
      : clampOverlayLayout(layout));

  const standalone = useStandalone();

  // 대기 수·테마는 부모(스튜디오 미리보기)의 상태 배지에서 함께 보여 준다.
  React.useEffect(() => {
    if (!preview || typeof window === 'undefined' || window.parent === window) return;
    try {
      window.parent.postMessage(
        { type: 'donaido-overlay-meta', creatorId, queue: queueLen, theme: themeName },
        window.location.origin,
      );
    } catch {
      /* ignore */
    }
  }, [preview, creatorId, queueLen, themeName]);

  return (
    // h-screen/w-screen 을 쓰지 않는다. 미리보기 고정 캔버스(OverlayCanvas) 안에서는
    // 뷰포트 크기가 아니라 캔버스(1920x1080)를 채워야 하기 때문이다.
    // `fixed inset-0` 만으로 방송용(화면 전체)과 캔버스 모드 양쪽 모두 올바르게 채워진다.
    <div className="pointer-events-none fixed inset-0 bg-transparent">
      {/* 파티클은 배너를 끈 구간에서도 재생된다. 캐릭터 스티커는 배너 위 인라인으로 처리. */}
      {current && !leaving ? <EffectLayer effect={effectOf(current)} theme={themeName} /> : null}

      <div className={`relative z-20 flex h-full w-full p-6 ${align}`}>
        {shown && bannerOf(shown) ? (
          // 배치 미세 조정은 배너(와 그 위 캐릭터)에만 적용한다.
          // 파티클은 화면 전체 연출이라 함께 움직이면 어색하다.
          <div
            ref={bannerBoxRef}
            className="flex flex-col items-center gap-0"
            style={{ transform: overlayLayoutTransform(activeLayout), transformOrigin: 'center' }}
          >
            {/* 캐릭터 스티커: 배너 바로 위에 자연스럽게 붙임 */}
            {current && isCharacterStickerEffect(effectOf(current)) && !leaving ? (
              <CharacterStickerInline effect={effectOf(current)} theme={themeName} />
            ) : null}
            <DonationCard
              payload={shown}
              leaving={Boolean(current) && leaving}
              maxMessageLen={shown.maxMessageLen ?? maxMessageLen}
              theme={themeName}
            />
          </div>
        ) : null}
      </div>

      {/*
        디버그 배지는 단독 창에서만 그린다.
        스튜디오 미리보기(iframe) 안에서는 부모가 같은 값을 툴바에 보여 주므로 중복이고,
        축소 캔버스 안에 그리면 위치가 어긋난다(위 주석 참고).
        body 로 옮겨 그려 축소 캔버스의 transform 밖에 두므로 항상 창의 왼쪽 위에 붙는다.
      */}
      {debug && standalone ? (
        <Portal>
          <span
            className={`fixed left-3 top-3 z-[100] rounded-md px-2 py-1 text-[11px] font-semibold text-white ${
              link.phase === 'connected' ? 'bg-ink-900/80' : 'bg-danger-500/85'
            }`}
          >
            {linkLabel(link)} · 대기 {queueLen} · 테마 {themeName}
            {current?.tierLabel ? ` · ${current.tierLabel}` : ''}
          </span>
        </Portal>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 알림 배너

function DonationCard({
  payload,
  leaving,
  maxMessageLen,
  theme,
}: {
  payload: OverlayPayload;
  leaving: boolean;
  maxMessageLen: number;
  theme: OverlayTheme;
}) {
  const t = THEME_CLASSES[theme];
  const amountText = payload.amount ? `${formatNumber(BigInt(payload.amount))}원` : '';
  const message =
    payload.message.length > maxMessageLen ? `${payload.message.slice(0, maxMessageLen)}...` : payload.message;

  return (
    <div
      className={`relative w-[420px] max-w-full rounded-[18px] border px-5 py-4 ${t.card} ${
        leaving ? 'animate-tornado-out' : 'animate-banner-in'
      }`}
    >
      {payload.isTest ? (
        <span className={`absolute right-3 top-3 rounded-md px-2 py-0.5 text-[10px] font-bold ${t.test}`}>
          테스트
        </span>
      ) : null}

      <div className="flex items-center gap-3">
        <TornadoSwirl className={t.swirl} />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[16px] font-extrabold leading-tight tracking-tight ${t.title}`}>
            {payload.donorName}님이 {amountText ? `${amountText}을 ` : ''}후원하셨습니다
          </p>
          {message ? (
            <p className={`mt-1.5 break-words text-[13px] leading-snug ${t.message}`}>{message}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <ThanksSticker variant={effectOf(payload)} className={t.sticker} />
        <span className={`text-[11px] font-semibold tracking-[0.16em] ${t.footer}`}>DONAIDO</span>
      </div>
    </div>
  );
}

/** 회오리 라인 애니메이션 */
function TornadoSwirl({ className }: { className: string }) {
  return (
    <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${className}`}>
      <svg
        width={30}
        height={30}
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        className="animate-tornado-spin"
        aria-hidden
      >
        <path d="M5 7h22" />
        <path d="M8 12h16" />
        <path d="M11 17h10" />
        <path d="M13.5 22h5" />
        <path d="M15.5 26.5h1.5" />
        <path d="M24 12c0 6-4.5 9.5-8 14.5" opacity="0.45" />
      </svg>
    </span>
  );
}

/** 감사 스티커 (라인 배지) */
function ThanksSticker({ variant, className }: { variant: string; className: string }) {
  const label = variant === 'SIMPLE' ? '고맙습니다' : '감사합니다';
  return (
    <span
      className={`animate-thanks-bounce inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-bold ${className}`}
    >
      <svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 20.5 4.8 13.3a4.4 4.4 0 0 1 6.2-6.2l1 1 1-1a4.4 4.4 0 0 1 6.2 6.2Z" />
        <path d="M8.5 10.5h2" opacity="0.5" />
      </svg>
      {label}
    </span>
  );
}
