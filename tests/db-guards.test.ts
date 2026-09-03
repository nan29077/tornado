import { describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';

/**
 * DB 레벨 방어선이 **실제로 존재하는지** 지키는 회귀 테스트.
 *
 * 왜 필요한가
 *  - 중복 결제 4중 방어의 마지막 겹(`payment_transaction_approved_uniq`)을 비롯한 여러
 *    제약이 **부분 유니크 인덱스**라 Prisma 스키마로는 표현할 수 없다. 그래서 raw SQL
 *    마이그레이션으로만 만들어져 있고, `prisma/schema.prisma` 에는 선언이 없다.
 *  - Prisma 는 "스키마에 없는데 DB 에 있는" 인덱스를 **삭제하는 마이그레이션을 자동 생성**한다.
 *    스키마를 한 번 고쳐 `prisma migrate dev` 를 돌리는 것만으로 방어선이 조용히 사라진다.
 *  - 그 사고를 사람이 눈으로 잡을 수는 없다. 여기서 CI 가 잡는다.
 *
 * 이 테스트가 실패하면 **DB 를 고쳐야 한다.** 테스트를 고치면 안 된다.
 */

async function indexExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM pg_indexes WHERE indexname = $1`,
    name,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function triggerExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`,
    name,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

describe('DB 방어선', () => {
  const REQUIRED_INDEXES = [
    // 중복 결제 4중 방어의 마지막 겹 — 후원 1건당 승인 결제는 1건
    'payment_transaction_approved_uniq',
    // 후원자당 활성 결제수단 1건 (교체 시 기존 키 REVOKED)
    'payment_method_token_active_uniq',
    // 크리에이터당 활성 코드 1개
    'creator_code_active_uniq',
    // 금칙어 중복 등록 방지
    'banned_word_global_uniq',
    'banned_word_creator_uniq',
    // 크리에이터당 화면에 뜬 게임 회차는 하나
    'game_round_active_uniq',
  ];

  for (const name of REQUIRED_INDEXES) {
    it(`${name} 인덱스가 존재한다`, async () => {
      expect(await indexExists(name)).toBe(true);
    });
  }

  it('정산 원장 append-only 트리거가 살아 있다', async () => {
    expect(await triggerExists('settlement_ledger_append_only')).toBe(true);
  });

  /**
   * 후원 1건에 승인 결제가 두 건 들어가지 않는지 **실제로** 확인한다.
   * 인덱스가 있다는 것과 그것이 의도한 조건으로 걸려 있다는 것은 다른 이야기다.
   */
  it('같은 후원에 APPROVED 결제 거래를 두 건 만들 수 없다', async () => {
    const { newId, newOrderNo, newTransactionNo } = await import('@/lib/id');
    const { resetDb, seedBasics } = await import('./helpers');
    await resetDb();
    const fx = await seedBasics();

    const donation = await prisma.donation.create({
      data: {
        id: newId(),
        transactionNo: newTransactionNo(),
        creatorId: fx.creatorId,
        amount: 3000n,
        displayName: '테스트',
        message: '테스트',
        status: 'PENDING_PAYMENT',
      },
    });

    const base = {
      donationId: donation.id,
      amount: 3000n,
      status: 'APPROVED' as const,
      approvedAt: new Date(),
    };

    await prisma.paymentTransaction.create({ data: { id: newId(), orderNo: newOrderNo(), ...base } });

    await expect(
      prisma.paymentTransaction.create({ data: { id: newId(), orderNo: newOrderNo(), ...base } }),
    ).rejects.toThrow();
  });
});
