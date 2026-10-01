/**
 * 오버레이 효과음.
 *
 * 규칙
 *  - 외부 음원 파일을 쓰지 않는다. Web Audio API 로 그때그때 합성한다.
 *    (OBS 브라우저 소스는 캐시가 비어 있는 상태로 자주 다시 열리므로 파일 의존을 만들지 않는다)
 *  - 효과음 실패가 알림 재생을 막지 않는다. 모든 예외는 조용히 무시한다.
 *  - 모르는 효과 이름은 기본 벨소리로 재생한다(효과가 추가돼도 소리가 사라지지 않는다).
 *  - 효과 목록(overlay-effect-catalog.ts)은 스티커 쪽에서 관리한다. 여기서는 값만 받아 소리를 고른다.
 */

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const Ctx: Ctor | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    // 자동재생 정책으로 정지돼 있으면 깨운다(OBS 브라우저 소스는 보통 바로 허용된다).
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** 0~100 음량을 실제 게인으로 바꾼다. 방송 음성(TTS)을 덮지 않도록 상한을 둔다. */
function gainOf(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 80;
  return (v / 100) * 0.35;
}

/** 사인/삼각파 한 음. 짧게 울리고 사라진다. */
function tone(
  audio: AudioContext,
  opts: { freq: number; start: number; duration: number; peak: number; type?: OscillatorType; endFreq?: number },
) {
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, opts.start);
  if (opts.endFreq) osc.frequency.exponentialRampToValueAtTime(opts.endFreq, opts.start + opts.duration);

  amp.gain.setValueAtTime(0.0001, opts.start);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.peak), opts.start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.duration);

  osc.connect(amp).connect(audio.destination);
  osc.start(opts.start);
  osc.stop(opts.start + opts.duration + 0.05);
}

/** 화이트 노이즈 버스트(폭죽). 저역 통과 필터를 닫으며 흩어지는 소리를 만든다. */
function noiseBurst(audio: AudioContext, start: number, duration: number, peak: number) {
  const frames = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, Math.max(1, frames), audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // 뒤로 갈수록 잦아드는 노이즈
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }

  const src = audio.createBufferSource();
  src.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(6000, start);
  filter.frequency.exponentialRampToValueAtTime(400, start + duration);

  const amp = audio.createGain();
  amp.gain.setValueAtTime(peak, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  src.connect(filter).connect(amp).connect(audio.destination);
  src.start(start);
  src.stop(start + duration + 0.05);
}

/** 여러 음을 순서대로 울린다(아르페지오·리프 공용). */
function sequence(
  audio: AudioContext,
  start: number,
  notes: number[],
  opts: { step: number; duration: number; peak: number; type?: OscillatorType },
) {
  notes.forEach((freq, i) => {
    tone(audio, {
      freq,
      start: start + i * opts.step,
      duration: opts.duration,
      peak: opts.peak,
      type: opts.type,
    });
  });
}

/**
 * 도네이도 캐릭터 스티커 효과음.
 * 스티커 종류마다 분위기를 다르게 준다. 목록에 없으면 null 을 돌려주고 기본 벨소리로 재생된다.
 */
function playCharacterSound(audio: AudioContext, name: string, t: number, peak: number): boolean {
  switch (name) {
    case 'DONAIDO_CHEER':
      // 응원: 밝게 올라가는 세 음 + 응원봉을 흔드는 듯한 짧은 노이즈
      sequence(audio, t, [587.33, 739.99, 987.77], { step: 0.08, duration: 0.24, peak, type: 'triangle' });
      noiseBurst(audio, t + 0.05, 0.18, peak * 0.35);
      noiseBurst(audio, t + 0.22, 0.16, peak * 0.28);
      return true;

    case 'DONAIDO_HEART_HUG':
      // 하트 포옹: 부드러운 벨 뒤에 두근거리는 저음 두 번
      tone(audio, { freq: 659.25, start: t, duration: 0.7, peak: peak * 0.85 });
      tone(audio, { freq: 146.83, start: t + 0.22, duration: 0.18, peak: peak * 0.7, type: 'sine' });
      tone(audio, { freq: 146.83, start: t + 0.46, duration: 0.22, peak: peak * 0.55, type: 'sine' });
      return true;

    case 'DONAIDO_GIFT_POP':
      // 선물 팡: 짧게 터지는 팝 소리 + 반짝이는 고음
      tone(audio, { freq: 180, start: t, duration: 0.1, peak, endFreq: 760, type: 'triangle' });
      noiseBurst(audio, t + 0.06, 0.22, peak * 0.8);
      sequence(audio, t + 0.2, [1174.66, 1567.98], { step: 0.07, duration: 0.2, peak: peak * 0.6 });
      return true;

    case 'DONAIDO_MIC_DANCE':
      // 마이크 댄스: 통통 튀는 짧은 리프
      sequence(audio, t, [523.25, 622.25, 783.99, 622.25], {
        step: 0.11,
        duration: 0.13,
        peak: peak * 0.9,
        type: 'triangle',
      });
      return true;

    case 'DONAIDO_THANKS_BOW':
      // 감사 인사: 차분하게 내려오는 두 음
      tone(audio, { freq: 783.99, start: t, duration: 0.5, peak: peak * 0.9 });
      tone(audio, { freq: 523.25, start: t + 0.26, duration: 0.8, peak: peak * 0.8 });
      return true;

    case 'DONAIDO_COIN_CLOUD':
      // 코인 구름: 동전이 찰랑이는 높은 두 음 + 구름처럼 부드러운 여운
      sequence(audio, t, [1318.51, 1760.0, 1318.51, 2093.0], { step: 0.07, duration: 0.18, peak: peak * 0.7 });
      tone(audio, { freq: 392.0, start: t + 0.1, duration: 0.8, peak: peak * 0.45, type: 'sine' });
      return true;

    case 'DONAIDO_HEART_PEEK':
      // 하트 메시지: 빼꼼 올라오는 글리산도 + 두근 한 번
      tone(audio, { freq: 330, start: t, duration: 0.28, peak: peak * 0.8, endFreq: 880, type: 'triangle' });
      tone(audio, { freq: 146.83, start: t + 0.34, duration: 0.2, peak: peak * 0.6, type: 'sine' });
      tone(audio, { freq: 987.77, start: t + 0.36, duration: 0.5, peak: peak * 0.6 });
      return true;

    case 'DONAIDO_LETTER_FLY':
      // 편지 배달: 휙 날아오는 바람 소리 + 도착 알림 두 음
      noiseBurst(audio, t, 0.32, peak * 0.45);
      sequence(audio, t + 0.28, [880.0, 1174.66], { step: 0.12, duration: 0.3, peak: peak * 0.85 });
      return true;

    case 'DONAIDO_FRIENDS':
      // 친구들 총출동: 세 친구가 차례로 튀어나오는 팝 세 번 + 화음
      [0, 0.18, 0.36].forEach((d, i) =>
        tone(audio, { freq: 200 + i * 60, start: t + d, duration: 0.09, peak: peak * 0.8, endFreq: 700 + i * 120, type: 'triangle' }),
      );
      sequence(audio, t + 0.5, [523.25, 659.25, 783.99], { step: 0.05, duration: 0.5, peak: peak * 0.6 });
      return true;

    case 'DONAIDO_PARADE':
      // 퍼레이드: 행진하듯 경쾌한 리듬
      sequence(audio, t, [392.0, 523.25, 392.0, 659.25, 523.25, 783.99], {
        step: 0.12,
        duration: 0.12,
        peak: peak * 0.85,
        type: 'triangle',
      });
      noiseBurst(audio, t, 0.06, peak * 0.3);
      noiseBurst(audio, t + 0.24, 0.06, peak * 0.3);
      noiseBurst(audio, t + 0.48, 0.06, peak * 0.3);
      return true;

    default:
      return false;
  }
}

/**
 * 효과에 맞는 효과음을 재생한다.
 * @param effect NONE | HEART | STAR | COIN | FIREWORK | CONFETTI | DONAIDO_* | 그 외(기본 벨소리)
 * @param volume 0~100
 */
export function playEffectSound(effect: string, volume: number): void {
  const name = (effect || 'DEFAULT').toUpperCase();
  if (name === 'NONE') return;

  const audio = getContext();
  if (!audio) return;
  const peak = gainOf(volume);
  if (peak <= 0) return;

  try {
    const t = audio.currentTime + 0.02;

    // 도네이도 캐릭터 스티커는 스티커별 전용 소리를 쓴다.
    if (name.startsWith('DONAIDO_') && playCharacterSound(audio, name, t, peak)) return;

    if (name === 'COIN') {
      // 코인: 고음 사인파 두 음 + 급격한 페이드아웃
      tone(audio, { freq: 1046.5, start: t, duration: 0.08, peak });
      tone(audio, { freq: 1568, start: t + 0.07, duration: 0.22, peak });
      return;
    }

    if (name === 'FIREWORK') {
      // 폭죽: 짧은 발사음 뒤 노이즈 버스트
      tone(audio, { freq: 320, start: t, duration: 0.16, peak: peak * 0.5, endFreq: 900, type: 'triangle' });
      noiseBurst(audio, t + 0.18, 0.7, peak);
      noiseBurst(audio, t + 0.42, 0.5, peak * 0.6);
      return;
    }

    if (name === 'CONFETTI') {
      // 환호: 상승하는 아르페지오 (도-미-솔-도)
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        tone(audio, { freq, start: t + i * 0.09, duration: 0.26, peak: peak * 0.9, type: 'triangle' });
      });
      return;
    }

    // 기본 / 하트 / 별 · 그 밖의 효과: 부드러운 벨소리
    tone(audio, { freq: 440, start: t, duration: 0.9, peak });
    tone(audio, { freq: 880, start: t + 0.02, duration: 0.7, peak: peak * 0.45 });
  } catch {
    /* 효과음 실패는 무시한다 */
  }
}
