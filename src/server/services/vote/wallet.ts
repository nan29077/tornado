/**
 * 팬투표권 지갑 (2026-11-17).
 *
 * - 팬투표권은 묶음(vote_ticket_lot) 단위로 보관한다. 잔액 = 만료되지 않은 묶음의 잔량 합계.
 * - 사용할 때는 해당 회원의 묶음 행을 FOR UPDATE 로 잠근 뒤 다시 읽는다 → 동시에 여러 번 눌러도 초과 사용이 없다.
 *   (DB 에도 remaining >= 0 CHECK 제약이 있다 — 마지막 방어선)
 * - 모든 증감은 vote_ticket_ledger 에 남긴다.
 * - 팬투표권은 팬투표 전용이다. 현금 환급·양도·상품 구매·후원에 쓰는 경로를 만들지 않는다.
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import type { SpendOrder } from '@/server/services/engagement/config';

export type TicketBucket = 'FREE' | 'PAID' | 'BONUS';

export const BUCKET_LABEL: Record<TicketBucket, string> = { FREE: '무료', PAID: '유료', BONUS: '보너스' };

export const LEDGER_TYPE_LABEL: Record<string, string> = {
  OFFERWALL_EARN: '무료 충전 (광고 참여)',
  OFFERWALL_REVOKE: '무료 충전 취소 (광고사 회수)',
  PURCHASE: '구매',
  PURCHASE_BONUS: '구매 보너스',
  VOTE_SPEND: '팬투표 사용',
  REFUND: '환불 회수',
  EXPIRE: '기간 만료',
  ADMIN_GRANT: '관리자 지급',
  ADMIN_REVOKE: '관리자 회수',
  PROMO: '이벤트 지급',
  WITHDRAW_FORFEIT: '회원 탈퇴로 소멸',
  ATTENDANCE: '출석 체크',
  MISSION: '일일 미션',
  REFERRAL: '친구 초대',
  SUPPORT_SPEND: '서포트 참여',
  SUPPORT_REFUND: '서포트 반환',
};

/**
 * 팬투표권을 "사용"한 이력 종류 (9차 P1-1).
 * 환불 가능 여부는 이 종류로 판단한다. 만료 · 환불 회수 · 관리자 회수 · 탈퇴 소멸은 사용이 아니다.
 * 새로 쓰는 곳이 생기면(예: 다른 참여 기능) 여기에 함께 넣는다.
 */
export const TICKET_SPEND_TYPES = ['VOTE_SPEND', 'SUPPORT_SPEND'] as const;

type Tx = Prisma.TransactionClient;

export interface Balance {
  total: number;
  free: number;
  paid: number;
  bonus: number;
  /** 7일 안에 만료되는 수량 */
  expiringSoon: number;
}

export async function getBalance(userId: string, now: Date = new Date(), db: Pick<Tx, 'voteTicketLot'> = prisma): Promise<Balance> {
  const lots = await db.voteTicketLot.findMany({
    where: { userId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { bucket: true, remaining: true, expiresAt: true },
  });
  const soon = now.getTime() + 7 * 86_400_000;
  const b: Balance = { total: 0, free: 0, paid: 0, bonus: 0, expiringSoon: 0 };
  for (const l of lots) {
    b.total += l.remaining;
    if (l.bucket === 'FREE') b.free += l.remaining;
    else if (l.bucket === 'PAID') b.paid += l.remaining;
    else b.bonus += l.remaining;
    if (l.expiresAt && l.expiresAt.getTime() <= soon) b.expiringSoon += l.remaining;
  }
  return b;
}

export interface GrantInput {
  userId: string;
  bucket: TicketBucket;
  amount: number;
  source: string;
  ledgerType: string;
  refType?: string;
  refId?: string;
  valueWon?: bigint;
  expiresInDays?: number;
  memo?: string;
}

/** 팬투표권 지급. 반드시 호출 쪽 트랜잭션(tx) 안에서 부른다. */
export async function grantTickets(tx: Tx, input: GrantInput, now: Date = new Date()): Promise<string> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('지급 수량이 올바르지 않습니다.');
  const lotId = newId();
  const expiresAt = input.expiresInDays && input.expiresInDays > 0 ? new Date(now.getTime() + input.expiresInDays * 86_400_000) : null;
  await tx.voteTicketLot.create({
    data: {
      id: lotId,
      userId: input.userId,
      bucket: input.bucket,
      amount: input.amount,
      remaining: input.amount,
      valueWon: input.valueWon ?? 0n,
      source: input.source,
      refId: input.refId ?? null,
      expiresAt,
    },
  });
  await tx.voteTicketLedger.create({
    data: {
      id: newId(),
      userId: input.userId,
      bucket: input.bucket,
      delta: input.amount,
      type: input.ledgerType,
      lotId,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      memo: input.memo?.slice(0, 200) ?? null,
    },
  });
  return lotId;
}

type LockedLot = { id: string; bucket: string; remaining: number; amount: number; value_won: bigint; expires_at: Date | null };

/** 회원의 사용 가능한 묶음을 잠그고 읽는다 (사용 순서대로 정렬) */
async function lockLots(tx: Tx, userId: string, now: Date): Promise<LockedLot[]> {
  return tx.$queryRaw<LockedLot[]>`
    SELECT id, bucket, remaining, amount, value_won, expires_at
    FROM vote_ticket_lot
    WHERE user_id = ${userId} AND remaining > 0 AND (expires_at IS NULL OR expires_at > ${now})
    ORDER BY created_at ASC
    FOR UPDATE`;
}

/** 버킷 사용 순서. 같은 버킷 안에서는 만료가 가까운 것부터, 만료 없는 것은 마지막 */
export function sortLotsForSpend<T extends { bucket: string; expires_at: Date | null }>(lots: T[], order: SpendOrder): T[] {
  const rank = order === 'PAID_FIRST' ? { PAID: 0, BONUS: 1, FREE: 2 } : { FREE: 0, BONUS: 1, PAID: 2 };
  return [...lots].sort((a, b) => {
    const r = (rank[a.bucket as TicketBucket] ?? 9) - (rank[b.bucket as TicketBucket] ?? 9);
    if (r !== 0) return r;
    const ea = a.expires_at ? a.expires_at.getTime() : Number.MAX_SAFE_INTEGER;
    const eb = b.expires_at ? b.expires_at.getTime() : Number.MAX_SAFE_INTEGER;
    return ea - eb;
  });
}

export interface SpendResult {
  free: number;
  paid: number;
  bonus: number;
  /** 유료분의 금액 가치(원) */
  paidValue: bigint;
}

/**
 * 팬투표권 사용. 반드시 트랜잭션 안에서 부른다. 잔액이 모자라면 예외.
 * 같은 회원의 묶음을 먼저 잠그므로, 이 함수를 부르기 전에 한도 확인을 하더라도 **잠근 뒤에** 다시 확인해야 한다
 * (castVote 는 lockUserTickets → 한도 확인 → spendTickets 순서로 부른다).
 */
export async function spendTickets(
  tx: Tx,
  userId: string,
  count: number,
  order: SpendOrder,
  ref: { refType: string; refId: string; memo?: string; ledgerType?: string },
  now: Date = new Date(),
  preLocked?: LockedLot[],
): Promise<SpendResult> {
  if (!Number.isInteger(count) || count <= 0) throw new Error('사용 수량이 올바르지 않습니다.');
  const lots = sortLotsForSpend(preLocked ?? (await lockLots(tx, userId, now)), order);
  const total = lots.reduce((s, l) => s + l.remaining, 0);
  if (total < count) throw new Error(`팬투표권이 부족합니다. (보유 ${total.toLocaleString('ko-KR')}개 · 필요 ${count.toLocaleString('ko-KR')}개)`);
  let left = count;
  const out: SpendResult = { free: 0, paid: 0, bonus: 0, paidValue: 0n };
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(l.remaining, left);
    const moved = await tx.voteTicketLot.updateMany({ where: { id: l.id, remaining: { gte: take } }, data: { remaining: { decrement: take } } });
    if (moved.count === 0) throw new Error('팬투표권 처리 중 충돌이 발생했습니다. 다시 시도해 주세요.');
    left -= take;
    if (l.bucket === 'FREE') out.free += take;
    else if (l.bucket === 'PAID') {
      out.paid += take;
      if (l.amount > 0) out.paidValue += (BigInt(l.value_won) * BigInt(take)) / BigInt(l.amount);
    } else out.bonus += take;
    await tx.voteTicketLedger.create({
      data: { id: newId(), userId, bucket: l.bucket, delta: -take, type: ref.ledgerType ?? 'VOTE_SPEND', lotId: l.id, refType: ref.refType, refId: ref.refId, memo: ref.memo?.slice(0, 200) ?? null },
    });
  }
  return out;
}

/** 팬투표 직전에 묶음을 잠근다 (한도 확인을 잠금 뒤에 하기 위해) */
export async function lockUserTickets(tx: Tx, userId: string, now: Date = new Date()): Promise<LockedLot[]> {
  return lockLots(tx, userId, now);
}

/** 특정 묶음의 남은 수량을 회수한다 (환불·오퍼월 취소·관리자 회수). 회수한 수량을 돌려준다 */
export async function revokeLot(tx: Tx, lotId: string, type: string, memo: string, ref?: { refType: string; refId: string }): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ id: string; user_id: string; bucket: string; remaining: number }>>`
    SELECT id, user_id, bucket, remaining FROM vote_ticket_lot WHERE id = ${lotId} FOR UPDATE`;
  const lot = rows[0];
  if (!lot || lot.remaining <= 0) return 0;
  await tx.voteTicketLot.update({ where: { id: lot.id }, data: { remaining: 0 } });
  await tx.voteTicketLedger.create({
    data: { id: newId(), userId: lot.user_id, bucket: lot.bucket, delta: -lot.remaining, type, lotId: lot.id, refType: ref?.refType ?? null, refId: ref?.refId ?? null, memo: memo.slice(0, 200) },
  });
  return lot.remaining;
}

/**
 * 관리자 회수: 지정 버킷에서 count 만큼 (만료 임박 묶음부터) 회수한다.
 * 잔량이 모자라면 있는 만큼만 회수하고 실제 회수량을 돌려준다.
 */
export async function adminRevokeTickets(userId: string, bucket: TicketBucket, count: number, memo: string, now: Date = new Date()): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const lots = sortLotsForSpend((await lockLots(tx, userId, now)).filter((l) => l.bucket === bucket), 'FREE_FIRST');
    let left = count;
    let done = 0;
    for (const l of lots) {
      if (left <= 0) break;
      const take = Math.min(l.remaining, left);
      await tx.voteTicketLot.update({ where: { id: l.id }, data: { remaining: { decrement: take } } });
      await tx.voteTicketLedger.create({ data: { id: newId(), userId, bucket, delta: -take, type: 'ADMIN_REVOKE', lotId: l.id, memo: memo.slice(0, 200) } });
      left -= take;
      done += take;
    }
    return done;
  });
}

/** 만료 처리: 기한이 지난 묶음의 남은 수량을 0 으로 만들고 이력을 남긴다. 처리한 묶음 수를 돌려준다 */
export async function expireLots(now: Date = new Date(), limit = 500): Promise<number> {
  const due = await prisma.voteTicketLot.findMany({ where: { remaining: { gt: 0 }, expiresAt: { lte: now } }, select: { id: true }, take: limit });
  let n = 0;
  for (const d of due) {
    const done = await prisma.$transaction((tx) => revokeLot(tx, d.id, 'EXPIRE', '유효기간 만료'));
    if (done > 0) n++;
  }
  return n;
}
