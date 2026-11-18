/**
 * 팬투표하기 (2026-11-17).
 *
 * 한 트랜잭션 안에서: 팬투표권 묶음 잠금 → 한도 확인 → 팬투표권 소진 → 팬투표 기록 → 기간별 집계(일·주·월·누적) 증가
 *   → (유료분 × 크리에이터 몫 비율 > 0 이면) 정산 원장 VOTE_REVENUE_SHARE 적립.
 * 크리에이터 몫 비율은 "크리에이터별 지정 > 전역 기본값". 1차 운영값은 0(나누지 않음).
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { hmac } from '@/lib/crypto';
import { kstStartOfDay } from '@/lib/datetime';
import { periodKey } from '@/lib/vote-period';
import { appendLedger } from '@/server/services/settlement';
import { getCreatorEngagement, getTalkConfig, getVoteConfig, rateOf } from '@/server/services/engagement/config';
import { lockUserTickets, spendTickets } from './wallet';
import { rewardInviterOnFirstVote, syncFanBadges } from './fan';

type Tx = Prisma.TransactionClient;

export interface CastInput {
  creatorId: string;
  votes: number;
  roundId?: string | null;
  ip?: string | null;
}

export interface CastResult {
  ok: boolean;
  message: string;
  castId?: string;
  votes?: number;
  tickets?: number;
}

/** 기간별 집계 증가 (동시에 여러 명이 팬투표해도 행이 하나만 생기도록 ON CONFLICT 로 더한다) */
export async function bumpTally(tx: Tx, periodType: string, periodKeyValue: string, creatorId: string, votes: number, at: Date) {
  await tx.$executeRaw`
    INSERT INTO vote_tally (id, period_type, period_key, creator_id, votes, last_vote_at)
    VALUES (${newId()}, ${periodType}, ${periodKeyValue}, ${creatorId}, ${BigInt(votes)}, ${at})
    ON CONFLICT (period_type, period_key, creator_id)
    DO UPDATE SET votes = vote_tally.votes + EXCLUDED.votes, last_vote_at = EXCLUDED.last_vote_at`;
}

export async function castVote(user: { id: string }, input: CastInput, now: Date = new Date()): Promise<CastResult> {
  const cfg = await getVoteConfig();
  if (!cfg.enabled) return { ok: false, message: '지금은 팬투표를 받지 않습니다.' };
  const votes = Math.trunc(Number(input.votes));
  if (!Number.isFinite(votes) || votes < 1) return { ok: false, message: '1표 이상 선택해 주세요.' };
  if (votes > cfg.maxVotesPerAction) return { ok: false, message: `한 번에 최대 ${cfg.maxVotesPerAction.toLocaleString('ko-KR')}표까지 팬투표할 수 있어요.` };

  const [account, creator] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { id: true, status: true, phoneHash: true, creatorProfile: { select: { id: true } } } }),
    prisma.creatorProfile.findUnique({ where: { id: input.creatorId }, select: { id: true, status: true, displayName: true } }),
  ]);
  if (!account || account.status !== 'ACTIVE') return { ok: false, message: '팬투표할 수 없는 계정입니다.' };
  if (!creator || creator.status !== 'APPROVED') return { ok: false, message: '팬투표할 수 없는 크리에이터입니다.' };
  if (account.creatorProfile?.id === creator.id) return { ok: false, message: '내 채널에는 팬투표할 수 없어요.' };
  if (cfg.requirePhone && !account.phoneHash) return { ok: false, message: '휴대폰 번호를 연결한 회원만 팬투표할 수 있어요. 마이페이지 > 내 정보에서 연결해 주세요.' };

  // 왕중왕전·이벤트 회차
  let roundId: string | null = null;
  let roundDailyMax = 0;
  if (input.roundId) {
    const round = await prisma.voteRound.findUnique({ where: { id: input.roundId }, include: { candidates: { where: { creatorId: creator.id }, select: { id: true } } } });
    if (!round || round.status !== 'OPEN' || round.startsAt > now || round.endsAt <= now) return { ok: false, message: '진행 중인 팬투표가 아닙니다.' };
    if (round.candidates.length === 0) return { ok: false, message: '이 팬투표의 후보가 아닙니다.' };
    roundId = round.id;
    roundDailyMax = round.dailyMaxVotes ?? 0;
  }

  const tickets = votes * cfg.ticketsPerVote;
  const engagement = await getCreatorEngagement(creator.id, prisma, { vote: cfg, talk: await getTalkConfig() });
  const ipHash = input.ip ? hmac(`vote-ip:${input.ip}`).slice(0, 32) : null;
  const castId = newId();
  const dayStart = kstStartOfDay(now);

  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockUserTickets(tx, user.id, now);
      // 한도 확인은 잠근 뒤에 (동시에 눌러도 한도를 넘지 않게)
      if (cfg.dailyMaxVotesPerUser > 0 || cfg.dailyMaxVotesPerCreator > 0) {
        const [all, toCreator] = await Promise.all([
          cfg.dailyMaxVotesPerUser > 0
            ? tx.voteCast.aggregate({ where: { userId: user.id, createdAt: { gte: dayStart }, voidedAt: null }, _sum: { votes: true } })
            : null,
          cfg.dailyMaxVotesPerCreator > 0
            ? tx.voteCast.aggregate({ where: { userId: user.id, creatorId: creator.id, createdAt: { gte: dayStart }, voidedAt: null }, _sum: { votes: true } })
            : null,
        ]);
        const usedAll = all?._sum.votes ?? 0;
        const usedCreator = toCreator?._sum.votes ?? 0;
        if (cfg.dailyMaxVotesPerUser > 0 && usedAll + votes > cfg.dailyMaxVotesPerUser) {
          throw new Error(`오늘은 ${Math.max(0, cfg.dailyMaxVotesPerUser - usedAll).toLocaleString('ko-KR')}표까지 더 팬투표할 수 있어요. (하루 최대 ${cfg.dailyMaxVotesPerUser.toLocaleString('ko-KR')}표)`);
        }
        if (cfg.dailyMaxVotesPerCreator > 0 && usedCreator + votes > cfg.dailyMaxVotesPerCreator) {
          throw new Error(`이 크리에이터에게는 오늘 ${Math.max(0, cfg.dailyMaxVotesPerCreator - usedCreator).toLocaleString('ko-KR')}표까지 더 팬투표할 수 있어요.`);
        }
      }
      // (2026-11-18) 이벤트별 하루 한도
      if (roundId && roundDailyMax > 0) {
        const r = await tx.voteCast.aggregate({ where: { userId: user.id, roundId, createdAt: { gte: dayStart }, voidedAt: null }, _sum: { votes: true } });
        const used = r._sum.votes ?? 0;
        if (used + votes > roundDailyMax) throw new Error(`이 이벤트에는 오늘 ${Math.max(0, roundDailyMax - used).toLocaleString('ko-KR')}표까지 더 팬투표할 수 있어요. (하루 최대 ${roundDailyMax.toLocaleString('ko-KR')}표)`);
      }
      const spent = await spendTickets(tx, user.id, tickets, cfg.spendOrder, { refType: 'VOTE_CAST', refId: castId, memo: `${creator.displayName} ${votes}표` }, now, locked);
      const shareAmount = rateOf(spent.paidValue, engagement.voteShareRate);
      await tx.voteCast.create({
        data: {
          id: castId,
          userId: user.id,
          creatorId: creator.id,
          roundId,
          votes,
          tickets,
          fromFree: spent.free,
          fromPaid: spent.paid,
          fromBonus: spent.bonus,
          paidValue: spent.paidValue,
          shareRate: engagement.voteShareRate.toFixed(6),
          shareAmount,
          ipHash,
          createdAt: now,
        },
      });
      if (roundId) {
        await bumpTally(tx, 'ROUND', roundId, creator.id, votes, now);
      } else {
        await bumpTally(tx, 'DAY', periodKey('DAY', now), creator.id, votes, now);
        await bumpTally(tx, 'WEEK', periodKey('WEEK', now), creator.id, votes, now);
        await bumpTally(tx, 'MONTH', periodKey('MONTH', now), creator.id, votes, now);
        await bumpTally(tx, 'ALL', 'ALL', creator.id, votes, now);
      }
      if (shareAmount > 0n) {
        await appendLedger(
          [{ creatorId: creator.id, entryType: 'VOTE_REVENUE_SHARE', amount: shareAmount, memo: `팬투표 수익 배분 ${votes}표 (유료분 ${spent.paidValue.toString()}원 × ${(engagement.voteShareRate * 100).toFixed(2)}%) #${castId}`, occurredAt: now }],
          tx,
        );
      }
    });
  } catch (e) {
    const message = (e as Error)?.message ?? '';
    if (/[가-힣]/.test(message) && !/prisma|invocation/i.test(message)) return { ok: false, message };
    throw e;
  }
  // (2026-11-18) 친구 초대 보상(첫 팬투표) · 배지. 실패해도 팬투표 결과는 그대로다
  await rewardInviterOnFirstVote(user.id, now).catch(() => false);
  await syncFanBadges(user.id).catch(() => undefined);
  return { ok: true, message: `${creator.displayName} 님에게 ${votes.toLocaleString('ko-KR')}표를 보냈어요.`, castId, votes, tickets };
}

/**
 * 관리자 무효 처리: 집계에서 빼고, 팬투표권은 돌려주지 않는다(부정 팬투표 회수 원칙).
 * 크리에이터 몫이 적립돼 있었다면 반대분개한다. 이미 마감·확정된 기간의 확정 순위는 바꾸지 않는다.
 */
export async function voidVoteCast(castId: string, adminUserId: string, reason: string, refundTickets = false): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const cast = await tx.voteCast.findUnique({ where: { id: castId } });
    if (!cast) throw new Error('팬투표 기록을 찾을 수 없습니다.');
    const moved = await tx.voteCast.updateMany({ where: { id: castId, voidedAt: null }, data: { voidedAt: now, voidReason: reason.slice(0, 200), voidedBy: adminUserId } });
    if (moved.count === 0) throw new Error('이미 무효 처리된 팬투표입니다.');
    const minus = -cast.votes;
    const keys: Array<[string, string]> = cast.roundId
      ? [['ROUND', cast.roundId]]
      : [['DAY', periodKey('DAY', cast.createdAt)], ['WEEK', periodKey('WEEK', cast.createdAt)], ['MONTH', periodKey('MONTH', cast.createdAt)], ['ALL', 'ALL']];
    for (const [t, k] of keys) {
      await tx.$executeRaw`UPDATE vote_tally SET votes = GREATEST(0, votes + ${BigInt(minus)}) WHERE period_type = ${t} AND period_key = ${k} AND creator_id = ${cast.creatorId}`;
    }
    if (cast.shareAmount > 0n) {
      await appendLedger([{ creatorId: cast.creatorId, entryType: 'VOTE_REVENUE_SHARE', amount: -cast.shareAmount, memo: `팬투표 무효 처리 반대분개 #${cast.id}`, occurredAt: now }], tx);
    }
    if (refundTickets) {
      // 사용한 버킷 그대로 돌려준다 (유효기간은 새로 시작)
      const parts: Array<['FREE' | 'PAID' | 'BONUS', number]> = [['FREE', cast.fromFree], ['PAID', cast.fromPaid], ['BONUS', cast.fromBonus]];
      for (const [bucket, n] of parts) {
        if (n <= 0) continue;
        const lotId = newId();
        await tx.voteTicketLot.create({ data: { id: lotId, userId: cast.userId, bucket, amount: n, remaining: n, valueWon: bucket === 'PAID' ? cast.paidValue : 0n, source: 'ADMIN', refId: cast.id } });
        await tx.voteTicketLedger.create({ data: { id: newId(), userId: cast.userId, bucket, delta: n, type: 'ADMIN_GRANT', lotId, refType: 'VOTE_VOID', refId: cast.id, memo: '무효 처리된 팬투표의 팬투표권 반환' } });
      }
    }
  });
}
