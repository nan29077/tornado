'use client';

import * as React from 'react';
import {
  BarChart3,
  Check,
  Disc3,
  Eye,
  EyeOff,
  ExternalLink,
  Hash,
  HelpCircle,
  ListOrdered,
  Loader2,
  Maximize2,
  Network,
  Pencil,
  Play,
  QrCode,
  RotateCcw,
  Square,
  Target,
  Trash2,
  Trophy,
  Undo2,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Notice, SectionTitle, cx } from '@/components/ui';
import { Portal } from '@/components/ui/portal';
import { ConfirmDialog, type ConfirmPhase } from '@/components/studio/confirm-dialog';
import { CopyButton } from '@/components/studio/copy';
import { GameForm, emptyGameForm, type GameFormValue } from '@/components/studio/game-form';
import {
  GAME_TYPE_META,
  ROUND_STATUS_LABEL,
  usesChoices,
  usesDonationTotal,
  usesEntries,
  usesItems,
  type GameType,
  type RoundStatus,
} from '@/lib/game-catalog';

/**
 * 게임 오버레이 운영 화면.
 *
 * UX 원칙 (방송 중에 쓰는 화면이다)
 *  1. 한 화면에서 끝난다 — 띄우기 → 마감 → 발표까지 페이지 이동이 없다.
 *  2. 지금 눌러야 할 버튼 하나만 크게 강조한다. 나머지는 약하게 둔다.
 *  3. 진행 버튼에는 확인 알림창을 두지 않는다. 확인창은 방송 타이밍을 죽인다.
 *     대신 되돌릴 수 있는 길을 준다(마감 취소 · 발표 취소 · 5초 실행취소).
 *  4. 되돌릴 수 없는 동작(게임 삭제)만 확인창을 띄운다.
 *  5. 시선 이동을 줄인다 — 컨트롤 옆에 실제 방송 화면 미리보기를 붙인다.
 *
 * 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
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

interface WinnerView {
  rank: number;
  name: string;
  prize: string;
  detail?: string;
  fulfilled?: boolean;
}

interface StudioState {
  creatorId: string;
  gameId: string;
  roundId: string;
  type: string;
  title: string;
  status: RoundStatus;
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
  winners: WinnerView[];
  updatedAt: string;
  secret: Record<string, unknown>;
  recentParticipants: { id: string; name: string; entry: string | null; source: string; at: string; correct?: boolean }[];
  autoCloseSec: number;
  entryMode: string;
}

interface GameRow {
  id: string;
  type: string;
  title: string;
  items: string[];
  config: Record<string, unknown>;
  entryMode: string;
  donationMinAmount: number;
  autoCloseSec: number;
  createdAt: string;
  lastRound: { id: string; status: string; seq: number } | null;
}

interface HistoryRow {
  id: string;
  seq: number;
  title: string;
  type: string;
  openedAt: string;
  revealedAt: string | null;
  participantCount: number;
  winners: { id: string; rank: number; name: string; prize: string; fulfilled: boolean }[];
}

type Action = 'start' | 'spin' | 'close' | 'reopen' | 'reveal' | 'undo' | 'end' | 'trace';

/**
 * 오류가 난 자리.
 *
 * 예전에는 오류 문구를 화면 맨 위에 한 곳에만 띄웠다. 그런데 [화면에 띄우기] 는 목록 아래쪽에
 * 있어서, 실패해도 문구가 화면 밖(위쪽)에 떠 크리에이터에게는 "눌러도 아무 반응이 없는" 것으로
 * 보였다. 그래서 **누른 버튼 근처**에 띄우고, 동시에 토스트로도 알린다.
 */
type ErrorScope = 'control' | 'list' | 'form';

const NETWORK_ERROR =
  '서버에 연결하지 못했습니다. 인터넷 연결과 서버 상태를 확인한 뒤 다시 눌러 주세요.';

/** 서버가 문구를 주지 않았을 때, 상태 코드만으로도 무엇을 해야 할지 알려 준다. */
function messageForStatus(status: number): string {
  if (status === 401) return '로그인이 풀렸습니다. 화면을 새로고침한 뒤 다시 로그인해 주세요.';
  if (status === 403) return '이 작업을 할 권한이 없습니다.';
  if (status === 404) return '대상을 찾을 수 없습니다. 목록을 새로고침해 주세요.';
  if (status === 429) return '요청이 너무 잦습니다. 잠시 뒤 다시 눌러 주세요.';
  if (status >= 500) return '서버에서 오류가 났습니다. 잠시 뒤 다시 눌러 주세요.';
  return `처리에 실패했습니다. (${status})`;
}

export function GameStudio({ creatorId, compact = false }: { creatorId: string; compact?: boolean }) {
  const [games, setGames] = React.useState<GameRow[]>([]);
  const [history, setHistory] = React.useState<HistoryRow[]>([]);
  const [state, setState] = React.useState<StudioState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<{ text: string; undo?: () => void } | null>(null);
  const [problem, setProblem] = React.useState<{ scope: ErrorScope; text: string } | null>(null);

  const [form, setForm] = React.useState<GameFormValue | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [previewGameId, setPreviewGameId] = React.useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = React.useState<GameRow | null>(null);
  const [removePhase, setRemovePhase] = React.useState<ConfirmPhase>('closed');

  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = React.useCallback((text: string, undo?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 5000 : 2600);
  }, []);

  /**
   * 실패를 알린다.
   * 문구는 누른 자리에 남겨 두고(스크롤해도 다시 찾을 수 있게), 토스트로 한 번 더 띄운다.
   * 토스트는 화면 아래 고정이라 목록 어디까지 내려가 있어도 반드시 보인다.
   */
  const fail = React.useCallback(
    (scope: ErrorScope, text: string) => {
      setProblem({ scope, text });
      showToast(text);
    },
    [showToast],
  );

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/studio/games', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setGames(data.games ?? []);
      setHistory(data.history ?? []);
      setState(data.state ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // 참여자 유입·집계는 SSE 로 흘러온다. 화면을 새로 고칠 일이 없다.
  React.useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const es = new EventSource('/api/studio/games/stream');
      source = es;
      es.addEventListener('state', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as StudioState | null;
          setState(data && data.roundId ? data : null);
          retry = 0;
        } catch {
          /* 무시 */
        }
      });
      es.onerror = () => {
        es.close();
        if (disposed) return;
        const wait = retry === 0 ? 400 : Math.min(30000, 1000 * 2 ** retry);
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
  }, []);

  const control = React.useCallback(
    async (action: Action, extra?: Record<string, unknown>) => {
      setBusy(true);
      setProblem(null);
      try {
        const res = await fetch('/api/studio/games/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, gameId: state?.gameId, roundId: state?.roundId, ...extra }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          fail('control', data.error || messageForStatus(res.status));
          return false;
        }
        setState(data.state ?? null);
        void load();
        return true;
      } catch {
        fail('control', NETWORK_ERROR);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [state?.gameId, state?.roundId, load, fail],
  );

  const startGame = React.useCallback(
    async (gameId: string) => {
      setBusy(true);
      setProblem(null);
      try {
        const res = await fetch('/api/studio/games/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', gameId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          fail('list', data.error || messageForStatus(res.status));
          return;
        }
        setState(data.state ?? null);
        setPreviewGameId(null);
        showToast('방송 화면에 띄웠습니다');
        void load();
      } catch {
        // 예전에는 catch 가 없어 네트워크 실패를 통째로 삼켰다.
        // 버튼만 잠깐 눌렸다 돌아오고 아무 문구도 뜨지 않아 "안 된다"로만 보였다.
        fail('list', NETWORK_ERROR);
      } finally {
        setBusy(false);
      }
    },
    [load, showToast, fail],
  );

  // ------------------------------------------------------- 주 동작 결정
  const primary = React.useMemo(() => {
    if (!state) return null;
    const item = usesItems(state.type);
    const donation = usesDonationTotal(state.type);

    if (state.status === 'OPEN') {
      if (item) return { key: 'spin' as Action, label: '돌리기', Icon: Play };
      if (donation) return { key: 'reveal' as Action, label: '결과 확정', Icon: Trophy };
      return { key: 'close' as Action, label: '참여 마감', Icon: Square };
    }
    if (state.status === 'CLOSED') return { key: 'reveal' as Action, label: '결과 발표', Icon: Trophy };
    return { key: 'end' as Action, label: '화면에서 내리기', Icon: X };
  }, [state]);

  const runPrimary = React.useCallback(async () => {
    if (!state || !primary || busy) return;
    const ok = await control(primary.key);
    if (!ok) return;

    if (primary.key === 'close') {
      showToast('참여를 마감했습니다', () => void control('reopen'));
    } else if (primary.key === 'reveal' || primary.key === 'spin') {
      // 발표는 되돌릴 수 있게 5초 실행취소를 준다. 확인창 대신이다.
      showToast('결과를 발표했습니다', () => void control('undo'));
    } else if (primary.key === 'end') {
      showToast('화면에서 내렸습니다');
    }
  }, [state, primary, busy, control, showToast]);

  /**
   * 단축키.
   *
   * 방송 중에 쓰는 단축키라 잘못 걸리면 그대로 방송 사고가 된다. 그래서 세 겹으로 막는다.
   *  1. 입력 칸(input·textarea·select·직접 편집)에 커서가 있을 때
   *  2. **게임 폼이 열려 있을 때** — 예전에는 여기가 뚫려 있었다. 폼의 [게임 종류] 카드는
   *     버튼이라 1번 조건에 걸리지 않아, 카드에 포커스를 두고 Space·Enter 를 누르면
   *     카드 선택과 동시에 진행 중인 회차가 마감·발표됐다.
   *  3. **버튼·링크에 포커스가 있을 때** — 브라우저가 그 버튼을 누르는 것과 전역 단축키가
   *     겹쳐 두 가지가 한 번에 실행되는 것을 막는다.
   * 확인창이 떠 있을 때도 쉰다. 그때 Space·Enter 는 확인창의 것이다.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // target 이 항상 요소인 것은 아니다(window 로 들어오는 합성 이벤트 등). 먼저 좁혀 둔다.
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;
      if (el?.getAttribute('role') === 'button') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (form || removePhase !== 'closed') return;

      if (e.key === 'Escape') {
        setQrOpen(false);
        return;
      }
      if (!state) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        void runPrimary();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (state.status === 'CLOSED') void control('reopen');
        else if (state.status === 'RESULT') void control('undo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, runPrimary, control, form, removePhase]);

  // --------------------------------------------------------------- 저장
  const saveForm = async () => {
    if (!form) return;
    setBusy(true);
    setProblem(null);
    try {
      const payload = {
        type: form.type,
        title: form.title,
        items: form.items,
        config: form.config,
        entryMode: form.entryMode,
        donationMinAmount: form.donationMinAmount,
        autoCloseSec: form.autoCloseSec,
      };
      const res = editingId
        ? await fetch(`/api/studio/games/${editingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/studio/games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail('form', data.error || messageForStatus(res.status));
        return;
      }
      setForm(null);
      setEditingId(null);
      showToast(editingId ? '수정했습니다' : '게임을 만들었습니다');
      void load();
    } catch {
      fail('form', NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const removeGame = async () => {
    if (!removeTarget) return;
    setRemovePhase('busy');
    try {
      const res = await fetch(`/api/studio/games/${removeTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        // 실패했는데 "삭제했습니다" 화면을 띄우면 안 된다. 알림창을 닫고 이유를 보여 준다.
        const data = await res.json().catch(() => ({}));
        setRemovePhase('closed');
        setRemoveTarget(null);
        fail('list', data.error || messageForStatus(res.status));
        return;
      }
      setRemovePhase('done');
      if (previewGameId === removeTarget.id) setPreviewGameId(null);
      void load();
    } catch {
      setRemovePhase('closed');
      setRemoveTarget(null);
      fail('list', NETWORK_ERROR);
    }
  };

  const toggleFulfilled = async (winnerId: string, done: boolean) => {
    await fetch('/api/studio/games/winner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winnerId, done }),
    });
    void load();
  };

  const openPopout = () => {
    window.open(
      '/game-control',
      'donaido-game-control',
      'width=460,height=820,menubar=no,toolbar=no,location=no,status=no',
    );
  };

  // ------------------------------------------------------------- 렌더

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      {/*
        진행 컨트롤에서 난 오류만 여기에 띄운다. 목록·폼에서 난 오류는 그 자리에 띄운다.
        단 팝아웃 창(compact)은 목록·폼 자체가 없으므로 모든 오류를 여기서 받는다.
      */}
      {problem && (compact || problem.scope === 'control') ? (
        <Notice tone="danger">{problem.text}</Notice>
      ) : null}

      {/* 1. 진행 컨트롤 */}
      {state ? (
        <ControlPanel
          state={state}
          creatorId={creatorId}
          primary={primary}
          busy={busy}
          compact={compact}
          onPrimary={runPrimary}
          onAction={control}
          onQr={() => setQrOpen(true)}
          onPopout={openPopout}
        />
      ) : compact ? (
        // 팝아웃 창에서도 게임을 바로 띄울 수 있어야 한다. 방송 중에 큰 창으로 돌아가지 않도록.
        <Card>
          <CardTitle>띄울 게임을 고르세요</CardTitle>
          {games.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-400">
              아직 만든 게임이 없습니다. 스튜디오의 [후원·게임 오버레이] 화면에서 먼저 만들어 주세요.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {games.map((g) => {
                const meta = GAME_TYPE_META[g.type as GameType];
                const Icon = ICONS[meta?.icon ?? 'Disc3'] ?? Disc3;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => void startGame(g.id)}
                    disabled={busy}
                    className="flex w-full items-center gap-2.5 rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-left hover:bg-ink-50 disabled:opacity-50"
                  >
                    <Icon size={18} strokeWidth={1.7} className="shrink-0 text-brand-700" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink-900">{g.title}</span>
                    <Play size={15} strokeWidth={1.9} className="shrink-0 text-ink-400" />
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <EmptyState
            title="지금 방송 화면에 띄운 게임이 없습니다"
            description="아래 목록에서 게임을 골라 [화면에 띄우기]를 누르면 여기에 진행 컨트롤이 나타납니다."
          />
        </Card>
      )}

      {compact ? null : (
        <>
          {/* 2. 게임 목록 */}
          <section>
            <SectionTitle
              title="내 게임"
              description="자주 쓰는 게임을 만들어 두고 방송 때 골라 띄웁니다."
              action={
                form ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditingId(null);
                      setProblem(null);
                      setForm(emptyGameForm());
                    }}
                  >
                    새 게임 만들기
                  </Button>
                )
              }
            />

            {problem?.scope === 'list' ? (
              <div className="mb-2.5">
                <Notice tone="danger">{problem.text}</Notice>
              </div>
            ) : null}
            {form && problem?.scope === 'form' ? (
              <div className="mb-2.5">
                <Notice tone="danger">{problem.text}</Notice>
              </div>
            ) : null}

            {form ? (
              <GameForm
                value={form}
                onChange={setForm}
                onSubmit={saveForm}
                onCancel={() => {
                  setForm(null);
                  setEditingId(null);
                  setProblem(null);
                }}
                busy={busy}
                mode={editingId ? 'edit' : 'create'}
              />
            ) : loading ? (
              <Card>
                <p className="py-6 text-center text-[13px] text-ink-400">불러오는 중</p>
              </Card>
            ) : games.length === 0 ? (
              <Card>
                <EmptyState
                  title="아직 만든 게임이 없습니다"
                  description="룰렛·투표·퀴즈 등 8가지 중에서 고를 수 있습니다."
                  action={
                    <Button
                      onClick={() => {
                        setEditingId(null);
                        setProblem(null);
                        setForm(emptyGameForm());
                      }}
                    >
                      첫 게임 만들기
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-2.5 lg:grid-cols-2">
                {games.map((g) => {
                  const meta = GAME_TYPE_META[g.type as GameType];
                  const Icon = ICONS[meta?.icon ?? 'Disc3'] ?? Disc3;
                  const live = state?.gameId === g.id;
                  return (
                    <Card key={g.id}>
                      <div className="flex items-start gap-3">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
                          <Icon size={20} strokeWidth={1.7} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <CardTitle className="truncate">{g.title}</CardTitle>
                            {live ? <Badge tone="success">방송 중</Badge> : null}
                          </div>
                          <p className="mt-0.5 text-[12px] text-ink-400">
                            {meta?.label}
                            {usesEntries(g.type) ? ` · ${g.autoCloseSec > 0 ? `${g.autoCloseSec}초 자동 마감` : '수동 마감'}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => void startGame(g.id)} disabled={busy || live}>
                          <Play size={15} strokeWidth={1.8} />
                          {live ? '띄우는 중' : '화면에 띄우기'}
                        </Button>
                        {/*
                          띄우기 전에 방송 화면을 확인한다.
                          회차를 만들지 않으므로 진행 이력에 아무것도 남지 않는다.
                        */}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setPreviewGameId((cur) => (cur === g.id ? null : g.id))}
                        >
                          {previewGameId === g.id ? (
                            <>
                              <EyeOff size={15} strokeWidth={1.8} /> 미리보기 닫기
                            </>
                          ) : (
                            <>
                              <Eye size={15} strokeWidth={1.8} /> 미리보기
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={live}
                          onClick={() => {
                            setEditingId(g.id);
                            setProblem(null);
                            setForm({
                              type: g.type as GameType,
                              title: g.title,
                              items: g.items.length ? g.items : ['', ''],
                              config: g.config,
                              entryMode: g.entryMode as GameFormValue['entryMode'],
                              donationMinAmount: g.donationMinAmount,
                              autoCloseSec: g.autoCloseSec,
                            });
                          }}
                        >
                          <Pencil size={15} strokeWidth={1.8} /> 수정
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={live}
                          onClick={() => {
                            setRemoveTarget(g);
                            setRemovePhase('ask');
                          }}
                        >
                          <Trash2 size={15} strokeWidth={1.8} /> 삭제
                        </Button>
                      </div>
                      {live ? (
                        <p className="mt-2 text-[12px] text-ink-400">
                          방송 중인 게임은 수정·삭제할 수 없습니다. 화면에서 내린 뒤 바꿔 주세요.
                        </p>
                      ) : null}

                      {previewGameId === g.id ? (
                        <div className="mt-3">
                          <p className="mb-1.5 text-[12px] font-semibold text-ink-500">
                            띄우면 이렇게 보입니다 — 참여자 0명 기준의 고정 화면입니다.
                          </p>
                          <div className="overflow-hidden rounded-xl border border-ink-100" style={CHECKER_STYLE}>
                            <div className="relative w-full" style={{ paddingTop: '56.25%' }}>
                              <iframe
                                title={`${g.title} 미리보기`}
                                src={`/overlay/${encodeURIComponent(creatorId)}/game?preview=1&sample=${encodeURIComponent(g.id)}`}
                                className="absolute inset-0 h-full w-full"
                              />
                            </div>
                          </div>
                          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">
                            회차를 만들지 않는 확인용 화면이라 방송에는 나가지 않고 진행 이력에도 남지
                            않습니다. QR 은 자리만 보여 주는 것이라 찍어도 참여되지 않습니다.
                          </p>
                        </div>
                      ) : null}
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {/* 3. 진행 이력 */}
          <section>
            <SectionTitle
              title="진행 이력"
              description="지난 회차의 참여자 수와 당첨자입니다. 보상을 전달했으면 체크해 두세요."
            />
            <Card>
              {history.length === 0 ? (
                <p className="py-4 text-center text-[13px] text-ink-400">아직 진행한 게임이 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {history.map((h) => (
                    <div key={h.id} className="rounded-xl border border-ink-100 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13.5px] font-bold text-ink-900">{h.title}</span>
                        <Badge tone="neutral">{h.seq}회차</Badge>
                        <span className="text-[12px] text-ink-400">참여 {h.participantCount}명</span>
                      </div>
                      {h.winners.length > 0 ? (
                        <div className="mt-2 space-y-1.5">
                          {h.winners.map((w) => (
                            <label key={w.id} className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={w.fulfilled}
                                onChange={(e) => void toggleFulfilled(w.id, e.target.checked)}
                                className="h-4 w-4 rounded border-ink-300 text-brand-700 focus:ring-brand-300"
                              />
                              <span className="text-[13px] font-semibold text-ink-700">
                                {w.rank}등 · {w.name}
                                {w.prize ? <span className="ml-1.5 text-ink-400">{w.prize}</span> : null}
                              </span>
                              {w.fulfilled ? <Badge tone="success">전달 완료</Badge> : null}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[12px] text-ink-400">당첨자 기록이 없는 회차입니다.</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </section>
        </>
      )}

      {/* QR 크게 보기 */}
      {qrOpen && state?.joinUrl ? (
        <Portal>
          <div
            className="fixed inset-0 z-[80] grid place-items-center bg-ink-900/80 p-6"
            onClick={() => setQrOpen(false)}
          >
            <div className="rounded-3xl bg-white p-8 text-center" onClick={(e) => e.stopPropagation()}>
              <QrImage url={state.joinUrl} size={360} />
              <p className="mt-4 text-[22px] font-black tracking-[0.3em] text-ink-900">{state.joinCode}</p>
              <p className="mt-1 text-[13px] text-ink-400">시청자에게 화면을 보여 주세요</p>
              <Button variant="secondary" className="mt-4" onClick={() => setQrOpen(false)}>
                닫기
              </Button>
            </div>
          </div>
        </Portal>
      ) : null}

      {/* 실행취소 토스트 */}
      {toast ? (
        <Portal>
          <div className="fixed inset-x-0 bottom-6 z-[90] flex justify-center px-4">
            <div className="flex items-center gap-3 rounded-2xl bg-ink-900 px-5 py-3.5 text-white shadow-[var(--shadow-lift)]">
              <span className="text-[13.5px] font-semibold">{toast.text}</span>
              {toast.undo ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.undo?.();
                    setToast(null);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-[12.5px] font-bold"
                >
                  <Undo2 size={14} strokeWidth={1.9} /> 실행취소
                </button>
              ) : null}
            </div>
          </div>
        </Portal>
      ) : null}

      <ConfirmDialog
        phase={removePhase}
        title={`"${removeTarget?.title ?? ''}" 게임을 삭제할까요?`}
        description="목록에서 사라집니다. 지난 회차의 참여자·당첨자 기록은 이력에 그대로 남습니다."
        confirmLabel="삭제"
        variant="danger"
        doneOk
        doneTitle="삭제했습니다"
        onConfirm={() => void removeGame()}
        onClose={() => {
          setRemovePhase('closed');
          setRemoveTarget(null);
        }}
      />
    </div>
  );
}

// --------------------------------------------------------------- 컨트롤 패널

function ControlPanel({
  state,
  creatorId,
  primary,
  busy,
  compact,
  onPrimary,
  onAction,
  onQr,
  onPopout,
}: {
  state: StudioState;
  creatorId: string;
  primary: { key: Action; label: string; Icon: React.ComponentType<{ size?: number; strokeWidth?: number }> } | null;
  busy: boolean;
  compact: boolean;
  onPrimary: () => void;
  onAction: (a: Action, extra?: Record<string, unknown>) => Promise<boolean>;
  onQr: () => void;
  onPopout: () => void;
}) {
  const meta = GAME_TYPE_META[state.type as GameType];
  const Icon = ICONS[meta?.icon ?? 'Disc3'] ?? Disc3;
  const item = usesItems(state.type);
  const entry = usesEntries(state.type);
  /** 참여 주소가 이 컴퓨터 안에서만 통하는 주소인지 (휴대폰에서 QR 이 열리지 않는다) */
  const localOnlyJoinUrl = Boolean(state.joinUrl && /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(state.joinUrl));

  return (
    <Card className="sticky top-2 z-30">
      {/* 상태 줄 — 높이를 고정한다. 상태가 바뀌어도 아래 내용이 위아래로 흔들리지 않는다. */}
      <div className="flex h-11 items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon size={18} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-black text-ink-900">{state.title}</p>
          <p className="text-[11.5px] text-ink-400">{meta?.label}</p>
        </div>
        <StatusBadge status={state.status} />
        {entry ? (
          <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-ink-50 px-2.5 text-[13px] font-bold text-ink-700 tabular-nums">
            <Users size={14} strokeWidth={1.8} className="text-ink-400" />
            {state.participantCount}
          </span>
        ) : null}
        <RemainBadge closesAt={state.closesAt} status={state.status} />
      </div>

      {/* 주 버튼 — 지금 눌러야 하는 것 하나만 크게 */}
      <div className="mt-3 flex flex-wrap gap-2">
        {primary ? (
          // size="lg" 는 폭 100% 다. 바깥 칸을 flex 로 잡아 다른 버튼과 한 줄에 놓는다.
          <div className="min-w-[200px] flex-1">
            <Button size="lg" onClick={onPrimary} disabled={busy}>
              {busy ? (
                <Loader2 size={18} strokeWidth={1.9} className="animate-spin" />
              ) : (
                <primary.Icon size={18} strokeWidth={1.9} />
              )}
              {primary.label}
            </Button>
          </div>
        ) : null}

        {/* 되돌리기 · 부가 동작 */}
        {state.status === 'OPEN' && entry ? (
          <Button variant="secondary" onClick={() => void onAction('reveal')} disabled={busy}>
            <Trophy size={16} strokeWidth={1.8} /> 바로 발표
          </Button>
        ) : null}
        {state.status === 'CLOSED' ? (
          <Button variant="secondary" onClick={() => void onAction('reopen')} disabled={busy}>
            <RotateCcw size={16} strokeWidth={1.8} /> 마감 취소
          </Button>
        ) : null}
        {state.status === 'RESULT' ? (
          <Button variant="secondary" onClick={() => void onAction('undo')} disabled={busy}>
            <Undo2 size={16} strokeWidth={1.8} /> 발표 취소
          </Button>
        ) : null}
        {state.status !== 'RESULT' ? (
          <Button variant="ghost" onClick={() => void onAction('end')} disabled={busy}>
            <X size={16} strokeWidth={1.8} /> 내리기
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => void onAction('start', { gameId: state.gameId })} disabled={busy}>
            <RotateCcw size={16} strokeWidth={1.8} /> 한 판 더
          </Button>
        )}
      </div>

      {/* 사다리 — 번호를 골라 그 줄만 굵게 따라간다 */}
      {state.type === 'LADDER' && (state.status === 'OPEN' || state.status === 'RESULT') ? (
        <div className="mt-3">
          <p className="mb-1.5 text-[12px] font-semibold text-ink-500">
            {state.status === 'OPEN'
              ? '번호를 고르면 그 줄만 따라 그리며 시작합니다. 그냥 [돌리기]를 누르면 전체 결과가 한 번에 나옵니다.'
              : '번호를 바꿔 누르면 그 줄을 다시 따라갑니다. 결과는 이미 확정돼 바뀌지 않습니다.'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {state.items.map((label, i) => {
              const active = Number(state.result?.activeIndex) === i;
              return (
                <button
                  key={`${label}-${i}`}
                  type="button"
                  onClick={() =>
                    void onAction(state.status === 'OPEN' ? 'spin' : 'trace', { selectedIndex: i })
                  }
                  disabled={busy}
                  className={cx(
                    'rounded-lg border px-3 py-2 text-[12.5px] font-bold disabled:opacity-40',
                    active
                      ? 'border-brand-400 bg-brand-50 text-brand-800'
                      : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                  )}
                >
                  {i + 1}. {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* 실시간 현황 + 미리보기 */}
      <div className={cx('mt-4 grid gap-3', compact ? '' : 'lg:grid-cols-2')}>
        <div className="min-w-0">
          <LiveTally state={state} />
        </div>

        <div className="min-w-0">
          <p className="mb-1.5 text-[12px] font-semibold text-ink-500">방송 화면 미리보기</p>
          <div className="overflow-hidden rounded-xl border border-ink-100" style={CHECKER_STYLE}>
            <div className="relative w-full" style={{ paddingTop: '56.25%' }}>
              <iframe
                title="게임 오버레이 미리보기"
                src={`/overlay/${creatorId}/game?preview=1`}
                className="absolute inset-0 h-full w-full"
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {state.joinUrl ? (
              <>
                <Button size="sm" variant="secondary" onClick={onQr}>
                  <QrCode size={15} strokeWidth={1.8} /> QR 크게 보기
                </Button>
                <CopyButton value={state.joinUrl} label="참여 링크 복사" />
              </>
            ) : null}
          </div>

          {/* 참여 주소가 이 PC 안에서만 통하는 주소면 휴대폰으로 QR 을 찍어도 열리지 않는다.
              방송 중에 그 사실을 모르고 QR 을 띄우는 사고를 막는다. */}
          {localOnlyJoinUrl ? (
            <div className="mt-2">
              <Notice tone="warning" title="지금 QR 은 휴대폰에서 열리지 않습니다">
                참여 주소가 <b>{state.joinUrl}</b> 로 만들어져 이 컴퓨터 안에서만 열립니다. 시청자가 QR 로
                참여하려면 <b>.env</b> 의 <b>APP_BASE_URL</b> 을 외부에서 접속되는 주소(도메인 또는 임시 터널
                주소)로 바꾼 뒤 서버를 다시 시작해 주세요.
              </Notice>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!compact ? (
              <>
                <Button size="sm" variant="ghost" onClick={onPopout}>
                  <Maximize2 size={15} strokeWidth={1.8} /> 팝아웃 컨트롤
                </Button>
                <a
                  href={`/overlay/${creatorId}/game?preview=1&debug=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-400 hover:text-ink-700"
                >
                  <ExternalLink size={14} strokeWidth={1.8} /> 새 탭에서 보기
                </a>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {!compact ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-400">
          단축키 — <b className="text-ink-700">Space</b> 또는 <b className="text-ink-700">Enter</b> 는 위의 큰 버튼,{' '}
          <b className="text-ink-700">Backspace</b> 는 마감·발표 취소입니다. 입력 칸이나 버튼에 커서가 있을 때,
          게임을 만들거나 고치는 중일 때는 동작하지 않습니다.
          진행 버튼에는 확인창을 두지 않았습니다. 잘못 눌러도 위의 [마감 취소] · [발표 취소]로 되돌릴 수 있습니다.
        </p>
      ) : null}
    </Card>
  );
}

const CHECKER_STYLE: React.CSSProperties = {
  backgroundColor: '#2b2b31',
  backgroundImage:
    'linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%), linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%)',
  backgroundSize: '24px 24px',
  backgroundPosition: '0 0, 12px 12px',
};

/** 상태 배지. 폭을 고정해 상태가 바뀌어도 옆 요소가 밀리지 않게 한다. */
function StatusBadge({ status }: { status: RoundStatus }) {
  const tone = status === 'OPEN' ? 'success' : status === 'CLOSED' ? 'warning' : 'brand';
  return (
    <span className="inline-flex h-8 w-[104px] shrink-0 items-center justify-center">
      <Badge tone={tone}>{ROUND_STATUS_LABEL[status]}</Badge>
    </span>
  );
}

/** 남은 시간. 폭을 고정하고 고정폭 숫자를 써서 1초마다 흔들리지 않게 한다. */
function RemainBadge({ closesAt, status }: { closesAt: string | null; status: RoundStatus }) {
  const [left, setLeft] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!closesAt || status !== 'OPEN') {
      setLeft(null);
      return;
    }
    const end = new Date(closesAt).getTime();
    const tick = () => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [closesAt, status]);

  if (left == null) return null;
  return (
    <span
      className={cx(
        'inline-flex h-8 w-[76px] shrink-0 items-center justify-center rounded-lg text-[13px] font-black tabular-nums',
        left <= 10 ? 'bg-danger-50 text-danger-500' : 'bg-ink-50 text-ink-700',
      )}
    >
      {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
    </span>
  );
}

/** 실시간 현황. 게임 종류에 따라 보여 줄 것이 달라진다. */
function LiveTally({ state }: { state: StudioState }) {
  if (usesDonationTotal(state.type)) {
    const goal = state.goal ?? { target: 0, current: 0 };
    const pct = goal.target > 0 ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
    return (
      <div>
        <p className="mb-1.5 text-[12px] font-semibold text-ink-500">누적 후원</p>
        <p className="text-[24px] font-black text-ink-900 tabular-nums">
          {goal.current.toLocaleString()}원
          <span className="ml-2 text-[13px] font-bold text-ink-400">/ {goal.target.toLocaleString()}원 · {pct}%</span>
        </p>
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-ink-100">
          <div className="h-full rounded-full bg-brand-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  if (usesChoices(state.type)) {
    const counts = state.counts ?? state.choices.map(() => 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const answer = state.type === 'QUIZ' ? Number(state.secret.answerIndex ?? -1) : -1;
    return (
      <div>
        <p className="mb-1.5 text-[12px] font-semibold text-ink-500">
          실시간 집계 {state.type === 'QUIZ' ? '(정답은 나에게만 보입니다)' : ''}
        </p>
        <div className="space-y-2">
          {state.choices.map((c, i) => {
            const value = counts[i] ?? 0;
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            const isAnswer = answer === i;
            return (
              <div key={`${c}-${i}`}>
                <div className="flex items-center justify-between text-[12.5px]">
                  <span className={cx('font-semibold', isAnswer ? 'text-brand-700' : 'text-ink-700')}>
                    {String.fromCharCode(65 + i)}. {c}
                    {isAnswer ? <span className="ml-1 text-[11px] font-black">정답</span> : null}
                  </span>
                  <span className="text-ink-400 tabular-nums">
                    {value} · {pct}%
                  </span>
                </div>
                <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-ink-100">
                  <div
                    className={cx('h-full rounded-full transition-[width] duration-500', isAnswer ? 'bg-ink-900' : 'bg-brand-400')}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (usesItems(state.type)) {
    return (
      <div>
        <p className="mb-1.5 text-[12px] font-semibold text-ink-500">항목</p>
        <div className="flex flex-wrap gap-1.5">
          {state.items.map((v, i) => (
            <span key={`${v}-${i}`} className="rounded-full bg-ink-50 px-2.5 py-1 text-[12px] font-semibold text-ink-700">
              {v}
            </span>
          ))}
        </div>
        {state.winners.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1.5 text-[12px] font-semibold text-ink-500">결과</p>
            <div className="space-y-1">
              {state.winners.slice(0, 6).map((w) => (
                <p key={`${w.rank}-${w.name}`} className="text-[13px] font-bold text-ink-900">
                  {w.rank}. {w.name}
                  {w.prize ? <span className="ml-1.5 text-ink-400">{w.prize}</span> : null}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // 참여형 (순위 추첨 · 키워드 · 숫자)
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-semibold text-ink-500">
        참여자
        {state.type === 'KEYWORD' ? (
          <span className="ml-1.5 font-bold text-brand-700">정답 {state.correctCount ?? 0}명</span>
        ) : null}
      </p>
      {state.recentParticipants.length === 0 ? (
        <p className="text-[13px] text-ink-400">아직 참여자가 없습니다. 방송 화면의 QR 을 잠시 보여 주세요.</p>
      ) : (
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {state.recentParticipants.map((p) => (
            <span
              key={p.id}
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold',
                p.correct === true ? 'bg-brand-50 text-brand-800' : 'bg-ink-50 text-ink-700',
              )}
            >
              {p.source === 'DONATION' ? <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> : null}
              {p.name}
              {p.entry && state.type === 'NUMBER_GUESS' ? <b className="text-ink-400">{p.entry}</b> : null}
              {p.correct === true ? <Check size={12} strokeWidth={2.4} /> : null}
            </span>
          ))}
        </div>
      )}
      {state.winners.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1.5 text-[12px] font-semibold text-ink-500">당첨자</p>
          <div className="space-y-1">
            {state.winners.map((w) => (
              <p key={`${w.rank}-${w.name}`} className="text-[13px] font-bold text-ink-900">
                {w.rank}등 · {w.name}
                {w.prize ? <span className="ml-1.5 text-ink-400">{w.prize}</span> : null}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** QR 이미지. 참여 링크를 그대로 그린다. */
function QrImage({ url, size = 240 }: { url: string; size?: number }) {
  const [src, setSrc] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    import('qrcode')
      .then((m) => m.toDataURL(url, { width: size * 2, margin: 1, color: { dark: '#17161a', light: '#ffffff' } }))
      .then((d) => {
        if (alive) setSrc(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url, size]);

  if (!src) {
    return (
      <div className="grid place-items-center bg-ink-50" style={{ width: size, height: size }}>
        <QrCode size={40} strokeWidth={1.5} className="text-ink-300" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="참여 QR 코드" width={size} height={size} />;
}
