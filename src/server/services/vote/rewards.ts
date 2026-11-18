/**
 * 팬투표 순위 보상 (2026-11-18) — 신문 광고 · 지하철 · 전광판 · 메인 배너 등.
 *
 * - 최고관리자가 보상 정책을 정한다: "월간 1위 → 신문 광고", "주간 1~3위 → 메인 배너", "이벤트 1위 → 전광판" 등.
 * - 기간 순위가 확정되거나(finalizePeriod) 이벤트가 끝나면(회차 종료) 정책에 맞는 크리에이터마다 보상 집행 행이 생긴다.
 *   (출처 · 크리에이터 · 보상 종류) 유니크라 확정이 여러 번 불려도 한 번만 생긴다.
 * - 서포트가 목표를 채우면 그 서포트의 보상 집행 행이 생긴다.
 * - 집행 진행(준비 → 집행 예정 → 집행 완료)과 인증 사진은 최고관리자가 올리고, 팬투표 [보상] 화면에 공개된다.
 * - 실제 광고 매체와의 계약 · 결제는 이 시스템 밖에서 진행한다(여기서는 기록 · 공개만).
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { notifyUser } from '@/server/services/notifications';
import { periodLabel, type VotePeriodType } from '@/lib/vote-period';

export const REWARD_TYPES = ['NEWSPAPER', 'SUBWAY', 'BILLBOARD', 'BUS', 'ONLINE_AD', 'BANNER', 'BIRTHDAY_AD', 'GOODS', 'ETC'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

export const REWARD_TYPE_LABEL: Record<string, string> = {
  NEWSPAPER: '신문 광고',
  SUBWAY: '지하철 광고',
  BILLBOARD: '전광판 광고',
  BUS: '버스 광고',
  ONLINE_AD: '온라인 광고',
  BANNER: '메인 배너',
  BIRTHDAY_AD: '생일 축하 광고',
  GOODS: '기념품',
  ETC: '기타 보상',
};

export const GRANT_STATUS_LABEL: Record<string, string> = { PENDING: '준비 중', SCHEDULED: '집행 예정', PUBLISHED: '집행 완료', CANCELLED: '취소' };

export interface PolicyInput {
  scope: 'PERIOD' | 'ROUND';
  periodType?: VotePeriodType | null;
  roundId?: string | null;
  rankFrom: number;
  rankTo: number;
  rewardType: string;
  title: string;
  description?: string | null;
  active?: boolean;
}

function checkPolicy(p: PolicyInput) {
  if (p.scope !== 'PERIOD' && p.scope !== 'ROUND') throw new Error('보상 대상을 골라 주세요.');
  if (p.scope === 'PERIOD' && !['DAY', 'WEEK', 'MONTH'].includes(p.periodType ?? '')) throw new Error('기간(일간 · 주간 · 월간)을 골라 주세요.');
  if (!(REWARD_TYPES as readonly string[]).includes(p.rewardType)) throw new Error('보상 종류를 골라 주세요.');
  if (!Number.isInteger(p.rankFrom) || !Number.isInteger(p.rankTo) || p.rankFrom < 1 || p.rankTo < p.rankFrom || p.rankTo > 100) throw new Error('순위 범위를 확인해 주세요. (1위 ~ 100위)');
  if (!p.title.trim()) throw new Error('보상 이름을 입력해 주세요.');
}

export async function createRewardPolicy(p: PolicyInput) {
  checkPolicy(p);
  return prisma.voteRewardPolicy.create({
    data: {
      id: newId(),
      scope: p.scope,
      periodType: p.scope === 'PERIOD' ? p.periodType ?? null : null,
      roundId: p.scope === 'ROUND' ? p.roundId || null : null,
      rankFrom: p.rankFrom,
      rankTo: p.rankTo,
      rewardType: p.rewardType,
      title: p.title.trim().slice(0, 60),
      description: p.description?.trim().slice(0, 300) || null,
      active: p.active ?? true,
    },
  });
}

export async function setRewardPolicyActive(id: string, active: boolean) {
  await prisma.voteRewardPolicy.update({ where: { id }, data: { active } });
}

export async function deleteRewardPolicy(id: string) {
  await prisma.voteRewardPolicy.delete({ where: { id } });
}

export async function listRewardPolicies(onlyActive = false) {
  return prisma.voteRewardPolicy.findMany({ where: onlyActive ? { active: true } : {}, orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] });
}

async function createGrants(rows: Array<{ policyId: string | null; creatorId: string; sourceType: string; sourceKey: string; sourceLabel: string; rank: number | null; rewardType: string; title: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  const r = await prisma.voteRewardGrant.createMany({ data: rows.map((x) => ({ id: newId(), ...x })), skipDuplicates: true });
  if (r.count > 0) {
    const creators = await prisma.creatorProfile.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.creatorId))] } }, select: { id: true, userId: true } });
    for (const row of rows) {
      const c = creators.find((x) => x.id === row.creatorId);
      if (c) await notifyUser({ userId: c.userId, title: '팬투표 보상이 정해졌어요', body: `${row.sourceLabel}${row.rank ? ` ${row.rank}위` : ''} · ${row.title}`, linkUrl: '/studio/vote' }).catch(() => undefined);
    }
  }
  return r.count;
}

/** 기간 순위 확정 뒤: 그 기간 정책에 맞는 보상 집행 행을 만든다 */
export async function issuePeriodRewards(periodType: string, key: string): Promise<number> {
  if (!['DAY', 'WEEK', 'MONTH'].includes(periodType)) return 0;
  const policies = await prisma.voteRewardPolicy.findMany({ where: { scope: 'PERIOD', periodType, active: true } });
  if (policies.length === 0) return 0;
  const maxRank = Math.max(...policies.map((p) => p.rankTo));
  const results = await prisma.votePeriodResult.findMany({ where: { periodType, periodKey: key, rank: { lte: maxRank } }, orderBy: { rank: 'asc' } });
  const label = periodLabel(periodType as VotePeriodType, key);
  const rows = [];
  for (const p of policies) {
    for (const r of results) {
      if (r.rank < p.rankFrom || r.rank > p.rankTo) continue;
      rows.push({ policyId: p.id, creatorId: r.creatorId, sourceType: 'PERIOD', sourceKey: `${periodType}:${key}`, sourceLabel: label, rank: r.rank, rewardType: p.rewardType, title: p.title });
    }
  }
  try {
    return await createGrants(rows);
  } catch (e) {
    logger.warn('팬투표 기간 보상 생성 실패', { periodType, key, message: (e as Error).message });
    return 0;
  }
}

/** 이벤트 · 왕중왕전 종료 뒤 */
export async function issueRoundRewards(roundId: string): Promise<number> {
  const round = await prisma.voteRound.findUnique({ where: { id: roundId }, select: { id: true, title: true } });
  if (!round) return 0;
  const policies = await prisma.voteRewardPolicy.findMany({ where: { scope: 'ROUND', active: true, OR: [{ roundId: null }, { roundId }] } });
  if (policies.length === 0) return 0;
  const maxRank = Math.max(...policies.map((p) => p.rankTo));
  const results = await prisma.votePeriodResult.findMany({ where: { periodType: 'ROUND', periodKey: roundId, rank: { lte: maxRank } }, orderBy: { rank: 'asc' } });
  const rows = [];
  for (const p of policies) {
    for (const r of results) {
      if (r.rank < p.rankFrom || r.rank > p.rankTo) continue;
      rows.push({ policyId: p.id, creatorId: r.creatorId, sourceType: 'ROUND', sourceKey: roundId, sourceLabel: round.title, rank: r.rank, rewardType: p.rewardType, title: p.title });
    }
  }
  try {
    return await createGrants(rows);
  } catch (e) {
    logger.warn('팬투표 이벤트 보상 생성 실패', { roundId, message: (e as Error).message });
    return 0;
  }
}

/** 서포트 성공 */
export async function issueSupportReward(support: { id: string; creatorId: string; title: string; rewardType: string }): Promise<number> {
  return createGrants([{ policyId: null, creatorId: support.creatorId, sourceType: 'SUPPORT', sourceKey: support.id, sourceLabel: `서포트 · ${support.title}`, rank: null, rewardType: support.rewardType, title: support.title }]);
}

/** 관리자 직접 추가 */
export async function createManualGrant(input: { creatorId: string; rewardType: string; title: string; sourceLabel: string }) {
  if (!(REWARD_TYPES as readonly string[]).includes(input.rewardType)) throw new Error('보상 종류를 골라 주세요.');
  if (!input.title.trim()) throw new Error('보상 이름을 입력해 주세요.');
  const c = await prisma.creatorProfile.findUnique({ where: { id: input.creatorId }, select: { id: true } });
  if (!c) throw new Error('크리에이터를 찾을 수 없습니다.');
  await createGrants([{ policyId: null, creatorId: c.id, sourceType: 'MANUAL', sourceKey: newId(), sourceLabel: input.sourceLabel.trim().slice(0, 60) || '특별 보상', rank: null, rewardType: input.rewardType, title: input.title.trim().slice(0, 60) }]);
}

export interface GrantUpdate {
  status: 'PENDING' | 'SCHEDULED' | 'PUBLISHED' | 'CANCELLED';
  mediaName?: string | null;
  scheduledAt?: Date | null;
  publishedAt?: Date | null;
  proofImageUrl?: string | null;
  note?: string | null;
}

export async function updateRewardGrant(id: string, u: GrantUpdate, adminUserId: string) {
  if (!['PENDING', 'SCHEDULED', 'PUBLISHED', 'CANCELLED'].includes(u.status)) throw new Error('상태를 골라 주세요.');
  const g = await prisma.voteRewardGrant.findUnique({ where: { id } });
  if (!g) throw new Error('보상을 찾을 수 없습니다.');
  const publishedAt = u.status === 'PUBLISHED' ? u.publishedAt ?? g.publishedAt ?? new Date() : u.publishedAt ?? null;
  await prisma.voteRewardGrant.update({
    where: { id },
    data: {
      status: u.status,
      mediaName: u.mediaName?.trim().slice(0, 60) || null,
      scheduledAt: u.scheduledAt ?? null,
      publishedAt,
      proofImageUrl: u.proofImageUrl || null,
      note: u.note?.trim().slice(0, 300) || null,
      updatedBy: adminUserId,
    },
  });
  if (u.status === 'PUBLISHED' && g.status !== 'PUBLISHED') {
    const c = await prisma.creatorProfile.findUnique({ where: { id: g.creatorId }, select: { userId: true } });
    if (c) await notifyUser({ userId: c.userId, title: '팬투표 보상이 집행됐어요', body: `${g.title}${u.mediaName ? ` · ${u.mediaName}` : ''}`, linkUrl: '/vote/rewards' }).catch(() => undefined);
  }
}

export async function listRewardGrants(opts: { status?: string | null; creatorId?: string | null; publicOnly?: boolean; limit?: number } = {}) {
  const rows = await prisma.voteRewardGrant.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.creatorId ? { creatorId: opts.creatorId } : {}),
      ...(opts.publicOnly ? { status: { not: 'CANCELLED' } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(opts.limit ?? 50, 200),
  });
  const creators = await prisma.creatorProfile.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.creatorId))] } },
    select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } },
  });
  return rows.map((r) => ({ ...r, creator: creators.find((c) => c.id === r.creatorId) ?? null }));
}

/** 메인 배너 보상 중 지금 걸려 있어야 하는 것 (최근 집행 완료 · 14일 이내) */
export async function currentBannerWinners(now: Date = new Date()) {
  const since = new Date(now.getTime() - 14 * 86_400_000);
  return listRewardGrants({ status: 'PUBLISHED', limit: 10 }).then((rows) => rows.filter((r) => r.rewardType === 'BANNER' && r.publishedAt && r.publishedAt >= since).slice(0, 3));
}
