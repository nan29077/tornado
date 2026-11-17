/**
 * 왕중왕전 · 이벤트 투표 회차 (2026-11-17). 최고관리자가 연다.
 * 왕중왕전 후보는 "지난달 월간 TOP N" 을 자동으로 추천하고, 관리자가 코드로 더하거나 뺄 수 있다.
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { previousPeriodKey } from '@/lib/vote-period';
import { finalizePeriod, rankTally } from './ranking';

export const ROUND_KIND_LABEL: Record<string, string> = { CHAMPION: '왕중왕전', EVENT: '이벤트 투표' };
export const ROUND_STATUS_LABEL: Record<string, string> = { DRAFT: '준비', OPEN: '진행', CLOSED: '종료' };

/** 지난달(또는 지정 월) 월간 TOP N 크리에이터 ID */
export async function suggestChampionCandidates(topN = 10, now: Date = new Date()): Promise<string[]> {
  const key = previousPeriodKey('MONTH', now);
  await finalizePeriod('MONTH', key);
  const results = await prisma.votePeriodResult.findMany({ where: { periodType: 'MONTH', periodKey: key }, orderBy: { rank: 'asc' }, take: topN, select: { creatorId: true } });
  if (results.length > 0) return results.map((r) => r.creatorId);
  // 지난달 기록이 없으면 누적 상위
  const { rows } = await rankTally('ALL', 'ALL', { limit: topN });
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

/** 진행 중인 회차 (투표 화면 상단 배너용) */
export async function openRounds(now: Date = new Date()) {
  return prisma.voteRound.findMany({ where: { status: 'OPEN', startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { endsAt: 'asc' }, take: 5 });
}
