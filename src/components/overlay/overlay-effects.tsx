'use client';

import * as React from 'react';
import Image from 'next/image';
import {
  findCharacterSticker,
  type OverlayEffectValue,
} from '@/lib/overlay-effect-catalog';

/**
 * 오버레이 파티클 효과 레이어.
 *
 * 규칙
 *  - 서버 모듈을 import 하지 않는다(브라우저 소스 전용 번들).
 *  - 배치는 인덱스 기반 결정적 계산만 쓴다. Math.random 을 쓰면 hydration 이 어긋난다.
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
