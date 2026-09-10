'use client';

import * as React from 'react';
import Image from 'next/image';
import {
  findCharacterSticker,
  type OverlayEffectValue,
} from '@/lib/overlay-effect-catalog';
import {
  EFFECT_LEVELS,
  effectLevelOf,
  particleCountFor,
  type MascotSize,
  type OverlayEffectLevel,
} from '@/lib/overlay-effect-level';

/**
 * 오버레이 파티클 효과 레이어.
 *
 * 규칙
 *  - 서버 모듈을 import 하지 않는다(브라우저 소스 전용 번들).
 *  - 배치는 인덱스 기반 결정적 계산만 쓴다. Math.random 을 쓰면 hydration 이 어긋난다.
 *    (아래 캔버스 폭발 효과는 예외다 — 그리기가 useEffect 안에서만 일어나므로
 *     서버 렌더 결과와 비교되는 DOM 이 없다)
 *  - 전체 화면을 덮되 클릭을 막지 않는다(pointer-events-none).
 *  - 효과 종류는 서버의 OVERLAY_EFFECTS 와 값이 일치해야 한다.
 *    DEFAULT 는 구간 기능을 쓰지 않는 기존 크리에이터용 값으로, 하트/별을 섞어 뿌린다.
 */

export type EffectName = OverlayEffectValue | 'DEFAULT';

/** 결정적 의사난수. 같은 인덱스는 항상 같은 값을 준다. */
function rand(i: number, salt: number) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function EffectLayer({ effect, theme = 'TORNADO' }: { effect: string; theme?: string }) {
  const name = (effect || 'DEFAULT').toUpperCase() as EffectName;
  if (name === 'NONE') return null;

  const characterSticker = findCharacterSticker(name);

  // 테마별 파티클 보정.
  //  - MINIMAL: 효과를 절제한다(반투명).
  //  - NEON: 형광 글로우를 더한다. 컨테이너에 filter 를 걸어 자식 absolute 배치 기준은 그대로 둔다.
  const themeClass =
    theme === 'MINIMAL'
      ? 'opacity-50'
      : theme === 'NEON'
        ? '[filter:drop-shadow(0_0_8px_rgba(34,211,238,0.55))]'
        : '';

  // 캐릭터 스티커는 배너 바로 위에 인라인으로 붙인다(CharacterStickerInline).
  // EffectLayer 에서는 파티클 계열 효과만 담당한다.
  if (characterSticker) return null;

  return (
    <div aria-hidden className={`pointer-events-none fixed inset-0 overflow-hidden ${themeClass}`}>
      {name === 'CONFETTI' ? <Confetti /> : null}
      {name === 'FIREWORK' ? <Fireworks /> : null}
      {name === 'HEART' || name === 'STAR' || name === 'COIN' || name === 'DEFAULT' ? (
        <RisingParticles kind={name} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ 떠오르는 파티클

function RisingParticles({ kind }: { kind: EffectName }) {
  const items = React.useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        left: rand(i, 1) * 96 + 2,
        delay: rand(i, 2) * 2.4,
        duration: 2.2 + rand(i, 3) * 1.8,
        size: 20 + Math.round(rand(i, 4) * 26),
        drift: (rand(i, 5) - 0.5) * 180,
        rise: 45 + Math.round(rand(i, 6) * 45),
        spin: Math.round((rand(i, 7) - 0.5) * 160),
        // DEFAULT 는 하트와 별을 섞는다
        shape: kind === 'DEFAULT' ? (i % 2 === 0 ? 'HEART' : 'STAR') : kind,
      })),
    [kind],
  );

  return (
    <>
      {items.map((p, i) => (
        <span
          key={i}
          className="animate-particle-rise absolute bottom-0"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            ['--drift' as string]: `${p.drift}px`,
            // vh 를 쓰면 미리보기 캔버스(축소 렌더링) 안에서 실제 화면 높이를 기준으로 계산돼
            // 파티클이 거의 움직이지 않는다. 오버레이 기준 높이(--ovh)를 쓴다.
            ['--rise' as string]: `calc(var(--ovh, 100vh) * ${(p.rise / 100).toFixed(3)})`,
            ['--spin' as string]: `${p.spin}deg`,
          }}
        >
          <ParticleShape kind={p.shape as EffectName} size={p.size} index={i} />
        </span>
      ))}
    </>
  );
}

const HEART_COLORS = ['#f4506b', '#ff7d97', '#e23a58'];
const STAR_COLORS = ['#fbb914', '#ffd35c', '#f59e0b'];
const COIN_COLORS = ['#eda600', '#ffcc4d', '#c98a00'];

function ParticleShape({ kind, size, index }: { kind: EffectName; size: number; index: number }) {
  if (kind === 'HEART') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={HEART_COLORS[index % HEART_COLORS.length]}>
        <path d="M12 20.5 4.8 13.3a4.4 4.4 0 0 1 6.2-6.2l1 1 1-1a4.4 4.4 0 0 1 6.2 6.2Z" />
      </svg>
    );
  }
  if (kind === 'COIN') {
    const color = COIN_COLORS[index % COIN_COLORS.length];
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill={color} />
        <circle cx="12" cy="12" r="6.2" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.4" />
        <path d="M12 8v8M9.6 10h4.8M9.6 14h4.8" stroke="rgba(255,255,255,0.85)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={STAR_COLORS[index % STAR_COLORS.length]}>
      <path d="M12 2.5l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L12 16.2 6.4 19.5l1.4-6.2L3 9l6.4-.6z" />
    </svg>
  );
}

// ------------------------------------------------------------------- 꽃가루

const CONFETTI_COLORS = ['#f4506b', '#fbb914', '#4ba3f2', '#5ecf8b', '#a06bf0', '#ff8f4d'];

function Confetti() {
  const items = React.useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => ({
        left: rand(i, 11) * 100,
        delay: rand(i, 12) * 3,
        duration: 2.6 + rand(i, 13) * 2.2,
        w: 7 + Math.round(rand(i, 14) * 7),
        h: 11 + Math.round(rand(i, 15) * 10),
        drift: (rand(i, 16) - 0.5) * 260,
        spin: 360 + Math.round(rand(i, 17) * 1080),
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        round: i % 4 === 0,
      })),
    [],
  );

  return (
    <>
      {items.map((c, i) => (
        <span
          key={i}
          className="animate-confetti-fall absolute top-0 block"
          style={{
            left: `${c.left}%`,
            width: c.w,
            height: c.h,
            background: c.color,
            borderRadius: c.round ? '999px' : '2px',
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.duration}s`,
            ['--drift' as string]: `${c.drift}px`,
            ['--spin' as string]: `${c.spin}deg`,
          }}
        />
      ))}
    </>
  );
}

// -------------------------------------------------------------------- 폭죽

const FIREWORK_COLORS = ['#fbb914', '#f4506b', '#4ba3f2', '#5ecf8b', '#a06bf0'];

/** 터지는 지점 5곳. 화면 상단~중단에 흩어 놓는다. */
const BURSTS = [
  { x: 22, y: 26, delay: 0 },
  { x: 50, y: 18, delay: 0.45 },
  { x: 78, y: 30, delay: 0.9 },
  { x: 34, y: 46, delay: 1.3 },
  { x: 68, y: 50, delay: 1.75 },
];

const RAYS = 18;

function Fireworks() {
  return (
    <>
      {BURSTS.map((b, bi) => (
        <span
          key={bi}
          className="absolute block"
          style={{ left: `${b.x}%`, top: `${b.y}%`, width: 0, height: 0 }}
        >
          {Array.from({ length: RAYS }, (_, i) => {
            const angle = (i / RAYS) * Math.PI * 2;
            const radius = 90 + rand(bi * RAYS + i, 21) * 90;
            const size = 6 + Math.round(rand(bi * RAYS + i, 22) * 6);
            return (
              <span
                key={i}
                className="animate-firework-burst absolute block"
                style={{
                  width: size,
                  height: size,
                  borderRadius: '999px',
                  background: FIREWORK_COLORS[(bi + i) % FIREWORK_COLORS.length],
                  boxShadow: `0 0 ${size * 2}px ${FIREWORK_COLORS[(bi + i) % FIREWORK_COLORS.length]}`,
                  animationDelay: `${b.delay + rand(i, 23) * 0.12}s`,
                  ['--dx' as string]: `${Math.cos(angle) * radius}px`,
                  ['--dy' as string]: `${Math.sin(angle) * radius}px`,
                }}
              />
            );
          })}
        </span>
      ))}
    </>
  );
}

// -------------------------------------------------- 캐릭터 스티커 인라인 (배너 위에)

/** 캐릭터 스티커 효과인지 여부 확인. */
export function isCharacterStickerEffect(effect: string): boolean {
  const name = (effect || 'DEFAULT').toUpperCase();
  return Boolean(findCharacterSticker(name));
}

/**
 * 캐릭터 스티커를 배너 바로 위에 인라인으로 렌더링한다.
 * fixed 레이어가 아니므로 배너와 자연스럽게 붙는다.
 */
export function CharacterStickerInline({
  effect,
  theme = 'TORNADO',
  /**
   * 배치 방식.
   *  - 'stack' : 배너 **위**에 크게 (카드형에서 쓰던 방식)
   *  - 'side'  : 글자 **왼쪽**에 나란히 (배경 없는 큰 글씨에서 쓴다)
   *
   * 배경이 없는 알림에서는 캐릭터를 글자 위에 크게 얹으면 세로로 너무 길어져
   * 방송 화면을 위아래로 가로지른다. 투네이션이 뱃지를 첫 줄 왼쪽에 두는 것과 같은 이유다.
   */
  placement = 'stack',
}: {
  effect: string;
  theme?: string;
  placement?: 'stack' | 'side';
}) {
  const name = (effect || 'DEFAULT').toUpperCase() as EffectName;
  const characterSticker = findCharacterSticker(name);
  if (!characterSticker) return null;

  const themeClass =
    theme === 'MINIMAL'
      ? 'opacity-50'
      : theme === 'NEON'
        ? '[filter:drop-shadow(0_0_8px_rgba(34,211,238,0.55))]'
        : '';

  return (
    <div
      aria-hidden
      // 1920 기준 고정 크기. 예전에는 clamp(100px,18vw,260px) 이었는데, 화면이 좁아질수록
      // 상대적으로 커져(322px 틀에서 화면의 31%) 위쪽이 잘렸다. 1920 에서는 clamp 결과가
      // 260px 이므로 방송 화면의 크기는 그대로다.
      // 옆에 붙일 때는 글자 두세 줄 높이에 맞춰 200px 로 줄인다.
      className={`${placement === 'side' ? 'w-[200px] shrink-0' : 'w-[260px]'} drop-shadow-[0_20px_28px_rgba(15,10,0,0.24)] ${characterSticker.animationClass} ${themeClass}`}
    >
      <Image
        src={characterSticker.image}
        alt=""
        width={640}
        height={640}
        priority
        unoptimized
        className="h-auto w-full select-none object-contain"
      />
    </div>
  );
}

// ==========================================================================
//  금액별 차등 효과 (레벨 1~4)
//  - 파티클 폭발 : Canvas 2D. 알림이 시작될 때 한 번 터지고 스스로 멈춘다.
//  - 캐릭터 등장 : SVG 라인 아트. 레벨 2 이상에서만 나온다.
//  - 화면 테두리 : 레벨 4 에서만 방송 화면 가장자리가 빛난다.
//  이 세 가지는 기존 EffectLayer(떠오르는 파티클 · 꽃가루 · 폭죽)와 **함께** 재생된다.
//  기존 효과는 크리에이터가 고른 "종류"이고, 여기 있는 것은 금액이 정하는 "세기"다.
// ==========================================================================

/** 파티클 한 알. 캔버스 안에서만 존재한다. */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  spin: number;
  life: number;
  age: number;
  color: string;
  shape: 'CIRCLE' | 'STAR' | 'HEART';
  /** 터지기까지의 지연(초). 폭죽 2차 폭발에 쓴다. */
  delay: number;
}

const SHAPE_POOL: readonly Particle['shape'][] = ['CIRCLE', 'STAR', 'HEART'];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 캔버스에 도형 하나를 그린다. 좌표계는 이미 이동·회전된 상태다. */
function paintShape(ctx: CanvasRenderingContext2D, shape: Particle['shape'], size: number) {
  const s = size;
  if (shape === 'CIRCLE') {
    ctx.beginPath();
    ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (shape === 'HEART') {
    // 24x24 뷰박스 기준 하트를 size 에 맞춰 그린다(EffectLayer 의 SVG 와 같은 모양).
    const k = s / 24;
    ctx.beginPath();
    ctx.moveTo(0, 8.5 * k);
    ctx.bezierCurveTo(-8 * k, -1.5 * k, -3 * k, -9 * k, 0, -3 * k);
    ctx.bezierCurveTo(3 * k, -9 * k, 8 * k, -1.5 * k, 0, 8.5 * k);
    ctx.closePath();
    ctx.fill();
    return;
  }
  // 별 (5각)
  const outer = s / 2;
  const inner = outer * 0.44;
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * 파티클 폭발 (Canvas 2D).
 *
 * 왜 캔버스인가
 *  - DOM 파티클은 30개만 넘어가도 OBS 브라우저 소스에서 레이아웃 비용이 눈에 띄게 커진다.
 *    (기존 떠오르는 파티클은 26개 고정이라 버티지만, 콤보 증폭까지 붙으면 100개를 넘는다)
 *  - 캔버스는 한 장이라 합성 비용이 일정하다.
 *
 * 수명
 *  - 마운트할 때 한 번 터지고, 모든 알갱이가 죽으면 rAF 를 스스로 멈춘다.
 *  - 알림마다 key 를 바꿔 다시 마운트하는 방식이라 "자동 제거"가 구조적으로 보장된다.
 */
export function ParticleBurst({
  level,
  multiplier = 1,
}: {
  level: OverlayEffectLevel;
  /** 콤보 증폭 배율 */
  multiplier?: number;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 움직임을 줄여 달라는 환경에서는 아예 그리지 않는다.
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    // 오버레이는 항상 1920x1080 캔버스 위에 그려진다. 아직 레이아웃 전이면 그 값을 쓴다.
    const w = canvas.clientWidth || 1920;
    const h = canvas.clientHeight || 1080;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const spec = EFFECT_LEVELS[level];
    const count = particleCountFor(level, multiplier);
    const particles: Particle[] = [];

    /** 한 점에서 사방으로 터뜨린다. */
    const burst = (ox: number, oy: number, n: number, delay: number, power: number) => {
      for (let i = 0; i < n; i += 1) {
        const angle = (i / n) * Math.PI * 2 + between(-0.18, 0.18);
        const speed = between(240, 640) * power;
        particles.push({
          x: ox,
          y: oy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - between(40, 180),
          size: between(14, 30),
          rot: between(0, Math.PI * 2),
          spin: between(-4, 4),
          life: between(1.5, 2.7),
          age: 0,
          color: pick(spec.colors),
          shape: spec.shape === 'MIXED' ? pick(SHAPE_POOL) : spec.shape,
          delay,
        });
      }
    };

    // 1차 폭발은 화면 가운데보다 조금 위에서. 알림 배너(보통 아래쪽)를 덮지 않는다.
    burst(w / 2, h * 0.42, count, 0, 1);

    // 레벨 4 는 폭죽처럼 2차 폭발이 이어진다.
    if (spec.firework) {
      const secondary = Math.max(8, Math.round(count * 0.45));
      burst(w * 0.24, h * 0.3, secondary, 0.42, 0.85);
      burst(w * 0.76, h * 0.34, secondary, 0.78, 0.85);
    }

    const GRAVITY = 620;
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      // 첫 RAF의 시각은 effect에서 읽은 performance.now()보다 앞설 수 있다.
      // 음수 시간이 입자 크기로 전파되면 arc()가 예외를 던져 재생이 멈춘다.
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      ctx.clearRect(0, 0, w, h);

      let alive = 0;
      for (const p of particles) {
        if (p.delay > 0) {
          p.delay -= dt;
          alive += 1;
          continue;
        }
        p.age += dt;
        if (p.age >= p.life) continue;
        alive += 1;

        // 공기 저항 — 터진 직후 빠르게 퍼지고 곧 느려진다.
        const drag = Math.pow(0.28, dt);
        p.vx *= drag;
        p.vy = p.vy * drag + GRAVITY * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;

        const t = p.age / p.life;
        // 처음 12% 동안 커지며 나타나고, 끝 35% 동안 사라진다.
        const grow = t < 0.12 ? t / 0.12 : 1;
        const fade = t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, fade));
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        // 레벨 4 는 알갱이마다 빛무리를 준다. 낮은 레벨에 주면 화면이 탁해진다.
        if (spec.screenGlow) {
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 18;
        }
        paintShape(ctx, p.shape, p.size * grow);
        ctx.restore();
      }

      if (alive > 0) raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, w, h);
    };
  }, [level, multiplier]);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}

// ------------------------------------------------------------------ 캐릭터

/** 캐릭터 크기(1920 기준 px). 금액 구간이 올라갈수록 커진다. */
const MASCOT_WIDTH: Record<Exclude<MascotSize, 'none'>, number> = {
  small: 200,
  large: 290,
  huge: 380,
};

/**
 * 도네이도 마스코트 등장 효과 (SVG 라인 아트).
 *
 * 이모지를 쓰지 않는다는 규칙에 따라 도형을 직접 그린다. 회오리 몸통 + 얼굴 + 흔드는 손이며,
 * 색은 브랜드 꿀색을 쓰되 테마에 따라 보정한다. 화면 왼쪽 아래에서 튀어올라 손을 흔들다가
 * 알림이 끝날 때(TTS 종료 후) 아래로 내려가며 사라진다.
 */
export function MascotEntrance({
  level,
  multiplier = 1,
  theme = 'TORNADO',
  leaving = false,
}: {
  level: OverlayEffectLevel;
  multiplier?: number;
  theme?: string;
  leaving?: boolean;
}) {
  const spec = EFFECT_LEVELS[level];
  if (spec.mascot === 'none') return null;

  // 콤보가 쌓이면 조금 더 커진다. 무제한으로 키우면 화면을 가리므로 1.3배에서 멈춘다.
  const boost = Math.min(1.3, 1 + (Math.max(1, multiplier) - 1) * 0.15);
  const width = Math.round(MASCOT_WIDTH[spec.mascot] * boost);

  const stroke = theme === 'NEON' ? '#06121f' : '#17161a';
  const body = theme === 'MINIMAL' ? '#e7e7ea' : theme === 'NEON' ? '#22d3ee' : '#ffc632';
  const bodyDark = theme === 'MINIMAL' ? '#b9b9c2' : theme === 'NEON' ? '#0ea5b7' : '#eda600';
  const glow =
    theme === 'NEON'
      ? 'drop-shadow-[0_0_18px_rgba(34,211,238,0.65)]'
      : 'drop-shadow-[0_18px_26px_rgba(15,10,0,0.35)]';

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute bottom-0 left-[6%] ${
        leaving ? 'animate-mascot-exit' : 'animate-mascot-enter'
      } ${glow}`}
      style={{ width }}
    >
      <svg viewBox="0 0 200 240" width={width} height={Math.round((width * 240) / 200)} fill="none">
        <g className={leaving ? undefined : 'animate-mascot-sway'}>
          {/* 회오리 몸통 */}
          <path
            d="M56 214c-6-34 2-64 14-92 9-21 12-40 6-58"
            stroke={bodyDark}
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.5}
          />
          <path
            d="M100 44c30 0 50 10 50 20s-20 18-50 18-50-8-50-18 20-20 50-20Z"
            fill={body}
            stroke={stroke}
            strokeWidth={5}
            strokeLinejoin="round"
          />
          <path
            d="M60 86c0 9 18 16 40 16s40-7 40-16"
            fill={body}
            stroke={stroke}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <path
            d="M60 86v14c0 10 18 17 40 17s40-7 40-17V86"
            fill={body}
            stroke={stroke}
            strokeWidth={5}
            strokeLinejoin="round"
          />
          <path
            d="M70 118v18c0 8 13 14 30 14s30-6 30-14v-18"
            fill={body}
            stroke={stroke}
            strokeWidth={5}
            strokeLinejoin="round"
          />
          <path
            d="M82 150v20c0 6 8 11 18 11s18-5 18-11v-20"
            fill={body}
            stroke={stroke}
            strokeWidth={5}
            strokeLinejoin="round"
          />
          <path
            d="M92 181v18c0 4 4 7 8 7s8-3 8-7v-18"
            fill={bodyDark}
            stroke={stroke}
            strokeWidth={5}
            strokeLinejoin="round"
          />

          {/* 얼굴 */}
          <circle cx={86} cy={64} r={4.2} fill={stroke} />
          <circle cx={116} cy={64} r={4.2} fill={stroke} />
          <path d="M92 74c4 4 12 4 16 0" stroke={stroke} strokeWidth={4} strokeLinecap="round" />
          <circle cx={72} cy={73} r={5} fill="#f4506b" opacity={0.35} />
          <circle cx={130} cy={73} r={5} fill="#f4506b" opacity={0.35} />

          {/* 흔드는 손 (팔 그룹에만 회전을 건다) */}
          <g className={leaving ? undefined : 'animate-mascot-wave'} style={{ transformOrigin: '150px 96px' }}>
            <path
              d="M144 96c12-6 22-16 26-28"
              stroke={stroke}
              strokeWidth={5}
              strokeLinecap="round"
            />
            <path
              d="M170 68c5-3 10-1 10 4 0 6-5 12-11 13-5 1-9-2-8-7 1-4 5-8 9-10Z"
              fill={body}
              stroke={stroke}
              strokeWidth={4.5}
              strokeLinejoin="round"
            />
          </g>

          {/* 반대쪽 팔 */}
          <path d="M58 100c-9 4-15 12-17 22" stroke={stroke} strokeWidth={5} strokeLinecap="round" />
          <circle cx={39} cy={126} r={8} fill={body} stroke={stroke} strokeWidth={4.5} />
        </g>
      </svg>
    </div>
  );
}

// -------------------------------------------------- 화면 테두리 빛나기 (레벨 4)

/**
 * 최고 구간에서만 방송 화면 가장자리가 빛난다.
 * 바깥으로 그림자를 주면 OBS 브라우저 소스 밖으로 나가 잘리므로 안쪽(inset)으로 준다.
 */
export function ScreenGlow({ level, theme = 'TORNADO' }: { level: OverlayEffectLevel; theme?: string }) {
  if (!EFFECT_LEVELS[level].screenGlow) return null;
  const color = theme === 'NEON' ? '34,211,238' : theme === 'MINIMAL' ? '255,255,255' : '255,198,50';
  return (
    <div
      aria-hidden
      className="animate-screen-glow pointer-events-none absolute inset-0"
      style={{
        boxShadow: `inset 0 0 120px 24px rgba(${color},0.55), inset 0 0 320px 60px rgba(${color},0.22)`,
      }}
    />
  );
}

// ------------------------------------------------------------ 효과 무대 통합

/**
 * 금액별 차등 효과를 한 겹에 모아 그린다.
 *
 * 알림마다 `key={eventId}` 로 다시 마운트하면 파티클이 새로 터지고,
 * 알림이 사라질 때(leaving) 캐릭터가 퇴장 애니메이션을 재생한다.
 */
export function LevelEffectStage({
  level,
  multiplier = 1,
  theme = 'TORNADO',
  leaving = false,
  /** 캐릭터 스티커 효과를 이미 쓰고 있으면 SVG 마스코트는 겹치지 않게 뺀다. */
  withMascot = true,
}: {
  level: number;
  multiplier?: number;
  theme?: string;
  leaving?: boolean;
  withMascot?: boolean;
}) {
  const lv = effectLevelOf(level);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <ScreenGlow level={lv} theme={theme} />
      <ParticleBurst level={lv} multiplier={multiplier} />
      {withMascot ? (
        <MascotEntrance level={lv} multiplier={multiplier} theme={theme} leaving={leaving} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 타이핑

/**
 * 타이핑 효과용 글자 수 카운터.
 *
 * 왜 CSS 가 아닌가
 *  - 한글은 글자 폭이 제각각이라 `steps()` + `width` 방식은 줄이 흔들리고,
 *    두 줄 이상이면 아예 동작하지 않는다.
 *  - rAF 로 "지금까지 몇 글자" 만 세고, 렌더는 문자열을 잘라 쓴다.
 *
 * @param total 전체 글자 수
 * @param active 타이핑 효과를 쓸 때만 true. false 면 즉시 전체를 보여 준다.
 * @param cps 초당 글자 수
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * 움직임 최소화 설정 여부.
 * 서버 렌더에서는 false 로 본다(브라우저에서만 알 수 있는 값이다).
 */
export function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => (typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false),
    () => false,
  );
}

export function useTypewriter(total: number, active: boolean, cps = 26): number {
  /**
   * 진행 글자 수. rAF 콜백에서만 올린다(효과 본문에서 곧바로 setState 하지 않는다 —
   * 렌더가 연쇄로 도는 것을 막기 위해서다).
   * 알림마다 컴포넌트를 key 로 다시 마운트하므로 0 부터 자연스럽게 다시 시작한다.
   */
  const [progress, setProgress] = React.useState(0);
  const reduced = usePrefersReducedMotion();
  const running = active && !reduced;

  React.useEffect(() => {
    if (!running || typeof window === 'undefined') return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const n = Math.min(total, Math.floor(((now - start) / 1000) * cps));
      setProgress(n);
      if (n < total) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [total, running, cps]);

  // 타이핑을 쓰지 않거나 움직임 최소화 환경이면 처음부터 전부 보여 준다.
  return running ? Math.min(total, progress) : total;
}

/** 색이 다른 조각들로 이루어진 문장을 앞에서부터 n 글자만 남긴다. */
export interface TextSegment {
  text: string;
  color?: string;
}

export function sliceSegments(segments: readonly TextSegment[], revealed: number): TextSegment[] {
  let left = revealed;
  const out: TextSegment[] = [];
  for (const seg of segments) {
    if (left <= 0) break;
    out.push(left >= seg.text.length ? seg : { ...seg, text: seg.text.slice(0, left) });
    left -= seg.text.length;
  }
  return out;
}

export function segmentsLength(segments: readonly TextSegment[]): number {
  return segments.reduce((sum, s) => sum + s.text.length, 0);
}
