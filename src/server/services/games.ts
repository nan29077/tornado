import { randomInt } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { newId } from '@/lib/id';
import { randomCodeString, sha256 } from '@/lib/crypto';
import {
  MAX_ITEMS,
  MAX_ITEM_LEN,
  MAX_NICKNAME_LEN,
  MAX_TITLE_LEN,
  defaultConfig,
  isGameType,
  needsNickname,
  normalizeConfig,
  normalizeKeyword,
  usesChoices,
  usesDonationTotal,
  usesEntries,
  usesFreeEntry,
  usesItems,
  validateGameInput,
  type EntryMode,
} from '@/lib/game-catalog';
import { filterContent, type BannedWordRule } from '@/server/services/content-filter';
import {
  computeEntryResult,
  computeLadder,
  computeRoulette,
  winnersOf,
  type WinnerSeed,
} from '@/server/services/game-result';
import { publishGameState, publishGameStateThrottled } from '@/server/services/game-bus';
import {
  buildStudioState,
  buildStudioStateForRound,
  findActiveRound,
  sumDonationsSince,
} from '@/server/services/game-state';

/**
 * 방송 게임 서비스.
 *
 * 원칙
 *  - 결과는 **항상 서버가 확정한다.** 클라이언트가 보낸 당첨자를 그대로 받지 않는다.
 *    (실시간 추첨은 조작 시비가 반드시 따라오므로 결과·참여자·시각을 모두 남긴다)
 *  - 추첨에는 CSPRNG(node:crypto randomInt)를 쓴다. Math.random 을 쓰지 않는다.
 *  - 보상은 무형 보상의 "이름"만 기록한다. 금전·크레딧·포인트·쿠폰을 발행하지 않으며
 *    결제·정산 원장과 어떤 방식으로도 연결하지 않는다.
 *  - 한 크리에이터가 방송 화면에 띄워 둘 수 있는 회차는 동시에 하나뿐이다.
 */

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동 문자 제외

export class GameError extends Error {}

function fail(message: string): never {
  throw new GameError(message);
}

function cleanItems(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? '').trim().slice(0, MAX_ITEM_LEN))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : [];
}

// ---------------------------------------------------------------- 게임 CRUD

export interface GameInput {
  type: string;
  title: string;
  items: string[];
  config: Record<string, unknown>;
  entryMode: string;
  donationMinAmount: number;
  autoCloseSec: number;
}

function normalizeEntryMode(type: string, value: string): EntryMode {
  // 후원 목표 게이지는 참여 개념이 없고, 항목형 게임도 시청자가 참여하지 않는다.
  if (!usesEntries(type)) return 'LINK';
  // 선택지·키워드·숫자를 입력해야 하는 게임은 후원만으로 참여시킬 수 없다.
  // 무엇을 골랐는지 알 수 없기 때문이다. 이름만으로 참여하는 순위 추첨에서만 허용한다.
  if (usesChoices(type) || usesFreeEntry(type)) return 'LINK';
  return value === 'DONATION' || value === 'BOTH' ? value : 'LINK';
}

export async function listGames(creatorId: string) {
  const games = await prisma.game.findMany({
    where: { creatorId, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      rounds: {
        orderBy: { openedAt: 'desc' },
        take: 1,
        select: { id: true, status: true, seq: true, openedAt: true },
      },
    },
  });

  return games.map((g) => ({
    id: g.id,
    type: g.type,
    title: g.title,
    items: asStringArray(g.items),
    config: asRecord(g.config),
    entryMode: g.entryMode,
    donationMinAmount: Number(g.donationMinAmount),
    autoCloseSec: g.autoCloseSec,
    createdAt: g.createdAt.toISOString(),
    lastRound: g.rounds[0]
      ? { id: g.rounds[0].id, status: g.rounds[0].status, seq: g.rounds[0].seq }
      : null,
  }));
}

export async function createGame(creatorId: string, input: GameInput) {
  const type = input.type;
  if (!isGameType(type)) fail('알 수 없는 게임 종류입니다.');

  const title = input.title.trim().slice(0, MAX_TITLE_LEN);
  const items = usesItems(type) ? cleanItems(input.items) : [];
  const config = normalizeConfig(type, { ...defaultConfig(type), ...input.config });

  const error = validateGameInput(type, title, items, config);
  if (error) fail(error);

  const count = await prisma.game.count({ where: { creatorId, archivedAt: null } });
  if (count >= 50) fail('게임은 최대 50개까지 만들 수 있습니다. 쓰지 않는 게임을 정리해 주세요.');

  const game = await prisma.game.create({
    data: {
      id: newId(),
      creatorId,
      type,
      title,
      items,
      config: config as object,
      entryMode: normalizeEntryMode(type, input.entryMode),
      donationMinAmount: BigInt(Math.max(0, Math.round(input.donationMinAmount || 0))),
      autoCloseSec: Math.min(600, Math.max(0, Math.round(input.autoCloseSec || 0))),
    },
  });
  return game.id;
}

export async function updateGame(creatorId: string, gameId: string, input: GameInput) {
  const game = await requireGame(creatorId, gameId);

  // 진행 중에는 설정을 바꿀 수 없다. 판을 벌여 둔 상태에서 정답이나 항목이 바뀌면
  // 결과를 신뢰할 수 없게 된다. (셀러브릭스와 같은 규칙)
  const active = await prisma.gameRound.findFirst({
    where: { gameId, status: { in: ['OPEN', 'CLOSED'] } },
    select: { id: true },
  });
  if (active) fail('진행 중에는 설정을 바꿀 수 없습니다. 게임을 화면에서 내린 뒤 수정해 주세요.');

  const title = input.title.trim().slice(0, MAX_TITLE_LEN);
  const items = usesItems(game.type) ? cleanItems(input.items) : [];
  const config = normalizeConfig(game.type, { ...defaultConfig(game.type), ...input.config });

  const error = validateGameInput(game.type, title, items, config);
  if (error) fail(error);

  await prisma.game.update({
    where: { id: gameId },
    data: {
      title,
      items,
      config: config as object,
      entryMode: normalizeEntryMode(game.type, input.entryMode),
      donationMinAmount: BigInt(Math.max(0, Math.round(input.donationMinAmount || 0))),
      autoCloseSec: Math.min(600, Math.max(0, Math.round(input.autoCloseSec || 0))),
    },
  });
}

export async function deleteGame(creatorId: string, gameId: string) {
  await requireGame(creatorId, gameId);
  // 진행 이력(회차·참여자·당첨자)은 남긴다. 목록에서만 감춘다.
  await prisma.game.update({ where: { id: gameId }, data: { archivedAt: new Date() } });
  const active = await findActiveRound(creatorId);
  if (active?.gameId === gameId) await endRound(creatorId, active.id);
}

async function requireGame(creatorId: string, gameId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || game.creatorId !== creatorId || game.archivedAt) fail('게임을 찾을 수 없습니다.');
  return game;
}

async function requireRound(creatorId: string, roundId: string) {
  const round = await prisma.gameRound.findUnique({ where: { id: roundId }, include: { game: true } });
  if (!round || round.creatorId !== creatorId) fail('회차를 찾을 수 없습니다.');
  return round;
}

// ------------------------------------------------------------- 회차 진행

async function nextJoinCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = randomCodeString(JOIN_CODE_ALPHABET, 6);
    const exists = await prisma.gameRound.findUnique({ where: { joinCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  // 확률적으로 도달할 수 없는 경로. 그래도 조용히 중복 코드를 쓰지는 않는다.
  fail('참여 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

/**
 * 게임을 방송 화면에 띄운다.
 * 이미 다른 게임이 떠 있으면 그 회차를 먼저 내린다(화면에는 하나만 뜬다).
 */
export async function startRound(creatorId: string, gameId: string) {
  const overlay = await prisma.overlaySetting.findUnique({
    where: { creatorId },
    select: { gameEnabled: true },
  });
  if (!overlay?.gameEnabled) fail('게임 오버레이 사용을 먼저 켜 주세요.');

  const game = await requireGame(creatorId, gameId);

  const now = new Date();
  const closesAt =
    usesEntries(game.type) && game.autoCloseSec > 0
      ? new Date(now.getTime() + game.autoCloseSec * 1000)
      : null;
  const joinCode = await nextJoinCode();

  /**
   * "화면에 뜬 회차는 하나"를 트랜잭션 안에서 보장한다.
   *
   * 예전에는 조회 → 종료 → 생성이 트랜잭션 밖이라, 스튜디오 창과 팝아웃 컨트롤에서 거의
   * 동시에 [방송에 시작]을 누르면 둘 다 "활성 회차 없음"을 보고 각각 OPEN 회차를 만들었다.
   * 그러면 하나는 화면에 보이지 않은 채 참여 코드로 참여를 계속 받는다.
   */
  const round = await prisma.$transaction(async (tx) => {
    // 활성 회차를 먼저 모두 내린다. updateMany 라 동시에 들어와도 한쪽만 실제로 바꾼다.
    await tx.gameRound.updateMany({
      where: { creatorId, status: { in: ['OPEN', 'CLOSED', 'RESULT'] } },
      data: { status: 'ENDED', endedAt: now },
    });

    const last = await tx.gameRound.findFirst({
      where: { gameId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });

    return tx.gameRound.create({
      data: {
        id: newId(),
        gameId,
        creatorId,
        seq: (last?.seq ?? 0) + 1,
        status: 'OPEN',
        joinCode,
        openedAt: now,
        closesAt,
      },
    });
  });

  await publish(creatorId);
  return round.id;
}

/** 항목형 게임(룰렛·사다리)을 돌린다. 결과는 이 시점에 서버가 확정한다. */
export async function spinRound(creatorId: string, roundId: string, selectedIndex?: number) {
  const round = await requireRound(creatorId, roundId);
  if (!usesItems(round.game.type)) fail('돌릴 수 있는 게임이 아닙니다.');
  if (round.status !== 'OPEN') fail('이미 결과가 나온 회차입니다.');

  const items = asStringArray(round.game.items);
  const config = asRecord(round.game.config);
  if (items.length < 2) fail('항목이 2개 이상 필요합니다.');

  const result =
    round.game.type === 'ROULETTE'
      ? computeRoulette(items)
      : computeLadder(items, asStringArray(config.destinations), selectedIndex);

  await prisma.$transaction([
    prisma.gameRound.update({
      where: { id: roundId },
      data: { status: 'RESULT', result: result as object, closedAt: new Date(), revealedAt: new Date() },
    }),
    ...winnerRows(round, winnersOf(round.game.type, result, config)),
  ]);

  await publish(creatorId);
  return result;
}

/** 참여를 마감한다. 이후 참여 요청은 거절된다. */
export async function closeRound(creatorId: string, roundId: string) {
  const round = await requireRound(creatorId, roundId);
  if (round.status !== 'OPEN') fail('참여 중인 회차가 아닙니다.');
  await prisma.gameRound.update({
    where: { id: roundId },
    data: { status: 'CLOSED', closedAt: new Date(), closesAt: null },
  });
  await publish(creatorId);
}

/** 마감을 되돌린다. 방송 중 실수로 눌렀을 때 쓰는 실행취소 경로다. */
export async function reopenRound(creatorId: string, roundId: string) {
  const round = await requireRound(creatorId, roundId);
  if (round.status !== 'CLOSED') fail('마감 상태가 아닙니다.');

  // 자동 마감을 쓰는 게임이면 타이머를 다시 건다.
  // 예전에는 마감할 때 지운 closesAt 을 되돌리지 않아, 마감을 취소하면 그 회차는
  // 남은 시간 표시도 자동 마감도 없이 계속 열려 있었다.
  const closesAt =
    usesEntries(round.game.type) && round.game.autoCloseSec > 0
      ? new Date(Date.now() + round.game.autoCloseSec * 1000)
      : null;

  await prisma.gameRound.update({
    where: { id: roundId },
    data: { status: 'OPEN', closedAt: null, closesAt },
  });
  await publish(creatorId);
}

/**
 * 결과를 발표한다.
 * 참여형은 참여자 중에서, 후원 목표는 달성 여부로 확정한다.
 */
export async function revealRound(creatorId: string, roundId: string) {
  const round = await requireRound(creatorId, roundId);
  if (round.status === 'RESULT') fail('이미 결과를 발표했습니다.');
  if (round.status === 'ENDED') fail('이미 끝난 회차입니다.');

  const type = round.game.type;
  const config = asRecord(round.game.config);

  let result: Record<string, unknown>;

  if (usesDonationTotal(type)) {
    const target = Number(config.target ?? 0);
    const current = await sumDonationsSince(creatorId, round.openedAt);
    result = { target, current, achieved: current >= target, reward: String(config.reward ?? '') };
  } else if (usesEntries(type)) {
    const participants = await prisma.gameParticipant.findMany({
      where: { roundId },
      orderBy: { createdAt: 'asc' },
      select: { displayName: true, entry: true, donorId: true, createdAt: true },
    });
    if (participants.length === 0 && type !== 'VOTE') {
      fail('아직 참여자가 없습니다. 참여자가 들어온 뒤에 발표해 주세요.');
    }
    result = computeEntryResult(type, config, participants);
  } else {
    fail('결과를 발표할 수 있는 게임이 아닙니다.');
  }

  /**
   * 상태를 조건부로 선점한 뒤에만 결과를 쓴다.
   *
   * 예전에는 상태를 읽고 계산한 뒤 무조건 update 했다. [결과 발표]를 빠르게 두 번 누르면
   * 두 요청이 각각 다른 추첨 결과를 계산해 나중 것이 이겼고, 방송 화면에는 순간적으로
   * 다른 당첨자가 스쳐 지나갔다.
   */
  const claimed = await prisma.gameRound.updateMany({
    where: { id: roundId, status: { in: ['OPEN', 'CLOSED'] } },
    data: {
      status: 'RESULT',
      result: result as object,
      revealedAt: new Date(),
      closedAt: round.closedAt ?? new Date(),
      closesAt: null,
      revealCount: { increment: 1 },
    },
  });
  if (claimed.count === 0) fail('이미 결과가 발표되었습니다. 화면을 새로 고쳐 주세요.');

  await prisma.$transaction([
    prisma.gameWinner.deleteMany({ where: { roundId } }),
    ...winnerRows(round, winnersOf(type, result, config)),
  ]);

  // 재발표는 조작 시비의 핵심이므로 반드시 흔적을 남긴다.
  if (round.revealCount > 0) {
    logger.warn('게임 결과 재발표', { creatorId, roundId, attempt: round.revealCount + 1 });
  }

  await publish(creatorId);
  return result;
}

/**
 * 결과 발표를 되돌린다.
 * 방송 중 [결과 발표]에 확인창을 두면 타이밍을 놓치므로, 대신 짧은 실행취소를 제공한다.
 */
export async function undoReveal(creatorId: string, roundId: string) {
  const round = await requireRound(creatorId, roundId);
  if (round.status !== 'RESULT') fail('발표된 결과가 없습니다.');

  /**
   * 실행취소는 **발표 직후 잠깐만** 열어 둔다.
   *
   * 무제한으로 열어 두면 "발표 → 취소 → 재발표"를 원하는 결과가 나올 때까지 반복할 수 있고,
   * 그건 추첨이 아니다. 잘못 눌렀을 때 되돌리는 용도로만 남긴다.
   */
  const revealedAt = round.revealedAt?.getTime() ?? 0;
  if (!revealedAt || Date.now() - revealedAt > UNDO_WINDOW_SEC * 1000) {
    fail(`결과 발표 후 ${UNDO_WINDOW_SEC}초가 지나 되돌릴 수 없습니다. 새 회차를 시작해 주세요.`);
  }

  const backTo = usesItems(round.game.type) || usesDonationTotal(round.game.type) ? 'OPEN' : 'CLOSED';
  await prisma.$transaction([
    prisma.gameWinner.deleteMany({ where: { roundId } }),
    prisma.gameRound.update({
      where: { id: roundId },
      // Json 컬럼을 SQL NULL 로 되돌리려면 Prisma.DbNull 을 써야 한다(null 은 JSON null 이 된다).
      // revealCount 는 되돌리지 않는다. 몇 번 발표했는지가 기록으로 남아야 한다.
      data: { status: backTo, result: Prisma.DbNull, revealedAt: null },
    }),
  ]);
  logger.warn('게임 결과 발표 취소', { creatorId, roundId, revealCount: round.revealCount });
  await publish(creatorId);
}

/**
 * 사다리 경로 다시 그리기.
 *
 * 결과는 [돌리기] 시점에 이미 확정되어 있다. 여기서는 **어느 줄을 굵게 따라갈지만** 바꾼다.
 * 사다리 배치도 당첨 결과도 건드리지 않으므로 조작 여지가 없다.
 * (예전에는 첫 클릭에 결과가 확정되면서 번호 버튼이 사라져, 한 회차에 한 줄만 볼 수 있었다)
 */
export async function traceLadder(creatorId: string, roundId: string, selectedIndex: number) {
  const round = await requireRound(creatorId, roundId);
  if (round.game.type !== 'LADDER') fail('사다리타기 게임이 아닙니다.');
  if (round.status !== 'RESULT') fail('아직 결과가 나오지 않았습니다.');

  const result = asRecord(round.result);
  const starts = asStringArray(result.starts);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= starts.length) {
    fail('없는 번호입니다.');
  }

  await prisma.gameRound.update({
    where: { id: roundId },
    data: { result: { ...result, activeIndex: selectedIndex } as object },
  });
  await publish(creatorId);
}

/** 방송 화면에서 내린다. */
export async function endRound(creatorId: string, roundId: string) {
  const round = await requireRound(creatorId, roundId);
  if (round.status === 'ENDED') return;
  await prisma.gameRound.update({
    where: { id: roundId },
    data: { status: 'ENDED', endedAt: new Date(), closesAt: null },
  });
  await publish(creatorId);
}

/** 보상 전달 완료 체크 */
export async function setWinnerFulfilled(creatorId: string, winnerId: string, done: boolean) {
  const winner = await prisma.gameWinner.findUnique({ where: { id: winnerId }, select: { creatorId: true } });
  if (!winner || winner.creatorId !== creatorId) fail('당첨 기록을 찾을 수 없습니다.');
  await prisma.gameWinner.update({
    where: { id: winnerId },
    data: { fulfilledAt: done ? new Date() : null },
  });
}

/**
 * 자동 마감 시각이 지났으면 마감한다.
 * 별도 스케줄러 없이, 상태를 읽는 쪽(SSE 하트비트)에서 확인한다.
 */
export async function autoCloseIfDue(creatorId: string): Promise<boolean> {
  const round = await prisma.gameRound.findFirst({
    where: { creatorId, status: 'OPEN', closesAt: { not: null, lte: new Date() } },
    select: { id: true },
  });
  if (!round) return false;
  /**
   * 조건부 갱신으로 **한 번만** 마감한다.
   *
   * 마감 시각이 지나는 순간 그 크리에이터에 붙어 있는 모든 SSE 연결이 같은 틱에서
   * 이 함수를 부른다. 무조건 update 하면 연결 수만큼 갱신과 상태 발행이 반복된다.
   */
  const closed = await prisma.gameRound.updateMany({
    where: { id: round.id, status: 'OPEN' },
    data: { status: 'CLOSED', closedAt: new Date(), closesAt: null },
  });
  if (closed.count === 0) return false;
  await publish(creatorId);
  return true;
}

/** 당첨자 기록을 만드는 트랜잭션 조각. 결과와 같은 트랜잭션에서 저장한다. */
function winnerRows(round: { id: string; gameId: string; creatorId: string }, seeds: WinnerSeed[]) {
  if (seeds.length === 0) return [];
  return [
    prisma.gameWinner.createMany({
      data: seeds.map((s) => ({
        id: newId(),
        roundId: round.id,
        gameId: round.gameId,
        creatorId: round.creatorId,
        rank: s.rank,
        displayName: s.name,
        prize: s.prize,
        donorId: s.donorId,
      })),
    }),
  ];
}

// --------------------------------------------------------------- 참여 처리

export interface JoinInput {
  /** 표시명. 투표처럼 익명 게임에서는 비어 있어도 된다 */
  name: string;
  /** 선택지 index · 숫자 · 키워드 */
  entry: string;
  /**
   * 브라우저가 보관하는 참여자 식별값. 같은 브라우저의 중복 제출을 막는다.
   * **이 값만으로는 부족하다.** 클라이언트가 만든 값이라 지우거나 바꾸면 그만이다.
   */
  deviceKey: string;
  /**
   * 서버가 아는 발신자 지문(IP + User-Agent). 클라이언트가 조작할 수 없다.
   * 이 값으로 **회차당 참여 횟수 상한**을 건다.
   */
  clientFingerprint?: string | null;
  /** 로그인한 후원자라면 후원자 ID */
  donorId?: string | null;
}

export interface JoinResult {
  ok: true;
  participantCount: number;
}

/**
 * 같은 네트워크 지문(IP + UA)에서 한 회차에 허용하는 참여 수.
 *
 * 1로 두면 회사·학교·이동통신망 NAT 뒤의 시청자들이 서로를 막는다.
 * 너무 크면 조작을 막지 못한다. 가족·사무실 정도는 통과하고 대량 투입은 막는 값으로 잡는다.
 */
const MAX_JOIN_PER_NETWORK = Math.max(1, Number(process.env.GAME_JOIN_MAX_PER_NETWORK) || 5);

/** 결과 발표를 되돌릴 수 있는 시간(초). 이 시간이 지나면 재추첨을 막는다. */
const UNDO_WINDOW_SEC = Math.max(10, Number(process.env.GAME_UNDO_WINDOW_SEC) || 120);

/**
 * 시청자 참여.
 * 참여 코드는 공개값이므로 인증이 없다. 남용은 회차 단위 유니크 키와 속도 제한으로 막는다.
 */
export async function joinByCode(joinCode: string, input: JoinInput): Promise<JoinResult> {
  const round = await prisma.gameRound.findUnique({
    where: { joinCode: joinCode.toUpperCase() },
    include: { game: true },
  });
  if (!round) fail('참여 코드를 찾을 수 없습니다.');
  if (round.status !== 'OPEN') fail('지금은 참여를 받지 않습니다.');

  const game = round.game;
  const type = game.type;
  if (!usesEntries(type)) fail('시청자가 참여하는 게임이 아닙니다.');
  if (game.entryMode === 'DONATION') fail('이 게임은 후원하신 분만 자동으로 참여됩니다.');

  // 자동 마감 시각이 지났다면 이 요청부터 거절한다.
  if (round.closesAt && round.closesAt.getTime() <= Date.now()) {
    await autoCloseIfDue(round.creatorId).catch(() => undefined);
    fail('참여가 마감되었습니다.');
  }

  const config = asRecord(game.config);
  const entry = normalizeEntry(type, config, input.entry);
  const displayName = await safeDisplayName(round.creatorId, type, input.name);

  /**
   * 중복 참여 차단은 **두 겹**이다.
   *
   *  1) `entryKey` 유니크 — 로그인 후원자는 계정 기준(기기를 바꿔도 1회),
   *     비로그인은 브라우저 기준. 같은 브라우저의 재제출을 막는다.
   *  2) `netHash` 상한 — 서버가 아는 IP + User-Agent 지문으로 **회차당 N회**까지만 허용한다.
   *
   * 왜 지문을 유니크 키로 쓰지 않는가: 이동통신망 NAT 뒤에서는 서로 다른 시청자 수백 명이
   * 같은 IP 를 쓴다. 지문을 유니크로 걸면 그 사람들이 서로를 막아 정상 참여가 불가능해진다.
   * 반대로 브라우저 값만 쓰면 localStorage 를 지우거나 curl 로 얼마든지 표를 늘릴 수 있다.
   * "브라우저 단위 유니크 + 네트워크 단위 상한" 이 두 실패를 모두 피한다.
   */
  const netHash = input.clientFingerprint ? sha256(input.clientFingerprint) : null;
  if (netHash) {
    const fromSameNetwork = await prisma.gameParticipant.count({
      where: { roundId: round.id, netHash },
    });
    if (fromSameNetwork >= MAX_JOIN_PER_NETWORK) {
      fail('같은 네트워크에서 참여할 수 있는 횟수를 넘었습니다.');
    }
  }

  const entryKey = input.donorId ? `donor:${input.donorId}` : `dev:${sha256(input.deviceKey)}`;

  try {
    await prisma.gameParticipant.create({
      data: {
        id: newId(),
        roundId: round.id,
        gameId: game.id,
        creatorId: round.creatorId,
        donorId: input.donorId ?? null,
        displayName,
        entry,
        source: 'LINK',
        entryKey,
        netHash,
      },
    });
  } catch (e) {
    // 유니크 위반 = 이미 참여함. 입력을 바꾸는 것은 허용하지 않는다(선착순 게임의 공정성).
    const message = (e as Error).message ?? '';
    if (message.includes('Unique') || message.includes('unique')) fail('이미 참여하셨습니다.');
    throw e;
  }

  const participantCount = await prisma.gameParticipant.count({ where: { roundId: round.id } });
  publishGameStateThrottled(round.creatorId, () => buildStudioStateForRound(round.id));

  /**
   * 정답 여부는 **응답에 담지 않는다.**
   *
   * 담으면 참여 API 자체가 정답 오라클이 된다. 4지선다 퀴즈는 세 번이면 정답이 확정되고,
   * 키워드는 후보를 무제한으로 찔러 볼 수 있다. 정답은 크리에이터가 발표할 때 공개된다.
   */
  return { ok: true, participantCount };
}

/**
 * 크리에이터에게 적용되는 금칙어.
 *
 * donation-flow 의 같은 함수를 쓰지 않는다.
 * donation-flow -> broadcast-dispatch -> games 로 이어지는 순환 참조가 생겨
 * 모듈 초기화 순서에 따라 함수가 undefined 가 될 수 있기 때문이다.
 */
async function loadCreatorBannedWords(creatorId: string): Promise<BannedWordRule[]> {
  const rows = await prisma.bannedWord.findMany({
    where: { active: true, OR: [{ scope: 'GLOBAL' }, { creatorId }] },
    select: { word: true, action: true },
  });
  return rows.map((r) => ({ word: r.word, action: r.action }));
}

/** 참여 입력값을 타입별로 검증·정규화한다. */
function normalizeEntry(type: string, config: Record<string, unknown>, raw: string): string | null {
  const value = (raw ?? '').trim();

  if (usesChoices(type)) {
    const choices = asStringArray(config.choices);
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) fail('선택지를 골라 주세요.');
    return String(idx);
  }

  if (type === 'KEYWORD') {
    if (!value) fail('키워드를 입력해 주세요.');
    // 대소문자·공백 차이로 정답이 갈리지 않게 정규화해 저장한다.
    // 저장·집계·판정·발표가 모두 같은 함수를 쓴다(lib/game-catalog.ts).
    return normalizeKeyword(value);
  }

  if (type === 'NUMBER_GUESS') {
    const num = Number(value.replace(/[,\s]/g, ''));
    if (!Number.isFinite(num)) fail('숫자를 입력해 주세요.');
    const min = Number(config.min);
    const max = Number(config.max);
    if (num < min || num > max) fail(`${min} ~ ${max} 사이의 숫자를 입력해 주세요.`);
    return String(Math.round(num));
  }

  return null; // RANKING 은 이름만 받는다
}


/**
 * 방송에 띄울 표시명을 만든다.
 * 시청자가 닉네임에 전화번호·주소를 넣는 일이 반드시 생기므로,
 * 후원 메시지와 같은 필터를 그대로 통과시킨다.
 */
async function safeDisplayName(creatorId: string, type: string, raw: string): Promise<string> {
  if (!needsNickname(type)) return '익명';
  const input = (raw ?? '').trim();
  if (!input) fail('닉네임을 입력해 주세요.');

  const banned = await loadCreatorBannedWords(creatorId).catch(() => []);
  const filtered = filterContent(input, { bannedWords: banned, maxLength: MAX_NICKNAME_LEN });
  if (filtered.action === 'BLOCK') fail('사용할 수 없는 닉네임입니다. 다른 이름으로 참여해 주세요.');

  const clean = filtered.clean.trim().slice(0, MAX_NICKNAME_LEN);
  if (!clean) fail('사용할 수 없는 닉네임입니다. 다른 이름으로 참여해 주세요.');
  return clean;
}

/**
 * 후원 자동 참여.
 *
 * 후원 송출(dispatchBroadcast) 뒤에 호출한다.
 * **어떤 경우에도 예외를 밖으로 던지지 않는다.** 게임은 부가 기능이고 후원 송출이 본류다.
 */
export async function joinFromDonation(donationId: string): Promise<void> {
  try {
    const donation = await prisma.donation.findUnique({
      where: { id: donationId },
      select: {
        id: true,
        creatorId: true,
        donorId: true,
        amount: true,
        displayName: true,
        isTest: true,
      },
    });
    if (!donation || donation.isTest) return;

    const round = await prisma.gameRound.findFirst({
      where: { creatorId: donation.creatorId, status: 'OPEN' },
      include: { game: true },
    });
    if (!round) return;

    const game = round.game;
    if (!usesEntries(game.type)) return;
    if (game.entryMode !== 'DONATION' && game.entryMode !== 'BOTH') return;
    if (donation.amount < game.donationMinAmount) return;

    // 값을 직접 입력해야 하는 게임(키워드·숫자·선택지)은 후원만으로 참여시킬 수 없다.
    // 무엇을 골랐는지 알 수 없기 때문이다. 이름만으로 참여하는 게임에서만 동작한다.
    if (usesChoices(game.type) || usesFreeEntry(game.type)) return;

    /**
     * 후원 자동 참여도 **회차당 1표**로 맞춘다.
     *
     * 예전에는 후원자 계정이 없는 건에 `donation:{id}` 를 써서, 같은 사람이 세 번 후원하면
     * 표가 세 장이 됐다. 로그인 후원자는 한 장이었으니 같은 규칙이 사람에 따라 다르게
     * 적용된 셈이다. 후원자 프로필이 없으면 표시명 기준으로라도 한 사람은 한 표로 묶는다.
     * (금액 가중 추첨이 필요하면 게임 설정으로 따로 열어야 할 기능이지, 우연히 생기면 안 된다)
     */
    const entryKey = donation.donorId
      ? `donor:${donation.donorId}`
      : `dname:${sha256(`${round.id}:${donation.displayName}`)}`;

    await prisma.gameParticipant.create({
      data: {
        id: newId(),
        roundId: round.id,
        gameId: game.id,
        creatorId: donation.creatorId,
        donorId: donation.donorId,
        donationId: donation.id,
        displayName: donation.displayName.slice(0, MAX_NICKNAME_LEN),
        entry: null,
        source: 'DONATION',
        entryKey,
        amount: donation.amount,
      },
    });

    publishGameStateThrottled(donation.creatorId, () => buildStudioStateForRound(round.id));
  } catch (e) {
    const message = (e as Error).message ?? '';
    // 이미 참여한 후원자의 추가 후원은 정상 흐름이다. 로그를 남기지 않는다.
    if (message.includes('Unique') || message.includes('unique')) return;
    logger.warn('후원 자동 참여 실패 (후원 처리에는 영향 없음)', { donationId, message });
  }
}

/**
 * 후원 목표 게이지 갱신.
 * 후원이 들어올 때마다 게이지를 다시 그려야 하므로 상태를 다시 발행한다.
 */
export async function refreshDonationGauge(creatorId: string): Promise<void> {
  try {
    const round = await prisma.gameRound.findFirst({
      where: { creatorId, status: 'OPEN' },
      include: { game: true },
    });
    if (!round || !usesDonationTotal(round.game.type)) return;
    publishGameStateThrottled(creatorId, () => buildStudioStateForRound(round.id));
  } catch {
    /* 게임은 부가 기능이다. 실패해도 후원 처리에 영향을 주지 않는다 */
  }
}

async function publish(creatorId: string) {
  const state = await buildStudioState(creatorId);
  if (state) {
    publishGameState(state);
    return;
  }
  // 화면에 띄운 회차가 사라졌다는 사실도 알려야 오버레이가 화면을 비운다.
  publishGameState({
    creatorId,
    gameId: '',
    roundId: '',
    type: '',
    title: '',
    status: 'ENDED',
    items: [],
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
    updatedAt: new Date().toISOString(),
    secret: {},
    recentParticipants: [],
    autoCloseSec: 0,
    entryMode: 'LINK',
  });
}

/** 지난 회차 이력 (스튜디오 [진행 이력] 탭) */
export async function listRoundHistory(creatorId: string, limit = 20) {
  const rounds = await prisma.gameRound.findMany({
    where: { creatorId, status: { in: ['RESULT', 'ENDED'] } },
    orderBy: { openedAt: 'desc' },
    take: limit,
    include: {
      game: { select: { title: true, type: true } },
      winners: { orderBy: { rank: 'asc' }, select: { id: true, rank: true, displayName: true, prize: true, fulfilledAt: true } },
      _count: { select: { participants: true } },
    },
  });

  return rounds.map((r) => ({
    id: r.id,
    seq: r.seq,
    title: r.game.title,
    type: r.game.type,
    openedAt: r.openedAt.toISOString(),
    revealedAt: r.revealedAt ? r.revealedAt.toISOString() : null,
    participantCount: r._count.participants,
    winners: r.winners.map((w) => ({
      id: w.id,
      rank: w.rank,
      name: w.displayName,
      prize: w.prize,
      fulfilled: Boolean(w.fulfilledAt),
    })),
  }));
}
