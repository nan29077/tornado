import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import {
  SECRET_CONFIG_KEYS,
  usesChoices,
  usesDonationTotal,
  usesEntries,
  type RoundStatus,
} from '@/lib/game-catalog';

/**
 * 게임 오버레이 상태 스냅샷.
 *
 * 화면 3곳이 같은 구조를 본다.
 *  - 방송 오버레이 (/overlay/{creatorId}/game)  : 공개 상태
 *  - 시청자 참여 페이지 (/play/{joinCode})       : 공개 상태
 *  - 크리에이터 컨트롤 (/studio/overlay?tab=game): 공개 상태 + 정답/참여자
 *
 * 공개 상태에는 정답·키워드가 절대 들어가지 않는다. 결과 발표(RESULT) 후에만 공개된다.
 * (셀러브릭스 구현은 게임 상태 API 가 config 를 통째로 내려보내 정답이 노출됐다. 같은 실수를 반복하지 않는다)
 */

export interface GameWinnerView {
  rank: number;
  name: string;
  prize: string;
  /** 숫자 맞히기의 제출값처럼 결과에 함께 보여 줄 부가 정보 */
  detail?: string;
  fulfilled?: boolean;
}

export interface GamePublicState {
  creatorId: string;
  gameId: string;
  roundId: string;
  type: string;
  title: string;
  status: RoundStatus;
  /** 항목형 게임의 출발 항목 */
  items: string[];
  /** 사다리타기의 도착 항목(보상) */
  destinations: string[];
  /** 투표·퀴즈 선택지 */
  choices: string[];
  topic: string;
  question: string;
  /** 선택지별 실시간 집계. 선택형이 아니면 null */
  counts: number[] | null;
  participantCount: number;
  /** 최근 참여자 표시명 (필터를 통과한 값만). 방송 화면에 흘려 보여 준다 */
  participantNames: string[];
  /** 선착순 키워드의 정답 입력자 수. 정답 자체는 공개하지 않는다 */
  correctCount: number | null;
  /** 후원 목표 게이지 */
  goal: { target: number; current: number } | null;
  /** 숫자 맞히기 입력 범위 */
  range: { min: number; max: number } | null;
  /** 공개해도 되는 보상 문구 */
  prize: string;
  joinUrl: string | null;
  joinCode: string | null;
  closesAt: string | null;
  /** 발표된 결과. 발표 전에는 null */
  result: Record<string, unknown> | null;
  winners: GameWinnerView[];
  updatedAt: string;
}

export interface GameStudioParticipant {
  id: string;
  name: string;
  entry: string | null;
  source: string;
  at: string;
  /** 정답 여부. 정답이 있는 게임에서만 채운다 */
  correct?: boolean;
}

export interface GameStudioState extends GamePublicState {
  /** 크리에이터만 볼 수 있는 정답 정보 */
  secret: Record<string, unknown>;
  recentParticipants: GameStudioParticipant[];
  /** 자동 마감 설정(초). 0 이면 수동 */
  autoCloseSec: number;
  entryMode: string;
}

/** 결과 발표 전까지 감춰야 하는 config 키를 제거한다. */
export function publicConfig(type: string, config: Record<string, unknown>, revealed: boolean): Record<string, unknown> {
  if (revealed) return config;
  const secrets = SECRET_CONFIG_KEYS[type] ?? [];
  if (secrets.length === 0) return config;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!secrets.includes(k)) copy[k] = v;
  }
  return copy;
}

/** 스튜디오 상태에서 시청자에게 나갈 부분만 남긴다. */
export function toPublicState(state: GameStudioState): GamePublicState {
  const { secret: _secret, recentParticipants: _p, autoCloseSec: _a, entryMode: _e, ...rest } = state;
  return rest;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 화면에 띄워 둔 회차 (없으면 null). 크리에이터당 하나만 존재한다. */
export async function findActiveRound(creatorId: string) {
  return prisma.gameRound.findFirst({
    where: { creatorId, status: { in: ['OPEN', 'CLOSED', 'RESULT'] } },
    orderBy: { openedAt: 'desc' },
    include: { game: true },
  });
}

/** 후원 목표 게이지의 현재 누적액. 회차를 연 시각 이후 결제 완료된 후원만 센다. */
export async function sumDonationsSince(creatorId: string, since: Date): Promise<number> {
  const agg = await prisma.donation.aggregate({
    where: {
      creatorId,
      isTest: false,
      refundedAt: null,
      paidAt: { gte: since },
    },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0n);
}

/**
 * 현재 회차의 전체 상태를 만든다.
 * 화면에 띄워 둔 회차가 없으면 null 을 돌려주고, 오버레이는 아무것도 그리지 않는다.
 */
export async function buildStudioState(creatorId: string): Promise<GameStudioState | null> {
  const round = await findActiveRound(creatorId);
  if (!round) return null;
  return buildStudioStateForRound(round.id);
}

export async function buildStudioStateForRound(roundId: string): Promise<GameStudioState | null> {
  const round = await prisma.gameRound.findUnique({ where: { id: roundId }, include: { game: true } });
  if (!round) return null;

  const game = round.game;
  const type = game.type;
  const config = asRecord(game.config);
  const items = asStringArray(game.items);
  const status = round.status as RoundStatus;
  const revealed = status === 'RESULT';

  const shown = publicConfig(type, config, revealed);
  const choices = usesChoices(type) ? asStringArray(config.choices) : [];

  let counts: number[] | null = null;
  let participantCount = 0;
  let participantNames: string[] = [];
  let correctCount: number | null = null;
  let recentParticipants: GameStudioParticipant[] = [];

  if (usesEntries(type)) {
    participantCount = await prisma.gameParticipant.count({ where: { roundId: round.id } });

    if (usesChoices(type) && choices.length > 0) {
      const grouped = await prisma.gameParticipant.groupBy({
        by: ['entry'],
        where: { roundId: round.id },
        _count: { _all: true },
      });
      const tally = choices.map(() => 0);
      for (const row of grouped) {
        const idx = Number(row.entry);
        if (Number.isInteger(idx) && idx >= 0 && idx < tally.length) tally[idx] = row._count._all;
      }
      counts = tally;
    }

    if (type === 'KEYWORD') {
      // 참여 시점에 소문자로 정규화해 저장하므로 그대로 비교한다.
      const keyword = String(config.keyword ?? '').trim().toLowerCase();
      correctCount = keyword ? await prisma.gameParticipant.count({ where: { roundId: round.id, entry: keyword } }) : 0;
    }

    // 최근 참여자. 방송 화면에는 이름만, 컨트롤 화면에는 입력값까지 보여 준다.
    const recent = await prisma.gameParticipant.findMany({
      where: { roundId: round.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, displayName: true, entry: true, source: true, createdAt: true },
    });
    // 투표는 익명이라 이름을 방송에 흘리지 않는다.
    participantNames = type === 'VOTE' ? [] : recent.slice(0, 24).map((p) => p.displayName);
    recentParticipants = recent.map((p) => ({
      id: p.id,
      name: p.displayName,
      entry: p.entry,
      source: p.source,
      at: p.createdAt.toISOString(),
      correct: correctOf(type, config, p.entry),
    }));
  }

  let goal: { target: number; current: number } | null = null;
  if (usesDonationTotal(type)) {
    const target = Number(config.target ?? 0);
    const current =
      status === 'RESULT' && round.result
        ? Number(asRecord(round.result).current ?? 0)
        : await sumDonationsSince(round.creatorId, round.openedAt);
    goal = { target, current };
  }

  const winners = await prisma.gameWinner.findMany({
    where: { roundId: round.id },
    orderBy: { rank: 'asc' },
    select: { rank: true, displayName: true, prize: true, fulfilledAt: true },
  });

  const secret: Record<string, unknown> = {};
  for (const key of SECRET_CONFIG_KEYS[type] ?? []) secret[key] = config[key];

  return {
    creatorId: round.creatorId,
    gameId: game.id,
    roundId: round.id,
    type,
    title: game.title,
    status,
    items,
    destinations: type === 'LADDER' ? asStringArray(config.destinations) : [],
    choices,
    topic: String(shown.topic ?? ''),
    question: String(shown.question ?? ''),
    counts,
    participantCount,
    participantNames,
    correctCount,
    goal,
    range:
      type === 'NUMBER_GUESS'
        ? { min: Number(config.min ?? 0), max: Number(config.max ?? 0) }
        : null,
    prize: String(config.prize ?? config.reward ?? ''),
    joinUrl: joinUrlFor(game.entryMode, type, round.joinCode, status),
    joinCode: usesEntries(type) ? round.joinCode : null,
    closesAt: round.closesAt ? round.closesAt.toISOString() : null,
    result: revealed ? asRecord(round.result) : null,
    winners: winners.map((w) => ({
      rank: w.rank,
      name: w.displayName,
      prize: w.prize,
      fulfilled: Boolean(w.fulfilledAt),
    })),
    updatedAt: round.updatedAt.toISOString(),
    secret,
    recentParticipants,
    autoCloseSec: game.autoCloseSec,
    entryMode: game.entryMode,
  };
}

/** 미리보기 전용 참여 코드. 실제로 참여할 수 있는 코드가 아니다. */
const SAMPLE_JOIN_CODE = 'PREVIEW';

/**
 * 회차를 시작하지 않고 "이 게임을 띄우면 방송 화면이 어떻게 보이는지"만 만들어 준다.
 *
 * 왜 필요한가 — 지금까지는 게임을 실제로 띄워야만 미리보기가 나타났다. 그래서 방송 전에
 * 배치·글자 크기를 확인하려면 회차를 열었다가 다시 내려야 했고, 그 흔적이 진행 이력에 남았다.
 *
 * 규칙
 *  - **DB 를 건드리지 않는다.** 회차도 참여자도 만들지 않는다. 읽기 전용이다.
 *  - 정답·키워드는 실제 회차와 똑같이 `publicConfig(..., false)` 로 걸러 낸다.
 *    미리보기는 크리에이터 본인만 보지만, 공개 상태에 비밀이 섞이는 경로 자체를 만들지 않는다.
 *  - 참여자 수 0, 결과 null 로 둔다. 방금 띄운 직후와 같은 화면이 된다.
 *  - 남은 시간은 넣지 않는다. 미리보기 창을 오래 열어 두면 00:00 에 멈춰 잘못된 인상을 준다.
 */
export async function buildSampleState(creatorId: string, gameId: string): Promise<GamePublicState | null> {
  const game = await prisma.game.findFirst({ where: { id: gameId, creatorId } });
  if (!game) return null;

  const type = game.type;
  const config = asRecord(game.config);
  const shown = publicConfig(type, config, false);
  const choices = usesChoices(type) ? asStringArray(config.choices) : [];

  return {
    creatorId,
    gameId: game.id,
    roundId: `sample-${game.id}`,
    type,
    title: game.title,
    status: 'OPEN',
    items: asStringArray(game.items),
    destinations: type === 'LADDER' ? asStringArray(config.destinations) : [],
    choices,
    topic: String(shown.topic ?? ''),
    question: String(shown.question ?? ''),
    counts: usesChoices(type) && choices.length > 0 ? choices.map(() => 0) : null,
    participantCount: 0,
    participantNames: [],
    correctCount: type === 'KEYWORD' ? 0 : null,
    goal: usesDonationTotal(type) ? { target: Number(config.target ?? 0), current: 0 } : null,
    range: type === 'NUMBER_GUESS' ? { min: Number(config.min ?? 0), max: Number(config.max ?? 0) } : null,
    prize: String(config.prize ?? config.reward ?? ''),
    joinUrl: joinUrlFor(game.entryMode, type, SAMPLE_JOIN_CODE, 'OPEN'),
    joinCode: usesEntries(type) ? SAMPLE_JOIN_CODE : null,
    closesAt: null,
    result: null,
    winners: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 참여 링크. 후원 자동 참여 전용 게임은 링크를 만들지 않는다. */
function joinUrlFor(entryMode: string, type: string, joinCode: string, status: RoundStatus): string | null {
  if (!usesEntries(type)) return null;
  if (entryMode === 'DONATION') return null;
  if (status !== 'OPEN') return null;
  return `${env.baseUrl}/play/${joinCode}`;
}

/** 정답이 있는 게임에서 참여자의 입력이 정답인지. 컨트롤 화면에서만 쓴다. */
function correctOf(type: string, config: Record<string, unknown>, entry: string | null): boolean | undefined {
  if (entry == null) return undefined;
  if (type === 'QUIZ') return Number(entry) === Number(config.answerIndex);
  if (type === 'KEYWORD') return entry === String(config.keyword ?? '').trim().toLowerCase();
  return undefined;
}
