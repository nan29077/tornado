'use client';

import * as React from 'react';
import { GAME_TYPE_META, type GameType } from '@/lib/game-catalog';
import { formatNumber } from '@/lib/money';
import { Portal } from '@/components/ui/portal';
import { useStandalone } from '@/components/overlay/use-standalone';
import {
  DEFAULT_OVERLAY_LAYOUT,
  clampOverlayLayout,
  overlayLayoutTransform,
  type OverlayLayout,
} from '@/lib/overlay-layout';

/**
 * 게임 오버레이 (OBS / PRISM 브라우저 소스).
 *
 * 규칙
 *  - 서버 모듈을 import 하지 않는다. 상태 타입만 다시 선언해 쓴다(overlay-client 과 동일).
 *  - 배경은 완전 투명. 카드와 캐릭터만 방송 화면에 얹힌다.
 *  - 1920x1080 캔버스를 기준으로 크기를 잡는다. 미리보기는 캔버스째로 축소되므로
 *    vw / vh 를 쓰지 않는다.
 *  - 화면 아래 15% 는 유튜브 자막·채팅 UI 와 겹치므로 비워 둔다(안전 영역).
 *  - 이모지를 쓰지 않는다. 아이콘은 인라인 SVG 라인 아이콘만 사용한다.
 */

export interface GameWinnerView {
  rank: number;
  name: string;
  prize: string;
  detail?: string;
}

export interface GamePublicState {
  creatorId: string;
  gameId: string;
  roundId: string;
  type: string;
  title: string;
  status: 'OPEN' | 'CLOSED' | 'RESULT' | 'ENDED';
  items: string[];
  destinations: string[];
  choices: string[];
  topic: string;
  question: string;
  counts: number[] | null;
  participantCount: number;
  participantNames: string[];
  correctCount: number | null;
  goal: { target: number; current: number } | null;
  range: { min: number; max: number } | null;
  prize: string;
  joinUrl: string | null;
  joinCode: string | null;
  closesAt: string | null;
  result: Record<string, unknown> | null;
  winners: GameWinnerView[];
  updatedAt: string;
}

const MAX_BACKOFF_MS = 30000;

/**
 * 배치 조정 중에 보여 주는 예시 게임 화면.
 *
 * 게임을 띄우지 않은 상태에서도 방송 화면에서의 자리와 크기를 미리 잡을 수 있어야 한다.
 * 스튜디오가 [배치 조정]을 켰을 때만 그리며, 방송용(토큰) 경로에는 이 신호가 오지 않는다.
 */
const LAYOUT_SAMPLE: GamePublicState = {
  creatorId: '',
  gameId: 'layout-sample',
  roundId: 'layout-sample',
  type: 'ROULETTE',
  title: '배치 조정 예시',
  status: 'OPEN',
  items: ['항목 1', '항목 2', '항목 3', '항목 4'],
  destinations: [],
  choices: [],
  topic: '',
  question: '',
  counts: null,
  participantCount: 0,
  participantNames: [],
  correctCount: null,
  goal: null,
  range: null,
  prize: '',
  joinUrl: null,
  joinCode: null,
  closesAt: null,
  result: null,
  winners: [],
  updatedAt: '',
};

/** 도네이도 브랜드 색. 룰렛·막대·게이지가 같은 팔레트를 쓴다. */
const WHEEL_COLORS = ['#fbb914', '#ff9f1c', '#ffcd4d', '#eda600', '#ffdf8c', '#c98600'];

const MASCOT = {
  cheer: '/stickers/donaido/cheer.webp',
  gift: '/stickers/donaido/gift-pop.webp',
  dance: '/stickers/donaido/mic-dance.webp',
  bow: '/stickers/donaido/thanks-bow.webp',
  heart: '/stickers/donaido/heart-hug.webp',
} as const;

// ------------------------------------------------------------------ 본체

export function GameOverlayClient({
  creatorId,
  token,
  preview = false,
  debug = false,
  sample = null,
  sampleMode = false,
  layout = DEFAULT_OVERLAY_LAYOUT,
}: {
  creatorId: string;
  token: string;
  preview?: boolean;
  debug?: boolean;
  /** 저장된 배치(위치 미세 조정 · 크기 배율). 스트림으로 새 값이 오면 그쪽이 우선한다. */
  layout?: OverlayLayout;
  /** 띄우기 전 미리보기로 보여 줄 고정 상태. 서버가 만들어 내려 준다. */
  sample?: GamePublicState | null;
  /** 미리보기 모드인지. true 면 실시간 연결을 열지 않는다. */
  sampleMode?: boolean;
}) {
  const [state, setState] = React.useState<GamePublicState | null>(null);
  const [phase, setPhase] = React.useState<'connecting' | 'connected' | 'retrying'>('connecting');
  /** 스트림으로 받은 최신 배치. 방송 중에 스튜디오에서 저장하면 새로 고침 없이 반영된다. */
  const [streamLayout, setStreamLayout] = React.useState<OverlayLayout | null>(null);
  /** 스튜디오에서 드래그하는 동안 실시간으로 받는 임시 값(미리보기 전용). */
  const [draftLayout, setDraftLayout] = React.useState<OverlayLayout | null>(null);
  /** 스튜디오가 [배치 조정]을 켠 상태. 켜지면 예시 화면을 띄우고 자리를 보고한다. */
  const [editFrame, setEditFrame] = React.useState<string | null>(null);

  React.useEffect(() => {
    /**
     * 미리보기 모드는 고정 화면이다. 실시간 연결을 열지 않는다.
     * 열어 두면 (1) 진행 중인 회차가 미리보기 자리에 끼어들고
     * (2) 크리에이터당 동시 연결 상한을 미리보기가 헛되이 차지한다.
     */
    if (sampleMode) return;

    let disposed = false;
    let source: EventSource | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const params = new URLSearchParams();
      if (preview) params.set('preview', '1');
      else params.set('token', token);

      const es = new EventSource(`/api/overlay/${encodeURIComponent(creatorId)}/game/stream?${params.toString()}`);
      source = es;

      es.addEventListener('ready', () => {
        retry = 0;
        setPhase('connected');
      });

      es.addEventListener('layout', (ev) => {
        try {
          setStreamLayout(clampOverlayLayout(JSON.parse((ev as MessageEvent).data)));
        } catch {
          /* 무시 */
        }
      });

      es.addEventListener('state', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as GamePublicState | null;
          setPhase('connected');
          setState(data && data.roundId ? data : null);
        } catch {
          /* 무시 */
        }
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setPhase('retrying');
        // 첫 재시도는 짧게. 순간적인 끊김은 대부분 바로 복구된다.
        const wait = retry === 0 ? 300 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry);
        retry += 1;
        timer = setTimeout(connect, wait);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [creatorId, token, preview, sampleMode]);

  const shown = sampleMode ? sample : (state ?? (editFrame !== null ? LAYOUT_SAMPLE : null));

  React.useEffect(() => {
    if (!preview || typeof window === 'undefined') return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as
        | { type?: string; target?: string; layout?: Partial<OverlayLayout>; on?: boolean; frame?: string }
        | null;
      if (!data || data.target !== 'game') return;
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

  /** 조정 중에는 게임 카드가 차지하는 자리를 부모에게 계속 알려 준다(윤곽선·손잡이용). */
  const boardBoxRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!preview || editFrame === null || typeof window === 'undefined') return;
    let raf = 0;
    const post = () => {
      const el = boardBoxRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        try {
          window.parent.postMessage(
            {
              type: 'donaido-overlay-rect',
              target: 'game',
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

  // 우선순위: 드래그 중인 임시 값 → 스트림으로 받은 값 → 페이지를 열 때 받은 값
  const activeLayout = draftLayout ?? streamLayout ?? clampOverlayLayout(layout);

  const standalone = useStandalone();

  // 부모(스튜디오 통합 미리보기)에 게임 레이어 상태를 알린다.
  React.useEffect(() => {
    if (!preview || sampleMode || typeof window === 'undefined' || window.parent === window) return;
    try {
      window.parent.postMessage(
        {
          type: 'donaido-game-status',
          creatorId,
          phase,
          live: Boolean(state),
          status: state?.status ?? '',
          participantCount: state?.participantCount ?? 0,
        },
        window.location.origin,
      );
    } catch {
      /* ignore */
    }
  }, [preview, sampleMode, creatorId, phase, state]);

  return (
    <div className="pointer-events-none fixed inset-0 bg-transparent">
      {shown ? <GameBoard state={shown} layout={activeLayout} boardRef={boardBoxRef} /> : null}

      {/* 디버그 배지는 단독 창에서만. body 로 옮겨 그려 축소 캔버스의 transform 밖에 둔다. */}
      {debug && !sampleMode && standalone ? (
        <Portal>
          <span
            className={`fixed left-3 top-3 z-[100] rounded-md px-2 py-1 text-[11px] font-semibold text-white ${
              phase === 'connected' ? 'bg-ink-900/80' : 'bg-danger-500/85'
            }`}
          >
            게임 {phase === 'connected' ? '연결됨' : phase === 'retrying' ? '재연결 중' : '연결 중'}
            {state ? ` · ${state.type} · ${state.status} · 참여 ${state.participantCount}` : ' · 대기'}
          </span>
        </Portal>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 프레임

function GameBoard({
  state,
  layout,
  boardRef,
}: {
  state: GamePublicState;
  layout: OverlayLayout;
  /** 배치 조정용 위치 측정에 쓴다. 평소에는 아무 영향이 없다. */
  boardRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const meta = GAME_TYPE_META[state.type as GameType];
  const leaving = state.status === 'ENDED';

  return (
    <div className="flex h-full w-full items-center justify-center px-[80px] pb-[170px] pt-[70px]">
      {/* 배치 미세 조정. 게임 카드 전체를 함께 옮기고 키운다. */}
      <div
        ref={boardRef}
        className={`w-full max-w-[1240px] ${leaving ? 'animate-game-out' : 'animate-game-in'}`}
        style={{ transform: overlayLayoutTransform(layout), transformOrigin: 'center' }}
      >
        <div className="rounded-[40px] border-[3px] border-white/70 bg-white/95 px-[52px] py-[40px] shadow-[0_30px_90px_rgba(23,22,26,0.34)]">
          {/* 머리말 — 회오리 마크 + 게임 이름 + 상태 */}
          <div className="mb-[28px] flex items-center gap-[20px]">
            <TornadoMark />
            <div className="min-w-0 flex-1">
              <p className="text-[20px] font-extrabold tracking-[0.2em] text-brand-600">
                {meta?.label ?? '게임'}
              </p>
              <h1 className="truncate text-[42px] font-black leading-tight tracking-[-0.03em] text-ink-900">
                {state.title}
              </h1>
            </div>
            <StatusPill state={state} />
          </div>

          <Body state={state} />

          {/* 꼬리말 */}
          <div className="mt-[30px] flex items-end justify-between">
            <div className="text-[20px] font-bold text-ink-400">
              {state.prize ? <span className="text-ink-700">보상 · {state.prize}</span> : null}
            </div>
            <span className="text-[18px] font-black tracking-[0.3em] text-ink-300">DONAIDO</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ state }: { state: GamePublicState }) {
  if (state.status === 'RESULT') {
    return (
      <span className="shrink-0 rounded-full bg-ink-900 px-[26px] py-[12px] text-[24px] font-black text-white">
        결과 발표
      </span>
    );
  }
  if (state.status === 'CLOSED') {
    return (
      <span className="shrink-0 rounded-full bg-ink-100 px-[26px] py-[12px] text-[24px] font-black text-ink-500">
        참여 마감
      </span>
    );
  }
  return <Countdown closesAt={state.closesAt} />;
}

/** 남은 시간. 자동 마감을 쓰지 않으면 [진행 중] 만 보여 준다. */
function Countdown({ closesAt }: { closesAt: string | null }) {
  /**
   * 첫 값은 계산하지 않는다.
   *
   * `Date.now()` 로 초기값을 잡으면 서버가 그린 숫자와 브라우저가 그린 숫자가 달라
   * 하이드레이션 불일치가 난다. 실제 숫자는 바로 아래 effect 가 즉시(0ms) 채워 준다.
   */
  const [left, setLeft] = React.useState<number | null>(null);

  React.useEffect(() => {
    const end = closesAt ? new Date(closesAt).getTime() : null;
    const tick = () => setLeft(end == null ? null : Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [closesAt]);

  if (left == null) {
    return (
      <span className="shrink-0 rounded-full bg-brand-100 px-[26px] py-[12px] text-[24px] font-black text-brand-800">
        진행 중
      </span>
    );
  }

  const urgent = left <= 10;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <span
      className={`shrink-0 rounded-full px-[26px] py-[12px] text-[24px] font-black tabular-nums ${
        urgent ? 'animate-urgent bg-accent-500 text-white' : 'bg-brand-100 text-brand-800'
      }`}
    >
      마감까지 {mm}:{ss}
    </span>
  );
}

function TornadoMark() {
  return (
    <span className="grid h-[86px] w-[86px] shrink-0 place-items-center rounded-[26px] bg-brand-50 text-brand-600">
      <svg
        width={54}
        height={54}
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
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

/** 도네이도 캐릭터. 투명 배경 webp 를 그대로 얹는다. */
function Mascot({ src, size = 210, className = '' }: { src: string; size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" aria-hidden width={size} height={size} className={`select-none ${className}`} />
  );
}

function Body({ state }: { state: GamePublicState }) {
  switch (state.type) {
    case 'ROULETTE':
      return <RouletteBoard state={state} />;
    case 'LADDER':
      return <LadderBoard state={state} />;
    case 'RANKING':
      return <RankingBoard state={state} />;
    case 'VOTE':
      return <ChoiceBoard state={state} mode="vote" />;
    case 'QUIZ':
      return <ChoiceBoard state={state} mode="quiz" />;
    case 'KEYWORD':
      return <KeywordBoard state={state} />;
    case 'NUMBER_GUESS':
      return <NumberBoard state={state} />;
    case 'GOAL_GAUGE':
      return <GoalBoard state={state} />;
    default:
      return null;
  }
}

// --------------------------------------------------------------- 참여 안내

/**
 * 참여 QR + 코드.
 *
 * 시청자가 학습할 수 있도록 **항상 같은 자리, 같은 크기**로 그린다.
 * QR 은 240px(1920 기준)보다 작게 만들지 않는다. 휴대폰 카메라가 인식하지 못한다.
 */
function JoinPanel({ state }: { state: GamePublicState }) {
  const [qr, setQr] = React.useState('');

  React.useEffect(() => {
    if (!state.joinUrl) {
      const clear = setTimeout(() => setQr(''), 0);
      return () => clearTimeout(clear);
    }
    let alive = true;
    import('qrcode')
      .then((m) => m.toDataURL(state.joinUrl as string, { width: 480, margin: 1, color: { dark: '#17161a', light: '#ffffff' } }))
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [state.joinUrl]);

  if (!state.joinCode) return null;

  return (
    <div className="flex w-[300px] shrink-0 flex-col items-center gap-[14px]">
      <div className="grid h-[260px] w-[260px] place-items-center overflow-hidden rounded-[28px] border-[3px] border-ink-100 bg-white p-[10px]">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="" aria-hidden className="h-full w-full" />
        ) : (
          <span className="text-[20px] font-bold text-ink-300">QR 준비 중</span>
        )}
      </div>
      <p className="text-[22px] font-extrabold text-ink-500">휴대폰으로 찍고 참여</p>
      <p className="rounded-[16px] bg-ink-900 px-[20px] py-[8px] text-[26px] font-black tracking-[0.28em] text-white">
        {state.joinCode}
      </p>
    </div>
  );
}

/** 참여자 수 + 최근 참여자 이름. 참여형 게임의 공통 머리 영역. */
function EntryHeader({ state, hint }: { state: GamePublicState; hint?: string }) {
  return (
    <div className="mb-[24px] flex items-center gap-[18px]">
      <span className="rounded-[20px] bg-brand-50 px-[24px] py-[12px] text-[30px] font-black text-brand-700">
        <span key={state.participantCount} className="inline-block animate-count-pulse tabular-nums">
          {formatNumber(BigInt(state.participantCount))}
        </span>
        <span className="ml-[6px] text-[24px]">명 참여</span>
      </span>
      {hint ? <span className="text-[24px] font-bold text-ink-400">{hint}</span> : null}
    </div>
  );
}

/** 최근 참여자 이름을 흘려 보여 준다. 투표(익명)에서는 쓰지 않는다. */
function ParticipantChips({ names }: { names: string[] }) {
  if (names.length === 0) {
    return <p className="text-[24px] font-bold text-ink-300">아직 참여자가 없습니다. QR 을 화면에 잠시 보여 주세요.</p>;
  }
  return (
    <div className="flex flex-wrap gap-[10px]">
      {names.slice(0, 16).map((n, i) => (
        <span
          key={`${n}-${i}`}
          className="rounded-full border-2 border-brand-100 bg-brand-50 px-[18px] py-[8px] text-[22px] font-bold text-brand-800"
        >
          {n}
        </span>
      ))}
    </div>
  );
}

/** 당첨자 목록. 순위 카드가 한 장씩 올라온다. */
function WinnerList({ winners, compact = false }: { winners: GameWinnerView[]; compact?: boolean }) {
  if (winners.length === 0) return null;
  return (
    <div className="flex flex-col gap-[14px]">
      {winners.map((w, i) => (
        <div
          key={`${w.rank}-${w.name}`}
          className="animate-rank-in flex items-center gap-[20px] rounded-[24px] border-[3px] border-brand-200 bg-brand-50 px-[28px] py-[18px]"
          style={{ animationDelay: `${i * 260}ms` }}
        >
          <span className="grid h-[62px] w-[62px] shrink-0 place-items-center rounded-full bg-brand-500 text-[30px] font-black text-ink-900">
            {w.rank}
          </span>
          <span className={`min-w-0 flex-1 truncate font-black text-ink-900 ${compact ? 'text-[34px]' : 'text-[44px]'}`}>
            {w.name}
            {w.detail ? <span className="ml-[14px] text-[28px] font-bold text-ink-400">{w.detail}</span> : null}
          </span>
          {w.prize ? (
            <span className="shrink-0 rounded-full bg-ink-900 px-[22px] py-[10px] text-[24px] font-black text-white">
              {w.prize}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- 룰렛

function RouletteBoard({ state }: { state: GamePublicState }) {
  const items = state.items;
  const result = state.result as { winnerIndex?: number; winner?: string } | null;
  const winnerIndex = typeof result?.winnerIndex === 'number' ? result.winnerIndex : null;

  // 결과가 정해지면 그 칸이 위쪽 바늘에 오도록 각도를 계산해 한 번만 회전한다.
  const [angle, setAngle] = React.useState(0);
  const [settled, setSettled] = React.useState(false);
  const spun = React.useRef<string>('');

  React.useEffect(() => {
    let frame = 0;
    if (winnerIndex == null || items.length === 0) {
      spun.current = '';
      frame = requestAnimationFrame(() => {
        setAngle(0);
        setSettled(false);
      });
      return () => cancelAnimationFrame(frame);
    }
    const key = `${state.roundId}:${winnerIndex}`;
    if (spun.current === key) return;
    spun.current = key;

    const seg = 360 / items.length;
    const target = 360 * 6 - (winnerIndex * seg + seg / 2);
    // 다음 프레임에 각도를 바꿔야 transition 이 걸린다.
    frame = requestAnimationFrame(() => {
      setSettled(false);
      setAngle(target);
    });
    const t = setTimeout(() => setSettled(true), 4600);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(t);
    };
  }, [winnerIndex, items.length, state.roundId]);

  return (
    <div className="flex items-center gap-[46px]">
      <div className="relative h-[440px] w-[440px] shrink-0">
        {/* 바늘 */}
        <div className="absolute left-1/2 top-[-6px] z-10 -translate-x-1/2">
          <svg width={54} height={54} viewBox="0 0 24 24" aria-hidden>
            <path d="M12 22 3 4h18z" fill="#17161a" />
          </svg>
        </div>
        <div
          className={winnerIndex == null ? 'animate-wheel-idle h-full w-full' : 'h-full w-full'}
          style={
            winnerIndex == null
              ? undefined
              : {
                  transform: `rotate(${angle}deg)`,
                  transition: 'transform 4.4s cubic-bezier(0.12, 0.75, 0.12, 1)',
                }
          }
        >
          <Wheel items={items} highlight={settled ? winnerIndex : null} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {state.status === 'RESULT' && settled && result?.winner ? (
          <div className="animate-game-pop">
            <p className="text-[28px] font-black text-brand-600">당첨</p>
            <p className="mt-[6px] break-words text-[76px] font-black leading-tight text-ink-900">{result.winner}</p>
            {state.prize ? (
              <p className="mt-[14px] text-[30px] font-bold text-ink-500">보상 · {state.prize}</p>
            ) : null}
          </div>
        ) : (
          <>
            <p className="text-[34px] font-black text-ink-900">
              {winnerIndex == null ? '곧 돌립니다' : '두구두구'}
            </p>
            <p className="mt-[10px] text-[24px] font-bold text-ink-400">항목 {items.length}개</p>
            <div className="mt-[22px]">
              <ParticipantChips names={items.slice(0, 10)} />
            </div>
          </>
        )}
      </div>

      {state.status === 'RESULT' && settled ? (
        <Mascot src={MASCOT.gift} size={220} className="animate-sticker-gift shrink-0" />
      ) : (
        <Mascot src={MASCOT.cheer} size={200} className="animate-sticker-cheer shrink-0" />
      )}
    </div>
  );
}

/** 룰렛 원판. 조각마다 브랜드 색을 돌려 쓴다. */
function Wheel({ items, highlight }: { items: string[]; highlight: number | null }) {
  const n = Math.max(1, items.length);
  const seg = 360 / n;
  const r = 210;
  const cx = 220;
  const cy = 220;

  const path = (i: number) => {
    const start = ((i * seg - 90) * Math.PI) / 180;
    const end = (((i + 1) * seg - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${seg > 180 ? 1 : 0} 1 ${x2} ${y2} Z`;
  };

  return (
    <svg width={440} height={440} viewBox="0 0 440 440" aria-hidden>
      <circle cx={cx} cy={cy} r={r + 8} fill="#ffffff" stroke="#e2e0e6" strokeWidth={6} />
      {items.map((label, i) => {
        const mid = ((i * seg + seg / 2 - 90) * Math.PI) / 180;
        const tx = cx + r * 0.62 * Math.cos(mid);
        const ty = cy + r * 0.62 * Math.sin(mid);
        const on = highlight === i;
        return (
          <g key={`${label}-${i}`}>
            <path
              d={path(i)}
              fill={on ? '#17161a' : WHEEL_COLORS[i % WHEEL_COLORS.length]}
              stroke="#ffffff"
              strokeWidth={3}
            />
            <text
              x={tx}
              y={ty}
              textAnchor="middle"
              dominantBaseline="central"
              transform={`rotate(${i * seg + seg / 2} ${tx} ${ty})`}
              fontSize={n > 10 ? 18 : 24}
              fontWeight={900}
              fill={on ? '#ffffff' : '#17161a'}
            >
              {label.length > 8 ? `${label.slice(0, 8)}…` : label}
            </text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={44} fill="#ffffff" stroke="#fbb914" strokeWidth={6} />
      <g stroke="#eda600" strokeWidth={3} strokeLinecap="round" fill="none">
        <path d="M198 206h44" />
        <path d="M204 218h32" />
        <path d="M210 230h20" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- 사다리

function LadderBoard({ state }: { state: GamePublicState }) {
  const result = state.result as
    | { rungs?: { row: number; col: number }[]; rows?: number; cols?: number; starts?: string[]; destinations?: string[]; order?: string[]; activeIndex?: number | null }
    | null;

  const starts = result?.starts ?? state.items;
  const destinations = result?.destinations ?? state.destinations;
  const cols = Math.max(2, starts.length);
  const rows = result?.rows ?? 12;
  const rungs = result?.rungs ?? [];

  const W = 980;
  const H = 360;
  const gapX = W / (cols - 1 || 1);
  const gapY = H / rows;

  return (
    <div className="flex items-center gap-[34px]">
      <div className="min-w-0 flex-1">
        <div className="mb-[14px] flex justify-between">
          {starts.map((s, i) => (
            <span
              key={`s-${i}`}
              // Tailwind 는 클래스 이름을 정적으로 읽으므로 폭은 인라인 스타일로 준다.
              style={{ width: `${100 / cols}%` }}
              className={`truncate text-center text-[24px] font-black ${
                result?.activeIndex === i ? 'text-brand-700' : 'text-ink-900'
              }`}
            >
              {s}
            </span>
          ))}
        </div>

        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="w-full" aria-hidden>
          {Array.from({ length: cols }).map((_, i) => (
            <line
              key={`c-${i}`}
              x1={i * gapX}
              y1={0}
              x2={i * gapX}
              y2={H}
              stroke="#e2e0e6"
              strokeWidth={8}
              strokeLinecap="round"
            />
          ))}
          {rungs.map((r, i) => (
            <line
              key={`r-${i}`}
              x1={r.col * gapX}
              y1={r.row * gapY}
              x2={(r.col + 1) * gapX}
              y2={r.row * gapY}
              stroke="#ffcd4d"
              strokeWidth={8}
              strokeLinecap="round"
            />
          ))}
          {result && typeof result.activeIndex === 'number' ? (
            <LadderPath
              startCol={result.activeIndex}
              rungs={rungs}
              rows={rows}
              cols={cols}
              gapX={gapX}
              gapY={gapY}
            />
          ) : null}
        </svg>

        <div className="mt-[14px] flex justify-between">
          {destinations.map((d, i) => (
            <span
              key={`d-${i}`}
              style={{ width: `${100 / cols}%` }}
              className="truncate text-center text-[22px] font-bold text-ink-500"
            >
              {d || '-'}
            </span>
          ))}
        </div>

        {state.status === 'RESULT' && result?.order ? (
          <div className="mt-[24px] grid grid-cols-2 gap-[10px]">
            {starts.map((s, i) => (
              <div
                key={`o-${i}`}
                className="animate-rank-in flex items-center justify-between rounded-[18px] bg-brand-50 px-[22px] py-[12px]"
                style={{ animationDelay: `${i * 140}ms` }}
              >
                <span className="truncate text-[26px] font-black text-ink-900">{s}</span>
                <span className="ml-[12px] shrink-0 text-[26px] font-black text-brand-700">
                  {result.order?.[i] || '-'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <Mascot
        src={state.status === 'RESULT' ? MASCOT.gift : MASCOT.cheer}
        size={190}
        className={state.status === 'RESULT' ? 'animate-sticker-gift shrink-0' : 'animate-sticker-cheer shrink-0'}
      />
    </div>
  );
}

/** 선택한 번호의 경로를 굵게 그린다. */
function LadderPath({
  startCol,
  rungs,
  rows,
  cols,
  gapX,
  gapY,
}: {
  startCol: number;
  rungs: { row: number; col: number }[];
  rows: number;
  cols: number;
  gapX: number;
  gapY: number;
}) {
  const points: string[] = [`M ${startCol * gapX} 0`];
  let col = startCol;
  for (let row = 0; row < rows; row++) {
    const y = row * gapY;
    points.push(`L ${col * gapX} ${y}`);
    if (rungs.some((r) => r.row === row && r.col === col)) {
      col = Math.min(col + 1, cols - 1);
      points.push(`L ${col * gapX} ${y}`);
    } else if (rungs.some((r) => r.row === row && r.col === col - 1)) {
      col = Math.max(col - 1, 0);
      points.push(`L ${col * gapX} ${y}`);
    }
  }
  points.push(`L ${col * gapX} ${rows * gapY}`);

  return (
    <path
      d={points.join(' ')}
      fill="none"
      stroke="#17161a"
      strokeWidth={10}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={0.85}
    />
  );
}

// ---------------------------------------------------------------- 순위 추첨

function RankingBoard({ state }: { state: GamePublicState }) {
  const revealed = state.status === 'RESULT';
  return (
    <div className="flex items-start gap-[40px]">
      <div className="min-w-0 flex-1">
        {revealed ? (
          <WinnerList winners={state.winners} />
        ) : (
          <>
            <EntryHeader state={state} hint={state.status === 'CLOSED' ? '참여 마감 · 추첨을 기다립니다' : '지금 참여할 수 있습니다'} />
            <ParticipantChips names={state.participantNames} />
          </>
        )}
      </div>
      {revealed ? (
        <Mascot src={MASCOT.gift} size={220} className="animate-sticker-gift shrink-0" />
      ) : (
        <JoinPanel state={state} />
      )}
    </div>
  );
}

// ------------------------------------------------------- 투표 · 퀴즈 (선택형)

function ChoiceBoard({ state, mode }: { state: GamePublicState; mode: 'vote' | 'quiz' }) {
  const revealed = state.status === 'RESULT';
  const result = state.result as { counts?: number[]; answerIndex?: number; answerLabel?: string; topIndex?: number } | null;
  const counts = result?.counts ?? state.counts ?? state.choices.map(() => 0);
  const total = counts.reduce((a, b) => a + b, 0);
  const answerIndex = revealed && typeof result?.answerIndex === 'number' ? result.answerIndex : null;
  const topIndex = revealed && typeof result?.topIndex === 'number' ? result.topIndex : null;

  return (
    <div className="flex items-start gap-[40px]">
      <div className="min-w-0 flex-1">
        <p className="mb-[18px] break-words text-[34px] font-black leading-snug text-ink-900">
          {mode === 'quiz' ? state.question : state.topic}
        </p>

        <div className="flex flex-col gap-[14px]">
          {state.choices.map((c, i) => {
            const value = counts[i] ?? 0;
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            const isAnswer = answerIndex === i;
            const isTop = topIndex === i;
            return (
              <div key={`${c}-${i}`}>
                <div className="mb-[6px] flex items-center justify-between">
                  <span className={`text-[28px] font-black ${isAnswer || isTop ? 'text-brand-700' : 'text-ink-900'}`}>
                    <span className="mr-[12px] inline-grid h-[44px] w-[44px] place-items-center rounded-full bg-ink-900 text-[24px] text-white">
                      {String.fromCharCode(65 + i)}
                    </span>
                    {c}
                    {isAnswer ? <span className="ml-[14px] text-[24px] font-black text-brand-600">정답</span> : null}
                  </span>
                  <span className="text-[26px] font-bold tabular-nums text-ink-400">
                    {value}
                    {mode === 'vote' ? '표' : '명'} · {pct}%
                  </span>
                </div>
                <div className="h-[26px] overflow-hidden rounded-full bg-ink-100">
                  <div
                    className={`h-full rounded-full transition-[width] duration-700 ease-out ${
                      isAnswer || isTop ? 'bg-ink-900' : 'bg-brand-400'
                    }`}
                    style={{ width: `${Math.max(pct, value > 0 ? 4 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {revealed && mode === 'quiz' ? (
          <div className="mt-[26px]">
            <WinnerList winners={state.winners} compact />
          </div>
        ) : null}
        {revealed && mode === 'vote' ? (
          <p className="mt-[26px] animate-game-pop text-[40px] font-black text-ink-900">
            1위 · {state.choices[topIndex ?? 0] ?? '-'}
          </p>
        ) : null}
      </div>

      {revealed ? (
        <Mascot src={mode === 'vote' ? MASCOT.dance : MASCOT.gift} size={210} className="animate-sticker-gift shrink-0" />
      ) : (
        <div className="flex flex-col items-center gap-[18px]">
          <JoinPanel state={state} />
          <span className="rounded-[18px] bg-brand-50 px-[20px] py-[10px] text-[24px] font-black text-brand-700 tabular-nums">
            {formatNumber(BigInt(state.participantCount))}명 참여
          </span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- 선착순 키워드

function KeywordBoard({ state }: { state: GamePublicState }) {
  const revealed = state.status === 'RESULT';
  const result = state.result as { keyword?: string; totalCorrect?: number } | null;

  return (
    <div className="flex items-start gap-[40px]">
      <div className="min-w-0 flex-1">
        {revealed ? (
          <>
            <p className="mb-[18px] text-[30px] font-bold text-ink-500">
              정답 키워드 · <span className="text-ink-900">{result?.keyword ?? ''}</span>
            </p>
            <WinnerList winners={state.winners} compact />
          </>
        ) : (
          <>
            <EntryHeader
              state={state}
              hint={state.status === 'CLOSED' ? '마감 · 발표를 기다립니다' : '키워드를 입력하세요'}
            />
            <div className="rounded-[28px] border-[3px] border-dashed border-brand-200 bg-brand-50 px-[36px] py-[30px]">
              <p className="text-[30px] font-black text-brand-800">
                정답 입력 <span className="tabular-nums">{state.correctCount ?? 0}</span>명
              </p>
              <p className="mt-[10px] text-[24px] font-bold text-ink-400">
                먼저 맞힌 순서대로 당첨됩니다. 정답은 발표 전까지 공개되지 않습니다.
              </p>
            </div>
          </>
        )}
      </div>
      {revealed ? (
        <Mascot src={MASCOT.gift} size={210} className="animate-sticker-gift shrink-0" />
      ) : (
        <JoinPanel state={state} />
      )}
    </div>
  );
}

// -------------------------------------------------------------- 숫자 맞히기

function NumberBoard({ state }: { state: GamePublicState }) {
  const revealed = state.status === 'RESULT';
  const result = state.result as { answer?: number; entryCount?: number } | null;

  return (
    <div className="flex items-start gap-[40px]">
      <div className="min-w-0 flex-1">
        {revealed ? (
          <>
            <p className="mb-[18px] text-[30px] font-bold text-ink-500">
              정답 ·{' '}
              <span className="text-[52px] font-black text-ink-900 tabular-nums">
                {formatNumber(BigInt(Math.round(Number(result?.answer ?? 0))))}
              </span>
            </p>
            <WinnerList winners={state.winners} compact />
          </>
        ) : (
          <>
            <EntryHeader
              state={state}
              hint={state.status === 'CLOSED' ? '마감 · 발표를 기다립니다' : '숫자를 입력하세요'}
            />
            <div className="rounded-[28px] border-[3px] border-dashed border-brand-200 bg-brand-50 px-[36px] py-[30px] text-center">
              <p className="text-[26px] font-bold text-ink-400">입력 범위</p>
              <p className="mt-[8px] text-[56px] font-black text-brand-800 tabular-nums">
                {state.range ? `${formatNumber(BigInt(state.range.min))} ~ ${formatNumber(BigInt(state.range.max))}` : '-'}
              </p>
            </div>
            <div className="mt-[20px]">
              <ParticipantChips names={state.participantNames} />
            </div>
          </>
        )}
      </div>
      {revealed ? (
        <Mascot src={MASCOT.gift} size={210} className="animate-sticker-gift shrink-0" />
      ) : (
        <JoinPanel state={state} />
      )}
    </div>
  );
}

// ---------------------------------------------------------- 후원 목표 게이지

function GoalBoard({ state }: { state: GamePublicState }) {
  const goal = state.goal ?? { target: 0, current: 0 };
  const pct = goal.target > 0 ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
  const achieved = goal.target > 0 && goal.current >= goal.target;

  return (
    <div className="flex items-center gap-[40px]">
      <div className="min-w-0 flex-1">
        <div className="mb-[16px] flex items-end justify-between">
          <span className="text-[64px] font-black leading-none text-ink-900 tabular-nums">
            {formatNumber(BigInt(Math.max(0, Math.round(goal.current))))}
            <span className="ml-[8px] text-[34px]">원</span>
          </span>
          <span className="text-[32px] font-bold text-ink-400 tabular-nums">
            목표 {formatNumber(BigInt(Math.max(0, Math.round(goal.target))))}원
          </span>
        </div>

        {/* 게이지. 회오리가 차오르는 느낌으로 빛이 훑고 지나간다 */}
        <div className="relative h-[62px] overflow-hidden rounded-full border-[3px] border-brand-200 bg-ink-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-300 via-brand-400 to-accent-500 transition-[width] duration-700 ease-out"
            style={{ width: `${Math.max(pct, goal.current > 0 ? 3 : 0)}%` }}
          />
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="animate-gauge-shine h-full w-[18%] bg-white/35 blur-[6px]" />
          </div>
          <span className="absolute inset-0 grid place-items-center text-[30px] font-black text-ink-900 tabular-nums">
            {pct}%
          </span>
        </div>

        <p className="mt-[20px] text-[30px] font-bold text-ink-500">
          {achieved ? (
            <span className="animate-game-pop inline-block text-[44px] font-black text-brand-700">목표 달성</span>
          ) : (
            <>남은 금액 {formatNumber(BigInt(Math.max(0, Math.round(goal.target - goal.current))))}원</>
          )}
        </p>
        {state.prize ? <p className="mt-[8px] text-[28px] font-bold text-ink-700">공약 · {state.prize}</p> : null}
      </div>

      <Mascot
        src={achieved ? MASCOT.dance : MASCOT.heart}
        size={220}
        className={achieved ? 'animate-sticker-dance shrink-0' : 'animate-sticker-heart shrink-0'}
      />
    </div>
  );
}
