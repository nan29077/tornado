'use client';

import * as React from 'react';
import {
  Eye,
  EyeOff,
  Gamepad2,
  Heart,
  Loader2,
  Maximize2,
  Monitor,
  MonitorPlay,
  Move,
  PictureInPicture2,
  PlugZap,
  RotateCcw,
  RotateCw,
  Save,
  Smartphone,
  Undo2,
  Wifi,
  X,
} from 'lucide-react';
import { Badge, Button, Notice, cx } from '@/components/ui';
import { Portal } from '@/components/ui/portal';
import {
  DEFAULT_OVERLAY_LAYOUT,
  LAYOUT_CANVAS_HEIGHT,
  LAYOUT_CANVAS_WIDTH,
  OVERLAY_LAYOUT_LIMITS,
  clampOverlayLayout,
  isDefaultOverlayLayout,
  type OverlayLayout,
} from '@/lib/overlay-layout';

/**
 * 방송 화면 미리보기 + 배치 편집기.
 *
 * 왜 하나로 합쳤나
 *  - 실제 방송 화면은 후원 알림 소스와 게임 소스가 **겹쳐진 결과**다. 예전에는 따로만 볼 수
 *    있어서 게임 QR 위에 후원 배너가 올라타는지 확인할 방법이 없었다.
 *  - 미리보기가 화면마다 규칙이 달라(어떤 것은 게임을 띄워야 나타나고, 어떤 것은 새 탭)
 *    크리에이터가 같은 말을 네 번 다르게 배워야 했다.
 *  - 위치·크기를 바꾸려면 OBS 를 열어 소스를 직접 끌어야 했다. 그렇게 하면 글자와 QR 까지
 *    통째로 줄어든다. 방송 화면 안에서 바로 잡을 수 있어야 한다.
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - 두 소스를 각각 iframe 으로 열고 **겹쳐 그린다.** 레이어는 CSS 로만 감춘다.
 *    감출 때 마운트를 풀면 SSE 가 끊겨 [테스트 후원 보내기]가 재생되지 않는다.
 *  - [PC 방송] · [모바일] 두 틀 모두 항상 마운트한다. 같은 이유다.
 *    작은 창(PiP)으로 줄어들 때도 **같은 DOM 을 CSS 로만 옮긴다.** 다시 마운트하면 끊긴다.
 *  - 미리보기 iframe 은 클릭을 받지 않는다(pointer-events: none). 조작은 위에 덮는 층이 받는다.
 *  - 연결 상태 · 대기 수 · 테마 · 게임 상태는 오버레이가 postMessage 로 알려 주고
 *    **이 툴바 한 곳에만** 표시한다. 오버레이 화면 안에는 그리지 않는다.
 */

/** 모바일 프레임 기준 크기 (단위: px). */
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 760;
/** 단말기 테두리 두께. 테두리를 포함해도 안쪽 화면이 정확히 기준 크기가 되도록 더해 준다. */
const MOBILE_BEZEL = 6;

/** 체커보드 배경 (투명 오버레이임을 시각적으로 표시). */
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: '#2b2b31',
  backgroundImage:
    'linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%), linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%)',
  backgroundSize: '32px 32px',
  backgroundPosition: '0 0, 16px 16px',
};

type PreviewTab = 'pc' | 'mobile';

const TABS: { value: PreviewTab; label: string; Icon: typeof Monitor }[] = [
  { value: 'pc', label: 'PC 방송', Icon: Monitor },
  { value: 'mobile', label: '모바일', Icon: Smartphone },
];

/** 배치를 조정할 대상. */
type LayoutTarget = 'donation' | 'game';

const TARGET_LABEL: Record<LayoutTarget, string> = {
  donation: '후원 알림',
  game: '게임 화면',
};

/** 방송 화면 아래쪽 안전 영역(유튜브 자막·채팅과 겹치는 구간). 캔버스 높이 대비 비율. */
const SAFE_BOTTOM_RATIO = 170 / LAYOUT_CANVAS_HEIGHT;

/** 이 값(%) 안쪽으로 들어오면 정가운데에 붙인다. */
const SNAP_THRESHOLD = 1.5;

interface LinkState {
  phase: string;
  retrySec?: number;
  recovered?: number;
}

/** 오버레이가 알려 주는 재생 상태. 진단용 값이다. */
interface MetaState {
  queue: number;
  theme: string;
}

/** 게임 소스가 알려 주는 상태. */
interface GameLayerState {
  phase: string;
  live: boolean;
  status: string;
  participantCount: number;
}

/**
 * 테두리를 뺀 안쪽 상자.
 *
 * 휴대폰 틀은 테두리가 6px 있어서 getBoundingClientRect() 로 재면 402px 이 나오지만,
 * 오버레이가 알려 주는 비율은 안쪽 화면(390px) 기준이다. 두 기준이 다르면 끌어 옮긴 거리와
 * 실제로 움직인 거리가 어긋난다.
 */
function innerRect(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return {
    left: r.left + el.clientLeft,
    top: r.top + el.clientTop,
    width: el.clientWidth,
    height: el.clientHeight,
  };
}

/** 오버레이가 알려 주는 "내가 차지한 자리". 값은 그 화면 크기에 대한 비율(0~1)이다. */
interface LayerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 오버레이가 자리를 알려 주기 전에 쓸 **대략 상자**.
 *
 * 왜 필요한가
 * -----------
 * 예전에는 오버레이(iframe)가 `donaido-overlay-rect` 로 자기 자리를 알려 줄 때까지
 * 조정 상자를 **아예 그리지 않았다**. 그래서 오버레이가 아직 안 떴거나 실시간 연결이
 * 끊긴 상태에서는 [위치·크기 조정]을 켜도 **화면에 아무것도 나타나지 않아**
 * "드래그로 옮길 수 없다" 가 된다. 기능이 없는 게 아니라 잡을 것이 없는 상태다.
 *
 * 실제 자리가 오면 곧바로 그 값으로 바뀐다. 그때까지는 이 근사치로 잡고 끌 수 있다.
 * 크기·위치는 저장된 배치값을 그대로 반영하므로 끄는 느낌도 실제와 같다.
 */
const FALLBACK_BOX: Record<LayoutTarget, { w: number; h: number; cx: number; cy: number }> = {
  // 후원 알림 배너: 가로로 긴 띠. 기본 자리는 아래쪽 가운데다.
  donation: { w: 0.46, h: 0.17, cx: 0.5, cy: 0.72 },
  // 게임 화면: 가운데 큰 카드.
  game: { w: 0.5, h: 0.46, cx: 0.5, cy: 0.48 },
};

/**
 * 이 자리로 두면 방송 화면 밖으로 나가는가.
 *
 * 조절 한도(±40%) 안에서도 **완전히 화면 밖으로 밀어낼 수 있다.**
 * 예: 아래쪽에 붙는 후원 배너를 세로 +40% 로 내리면 캔버스 아래로 완전히 사라진다.
 * 그러면 OBS 화면에도 아무것도 나오지 않는데, 크리에이터는 이유를 알 수 없다.
 * (미리보기에서도 안 보이니 "오버레이가 고장 났다" 로 읽힌다)
 * 값 자체를 막지는 않는다 — 화면 밖으로 빼 두고 싶은 경우도 있다. 대신 **경고한다.**
 */
export function offscreenRatio(r: LayerRect): number {
  const inX = Math.max(0, Math.min(1, r.x + r.w) - Math.max(0, r.x));
  const inY = Math.max(0, Math.min(1, r.y + r.h) - Math.max(0, r.y));
  const area = r.w * r.h;
  if (area <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - (inX * inY) / area));
}

export function fallbackRect(target: LayoutTarget, layout: OverlayLayout): LayerRect {
  const base = FALLBACK_BOX[target];
  const s = layout.scalePct / 100;
  const w = base.w * s;
  const h = base.h * s;
  return {
    x: base.cx + layout.offsetX / 100 - w / 2,
    y: base.cy + layout.offsetY / 100 - h / 2,
    w,
    h,
  };
}

// ---------------------------------------------------------------- 배지

/**
 * 연결 상태 배지.
 *
 * 문구 길이를 고정폭 칸 안에 가둔다. 남은 초처럼 1초마다 글자 수가 바뀌는 값은 넣지 않는다.
 * 배지가 탭·버튼과 자리를 다투면 줄바꿈이 켜졌다 꺼졌다 하며 아래 내용이 위아래로 흔들린다.
 */
function ConnectionBadge({ link, game }: { link: LinkState | null; game: GameLayerState | null }) {
  const phase = !link ? 'connecting' : link.phase;
  const tone = phase === 'connected' ? 'success' : phase === 'retrying' ? 'warning' : 'neutral';
  const label = phase === 'connected' ? '연결됨' : phase === 'retrying' ? '재연결 중' : '연결 중';
  const Icon = phase === 'connected' ? Wifi : PlugZap;

  /**
   * 게임 레이어의 연결 상태를 따로 표시한다.
   *
   * 예전에는 이 배지가 **후원 알림 레이어의 상태만** 보여 줬다. 그래서 후원 쪽은 붙었는데
   * 게임 쪽이 못 붙은 상황에서도 [연결됨] 하나만 떠 있었고, 화면이 비어 있는 이유를
   * 화면만 봐서는 알 수 없었다. 실제로 그 상태를 진단하는 데 오래 걸렸다.
   * 두 레이어가 각각 어떤 상태인지 항상 보이게 한다.
   */
  const gamePhase = !game ? 'connecting' : game.phase || 'connecting';
  const gameTone = gamePhase === 'connected' ? 'success' : gamePhase === 'retrying' ? 'warning' : 'neutral';
  const gameLabel =
    gamePhase === 'connected' ? (game?.live ? '게임 재생 중' : '게임 대기') : gamePhase === 'retrying' ? '게임 재연결' : '게임 연결 중';

  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1">
      <Badge tone={tone} className="whitespace-nowrap">
        <Icon size={13} strokeWidth={1.7} className="mr-1 inline-block align-[-2px]" />
        후원 {label}
      </Badge>
      <Badge tone={gameTone} className="hidden whitespace-nowrap lg:inline-flex">
        {gameLabel}
      </Badge>
    </span>
  );
}

/** 재생 대기 수 · 테마 · 게임 상태. */
function MetaBadge({ meta, game }: { meta: MetaState | null; game: GameLayerState | null }) {
  const parts: string[] = [];
  if (meta) parts.push(`대기 ${meta.queue}`, `테마 ${meta.theme}`);
  if (game?.live) parts.push(`게임 ${game.status} · 참여 ${game.participantCount}`);
  if (parts.length === 0) return null;

  return (
    <span className="hidden h-7 shrink-0 items-center rounded-lg bg-ink-50 px-2 text-[11.5px] font-semibold text-ink-500 tabular-nums xl:inline-flex">
      {parts.join(' · ')}
    </span>
  );
}

/**
 * 레이어 보이기/숨기기 버튼.
 *
 * 무엇을 하는 버튼인지 아이콘만으로는 알 수 없어서, 눈 모양(보임/숨김)을 함께 둔다.
 * 이 버튼은 **미리보기에서만** 감춘다. 실제 방송에는 아무 영향이 없다.
 */
function LayerToggle({
  on,
  label,
  Icon,
  onClick,
}: {
  on: boolean;
  label: string;
  Icon: typeof Heart;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={`미리보기에서 ${label}을(를) ${on ? '숨깁니다' : '보여 줍니다'}`}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-bold transition-colors',
        on
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-ink-200 bg-white text-ink-300 hover:bg-ink-50',
      )}
    >
      {on ? <Eye size={14} strokeWidth={1.8} /> : <EyeOff size={14} strokeWidth={1.8} />}
      <Icon size={14} strokeWidth={1.8} className="opacity-70" />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- 레이어

/** 두 브라우저 소스를 겹쳐 그린다. 게임이 아래, 후원 알림이 위다(OBS 권장 순서와 같다). */
function Layers({
  frame,
  donationUrl,
  gameUrl,
  showDonation,
  showGame,
  frameKey,
  donationRef,
}: {
  frame: string;
  donationUrl: string;
  gameUrl: string;
  showDonation: boolean;
  showGame: boolean;
  frameKey: number;
  donationRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  return (
    <>
      <iframe
        key={`game-${frameKey}`}
        title="게임 레이어"
        src={gameUrl}
        data-frame={frame}
        data-layer="game"
        className="pointer-events-none absolute inset-0 h-full w-full border-0"
        style={{ background: 'transparent', zIndex: 0, visibility: showGame ? 'visible' : 'hidden' }}
      />
      <iframe
        key={`donation-${frameKey}`}
        ref={donationRef}
        title="후원 알림 레이어"
        src={donationUrl}
        data-frame={frame}
        data-layer="donation"
        className="pointer-events-none absolute inset-0 h-full w-full border-0"
        style={{ background: 'transparent', zIndex: 1, visibility: showDonation ? 'visible' : 'hidden' }}
      />
    </>
  );
}

// ---------------------------------------------------------------- 편집 막대

/**
 * 배치 조정 막대.
 *
 * 화면에서 직접 끌어 옮기는 것이 기본이고, 슬라이더·숫자 입력은 미세 조정용이다.
 * 저장하기 전에는 아무것도 기록되지 않고, [원래 자리로] 는 기본값으로 되돌린다.
 */
function LayoutEditorBar({
  target,
  layout,
  saving,
  error,
  onSelect,
  onChange,
  onReset,
  onCancel,
  onSave,
}: {
  target: LayoutTarget;
  layout: OverlayLayout;
  saving: boolean;
  error: string | null;
  onSelect: (t: LayoutTarget) => void;
  onChange: (next: OverlayLayout) => void;
  onReset: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { offsetMax, scaleMin, scaleMax } = OVERLAY_LAYOUT_LIMITS;
  /** 지금 값으로 두면 방송 화면 밖으로 얼마나 나가는가 (0 = 다 보임, 1 = 안 보임) */
  const offscreen = offscreenRatio(fallbackRect(target, layout));

  return (
    <div className="rounded-xl border-2 border-brand-200 bg-brand-50/60 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
            <Move size={15} strokeWidth={1.8} className="text-brand-700" />
            배치 조정 중
          </span>
          {/* 화면에서 윤곽선을 눌러도 바뀌지만, 버튼으로도 고를 수 있게 둔다. */}
          <div className="inline-flex rounded-lg border border-ink-200 bg-white p-0.5">
            {(['donation', 'game'] as LayoutTarget[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onSelect(t)}
                className={cx(
                  'h-7 rounded-md px-2.5 text-[12px] font-bold transition-colors',
                  target === t ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:bg-ink-50',
                )}
              >
                {TARGET_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            <Undo2 size={14} strokeWidth={1.8} />
            원래 자리로
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            <X size={14} strokeWidth={1.8} />
            취소
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 size={14} strokeWidth={1.9} className="animate-spin" />
            ) : (
              <Save size={14} strokeWidth={1.8} />
            )}
            {saving ? '저장 중' : '이 배치로 저장'}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
        <LayoutSlider
          label="좌우"
          value={layout.offsetX}
          min={-offsetMax}
          max={offsetMax}
          onChange={(v) => onChange({ ...layout, offsetX: v })}
        />
        <LayoutSlider
          label="위아래"
          value={layout.offsetY}
          min={-offsetMax}
          max={offsetMax}
          onChange={(v) => onChange({ ...layout, offsetY: v })}
        />
        <LayoutSlider
          label="크기"
          value={layout.scalePct}
          min={scaleMin}
          max={scaleMax}
          onChange={(v) => onChange({ ...layout, scalePct: v })}
        />
      </div>

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
        미리보기에서 <b className="text-ink-700">상자를 끌면</b> 옮겨지고,{' '}
        <b className="text-ink-700">네 귀퉁이 손잡이를 끌거나 마우스 휠을 굴리면</b> 크기가 바뀝니다. 방향키로
        1%씩(Shift 5%) 미세 조정할 수 있습니다. 저장하면 방송 중인 OBS·PRISM 화면에도 새로 고침 없이 바로 반영됩니다. 게임의 참여
        QR 은 너무 작아지면 시청자 휴대폰이 인식하지 못하니 크기를 많이 줄이지 마세요.
      </p>

      {/*
        화면 밖으로 밀려났을 때의 경고.
        조절 한도 안에서도 완전히 나갈 수 있는데, 그 상태로 저장하면 방송 화면에
        아무것도 나오지 않는다. 저장을 막지는 않고(일부러 빼 두는 경우도 있다) 알려만 준다.
      */}
      {offscreen > 0.5 ? (
        <div className="mt-2">
          <Notice tone="warning" title={offscreen > 0.98 ? '방송 화면 밖으로 완전히 나갔습니다' : '방송 화면 밖으로 밀려나고 있습니다'}>
            지금 자리로 저장하면 OBS·PRISM 방송 화면에{' '}
            {offscreen > 0.98 ? '아무것도 보이지 않습니다' : `${Math.round((1 - offscreen) * 100)}% 만 보입니다`}.
            되돌리려면 [처음 배치로] 를 누르거나 위 슬라이더를 0 으로 맞춰 주세요.
          </Notice>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
    </div>
  );
}

function LayoutSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-2 text-[12px] font-semibold text-ink-600">
        {label}
        {/* 숫자를 직접 입력할 수 있어야 1% 단위를 맞추기 쉽다. */}
        <span className="inline-flex items-center gap-1">
          <input
            type="number"
            min={min}
            max={max}
            step={1}
            value={value}
            onChange={(e) => {
              /**
               * 숫자 칸을 비우면 `e.target.value` 가 빈 문자열이라 `Number('')` 은 0 이 된다.
               * 위치 값이 0 으로 튀면서 오버레이가 화면 구석으로 순간이동했다.
               * 숫자로 읽히지 않는 입력은 무시하고, 읽히면 허용 범위로 자른다.
               */
              const next = Number(e.target.value);
              if (e.target.value === '' || !Number.isFinite(next)) return;
              onChange(Math.min(max, Math.max(min, Math.round(next))));
            }}
            className="h-7 w-16 rounded-md border border-ink-200 bg-white px-1.5 text-right text-[12px] tabular-nums"
          />
          <span className="text-ink-400">%</span>
        </span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--color-brand-500,#fbb914)]"
      />
    </label>
  );
}


/** 끌기 상태. 이동과 크기 조절을 한 곳에서 다룬다. */
interface DragState {
  mode: 'move' | 'scale';
  x: number;
  y: number;
  base: OverlayLayout;
  /** 크기 조절용: 상자 중심과 시작 거리 */
  cx?: number;
  cy?: number;
  d0?: number;
}

/**
 * 조정 중인 틀 위에 덮는 층 (윤곽선 · 크기 조절 손잡이 · 안전 영역 · 안내선).
 *
 * 오버레이가 알려 준 자기 자리(비율)를 그대로 상자로 그린다. 그래서 배너 크기가 달라져도
 * 윤곽선이 정확히 따라간다. 상자 안을 끌면 이동, 귀퉁이를 끌면 크기다.
 */
function EditSurface({
  frame,
  editing,
  editingLayout,
  rects,
  boxRef,
  snapped,
  dragRef,
  onSelect,
  onKeyDown,
  onDragMove,
  onDragEnd,
  layoutOf,
  onWheelScale,
}: {
  frame: PreviewTab;
  editing: LayoutTarget;
  editingLayout: OverlayLayout;
  rects: Record<string, LayerRect>;
  boxRef: React.RefObject<HTMLDivElement | null>;
  snapped: { x: boolean; y: boolean };
  dragRef: React.RefObject<DragState | null>;
  onSelect: (t: LayoutTarget) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onDragMove: (e: React.PointerEvent<Element>) => void;
  onDragEnd: () => void;
  /** 선택되지 않은 대상의 저장된 배치. 대략 상자를 그릴 때 쓴다. */
  layoutOf: (t: LayoutTarget) => OverlayLayout;
  /** 마우스 휠로 크기 조절 */
  onWheelScale: (deltaY: number) => void;
}) {
  /**
   * 상자 위치. 오버레이가 알려 준 실제 자리를 우선 쓰고, 아직 못 받았으면 대략 상자를 쓴다.
   * 예전에는 실제 자리가 없으면 상자를 그리지 않아 **잡을 것이 없었다.**
   */
  const rectOf = (t: LayoutTarget): { rect: LayerRect; exact: boolean } => {
    const reported = rects[`${frame}:${t}`];
    if (reported) return { rect: reported, exact: true };
    return { rect: fallbackRect(t, t === editing ? editingLayout : layoutOf(t)), exact: false };
  };

  const startMove = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: 'move', x: e.clientX, y: e.clientY, base: editingLayout };
  };

  const startScale = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const { rect: r } = rectOf(editing);
    const el = boxRef.current;
    if (!el) return;
    const b = innerRect(el);
    e.currentTarget.setPointerCapture(e.pointerId);
    const cx = b.left + (r.x + r.w / 2) * b.width;
    const cy = b.top + (r.y + r.h / 2) * b.height;
    dragRef.current = {
      mode: 'scale',
      x: e.clientX,
      y: e.clientY,
      base: editingLayout,
      cx,
      cy,
      d0: Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy)),
    };
  };

  /**
   * 마우스 휠로 크기를 바꾼다.
   *
   * React 의 onWheel 은 passive 로 붙어 preventDefault 가 통하지 않는다. 그대로 두면
   * 크기를 줄이려고 굴릴 때마다 **페이지가 같이 스크롤돼** 조정하던 화면이 사라진다.
   * 그래서 직접(non-passive) 붙인다.
   */
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onWheelScale(e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheelScale]);

  return (
    <div
      ref={surfaceRef}
      className="absolute inset-0 z-30"
      tabIndex={0}
      role="application"
      aria-label={`${TARGET_LABEL[editing]} 배치 조정`}
      onKeyDown={onKeyDown}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
    >
      {/* 아래쪽 안전 영역 — 유튜브 자막·채팅과 겹치는 구간 */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-dashed border-white/45 bg-black/25"
        style={{ height: `${SAFE_BOTTOM_RATIO * 100}%` }}
      >
        <span className="absolute left-2 top-1 text-[10.5px] font-semibold text-white/70">
          유튜브 자막·채팅 영역 (여기는 비워 두세요)
        </span>
      </div>

      {/* 정가운데 안내선 — 붙는 순간에만 */}
      {snapped.x ? <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-brand-400" /> : null}
      {snapped.y ? <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-brand-400" /> : null}

      {(['game', 'donation'] as LayoutTarget[]).map((t) => {
        const { rect: r, exact } = rectOf(t);
        const active = editing === t;
        return (
          <div
            key={t}
            onPointerDown={active ? startMove : undefined}
            onClick={active ? undefined : () => onSelect(t)}
            className={cx(
              'absolute',
              active
                ? 'cursor-move border-2 border-brand-400 bg-brand-400/10'
                : 'cursor-pointer border border-dashed border-white/60',
            )}
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
          >
            <span
              className={cx(
                'absolute -top-6 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-bold',
                active ? 'bg-brand-500 text-ink-900' : 'bg-ink-900/70 text-white',
              )}
            >
              {TARGET_LABEL[t]}
              {active ? '' : ' — 눌러서 선택'}
              {exact ? '' : ' (대략 위치)'}
            </span>

            {/* 끄는 동안 지금 값을 상자 안에 보여 준다. 편집 막대까지 눈을 옮기지 않아도 된다. */}
            {active ? (
              <span className="pointer-events-none absolute -bottom-6 left-0 whitespace-nowrap rounded bg-ink-900/80 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-white">
                가로 {editingLayout.offsetX > 0 ? '+' : ''}{editingLayout.offsetX}% · 세로{' '}
                {editingLayout.offsetY > 0 ? '+' : ''}{editingLayout.offsetY}% · 크기 {editingLayout.scalePct}%
              </span>
            ) : null}

            {/* 네 귀퉁이 크기 조절 손잡이 */}
            {active
              ? ([
                  ['-left-1.5 -top-1.5', 'nwse-resize'],
                  ['-right-1.5 -top-1.5', 'nesw-resize'],
                  ['-left-1.5 -bottom-1.5', 'nesw-resize'],
                  ['-right-1.5 -bottom-1.5', 'nwse-resize'],
                ] as const).map(([pos, cursor]) => (
                  <button
                    key={pos}
                    type="button"
                    aria-label="크기 조절"
                    onPointerDown={startScale}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragEnd}
                    /*
                      보이는 크기는 작게, 집는 영역은 넉넉하게.
                      12px 짜리 점을 정확히 집는 것은 특히 노트북 트랙패드에서 어렵다.
                      before 로 사방 8px 를 더해 실제 클릭 영역을 28px 남짓으로 넓힌다.
                    */
                    className={cx(
                      'absolute h-3.5 w-3.5 rounded-sm border-2 border-brand-500 bg-white shadow-sm',
                      'before:absolute before:-inset-2 before:content-[""]',
                      pos,
                    )}
                    style={{ cursor }}
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 본체

export function BroadcastPreview({
  creatorId,
  donationLayout: savedDonationLayout = DEFAULT_OVERLAY_LAYOUT,
  gameLayout: savedGameLayout = DEFAULT_OVERLAY_LAYOUT,
}: {
  creatorId: string;
  donationLayout?: OverlayLayout;
  gameLayout?: OverlayLayout;
}) {
  const [tab, setTab] = React.useState<PreviewTab>('pc');
  const [showDonation, setShowDonation] = React.useState(true);
  const [showGame, setShowGame] = React.useState(true);

  const [link, setLink] = React.useState<LinkState | null>(null);
  const [meta, setMeta] = React.useState<MetaState | null>(null);
  const [game, setGame] = React.useState<GameLayerState | null>(null);

  /** 값이 바뀌면 그 틀의 iframe 이 새로 마운트되어 SSE 를 다시 연결한다. */
  const [pcKey, setPcKey] = React.useState(0);
  const [mobileKey, setMobileKey] = React.useState(0);
  const pcFrame = React.useRef<HTMLIFrameElement | null>(null);
  const mobileFrame = React.useRef<HTMLIFrameElement | null>(null);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const zoomRef = React.useRef<HTMLDivElement | null>(null);
  const pcBox = React.useRef<HTMLDivElement | null>(null);
  const mobileBox = React.useRef<HTMLDivElement | null>(null);

  // ── 배치 조정 ────────────────────────────────────────
  const [editing, setEditing] = React.useState<LayoutTarget | null>(null);
  const [donationLayout, setDonationLayout] = React.useState<OverlayLayout>(savedDonationLayout);
  const [gameLayout, setGameLayout] = React.useState<OverlayLayout>(savedGameLayout);
  const [savedLayouts, setSavedLayouts] = React.useState({
    donation: savedDonationLayout,
    game: savedGameLayout,
  });
  const [saving, setSaving] = React.useState(false);
  const [layoutError, setLayoutError] = React.useState<string | null>(null);
  /** 오버레이가 알려 준 각 레이어의 자리. `${틀}:${대상}` 으로 저장한다. */
  const [rects, setRects] = React.useState<Record<string, LayerRect>>({});
  /** 정가운데에 붙었는지. 붙는 순간 안내선을 보여 준다. */
  const [snapped, setSnapped] = React.useState<{ x: boolean; y: boolean }>({ x: false, y: false });

  const editingLayout = editing === 'game' ? gameLayout : donationLayout;

  /** 모든 미리보기 iframe(확대 보기 포함)에 메시지를 보낸다. */
  const postToFrames = React.useCallback(
    (message: Record<string, unknown>, filter?: (el: HTMLIFrameElement) => boolean) => {
      const roots = [rootRef.current, zoomRef.current].filter(Boolean) as HTMLElement[];
      for (const root of roots) {
        root.querySelectorAll('iframe').forEach((frame) => {
          if (filter && !filter(frame)) return;
          try {
            frame.contentWindow?.postMessage(message, window.location.origin);
          } catch {
            /* 아직 로드 전 */
          }
        });
      }
    },
    [],
  );

  /**
   * 조정 중인 값을 실시간으로 알린다. 저장 전에도 방송에 나갈 모습 그대로 보인다.
   * 오버레이는 미리보기(preview=1)일 때만 이 메시지를 받는다. 방송용 소스는 무시한다.
   */
  const pushLayout = React.useCallback(
    (target: LayoutTarget, layout: OverlayLayout | null) => {
      postToFrames({ type: 'donaido-overlay-layout', target, layout });
    },
    [postToFrames],
  );

  /** 조정 모드 on/off 를 알린다. 켜지면 오버레이가 예시 화면을 띄우고 자기 자리를 보고한다. */
  const pushEdit = React.useCallback(
    (target: LayoutTarget, on: boolean) => {
      postToFrames({ type: 'donaido-overlay-edit', target, on, frame: 'pc' }, (el) => el.dataset.frame === 'pc');
      postToFrames({ type: 'donaido-overlay-edit', target, on, frame: 'mobile' }, (el) => el.dataset.frame === 'mobile');
      postToFrames({ type: 'donaido-overlay-edit', target, on, frame: 'zoom' }, (el) => el.dataset.frame === 'zoom');
    },
    [postToFrames],
  );

  const updateLayout = React.useCallback(
    (target: LayoutTarget, next: OverlayLayout, snap = false) => {
      let value = { ...next };
      if (snap) {
        const x = Math.abs(value.offsetX) <= SNAP_THRESHOLD;
        const y = Math.abs(value.offsetY) <= SNAP_THRESHOLD;
        if (x) value.offsetX = 0;
        if (y) value.offsetY = 0;
        setSnapped({ x, y });
      }
      value = clampOverlayLayout(value);
      if (target === 'game') setGameLayout(value);
      else setDonationLayout(value);
      pushLayout(target, value);
    },
    [pushLayout],
  );

  const startEditing = React.useCallback(
    (target: LayoutTarget) => {
      setLayoutError(null);
      setEditing(target);
      if (target === 'game') setShowGame(true);
      else setShowDonation(true);
      pushLayout(target, target === 'game' ? gameLayout : donationLayout);
      pushEdit(target, true);
    },
    [pushLayout, pushEdit, gameLayout, donationLayout],
  );

  /** 조정 모드를 켠 직후에는 아직 로드되지 않은 iframe 이 있을 수 있어 잠깐 다시 알린다. */
  React.useEffect(() => {
    if (!editing) return;
    const timer = window.setInterval(() => {
      pushEdit(editing, true);
      pushLayout(editing, editing === 'game' ? gameLayout : donationLayout);
    }, 700);
    const stop = window.setTimeout(() => window.clearInterval(timer), 5000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [editing, pushEdit, pushLayout, gameLayout, donationLayout]);

  const stopEditing = React.useCallback(
    (revert: boolean) => {
      if (!editing) return;
      if (revert) {
        const back = savedLayouts[editing];
        if (editing === 'game') setGameLayout(back);
        else setDonationLayout(back);
        pushLayout(editing, back);
      }
      pushEdit('donation', false);
      pushEdit('game', false);
      setEditing(null);
      setSnapped({ x: false, y: false });
      setLayoutError(null);
    },
    [editing, savedLayouts, pushLayout, pushEdit],
  );

  const saveLayout = React.useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    setLayoutError(null);
    try {
      const res = await fetch('/api/studio/overlay/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: editing, ...editingLayout }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLayoutError(data.error || '배치를 저장하지 못했습니다.');
        return;
      }
      setSavedLayouts((prev) => ({ ...prev, [editing]: editingLayout }));
      pushEdit('donation', false);
      pushEdit('game', false);
      setEditing(null);
      setSnapped({ x: false, y: false });
    } catch {
      setLayoutError('서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  }, [editing, editingLayout, pushEdit]);

  /** 저장된 배치를 기본값으로 되돌린다(조정 모드 밖에서도 쓴다). */
  const resetSaved = React.useCallback(
    async (target: LayoutTarget) => {
      setSaving(true);
      try {
        const res = await fetch('/api/studio/overlay/layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, ...DEFAULT_OVERLAY_LAYOUT }),
        });
        if (!res.ok) return;
        if (target === 'game') setGameLayout(DEFAULT_OVERLAY_LAYOUT);
        else setDonationLayout(DEFAULT_OVERLAY_LAYOUT);
        setSavedLayouts((prev) => ({ ...prev, [target]: DEFAULT_OVERLAY_LAYOUT }));
        pushLayout(target, DEFAULT_OVERLAY_LAYOUT);
      } finally {
        setSaving(false);
      }
    },
    [pushLayout],
  );

  // ── 드래그 · 크기 조절 ────────────────────────────────
  /** 끌기 시작 지점과 그 시점의 배치. mode 로 이동/크기 조절을 구분한다. */
  const drag = React.useRef<DragState | null>(null);

  const activeBox = React.useCallback(
    () => (tab === 'pc' ? pcBox.current : mobileBox.current),
    [tab],
  );

  const onDragMove = React.useCallback(
    (e: React.PointerEvent<Element>) => {
      const start = drag.current;
      const el = activeBox();
      const box = el ? innerRect(el) : null;
      if (!start || !box || !editing || box.width <= 0) return;

      if (start.mode === 'scale') {
        const d = Math.hypot(e.clientX - (start.cx ?? 0), e.clientY - (start.cy ?? 0));
        const ratio = start.d0 && start.d0 > 0 ? d / start.d0 : 1;
        updateLayout(editing, { ...start.base, scalePct: Math.round(start.base.scalePct * ratio) });
        return;
      }

      // 틀 폭이 캔버스 폭(1920)에 대응한다. 화면에서 1px 움직이면 방송에서도 같은 비율로 움직인다.
      const canvasH = (box.width * LAYOUT_CANVAS_HEIGHT) / LAYOUT_CANVAS_WIDTH;
      updateLayout(
        editing,
        {
          offsetX: start.base.offsetX + ((e.clientX - start.x) / box.width) * 100,
          offsetY: start.base.offsetY + ((e.clientY - start.y) / canvasH) * 100,
          scalePct: start.base.scalePct,
        },
        true,
      );
    },
    [editing, updateLayout, activeBox],
  );

  const endDrag = React.useCallback(() => {
    drag.current = null;
    setSnapped({ x: false, y: false });
  }, []);

  /**
   * 마우스 휠로 크기 조절.
   * 귀퉁이 손잡이를 정확히 집지 않아도 되고, 화면을 보면서 바로 키우고 줄일 수 있다.
   * 한 칸에 2%씩 움직인다(너무 크면 지나치고, 너무 작으면 답답하다).
   */
  const onWheelScale = React.useCallback(
    (deltaY: number) => {
      if (!editing) return;
      const cur = editing === 'game' ? gameLayout : donationLayout;
      const step = deltaY > 0 ? -2 : 2;
      updateLayout(editing, { ...cur, scalePct: cur.scalePct + step });
    },
    [editing, gameLayout, donationLayout, updateLayout],
  );

  /** 선택되지 않은 대상의 저장된 배치 (대략 상자용) */
  const layoutOf = React.useCallback(
    (t: LayoutTarget) => (t === 'game' ? gameLayout : donationLayout),
    [gameLayout, donationLayout],
  );

  /** 방향키 미세 조정. 상자에 포커스가 있을 때만 동작한다. */
  const onEditKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!editing) return;
      const step = e.shiftKey ? 5 : 1;
      const cur = editing === 'game' ? gameLayout : donationLayout;
      if (e.key === 'ArrowLeft') updateLayout(editing, { ...cur, offsetX: cur.offsetX - step });
      else if (e.key === 'ArrowRight') updateLayout(editing, { ...cur, offsetX: cur.offsetX + step });
      else if (e.key === 'ArrowUp') updateLayout(editing, { ...cur, offsetY: cur.offsetY - step });
      else if (e.key === 'ArrowDown') updateLayout(editing, { ...cur, offsetY: cur.offsetY + step });
      else if (e.key === 'Escape') stopEditing(true);
      else return;
      e.preventDefault();
    },
    [editing, gameLayout, donationLayout, updateLayout, stopEditing],
  );

  // ── 확대 보기 ────────────────────────────────────────
  const [zoomOpen, setZoomOpen] = React.useState(false);
  const [zoomRotated, setZoomRotated] = React.useState(false);

  const openZoom = React.useCallback(() => {
    setZoomRotated(typeof window !== 'undefined' && window.innerHeight > window.innerWidth);
    setZoomOpen(true);
  }, []);

  React.useEffect(() => {
    if (!zoomOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [zoomOpen]);

  /** 확대 보기가 열리면 지금 조정 중인 값을 그 iframe 에도 전달한다. */
  React.useEffect(() => {
    if (!zoomOpen) return;
    const timer = window.setInterval(() => {
      pushLayout('donation', donationLayout);
      pushLayout('game', gameLayout);
      if (editing) pushEdit(editing, true);
    }, 600);
    const stop = window.setTimeout(() => window.clearInterval(timer), 4000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [zoomOpen, pushLayout, pushEdit, editing, donationLayout, gameLayout]);

  // ── 오버레이가 보내는 소식 ────────────────────────────
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as
        | {
            type?: string;
            creatorId?: string;
            phase?: string;
            retrySec?: number;
            recovered?: number;
            queue?: number;
            theme?: string;
            live?: boolean;
            status?: string;
            participantCount?: number;
            target?: string;
            frame?: string;
            rect?: LayerRect;
          }
        | null;
      if (!data || data.creatorId !== creatorId) return;

      if (data.type === 'donaido-overlay-ready') setLink((prev) => prev ?? { phase: 'connected' });
      if (data.type === 'donaido-overlay-status' && data.phase) {
        setLink({ phase: data.phase, retrySec: data.retrySec, recovered: data.recovered });
      }
      if (data.type === 'donaido-overlay-meta') {
        setMeta({ queue: Number(data.queue ?? 0), theme: String(data.theme ?? '') });
      }
      if (data.type === 'donaido-game-status') {
        setGame({
          phase: String(data.phase ?? ''),
          live: Boolean(data.live),
          status: String(data.status ?? ''),
          participantCount: Number(data.participantCount ?? 0),
        });
      }
      if (data.type === 'donaido-overlay-rect' && data.rect && data.target && data.frame) {
        const key = `${data.frame}:${data.target}`;
        const next = data.rect;
        setRects((prev) => {
          const cur = prev[key];
          if (
            cur &&
            Math.abs(cur.x - next.x) < 0.0008 &&
            Math.abs(cur.y - next.y) < 0.0008 &&
            Math.abs(cur.w - next.w) < 0.0008 &&
            Math.abs(cur.h - next.h) < 0.0008
          ) {
            return prev;
          }
          return { ...prev, [key]: next };
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [creatorId]);

  /** 첫 상태 알림을 놓쳤을 때를 대비한 재문의. */
  React.useEffect(() => {
    if (link) return;
    const ask = () => {
      const msg = { type: 'donaido-overlay-hello' };
      try { pcFrame.current?.contentWindow?.postMessage(msg, window.location.origin); } catch { /* 아직 로드 전 */ }
      try { mobileFrame.current?.contentWindow?.postMessage(msg, window.location.origin); } catch { /* 아직 로드 전 */ }
    };
    ask();
    const timer = window.setInterval(ask, 500);
    const stop = window.setTimeout(() => window.clearInterval(timer), 15000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [link, pcKey, mobileKey]);

  // ── 작은 창(PiP) ─────────────────────────────────────
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const [offscreen, setOffscreen] = React.useState(false);
  const [pipClosed, setPipClosed] = React.useState(false);
  const [placeholder, setPlaceholder] = React.useState(0);
  /** 넓은 화면에서는 왼쪽 열에 고정돼 있으므로 작은 창이 필요 없다. */
  const [wide, setWide] = React.useState(true);

  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setOffscreen(!entry.isIntersecting),
      { threshold: 0.12 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pip = offscreen && !wide && !pipClosed && !editing;

  // 작은 창으로 떠 있는 동안 원래 자리가 무너지지 않도록 높이를 기억해 둔다.
  React.useEffect(() => {
    if (pip) return;
    const el = surfaceRef.current;
    if (el) setPlaceholder(el.offsetHeight);
  }, [pip, tab, editing]);

  // 다시 화면 안으로 들어오면 [닫음] 기억을 지운다.
  // effect 로 처리하면 한 프레임 늦게 반영되고 cascading render 경고가 난다.
  const [prevOffscreen, setPrevOffscreen] = React.useState(offscreen);
  if (prevOffscreen !== offscreen) {
    setPrevOffscreen(offscreen);
    if (!offscreen) setPipClosed(false);
  }

  const isPc = tab === 'pc';
  const donationUrl = `/overlay/${encodeURIComponent(creatorId)}?preview=1`;
  const gameUrl = `/overlay/${encodeURIComponent(creatorId)}/game?preview=1`;
  // 세로형 틀에서는 방송 화면을 위쪽에 붙인다(유튜브 모바일 실제 배치).
  const donationMobileUrl = `${donationUrl}&align=top`;
  const gameMobileUrl = `${gameUrl}&align=top`;

  const reconnect = () => {
    setLink(null);
    setMeta(null);
    setGame(null);
    if (isPc) setPcKey((k) => k + 1);
    else setMobileKey((k) => k + 1);
  };

  return (
    <div ref={wrapRef} style={pip && placeholder > 0 ? { height: placeholder } : undefined}>
      <div
        ref={surfaceRef}
        className={cx(
          'space-y-2.5',
          pip &&
            'fixed bottom-3 right-3 z-40 w-[330px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-ink-200 bg-white p-2 shadow-[0_16px_40px_rgba(0,0,0,0.28)]',
        )}
      >
        {/* 작은 창 머리 — 원래 자리로 돌아가거나 닫는다. */}
        {pip ? (
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-ink-700">
              <PictureInPicture2 size={14} strokeWidth={1.8} className="text-brand-700" />
              방송 화면
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => wrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="rounded-md px-2 py-1 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50"
              >
                원래 자리로
              </button>
              <button
                type="button"
                aria-label="작은 창 닫기"
                onClick={() => setPipClosed(true)}
                className="grid h-6 w-6 place-items-center rounded-md text-ink-400 hover:bg-ink-50"
              >
                <X size={14} strokeWidth={1.9} />
              </button>
            </span>
          </div>
        ) : null}

        {/*
          ── 윗줄: 어떤 화면으로 볼지 + 연결 상태 ───────────
          버튼이 한 줄에 뒤섞이면 무엇이 무엇인지 알 수 없다.
          "무엇으로 보는가(틀)" / "무엇을 보여 줄까(레이어)" / "무엇을 바꾸는가(배치)" 를
          줄과 라벨로 나눠 둔다.
        */}
        <div className={cx('flex flex-wrap items-center justify-between gap-2', pip && 'hidden')}>
          <div
            role="tablist"
            aria-label="미리보기 화면 선택"
            className="inline-flex rounded-xl border border-ink-100 bg-white p-1"
          >
            {TABS.map((t) => {
              const active = tab === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.value)}
                  className={cx(
                    'inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-bold transition-colors',
                    active ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-700',
                  )}
                >
                  <t.Icon size={16} strokeWidth={1.7} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="flex h-9 shrink-0 items-center gap-1.5">
            <ConnectionBadge link={link} game={game} />
            <MetaBadge meta={meta} game={game} />
            <Button type="button" variant="ghost" size="sm" onClick={openZoom}>
              <Maximize2 size={14} strokeWidth={1.7} />
              확대
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reconnect}>
              <RotateCw size={14} strokeWidth={1.7} />
              다시 연결
            </Button>
          </div>
        </div>

        {/* ── 아랫줄: 무엇을 보여 줄까 · 무엇을 옮길까 ─────── */}
        <div className={cx('space-y-2', pip && 'hidden')}>
          {/*
            **[보여 줄 것] 토글은 조정 중에도 계속 보여 준다.**

            예전에는 [위치·크기 조정]을 켜면 이 줄이 편집 막대로 **통째로 바뀌어 사라졌다.**
            그런데 게임 자리를 잡는 동안 후원 알림을 잠깐 끄고 보고 싶은 것이 자연스럽고,
            버튼이 갑자기 없어지면 "어디 갔지" 하고 조정을 취소하게 된다.
            항상 같은 자리에 두고, 편집 막대는 그 아래에 덧붙인다.
          */}
          {editing ? (
            <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] font-extrabold tracking-[0.02em] text-ink-400">
                  미리보기에 보여 줄 것
                </span>
                <LayerToggle
                  on={showDonation}
                  label="후원 알림"
                  Icon={Heart}
                  onClick={() => setShowDonation((v) => !v)}
                />
                <LayerToggle on={showGame} label="게임" Icon={Gamepad2} onClick={() => setShowGame((v) => !v)} />
              </div>
            </div>
          ) : null}

          {editing ? (
            <LayoutEditorBar
              target={editing}
              layout={editingLayout}
              saving={saving}
              error={layoutError}
              onSelect={setEditing}
              onChange={(next) => updateLayout(editing, next)}
              onReset={() => updateLayout(editing, DEFAULT_OVERLAY_LAYOUT)}
              onCancel={() => stopEditing(true)}
              onSave={() => void saveLayout()}
            />
          ) : (
            <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] font-extrabold tracking-[0.02em] text-ink-400">
                    미리보기에 보여 줄 것
                  </span>
                  <LayerToggle
                    on={showDonation}
                    label="후원 알림"
                    Icon={Heart}
                    onClick={() => setShowDonation((v) => !v)}
                  />
                  <LayerToggle
                    on={showGame}
                    label="게임"
                    Icon={Gamepad2}
                    onClick={() => setShowGame((v) => !v)}
                  />
                </div>

                <span className="hidden h-6 w-px bg-ink-200 sm:block" />

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] font-extrabold tracking-[0.02em] text-ink-400">
                    위치·크기 조정
                  </span>
                  {(['donation', 'game'] as LayoutTarget[]).map((t) => (
                    <Button key={t} type="button" variant="secondary" size="sm" onClick={() => startEditing(t)}>
                      <Move size={14} strokeWidth={1.8} />
                      {TARGET_LABEL[t]}
                      {isDefaultOverlayLayout(savedLayouts[t]) ? null : <Badge tone="brand">조정됨</Badge>}
                    </Button>
                  ))}
                  {/* 조정 모드에 들어가지 않고도 되돌릴 수 있어야 한다. */}
                  {isDefaultOverlayLayout(savedLayouts.donation) &&
                  isDefaultOverlayLayout(savedLayouts.game) ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => {
                        void resetSaved('donation');
                        void resetSaved('game');
                      }}
                    >
                      <Undo2 size={14} strokeWidth={1.8} />
                      처음 배치로
                    </Button>
                  )}
                </div>
              </div>

              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
                <b className="text-ink-500">보여 줄 것</b>은 이 미리보기 화면에서만 켜고 끕니다 — 실제 방송에는
                영향이 없습니다. 후원 알림과 게임이 서로 겹치는지 확인할 때 씁니다.{' '}
                <b className="text-ink-500">위치·크기 조정</b>은 실제 방송에 나가는 자리와 크기를 바꿉니다.
              </p>
            </div>
          )}
        </div>

        {/* ── PC 방송 (16:9) ──────────────────────────────── */}
        {/* 감출 때도 마운트를 유지한다. 다시 마운트되면 SSE 가 끊긴다. */}
        <div role="tabpanel" hidden={!isPc && !pip} className={cx('space-y-2.5', !isPc && !pip && 'hidden')}>
          <p className={cx('flex items-center gap-1.5 text-[13px] font-bold text-ink-900', pip && 'hidden')}>
            <MonitorPlay size={16} strokeWidth={1.7} className="shrink-0 text-brand-700" />
            OBS · PRISM 에 나가는 화면과 같습니다 (1920x1080 을 그대로 그린 뒤 축소)
          </p>

          <div
            ref={pcBox}
            className="relative w-full overflow-hidden rounded-xl border border-ink-200"
            style={{ aspectRatio: '16 / 9', ...CHECKERBOARD_STYLE }}
          >
            <Layers
              frame="pc"
              donationUrl={donationUrl}
              gameUrl={gameUrl}
              showDonation={showDonation}
              showGame={showGame}
              frameKey={pcKey}
              donationRef={pcFrame}
            />
            {isPc && editing ? (
              <EditSurface
                frame="pc"
                editing={editing}
                editingLayout={editingLayout}
                rects={rects}
                boxRef={pcBox}
                snapped={snapped}
                dragRef={drag}
                onSelect={setEditing}
                onKeyDown={onEditKeyDown}
                onDragMove={onDragMove}
                onDragEnd={endDrag}
                layoutOf={layoutOf}
                onWheelScale={onWheelScale}
              />
            ) : null}
          </div>
        </div>

        {/* ── 모바일 (세로형) ─────────────────────────────── */}
        <div role="tabpanel" hidden={isPc || pip} className={cx('space-y-2.5', (isPc || pip) && 'hidden')}>
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
            <Smartphone size={16} strokeWidth={1.7} className="shrink-0 text-brand-700" />
            시청자가 휴대폰 세로 화면으로 볼 때 ({MOBILE_WIDTH}px 기준)
          </p>

          <div className="flex justify-center rounded-xl border border-ink-100 bg-[#1c1c1e] px-3 py-4">
            <div
              ref={mobileBox}
              className="relative overflow-hidden shadow-[0_14px_36px_rgba(0,0,0,0.5)]"
              style={{
                borderWidth: MOBILE_BEZEL,
                borderStyle: 'solid',
                borderColor: '#3a3a3c',
                borderRadius: 34,
                width: MOBILE_WIDTH + MOBILE_BEZEL * 2,
                maxWidth: '100%',
                height: MOBILE_HEIGHT + MOBILE_BEZEL * 2,
                ...CHECKERBOARD_STYLE,
              }}
            >
              <Layers
                frame="mobile"
                donationUrl={donationMobileUrl}
                gameUrl={gameMobileUrl}
                showDonation={showDonation}
                showGame={showGame}
                frameKey={mobileKey}
                donationRef={mobileFrame}
              />
              {!isPc && editing ? (
                <EditSurface
                  frame="mobile"
                  editing={editing}
                  editingLayout={editingLayout}
                  rects={rects}
                  boxRef={mobileBox}
                  snapped={snapped}
                  dragRef={drag}
                  onSelect={setEditing}
                  onKeyDown={onEditKeyDown}
                  onDragMove={onDragMove}
                  onDragEnd={endDrag}
                  layoutOf={layoutOf}
                  onWheelScale={onWheelScale}
                />
              ) : null}
            </div>
          </div>
        </div>

        <p className={cx('text-[12px] leading-relaxed text-ink-400', pip && 'hidden')}>
          체커보드 무늬는 투명 배경을 보여 주기 위한 것으로, 실제 방송에서는 방송 화면이 그대로 비칩니다. 이
          미리보기 연결은 방송용 브라우저 소스 연결과 따로 관리되므로 방송 중에 열어 두어도 OBS 연결이 끊기지
          않습니다. 브라우저 자동재생 정책에 따라 이 창에서는 음성이 나오지 않을 수 있습니다.
        </p>
      </div>

      {/* ── 확대 보기 ────────────────────────────────────── */}
      {zoomOpen ? (
        <Portal>
          <div className="fixed inset-0 z-[95] bg-black" ref={zoomRef}>
            <div
              className="absolute overflow-hidden"
              style={
                zoomRotated
                  ? {
                      left: '50%',
                      top: '50%',
                      width: '100dvh',
                      height: '100dvw',
                      transform: 'translate(-50%, -50%) rotate(90deg)',
                      ...CHECKERBOARD_STYLE,
                    }
                  : { inset: 0, ...CHECKERBOARD_STYLE }
              }
            >
              <Layers
                frame="zoom"
                donationUrl={donationUrl}
                gameUrl={gameUrl}
                showDonation={showDonation}
                showGame={showGame}
                frameKey={0}
              />
            </div>

            <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoomRotated((v) => !v)}
                aria-label={zoomRotated ? '세로로 보기' : '가로로 보기'}
                className="inline-flex h-10 items-center gap-1.5 rounded-full bg-white/90 px-3.5 text-[13px] font-bold text-ink-900 shadow-lg"
              >
                <RotateCcw size={16} strokeWidth={1.8} />
                {zoomRotated ? '세로로' : '가로로'}
              </button>
              <button
                type="button"
                onClick={() => setZoomOpen(false)}
                aria-label="확대 보기 닫기"
                className="grid h-10 w-10 place-items-center rounded-full bg-white/90 text-ink-900 shadow-lg"
              >
                <X size={18} strokeWidth={1.9} />
              </button>
            </div>
          </div>
        </Portal>
      ) : null}
    </div>
  );
}
