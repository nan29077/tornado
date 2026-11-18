import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { revokeLot } from '@/server/services/vote/wallet';

/**
 * [6차 P1-3] 회원 탈퇴 전 확인 · 정리.
 *
 * 탈퇴를 막는 것 (돈·배송이 아직 끝나지 않은 일)
 *  - 진행 중인 샵 주문(결제 대기 ~ 배송 중)과 처리 중인 취소·반품 요청
 *  - 아직 끝나지 않은 1:1 채팅 예약(신청·수락)
 * 동의가 필요한 것 (탈퇴하면 사라지는 유료 자산)
 *  - 남은 유료 투표권, 이용 기간이 남은 소통 구독
 * 탈퇴와 함께 지우는 것 (개인정보·개인 설정)
 *  - 배송지, 장바구니, 찜, 팔로우, 남은 투표권(이력은 원장에 남긴다), 소통 구독
 */
type Tx = Prisma.TransactionClient;

const OPEN_ORDER = ['PENDING_PAYMENT', 'PAID', 'PREPARING', 'SHIPPED'];

export interface WithdrawSummary {
  /** 탈퇴를 막는 사유 (비어 있으면 진행 가능) */
  blockers: string[];
  /** 남은 유료 투표권 수 */
  paidTickets: number;
  /** 이용 기간이 남은 소통 구독 수 */
  activeSubs: number;
}

export async function getWithdrawSummary(userId: string, now: Date = new Date()): Promise<WithdrawSummary> {
  const [orders, claims, sessions, paid, subs] = await Promise.all([
    prisma.shopOrder.count({ where: { userId, status: { in: OPEN_ORDER } } }),
    prisma.orderClaim.count({ where: { order: { userId }, status: { in: ['REQUESTED', 'APPROVED'] } } }),
    prisma.talkSession.count({ where: { userId, status: { in: ['REQUESTED', 'ACCEPTED'] }, endsAt: { gt: now } } }),
    prisma.voteTicketLot.aggregate({
      where: { userId, bucket: 'PAID', remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      _sum: { remaining: true },
    }),
    prisma.talkSubscription.count({ where: { userId, status: 'ACTIVE', endsAt: { gt: now } } }),
  ]);
  const blockers: string[] = [];
  if (orders > 0) blockers.push(`진행 중인 상품 주문이 ${orders}건 있습니다. 배송이 끝나거나 주문을 취소한 뒤에 탈퇴할 수 있습니다.`);
  if (claims > 0) blockers.push(`처리 중인 취소·반품 요청이 ${claims}건 있습니다. 처리가 끝난 뒤에 탈퇴할 수 있습니다.`);
  if (sessions > 0) blockers.push(`예약된 1:1 채팅이 ${sessions}건 있습니다. 채팅을 마치거나 예약을 취소한 뒤에 탈퇴할 수 있습니다.`);
  return { blockers, paidTickets: paid._sum.remaining ?? 0, activeSubs: subs };
}

/** 탈퇴 트랜잭션 안에서 개인 데이터와 남은 이용권을 정리한다. */
export async function cleanupMemberOnWithdraw(tx: Tx, userId: string, now: Date = new Date()): Promise<void> {
  await tx.memberAddress.deleteMany({ where: { userId } });
  await tx.cartItem.deleteMany({ where: { userId } });
  await tx.productWish.deleteMany({ where: { userId } });
  await tx.memberFollow.deleteMany({ where: { userId } });
  const lots = await tx.voteTicketLot.findMany({ where: { userId, remaining: { gt: 0 } }, select: { id: true } });
  for (const l of lots) {
    await revokeLot(tx, l.id, 'WITHDRAW_FORFEIT', '회원 탈퇴로 소멸');
  }
  // 상태는 그대로 두고 이용 기간만 지금으로 끝낸다 (환불이 아니므로 크리에이터 수익 집계는 바뀌지 않는다)
  await tx.talkSubscription.updateMany({ where: { userId, status: 'ACTIVE', endsAt: { gt: now } }, data: { endsAt: now } });
}
