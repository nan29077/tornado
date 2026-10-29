/**
 * 오버레이 TTS 시간 계산과 안전장치 (P2-16).
 *
 * 화면 컴포넌트(overlay-client.tsx)에서 시간 계산만 떼어 낸 순수 모듈이다.
 * 브라우저 API 를 직접 부르지 않으므로 테스트에서 가짜 타이머로 그대로 검증할 수 있다.
 */

/**
 * TTS 한 건이 붙들 수 있는 기본 최대 시간.
 * 이 시간이 지나면 읽기가 안 끝나도 다음 알림으로 넘어간다(overlay-client.tsx playNext 주석 참고).
 */
export const TTS_MAX_MS = 20_000;

/**
 * [OV-A] TTS 안전장치의 절대 상한. 느린 속도(0.5배)로 긴 문장을 읽어도 이 시간을 넘지 않는다.
 * 대기열 한 건이 방송을 너무 오래 붙잡지 않도록 40초로 둔다.
 */
export const TTS_GUARD_CAP_MS = 40_000;

/**
 * 서버 합성(클로바) 요청 타임아웃.
 * src/server/services/tts/naver.ts 의 NAVER_TTS_TIMEOUT_MS 와 같아야 한다(테스트가 확인한다).
 * 서버 모듈을 화면 번들로 끌어오지 않으려고 값만 따로 둔다.
 */
export const SERVER_TTS_SYNTH_TIMEOUT_MS = 8000;

/**
 * 합성이 끝난 뒤 mp3 를 내려받아 메타데이터(길이)를 읽기까지의 여유.
 * 터널·느린 회선에서 응답 헤더와 첫 조각이 늦게 오는 경우를 감안한다.
 */
export const SERVER_TTS_LOAD_MARGIN_MS = 4000;

/**
 * [P2-16] 서버 음성이 재생을 시작하기 전(메타데이터를 받기 전)까지 기다리는 시간.
 *
 * 예전에는 new Audio() 를 만든 순간부터 **문장 길이로 잡은 3~6초** 를 셌다. 짧은 문장이면
 * 클로바 합성(최대 8초)이 끝나기도 전에 시간이 다 돼 버렸고, 그 시간 초과를 "성공" 으로 처리해
 * 브라우저 음성으로 되돌아가지도 않았다. OBS 에서는 그대로 무음이었다.
 */
export function serverTtsPreloadTimeoutMs(): number {
  return SERVER_TTS_SYNTH_TIMEOUT_MS + SERVER_TTS_LOAD_MARGIN_MS;
}

/** 서로 다른 기기·환경에서 TTS 종료 신호가 오지 않을 때를 대비한 상한. */
export function ttsGuardMs(text: string, speed?: number): number {
  // 한국어 TTS 는 대략 초당 6~8자. 넉넉히 잡아도 문장 길이의 함수여야 한다.
  const estimated = 2000 + Math.ceil((text?.length ?? 0) / 5) * 1000;
  // [OV-A] 예전에는 속도를 무시하고 15초로 잘랐다. 0.7배 속도의 긴 문장은 읽는 도중 다음 알림으로
  // 넘어가 두 목소리가 겹쳤다. 읽는 시간은 속도에 반비례하므로 속도로 나눈다.
  const rate = Math.min(2, Math.max(0.5, Number(speed) || 1));
  return Math.min(TTS_GUARD_CAP_MS, Math.max(3000, Math.ceil(estimated / rate)));
}

/** [OV-A] 실제 길이를 알면 그 길이 + 여유로 안전장치를 건다(추정보다 정확하다). */
export function playbackGuardFromDuration(durationSec: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  return Math.min(TTS_GUARD_CAP_MS, Math.ceil(durationSec * 1000) + 1500);
}

/**
 * 알림 한 건이 TTS 를 기다리는 바깥 상한.
 *
 * 서버 음성은 [합성 대기] 뒤에 [재생] 이 오고, 대기 시간이 다 되면 브라우저 음성이 이어서 읽는다.
 * 바깥 상한이 그보다 짧으면 브라우저 음성이 읽는 도중 다음 알림으로 넘어가 두 목소리가 겹친다.
 */
export function ttsOuterLimitMs(text: string | undefined, speed: number | undefined, serverMode: boolean): number {
  if (!text) return TTS_MAX_MS;
  const speaking = ttsGuardMs(text, speed) + 1000;
  return Math.max(TTS_MAX_MS, serverMode ? serverTtsPreloadTimeoutMs() + speaking : speaking);
}

export interface TtsTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: TtsTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ServerTtsGuard {
  /** audio.onloadedmetadata 에서 부른다. 길이를 알면 그 길이로 안전장치를 다시 건다. */
  onMetadata: (durationSec: number) => void;
  /** audio.onplaying 에서 부른다. 길이를 아직 모르면 문장 길이 추정으로 안전장치를 건다. */
  onPlaying: () => void;
  /** 재생이 끝났거나 실패해 더는 필요 없을 때 */
  cancel: () => void;
}

/**
 * [P2-16] 서버 음성 안전장치.
 *
 * 두 단계로 나눈다.
 *  1) 재생 전(합성·다운로드 대기): serverTtsPreloadTimeoutMs. 시간이 다 되면 **실패(ok=false)** 로
 *     끝내 호출부가 브라우저 음성으로 되돌아가게 한다.
 *  2) 재생 중: 메타데이터(실제 길이) 또는 재생 시작 시점부터 길이 기반 상한을 센다.
 *     이미 소리가 나고 있었으므로 시간이 다 되면 **성공(ok=true)** 으로 끝낸다(두 번 읽지 않는다).
 *
 * onTimeout 은 한 번만 불린다.
 */
export function createServerTtsGuard(
  text: string,
  speed: number | undefined,
  onTimeout: (ok: boolean) => void,
  timers: TtsTimers = defaultTimers,
): ServerTtsGuard {
  let done = false;
  let playbackArmed = false;
  const fire = (ok: boolean) => {
    if (done) return;
    done = true;
    onTimeout(ok);
  };
  let handle: unknown = timers.set(() => fire(false), serverTtsPreloadTimeoutMs());

  const arm = (ms: number) => {
    timers.clear(handle);
    playbackArmed = true;
    handle = timers.set(() => fire(true), ms);
  };

  return {
    onMetadata(durationSec) {
      if (done) return;
      const ms = playbackGuardFromDuration(durationSec);
      if (ms != null) arm(ms);
    },
    onPlaying() {
      if (done || playbackArmed) return;
      arm(ttsGuardMs(text, speed));
    },
    cancel() {
      done = true;
      timers.clear(handle);
    },
  };
}
