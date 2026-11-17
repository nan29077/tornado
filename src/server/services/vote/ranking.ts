/**
 * 투표 랭킹 조회 · 기간 마감 확정 (2026-11-17).
 *
 * 랭킹 탭
 *   실시간  오늘(KST) 누적 — 투표하면 바로 바뀐다
 *   일간    어제 확정 순위
 *   주간    이번 주(월~일) 누적 · 마감까지 남은 시간
 *   월간    이번 달 누적
 *   왕중왕  진행 중(또는 가장 최근) 왕중왕전
 * 동점이면 먼저 그 표 수에 도달한 쪽(last_vote_at 이 빠른 쪽)이 위다.
 *
 * 마감 확정은 화면을 열 때 지난 기간을 확인해 한 번만 기록한다(배치가 없어도 빠짐없이 확정된다).
 * 기간이 끝나면 그 기간 집계에는 더 이상 표가 들어오지 않으므로 늦게 확정해도 결과는 같다.
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { periodKey, periodRange, previousPeriodKey, type VotePeriodType } from '@/lib/vote-period';

export type RankingTab = 'live' | 'day' | 'week' | 'month' | 'champion';

export const RANKING_TABS: Array<{ key: RankingTab; label: string; short: string }> = [
  { key: 'live', label: '실시간', short: '실시간' },
  { key: 'day', label: '일간', short: '일간' },
  { key: 'week', label: '주간', short: '주간' },
  { key: 'month', label: '월간', short: '월간' },
  { key: 'champion', label: '왕중왕', short: '왕중왕' },
];

export function resolveRankingTab(v: string | undefined | null): RankingTab {
  const s = (v ?? '').toLowerCase();
  return (RANKING_TABS.find((t) => t.key === s)?.key ?? 'live') as RankingTab;
}

export interface RankRow {
  rank: number;
  creatorId: string;
  code: string;
  displayName: string;
  avatarUrl: string | null;
  avatarIndex: number;
  category: string | null;
  votes: number;
  /** 직전 기간 확정 순위 (없으면 null = NEW) */
  prevRank: number | null;
}

type RawRow = {
  rank: bigint | number;
  creator_id: string;
  code: string;
  display_name: string;
  avatar_url: string | null;
  avatar_index: number | null;
  content_category: string | null;
  votes: bigint | number;
};

function mapRow(r: RawRow, prev: Map<string, number>): RankRow {
  return {
    rank: Number(r.rank),
    creatorId: r.creator_id,
    code: r.code,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    avatarIndex: r.avatar_index ?? 0,
    category: r.content_category,
    votes: Number(r.votes),
    prevRank: prev.get(r.creator_id) ?? null,
  };
}

/** 집계표에서 순위를 계산한다 (승인된 크리에이터만). q 가 있으면 이름·코드로 거르되 순위는 전체 기준 */
export async function rankTally(periodType: string, key: string, opts: { limit?: number; offset?: number; q?: string | null } = {}): Promise<{ rows: RawRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.q ?? '').trim().slice(0, 40);
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await prisma.$queryRaw<RawRow[]>`
    WITH ranked AS (
      SELECT ROW_NUMBER() OVER (ORDER BY t.votes DESC, t.last_vote_at ASC, t.creator_id ASC) AS rank,
             t.creator_id, c.code, c.display_name, c.avatar_url, u.avatar_index, c.content_category, t.votes
      FROM vote_tally t
      JOIN creator_profile c ON c.id = t.creator_id AND c.status = 'APPROVED'
      JOIN app_user u ON u.id = c.user_id
      WHERE t.period_type = ${periodType} AND t.period_key = ${key} AND t.votes > 0
    )
    SELECT * FROM ranked
    WHERE (${q} = '' OR display_name ILIKE ${like} OR code ILIKE ${like})
    ORDER BY rank ASC
    LIMIT ${limit} OFFSET ${offset}`;
  const totalRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM vote_tally t JOIN creator_profile c ON c.id = t.creator_id AND c.status = 'APPROVED'
    WHERE t.period_type = ${periodType} AND t.period_key = ${key} AND t.votes > 0`;
  return { rows, total: Number(totalRows[0]?.n ?? 0) };
}

async function prevRanks(periodType: VotePeriodType, prevKey: string): Promise<Map<string, number>> {
  const rows = await prisma.votePeriodResult.findMany({ where: { periodType, periodKey: prevKey, rank: { lte: 300 } }, select: { creatorId: true, rank: true } });
  return new Map(rows.map((r) => [r.creatorId, r.rank]));
}

/** 마감된 기간의 순위를 확정 기록한다 (이미 있으면 아무것도 하지 않는다). 기록한 행 수 */
export async function finalizePeriod(periodType: string, key: string): Promise<number> {
  const exists = await prisma.votePeriodResult.findFirst({ where: { periodType, periodKey: key }, select: { id: true } });
  if (exists) return 0;
  const { rows } = await rankTally(periodType, key, { limit: 200 });
  if (rows.length === 0) return 0;
  const now = new Date();
  const r = await prisma.votePeriodResult.createMany({
    data: rows.map((x) => ({ id: newId(), periodType, periodKey: key, creatorId: x.creator_id, rank: Number(x.rank), votes: BigInt(x.votes), finalizedAt: now })),
    skipDuplicates: true,
  });
  return r.count;
}

let lastEnsure = 0;

/** 지난 일·주·월 기간과 끝난 회차를 확정한다. 화면을 열 때 호출하며, 프로세스당 1분에 한 번만 실제로 확인한다 */
export async function ensureRecentFinalized(now: Date = new Date(), force = false): Promise<void> {
  if (!force && Date.now() - lastEnsure < 60_000) return;
  lastEnsure = Date.now();
  try {
    for (const t of ['DAY', 'WEEK', 'MONTH'] as const) {
      await finalizePeriod(t, previousPeriodKey(t, now));
    }
    const ended = await prisma.voteRound.findMany({ where: { status: 'OPEN', endsAt: { lte: now } }, select: { id: true } });
    for (const r of ended) {
      await prisma.voteRound.update({ where: { id: r.id }, data: { status: 'CLOSED' } });
      await finalizePeriod('ROUND', r.id);
    }
  } catch {
    lastEnsure = 0; // 다음 접속 때 다시 시도
  }
}

export interface RankingView {
  tab: RankingTab;
  title: string;
  /** 기간 설명 (오늘 · 어제 확정 · 이번 주 …) */
  caption: string;
  /** 진행 중인 기간이면 마감 시각 */
  endsAt: Date | null;
  rows: RankRow[];
  total: number;
  /** 왕중왕 탭: 회차 정보 */
  round?: { id: string; title: string; description: string | null; status: string; startsAt: Date; endsAt: Date } | null;
}

/** 랭킹 탭 하나 */
export async function getRanking(tab: RankingTab, opts: { limit?: number; offset?: number; q?: string | null; now?: Date } = {}): Promise<RankingView> {
  const now = opts.now ?? new Date();
  await ensureRecentFinalized(now);
  if (tab === 'champion') {
    const round =
      (await prisma.voteRound.findFirst({ where: { kind: 'CHAMPION', status: 'OPEN', startsAt: { lte: now } }, orderBy: { startsAt: 'desc' } })) ??
      (await prisma.voteRound.findFirst({ where: { kind: 'CHAMPION', status: { in: ['OPEN', 'CLOSED'] } }, orderBy: { endsAt: 'desc' } }));
    if (!round) return { tab, title: '왕중왕전', caption: '아직 열린 왕중왕전이 없어요.', endsAt: null, rows: [], total: 0, round: null };
    const rows = await roundRanking(round.id, opts);
    const live = round.status === 'OPEN' && round.endsAt > now && round.startsAt <= now;
    return {
      tab,
      title: round.title,
      caption: live ? '왕중왕전 진행 중' : round.status === 'OPEN' && round.startsAt > now ? '곧 시작해요' : '왕중왕전 종료 · 최종 결과',
      endsAt: live ? round.endsAt : null,
      rows,
      total: rows.length,
      round: { id: round.id, title: round.title, description: round.description, status: live ? 'OPEN' : round.status === 'OPEN' && round.startsAt > now ? 'UPCOMING' : 'CLOSED', startsAt: round.startsAt, endsAt: round.endsAt },
    };
  }
  if (tab === 'day') {
    const key = previousPeriodKey('DAY', now);
    const prevOfPrev = previousPeriodKey('DAY', new Date(periodRange('DAY', now).start.getTime() - 1000));
    // 어제 확정 결과 (확정 전이면 집계에서 바로)
    const [{ rows, total }, prev] = await Promise.all([rankTally('DAY', key, opts), prevRanks('DAY', prevOfPrev)]);
    return { tab, title: '일간 랭킹', caption: '어제 하루 동안 받은 표 · 확정 순위', endsAt: null, rows: rows.map((r) => mapRow(r, prev)), total };
  }
  const type: VotePeriodType = tab === 'live' ? 'DAY' : tab === 'week' ? 'WEEK' : 'MONTH';
  const key = periodKey(type, now);
  const [{ rows, total }, prev] = await Promise.all([rankTally(type, key, opts), prevRanks(type, previousPeriodKey(type, now))]);
  const caption = tab === 'live' ? '오늘 받은 표 · 실시간으로 바뀌어요' : tab === 'week' ? '이번 주(월~일) 누적' : '이번 달 누적';
  return {
    tab,
    title: tab === 'live' ? '실시간 랭킹' : tab === 'week' ? '주간 랭킹' : '월간 랭킹',
    caption,
    endsAt: periodRange(type, now).end,
    rows: rows.map((r) => mapRow(r, prev)),
    total,
  };
}

/** 회차 순위 — 표가 없는 후보도 0표로 함께 보여 준다 */
export async function roundRanking(roundId: string, opts: { limit?: number; q?: string | null } = {}): Promise<RankRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT ROW_NUMBER() OVER (ORDER BY COALESCE(t.votes, 0) DESC, t.last_vote_at ASC NULLS LAST, rc.sort_order ASC) AS rank,
           rc.creator_id, c.code, c.display_name, c.avatar_url, u.avatar_index, c.content_category, COALESCE(t.votes, 0) AS votes
    FROM vote_round_candidate rc
    JOIN creator_profile c ON c.id = rc.creator_id AND c.status = 'APPROVED'
    JOIN app_user u ON u.id = c.user_id
    LEFT JOIN vote_tally t ON t.period_type = 'ROUND' AND t.period_key = rc.round_id AND t.creator_id = rc.creator_id
    WHERE rc.round_id = ${roundId}
    ORDER BY rank ASC
    LIMIT ${limit}`;
  const q = (opts.q ?? '').trim().toLowerCase();
  const empty = new Map<string, number>();
  return rows.map((r) => mapRow(r, empty)).filter((r) => !q || r.displayName.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
}

/** 크리에이터 한 명의 현재 순위 (실시간·주간·월간·누적) */
export async function getCreatorRanks(creatorId: string, now: Date = new Date()) {
  const specs: Array<{ key: 'live' | 'week' | 'month' | 'all'; type: string; pk: string }> = [
    { key: 'live', type: 'DAY', pk: periodKey('DAY', now) },
    { key: 'week', type: 'WEEK', pk: periodKey('WEEK', now) },
    { key: 'month', type: 'MONTH', pk: periodKey('MONTH', now) },
    { key: 'all', type: 'ALL', pk: 'ALL' },
  ];
  const out: Record<'live' | 'week' | 'month' | 'all', { rank: number | null; votes: number }> = {
    live: { rank: null, votes: 0 },
    week: { rank: null, votes: 0 },
    month: { rank: null, votes: 0 },
    all: { rank: null, votes: 0 },
  };
  await Promise.all(
    specs.map(async (s) => {
      const mine = await prisma.voteTally.findUnique({ where: { periodType_periodKey_creatorId: { periodType: s.type, periodKey: s.pk, creatorId } } });
      if (!mine || mine.votes <= 0n) return;
      const higher = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM vote_tally t JOIN creator_profile c ON c.id = t.creator_id AND c.status = 'APPROVED'
        WHERE t.period_type = ${s.type} AND t.period_key = ${s.pk}
          AND (t.votes > ${mine.votes} OR (t.votes = ${mine.votes} AND (t.last_vote_at < ${mine.lastVoteAt} OR (t.last_vote_at = ${mine.lastVoteAt} AND t.creator_id < ${creatorId}))))`;
      out[s.key] = { rank: Number(higher[0]?.n ?? 0) + 1, votes: Number(mine.votes) };
    }),
  );
  return out;
}

/** 최근 N일 일별 받은 표 (오래된 날 → 오늘) */
export async function getCreatorDailyTrend(creatorId: string, days = 30, now: Date = new Date()) {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(periodKey('DAY', new Date(now.getTime() - i * 86_400_000)));
  const rows = await prisma.voteTally.findMany({ where: { creatorId, periodType: 'DAY', periodKey: { in: keys } }, select: { periodKey: true, votes: true } });
  const map = new Map(rows.map((r) => [r.periodKey, Number(r.votes)]));
  const results = await prisma.votePeriodResult.findMany({ where: { creatorId, periodType: 'DAY', periodKey: { in: keys } }, select: { periodKey: true, rank: true } });
  const rmap = new Map(results.map((r) => [r.periodKey, r.rank]));
  return keys.map((k) => ({ key: k, votes: map.get(k) ?? 0, rank: rmap.get(k) ?? null }));
}

/** 나에게 투표한 팬 순위 (기간 내, 무효 제외). 이름은 닉네임만, 개인정보 없음 */
export async function getTopVoters(creatorId: string, since: Date | null, limit = 20) {
  const grouped = await prisma.voteCast.groupBy({
    by: ['userId'],
    where: { creatorId, voidedAt: null, roundId: null, ...(since ? { createdAt: { gte: since } } : {}) },
    _sum: { votes: true },
    orderBy: { _sum: { votes: 'desc' } },
    take: limit,
  });
  const users = await prisma.user.findMany({ where: { id: { in: grouped.map((g) => g.userId) } }, select: { id: true, name: true, avatarIndex: true } });
  const umap = new Map(users.map((u) => [u.id, u]));
  return grouped.map((g, i) => {
    const u = umap.get(g.userId);
    return { rank: i + 1, userId: g.userId, name: maskNick(u?.name ?? null), avatarIndex: u?.avatarIndex ?? 0, votes: g._sum.votes ?? 0 };
  });
}

function maskNick(name: string | null): string {
  const n = (name ?? '').trim();
  if (!n) return '익명 팬';
  if (n.length <= 2) return `${n[0]}*`;
  return `${n.slice(0, 2)}${'*'.repeat(Math.min(3, n.length - 2))}`;
}

/** 명예의 전당: 월간 1위 + 왕중왕전 우승 */
export async function getHallOfFame(limit = 24) {
  const months = await prisma.votePeriodResult.findMany({
    where: { periodType: 'MONTH', rank: 1 },
    orderBy: { periodKey: 'desc' },
    take: limit,
    include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, status: true, user: { select: { avatarIndex: true } } } } },
  });
  const rounds = await prisma.voteRound.findMany({ where: { kind: 'CHAMPION', status: 'CLOSED' }, orderBy: { endsAt: 'desc' }, take: limit });
  const champs = await prisma.votePeriodResult.findMany({
    where: { periodType: 'ROUND', periodKey: { in: rounds.map((r) => r.id) }, rank: 1 },
    include: { creator: { select: { id: true, code: true, displayName: true, avatarUrl: true, status: true, user: { select: { avatarIndex: true } } } } },
  });
  const cmap = new Map(champs.map((c) => [c.periodKey, c]));
  return {
    months: months.filter((m) => m.creator.status === 'APPROVED'),
    champions: rounds.map((r) => ({ round: r, winner: cmap.get(r.id) ?? null })).filter((x) => x.winner && x.winner.creator.status === 'APPROVED'),
  };
}

/** 크리에이터의 확정 순위 이력 (최근 순) */
export async function getCreatorResultHistory(creatorId: string, limit = 20) {
  return prisma.votePeriodResult.findMany({ where: { creatorId, rank: { lte: 100 } }, orderBy: { finalizedAt: 'desc' }, take: limit });
}
