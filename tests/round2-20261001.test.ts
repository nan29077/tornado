import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstMonthKey } from '@/lib/datetime';
import { encrypt } from '@/lib/crypto';
import { mockMoAdapter } from '@/server/adapters/mo';
import { mockPaymentAdapter } from '@/server/adapters/payment';
import { handleMoInbound, executePayment } from '@/server/services/donation-flow';
import { commitCounters } from '@/server/services/limits';
import {
  createSettlementRequest,
  getSettlementSummary,
  markPayoutFileIssued,
  markSettlementPaid,
  markSettlementPayoutFailed,
} from '@/server/services/settlement';
import {
  closeRound,
  createGame,
  joinByCode,
  revealRound,
  startRound,
  undoReveal,
} from '@/server/services/games';
import { buildStudioStateForRound, toPublicState } from '@/server/services/game-state';
import { cancelPendingPinDonation } from '@/server/services/pin-authorization';
import { sendTestOverlay } from '@/server/services/broadcast-dispatch';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/**
 * 2026-10-01 2차 점검 수정의 회귀 테스트. 항목 번호는 2차 점검 보고서를 따른다.
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

async function fundByLedger(creatorId: string, amount: bigint) {
  await prisma.settlementAccount.upsert({
    where: { creatorId },
    create: {
      id: newId(), creatorId, bankCode: '004', bankName: '국민은행',
      accountEnc: encrypt('11122233344455'), accountTail4: '4455',
      holderNameEnc: encrypt('김도네'), holderMasked: '김*네', verified: true, verifiedAt: new Date(),
    },
    update: { verified: true, verifiedAt: new Date() },
  });
  await prisma.settlementLedger.create({
    data: {
      id: newId(), creatorId, entryType: 'DONATION_GROSS', amount,
      occurredAt: new Date(Date.now() - 40 * 86_400_000), settlementKey: kstMonthKey(),
    },
  });
}

// ───────────────────── SET-1 ─────────────────────

describe('SET-1 은행 결과로 정정된 지급실패 건은 반드시 기록된다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await fundByLedger(fx.creatorId, 100_000n);
  });

  it('재요청이 대기 중이어도 은행 결과(SUCCESS) 반영은 막지 않고, 대기 요청은 검토중으로 돌린다', async () => {
    const old = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    await prisma.settlementRequest.update({ where: { id: old.id }, data: { status: 'APPROVED' } });
    await markSettlementPaid(old.id, 'admin');
    await markSettlementPayoutFailed(old.id, '계좌 오류', 'admin');
    const again = await createSettlementRequest(fx.creatorId, 60_000n, { resident: '9001011234567' });

    // 은행이 옛 배치를 "성공"으로 정정해 알려 왔다 → 돈은 이미 나갔다.
    const paid = await markSettlementPaid(old.id, 'admin', undefined, { fromBankResult: true });
    expect(paid.status).toBe('PAID');
    expect(paid.adminMemo).toContain('[주의]');

    // 첫 지급(-) + 실패 환입(+) + 정정 지급(-) → 3건, 순액은 지급 1회분
    const payouts = await prisma.settlementLedger.findMany({ where: { requestId: old.id, entryType: 'PAYOUT' } });
    expect(payouts.length).toBe(3);
    const net = payouts.reduce((s, e) => s + e.amount, 0n);
    expect(net).toBe(-paid.payoutAmount);

    const held = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: again.id } });
    expect(held.status).toBe('REVIEWING');
    expect(held.adminMemo).toContain('이중지급');
  });

  it('은행 결과가 아닌 경로에서는 기존처럼 막는다', async () => {
    const old = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    await prisma.settlementRequest.update({ where: { id: old.id }, data: { status: 'APPROVED' } });
    await markSettlementPaid(old.id, 'admin');
    await markSettlementPayoutFailed(old.id, '계좌 오류', 'admin');
    await createSettlementRequest(fx.creatorId, 60_000n, { resident: '9001011234567' });
    await expect(markSettlementPaid(old.id, 'admin')).rejects.toThrow(/잔액이 부족/);
  });
});

// ───────────────────── SET-14 ─────────────────────

describe('SET-14 재발급은 확인한 ID 목록과 정확히 같을 때만', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await fundByLedger(fx.creatorId, 300_000n);
  });

  it('미리보기 뒤 다른 건이 발급되면 거절하고, 정확히 일치하면 허용한다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    const b = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    await markPayoutFileIssued([a.id], 'admin');

    // A 만 재발급 대상이라고 확인했는데, 그 사이 B 도 다른 담당자가 받아 갔다.
    await markPayoutFileIssued([b.id], 'admin');
    const stale = await markPayoutFileIssued([a.id, b.id], 'admin', { allowReissueIds: [a.id] });
    expect(stale.blocked).toBe(true);

    const exact = await markPayoutFileIssued([a.id, b.id], 'admin', { allowReissueIds: [b.id, a.id] });
    expect(exact.blocked).toBe(false);
  });

  it('기본값은 재발급 거부다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    await markPayoutFileIssued([a.id], 'admin');
    expect((await markPayoutFileIssued([a.id], 'admin')).blocked).toBe(true);
  });
});

// ───────────────────── PAY-1 ─────────────────────

describe('PAY-1 고착 결제 재시도는 자기 한도 예약을 두 번 세지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.ALLOW_LEGACY_CONFIRM_LINK;
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  });

  async function stuckDonation() {
    const donor = await seedRegisteredDonor(fx.donorPhone);
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    // 일일 한도를 이 후원 금액 + 1,000원으로 둔다. 자기 예약을 또 세면 넘친다.
    await prisma.donorProfile.update({ where: { id: donor.id }, data: { dailyLimit: d.amount + 1000n } });
    // 첫 시도가 "예약 + 거래 생성 + 승인 요청" 까지 하고 죽은 상태를 만든다.
    const orderNo = `ORD${newId()}`;
    const txn = await prisma.paymentTransaction.create({
      data: { id: newId(), donationId, orderNo, provider: 'mock', amount: d.amount, status: 'REQUESTED' },
    });
    await commitCounters(donor.id, fx.creatorId, d.amount, new Date());
    await prisma.paymentAttempt.create({
      data: { id: newId(), transactionId: txn.id, attemptNo: 1, operation: 'APPROVE', errorCode: 'CRASH' },
    });
    await prisma.donation.update({
      where: { id: donationId },
      data: { status: 'PENDING_PAYMENT', updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    return { donationId, orderNo, amount: d.amount };
  }

  it('PG 에 기록이 없으면 같은 주문번호로 다시 승인한다(한도 차단 아님)', async () => {
    const { donationId } = await stuckDonation();
    const out = await executePayment(donationId);
    expect(out.ok).toBe(true);
    expect(out.status).not.toBe('LIMIT_BLOCKED');
  });

  it('PG 에서 이미 승인됐으면 결과조회로 마무리하고 승인을 다시 보내지 않는다', async () => {
    const { donationId, orderNo, amount } = await stuckDonation();
    // 첫 시도의 승인은 실제로 PG 에 도달했다(응답만 유실).
    await mockPaymentAdapter.approve({ orderNo, amount, billKey: 'x', productName: 't', buyerName: 't' });
    const out = await executePayment(donationId);
    expect(out.ok).toBe(true);
    const approves = await prisma.paymentAttempt.count({
      where: { operation: 'APPROVE', transaction: { donationId } },
    });
    expect(approves).toBe(1); // 첫 시도의 기록 1건뿐, 새 승인 요청 없음
    const inquiries = await prisma.paymentAttempt.count({
      where: { operation: 'INQUIRE', transaction: { donationId } },
    });
    expect(inquiries).toBeGreaterThanOrEqual(1);
    expect(await prisma.settlementLedger.count({ where: { donationId, entryType: 'DONATION_GROSS' } })).toBe(1);
  });
});

// ───────────────────── 게임 ─────────────────────

async function keywordRound(creatorId: string) {
  const gameId = await createGame(creatorId, {
    type: 'KEYWORD', title: '키워드', items: [], config: { keyword: '도네', winnerCount: 3, prize: '상품' },
    entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
  });
  const roundId = await startRound(creatorId, gameId);
  const round = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
  return { gameId, roundId, joinCode: round.joinCode };
}

describe('GM-1 같은 네트워크 참여 상한은 동시 요청에도 지켜진다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('같은 IP 지문으로 30건을 동시에 보내도 15건까지만 들어간다', async () => {
    const { roundId, joinCode } = await keywordRound(fx.creatorId);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        joinByCode(joinCode, {
          name: `참가${i}`, entry: '도네', deviceKey: `device-${i}-xxxx`, clientFingerprint: 'v4:203.0.113.7', donorId: null,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(15);
    expect(await prisma.gameParticipant.count({ where: { roundId } })).toBe(15);
  });
});

describe('GM-2·GM-3 발표 취소 제한과 상태 조건부 갱신', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('발표 취소는 회차당 한 번만 된다', async () => {
    const { roundId, joinCode } = await keywordRound(fx.creatorId);
    await joinByCode(joinCode, { name: 'a', entry: '도네', deviceKey: 'device-a-xxxx', clientFingerprint: 'v4:1.1.1.1', donorId: null });
    await closeRound(fx.creatorId, roundId);
    await revealRound(fx.creatorId, roundId);
    await undoReveal(fx.creatorId, roundId); // 첫 번째 취소는 된다
    await revealRound(fx.creatorId, roundId);
    await expect(undoReveal(fx.creatorId, roundId)).rejects.toThrow(/한 번만/);
    const r = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    expect(r.revealCount).toBe(2);
    expect(r.status).toBe('RESULT');
  });

  it('발표된 회차를 마감 처리로 덮어쓰지 않는다', async () => {
    const { roundId, joinCode } = await keywordRound(fx.creatorId);
    await joinByCode(joinCode, { name: 'a', entry: '도네', deviceKey: 'device-b-xxxx', clientFingerprint: 'v4:1.1.1.2', donorId: null });
    await revealRound(fx.creatorId, roundId);
    await expect(closeRound(fx.creatorId, roundId)).rejects.toThrow();
    expect((await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } })).status).toBe('RESULT');
  });
});

describe('GM-8 퀴즈 진행 중 집계는 방송 상태에 실리지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('OPEN 동안 공개 상태의 counts 는 null, 마감 뒤에는 공개된다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'QUIZ', title: '퀴즈', items: [],
      config: { question: '정답은?', choices: ['가', '나', '다'], answerIndex: 1, prize: '' },
      entryMode: 'LINK', donationMinAmount: 0, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const round = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    await joinByCode(round.joinCode, { name: 'q', entry: '0', deviceKey: 'device-q-xxxx', clientFingerprint: 'v4:2.2.2.2', donorId: null });

    const open = await buildStudioStateForRound(roundId);
    expect(open!.counts).not.toBeNull(); // 크리에이터 화면에는 보인다
    expect(toPublicState(open!).counts).toBeNull(); // 방송에는 안 나간다

    await closeRound(fx.creatorId, roundId);
    const closed = await buildStudioStateForRound(roundId);
    expect(toPublicState(closed!).counts).not.toBeNull();
  });
});

// ───────────────────── UI-2 · OV-6 ─────────────────────

describe('UI-2 다시 시작하면 대기 중인 PIN 후원이 취소된다', () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.ALLOW_LEGACY_CONFIRM_LINK;
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
    await seedRegisteredDonor(fx.donorPhone);
  });

  it('PENDING_PIN 건과 PIN 세션이 취소되고, 그 뒤 결제할 수 없다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    expect(await cancelPendingPinDonation(donationId, '다시 시작')).toBe(true);
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(d.status).toBe('PAYMENT_FAILED');
    const s = await prisma.paymentPinSession.findUniqueOrThrow({ where: { donationId } });
    expect(s.status).toBe('EXPIRED');
    expect((await executePayment(donationId)).ok).toBe(false);
    // 두 번째 호출은 아무것도 하지 않는다
    expect(await cancelPendingPinDonation(donationId, '다시 시작')).toBe(false);
  });
});

describe('OV-6 구간 미리보기는 방송용 연결로 나가지 않도록 표시된다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('previewOnly 로 보낸 테스트 알림은 저장된 페이로드에 표시가 남는다', async () => {
    await sendTestOverlay(fx.creatorId, { donorName: '구간', amount: 5000n, message: 'm' }, { previewOnly: true });
    await sendTestOverlay(fx.creatorId, { donorName: '일반', amount: 5000n, message: 'm' });
    const rows = await prisma.overlayEvent.findMany({ where: { creatorId: fx.creatorId }, orderBy: { createdAt: 'asc' } });
    const payloads = rows.map((r) => r.payload as { donorName: string; previewOnly?: boolean });
    expect(payloads.find((p) => p.donorName.includes('구간'))?.previewOnly).toBe(true);
    expect(payloads.find((p) => p.donorName.includes('일반'))?.previewOnly).toBeUndefined();
  });
});

// 사용하지 않는 import 경고 방지(요약 확인용)
void getSettlementSummary;
