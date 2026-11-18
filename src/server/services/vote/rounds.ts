/**
 * 왕중왕전 · 이벤트 팬투표 회차 (2026-11-17). 최고관리자가 연다.
 * 왕중왕전 후보는 "지난달 월간 TOP N" 을 자동으로 추천하고, 관리자가 코드로 더하거나 뺄 수 있다.
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { previousPeriodKey } from '@/lib/vote-period';
import { finalizePeriod, rankTally } from './ranking';

export const ROUND_KIND_LABEL: Record<string, string> = { CHAMPION: '왕중왕전', EVENT: '이벤트 팬투표' };
export const ROUND_STATUS_LABEL: Record<string, string> = { DRAFT: '준비', OPEN: '진행', CLOSED: '종료' };

/** 지난달(또는 지정 월) 월간 TOP N 크리에이터 ID */
export async function suggestChampionCandidates(topN = 10, now: Date = new Date(), category?: string | null): Promise<string[]> {
  const key = previousPeriodKey('MONTH', now);
  await finalizePeriod('MONTH', key);
  const results = await prisma.votePeriodResult.findMany({
    where: { periodType: 'MONTH', periodKey: key, ...(category ? { creator: { contentCategory: category } } : {}) },
    orderBy: { rank: 'asc' },
    take: topN,
    select: { creatorId: true },
  });
  if (results.length > 0) return results.map((r) => r.creatorId);
  // 지난달 기록이 없으면 누적 상위 (카테고리를 주면 그 카테고리 안에서)
  const { rows } = await rankTally('ALL', 'ALL', { limit: topN, category: category ?? null });
  return rows.map((r) => r.creator_id);
}

export interface RoundInput {
  kind: 'CHAMPION' | 'EVENT';
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt: Date;
  creatorIds: string[];
  status?: 'DRAFT' | 'OPEN';
  bannerUrl?: string | null;
  rewardText?: string | null;
  dailyMaxVotes?: number | null;
}

export async function createRound(input: RoundInput, adminUserId: string): Promise<string> {
  if (!input.title.trim()) throw new Error('회차 제목을 입력해 주세요.');
  if (!(input.endsAt > input.startsAt)) throw new Error('종료 시각은 시작 시각보다 뒤여야 합니다.');
  const ids = [...new Set(input.creatorIds)];
  if (ids.length < 2) throw new Error('후보는 2명 이상이어야 합니다.');
  if (ids.length > 100) throw new Error('후보는 100명까지 넣을 수 있습니다.');
  const ok = await prisma.creatorProfile.count({ where: { id: { in: ids }, status: 'APPROVED' } });
  if (ok !== ids.length) throw new Error('승인되지 않았거나 찾을 수 없는 크리에이터가 후보에 있습니다.');
  const id = newId();
  await prisma.voteRound.create({
    data: {
      id,
      kind: input.kind,
      title: input.title.trim().slice(0, 60),
      description: input.description?.trim().slice(0, 300) || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: input.status ?? 'DRAFT',
      bannerUrl: input.bannerUrl || null,
      rewardText: input.rewardText?.trim().slice(0, 120) || null,
      dailyMaxVotes: Math.max(0, Math.trunc(Number(input.dailyMaxVotes ?? 0)) || 0),
      createdBy: adminUserId,
      candidates: { create: ids.map((creatorId, i) => ({ id: newId(), creatorId, sortOrder: i })) },
    },
  });
  return id;
}

export async function setRoundStatus(roundId: string, status: 'DRAFT' | 'OPEN' | 'CLOSED') {
  const round = await prisma.voteRound.findUnique({ where: { id: roundId } });
  if (!round) throw new Error('회차를 찾을 수 없습니다.');
  if (round.status === 'CLOSED' && status !== 'CLOSED') throw new Error('종료된 회차는 다시 열 수 없습니다. 새 회차를 만들어 주세요.');
  await prisma.voteRound.update({ where: { id: roundId }, data: { status } });
  if (status === 'CLOSED') await finalizePeriod('ROUND', roundId);
}

/** 진행 중인 회차 (팬투표 화면 상단 배너용) */
export async function openRounds(now: Date = new Date()) {
  return prisma.voteRound.findMany({ where: { status: 'OPEN', startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { endsAt: 'asc' }, take: 5 });
}

/** 기간이 끝난 진행 중 회차를 종료 처리한다(결과 확정 · 보상). 화면 열 때 부른다 — 배치가 없어도 누락이 없다 */
export async function closeEndedRounds(now: Date = new Date()): Promise<number> {
  const due = await prisma.voteRound.findMany({ where: { status: 'OPEN', endsAt: { lte: now } }, select: { id: true }, take: 20 });
  for (const r of due) {
    const moved = await prisma.voteRound.updateMany({ where: { id: r.id, status: 'OPEN' }, data: { status: 'CLOSED' } });
    if (moved.count > 0) await finalizePeriod('ROUND', r.id).catch(() => 0);
  }
  return due.length;
}

/** 이벤트 목록 (진행 · 예정 · 종료) */
export async function listEventRounds(now: Date = new Date()) {
  await closeEndedRounds(now).catch(() => 0);
  const rows = await prisma.voteRound.findMany({
    where: { status: { in: ['OPEN', 'CLOSED'] } },
    orderBy: [{ endsAt: 'desc' }],
    take: 60,
    include: { candidates: { select: { creatorId: true } } },
  });
  const live = rows.filter((r) => r.status === 'OPEN' && r.startsAt <= now && r.endsAt > now).sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
  const upcoming = rows.filter((r) => r.status === 'OPEN' && r.startsAt > now).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const ended = rows.filter((r) => r.status === 'CLOSED').slice(0, 30);
  return { live, upcoming, ended };
}

/** 이벤트 결과 리포트: 순위 · 표 수 · 득표율 · 참여 회원 수 */
export async function roundReport(roundId: string) {
  const round = await prisma.voteRound.findUnique({ where: { id: roundId }, include: { candidates: { orderBy: { sortOrder: 'asc' }, select: { creatorId: true } } } });
  if (!round) return null;
  const [casts, voters] = await Promise.all([
    prisma.voteCast.aggregate({ where: { roundId, voidedAt: null }, _sum: { votes: true } }),
    prisma.voteCast.findMany({ where: { roundId, voidedAt: null }, distinct: ['userId'], select: { userId: true } }),
  ]);
  return { round, totalVotes: casts._sum.votes ?? 0, voters: voters.length };
}
