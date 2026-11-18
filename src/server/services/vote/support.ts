/**
 * 서포트 (2026-11-18) — 팬들이 팬투표권을 모아 크리에이터 광고(신문 · 전광판 등)를 연다.
 *
 * - 최고관리자가 서포트를 연다(크리에이터 · 보상 종류 · 목표 팬투표권 · 기간).
 * - 팬은 팬투표권을 써서 참여한다(팬투표와 같은 지갑 · 같은 잠금 규칙). 쓴 팬투표권은 순위 집계에는 들어가지 않는다.
 * - 목표를 채우면 바로 성공 → 보상 집행 행(SUPPORT) 생성. 기간이 끝났는데 못 채우면 실패 → 참여분을 같은 종류로 돌려준다.
 * - 관리자가 취소해도 돌려준다. 돌려줄 때 유료분은 금액 가치를 그대로 유지한다(환불 · 배분 계산이 어긋나지 않게).
 * - 크리에이터 몫 배분은 하지 않는다(서포트 팬투표권은 광고 집행에 쓰인다).
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { getVoteConfig } from '@/server/services/engagement/config';
import { lockUserTickets, spendTickets } from './wallet';
import { issueSupportReward } from './rewards';
import { syncFanBadges } from './fan';

export const SUPPORT_STATUS_LABEL: Record<string, string> = { OPEN: '진행 중', SUCCESS: '성공', FAILED: '목표 미달', CANCELLED: '취소' };

export interface SupportInput {
  creatorId: string;
  title: string;
  description?: string | null;
  rewardType: string;
  bannerUrl?: string | null;
  goalTickets: number;
  startsAt: Date;
  endsAt: Date;
}

export async function createSupport(input: SupportInput, adminUserId: string): Promise<string> {
  if (!input.title.trim()) throw new Error('서포트 제목을 입력해 주세요.');
  if (!Number.isInteger(input.goalTickets) || input.goalTickets < 10 || input.goalTickets > 1_000_000_000) throw new Error('목표 팬투표권은 10개 이상으로 정해 주세요.');
  if (!(input.endsAt > input.startsAt)) throw new Error('종료 시각은 시작 시각보다 뒤여야 합니다.');
  const c = await prisma.creatorProfile.findUnique({ where: { id: input.creatorId }, select: { id: true, status: true } });
  if (!c || c.status !== 'APPROVED') throw new Error('승인된 크리에이터만 서포트를 열 수 있습니다.');
  const id = newId();
  await prisma.voteSupport.create({
    data: {
      id,
      creatorId: c.id,
      title: input.title.trim().slice(0, 60),
      description: input.description?.trim().slice(0, 500) || null,
      rewardType: input.rewardType,
      bannerUrl: input.bannerUrl || null,
      goalTickets: input.goalTickets,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: adminUserId,
    },
  });
  return id;
}

export interface SupportResult {
  ok: boolean;
  message: string;
  success?: boolean;
}

export async function contributeSupport(userId: string, supportId: string, tickets: number, now: Date = new Date()): Promise<SupportResult> {
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.supportEnabled) return { ok: false, message: '지금은 서포트를 받지 않아요.' };
  const n = Math.trunc(Number(tickets));
  if (!Number.isFinite(n) || n < cfg.supportMinTickets) return { ok: false, message: `서포트는 팬투표권 ${cfg.supportMinTickets}개부터 참여할 수 있어요.` };
  if (n > 1_000_000) return { ok: false, message: '한 번에 너무 많이 참여할 수 없어요.' };
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { status: true, phoneHash: true, creatorProfile: { select: { id: true } } } });
  if (!account || account.status !== 'ACTIVE') return { ok: false, message: '참여할 수 없는 계정입니다.' };
  if (cfg.requirePhone && !account.phoneHash) return { ok: false, message: '휴대폰 번호를 연결한 회원만 참여할 수 있어요.' };
  await settleExpiredSupports(now);
  const support = await prisma.voteSupport.findUnique({ where: { id: supportId } });
  if (!support || support.status !== 'OPEN' || support.startsAt > now || support.endsAt <= now) return { ok: false, message: '진행 중인 서포트가 아니에요.' };
  if (account.creatorProfile?.id === support.creatorId) return { ok: false, message: '내 서포트에는 참여할 수 없어요.' };
  const left = support.goalTickets - support.raisedTickets;
  if (left <= 0) return { ok: false, message: '이미 목표를 채웠어요.' };
  const use = Math.min(n, left);
  const contribId = newId();
  let success = false;
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockUserTickets(tx, userId, now);
      // 서포트 행을 잠그고 남은 목표를 다시 확인한다 (동시에 참여해도 목표를 넘지 않게)
      const rows = await tx.$queryRaw<Array<{ raised_tickets: number; goal_tickets: number; status: string }>>`
        SELECT raised_tickets, goal_tickets, status FROM vote_support WHERE id = ${supportId} FOR UPDATE`;
      const cur = rows[0];
      if (!cur || cur.status !== 'OPEN') throw new Error('진행 중인 서포트가 아니에요.');
      const room = cur.goal_tickets - cur.raised_tickets;
      if (room <= 0) throw new Error('이미 목표를 채웠어요.');
      const take = Math.min(use, room);
      const spent = await spendTickets(tx, userId, take, cfg.spendOrder, { refType: 'SUPPORT', refId: contribId, memo: `서포트 · ${support.title}`, ledgerType: 'SUPPORT_SPEND' }, now, locked);
      const before = await tx.voteSupportContribution.count({ where: { supportId, userId, refundedAt: null } });
      await tx.voteSupportContribution.create({
        data: { id: contribId, supportId, userId, tickets: take, fromFree: spent.free, fromPaid: spent.paid, fromBonus: spent.bonus, paidValue: spent.paidValue, createdAt: now },
      });
      const reached = cur.raised_tickets + take >= cur.goal_tickets;
      await tx.voteSupport.update({
        where: { id: supportId },
        data: {
          raisedTickets: { increment: take },
          participantCount: before === 0 ? { increment: 1 } : undefined,
          ...(reached ? { status: 'SUCCESS', closedAt: now } : {}),
        },
      });
      success = reached;
    });
  } catch (e) {
    const message = (e as Error)?.message ?? '';
    if (/[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return { ok: false, message };
    throw e;
  }
  if (success) await issueSupportReward(support).catch(() => undefined);
  await syncFanBadges(userId).catch(() => undefined);
  return { ok: true, success, message: success ? `팬투표권 ${use.toLocaleString('ko-KR')}개로 서포트 목표를 채웠어요! 광고가 집행돼요.` : `팬투표권 ${use.toLocaleString('ko-KR')}개로 서포트에 참여했어요.${use < n ? ' (목표까지 남은 만큼만 썼어요)' : ''}` };
}

/** 실패 · 취소된 서포트 참여분 반환 (참여 1건씩, 같은 종류 · 같은 금액 가치) */
async function refundContributions(supportId: string, reason: string, now: Date) {
  const cfg = await getVoteConfig();
  const list = await prisma.voteSupportContribution.findMany({ where: { supportId, refundedAt: null }, select: { id: true } });
  for (const { id } of list) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.voteSupportContribution.updateMany({ where: { id, refundedAt: null }, data: { refundedAt: now } });
      if (moved.count === 0) return;
      const c = await tx.voteSupportContribution.findUniqueOrThrow({ where: { id } });
      const parts: Array<['FREE' | 'PAID' | 'BONUS', number, bigint, number]> = [
        ['FREE', c.fromFree, 0n, cfg.freeExpiryDays],
        ['PAID', c.fromPaid, c.paidValue, cfg.paidExpiryDays],
        ['BONUS', c.fromBonus, 0n, cfg.bonusExpiryDays],
      ];
      for (const [bucket, n, value, days] of parts) {
        if (n <= 0) continue;
        const lotId = newId();
        await tx.voteTicketLot.create({
          data: { id: lotId, userId: c.userId, bucket, amount: n, remaining: n, valueWon: value, source: 'SUPPORT_REFUND', refId: c.id, expiresAt: days > 0 ? new Date(now.getTime() + days * 86_400_000) : null },
        });
        await tx.voteTicketLedger.create({ data: { id: newId(), userId: c.userId, bucket, delta: n, type: 'SUPPORT_REFUND', lotId, refType: 'SUPPORT', refId: c.id, memo: reason.slice(0, 200) } });
      }
    });
  }
}

/** 기간이 끝난 진행 중 서포트를 마감한다 (목표 미달 → 반환). 화면 열 때 · 배치에서 부른다 */
export async function settleExpiredSupports(now: Date = new Date()): Promise<number> {
  const due = await prisma.voteSupport.findMany({ where: { status: 'OPEN', endsAt: { lte: now } }, select: { id: true, title: true }, take: 20 });
  let n = 0;
  for (const s of due) {
    const moved = await prisma.voteSupport.updateMany({ where: { id: s.id, status: 'OPEN' }, data: { status: 'FAILED', closedAt: now } });
    if (moved.count === 0) continue;
    await refundContributions(s.id, `서포트 목표 미달 반환 · ${s.title}`, now);
    n++;
  }
  return n;
}

export async function cancelSupport(supportId: string, reason: string, now: Date = new Date()): Promise<void> {
  const moved = await prisma.voteSupport.updateMany({ where: { id: supportId, status: 'OPEN' }, data: { status: 'CANCELLED', closedAt: now } });
  if (moved.count === 0) throw new Error('진행 중인 서포트만 취소할 수 있습니다.');
  await refundContributions(supportId, `서포트 취소 반환 · ${reason}`, now);
}

export async function listSupports(opts: { status?: 'OPEN' | 'DONE' | 'ALL'; creatorId?: string | null; limit?: number } = {}) {
  await settleExpiredSupports().catch(() => undefined);
  const rows = await prisma.voteSupport.findMany({
    where: {
      ...(opts.status === 'OPEN' ? { status: 'OPEN' } : opts.status === 'DONE' ? { status: { in: ['SUCCESS', 'FAILED'] } } : {}),
      ...(opts.creatorId ? { creatorId: opts.creatorId } : {}),
    },
    orderBy: [{ status: 'desc' }, { endsAt: 'asc' }],
    take: Math.min(opts.limit ?? 30, 100),
  });
  const creators = await prisma.creatorProfile.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.creatorId))] } },
    select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } },
  });
  return rows.map((r) => ({ ...r, creator: creators.find((c) => c.id === r.creatorId) ?? null }));
}

export async function getSupportDetail(supportId: string, viewerId?: string | null) {
  await settleExpiredSupports().catch(() => undefined);
  const s = await prisma.voteSupport.findUnique({ where: { id: supportId } });
  if (!s) return null;
  const [creator, top, mine, grant] = await Promise.all([
    prisma.creatorProfile.findUnique({ where: { id: s.creatorId }, select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } } }),
    prisma.voteSupportContribution.groupBy({ by: ['userId'], where: { supportId, refundedAt: null }, _sum: { tickets: true }, orderBy: { _sum: { tickets: 'desc' } }, take: 10 }),
    viewerId ? prisma.voteSupportContribution.aggregate({ where: { supportId, userId: viewerId, refundedAt: null }, _sum: { tickets: true } }) : null,
    prisma.voteRewardGrant.findFirst({ where: { sourceType: 'SUPPORT', sourceKey: supportId } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: top.map((t) => t.userId) } }, select: { id: true, name: true, avatarIndex: true } });
  const { maskNick } = await import('./ranking');
  return {
    support: s,
    creator,
    grant,
    myTickets: mine?._sum.tickets ?? 0,
    top: top.map((t, i) => ({ rank: i + 1, name: maskNick(users.find((u) => u.id === t.userId)?.name ?? null), avatarIndex: users.find((u) => u.id === t.userId)?.avatarIndex ?? 0, tickets: t._sum.tickets ?? 0 })),
  };
}
