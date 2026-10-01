import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstMonthKey } from '@/lib/datetime';
import { encrypt } from '@/lib/crypto';
import { mockMoAdapter } from '@/server/adapters/mo';
import { handleMoInbound, executePayment } from '@/server/services/donation-flow';
import {
  createSettlementRequest,
  getSettlementSummary,
  markPayoutFileIssued,
  markSettlementPaid,
  markSettlementPayoutFailed,
} from '@/server/services/settlement';
import { getLedgerTotals, getCreatorFeeRows } from '@/server/services/tax';
import { calculateWithholding } from '@/lib/withholding';
import { env } from '@/lib/env';
import { safeInternalPath } from '@/lib/auth-return-path';
import { redisRetryStrategy } from '@/server/redis-quiet';
import { composeMoNumber, moTableSuffix } from '@/server/emma';
import { runEmmaMoPolling } from '@/server/services/emma-mo-ingest';
import { createGame, joinFromDonation, startRound } from '@/server/services/games';
import { requestLookupCode, verifyAndLookup, type LookupState } from '@/app/actions/donation-lookup';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, type Fixture } from './helpers';
import { createEmmaTables, clearEmmaTables, insertFakeMo, readMoStatus } from './emma-helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/**
 * 2026-10-01 전체 점검 P1 수정의 회귀 테스트.
 * 각 블록은 점검 보고서의 항목 번호(P1-n)를 따른다.
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

async function approveAttempts(donationId: string) {
  return prisma.paymentAttempt.count({
    where: { operation: 'APPROVE', transaction: { donationId } },
  });
}

// ───────────────────── P1-1 결제 진행권 선점 ─────────────────────

describe('P1-1 같은 후원에 PG 승인이 두 번 나가지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.ALLOW_LEGACY_CONFIRM_LINK;
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
    await seedRegisteredDonor(fx.donorPhone);
  });

  it('동시에 세 번 실행해도 승인 요청은 한 번, 원장 분개도 한 벌이다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    expect(res.status).toBe('PENDING_PIN');
    const donationId = res.donationId!;

    const results = await Promise.all([
      executePayment(donationId),
      executePayment(donationId),
      executePayment(donationId),
    ]);

    expect(await approveAttempts(donationId)).toBe(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await prisma.settlementLedger.count({ where: { donationId, entryType: 'PLATFORM_FEE' } }),
    ).toBe(1);
    const d = await prisma.donation.findUniqueOrThrow({ where: { id: donationId } });
    expect(['SETTLEMENT_PENDING', 'BROADCASTED', 'BROADCAST_PENDING', 'PARTIAL_DELIVERY_FAILED']).toContain(d.status);
    // 진행 중 상태 전이 이력이 남는다
    expect(
      await prisma.donationStatusLog.count({ where: { donationId, toStatus: 'PENDING_PAYMENT' } }),
    ).toBe(1);
  });

  it('최근에 진행권을 잡은 건(PENDING_PAYMENT)은 다시 승인하지 않는다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    await prisma.donation.update({ where: { id: donationId }, data: { status: 'PENDING_PAYMENT' } });

    const out = await executePayment(donationId);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('PENDING_PAYMENT');
    expect(await approveAttempts(donationId)).toBe(0);
  });

  it('리스(3분)가 지난 고착 건은 다시 잡아 결제를 마무리한다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    // 시각은 Prisma 로 쓴다(앱과 같은 경로). 원시 SQL NOW() 는 세션 시간대 해석이 달라질 수 있다.
    await prisma.donation.update({
      where: { id: donationId },
      data: { status: 'PENDING_PAYMENT', updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const out = await executePayment(donationId);
    expect(out.ok).toBe(true);
    expect(await approveAttempts(donationId)).toBe(1);
  });

  it('결과 미확인(UNKNOWN) 거래는 자동으로 다시 승인하지 않는다', async () => {
    const res = await inbound(moPayload({ to: fx.moNumber }));
    const donationId = res.donationId!;
    await prisma.paymentTransaction.create({
      data: {
        id: newId(), donationId, orderNo: `ORD${newId()}`, provider: 'mock', amount: 3000n, status: 'UNKNOWN',
      },
    });

    const out = await executePayment(donationId);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('PENDING_PAYMENT');
    expect(await approveAttempts(donationId)).toBe(0);
    expect(await prisma.settlementLedger.count({ where: { donationId } })).toBe(0);
  });
});

// ───────────────────── P1-2 장문 늦은 조각 ─────────────────────

describe('P1-2 장문 조각이 늦게 와도 후원은 한 건이다', () => {
  const BASE = '16881234';

  beforeAll(async () => {
    await createEmmaTables();
  });

  beforeEach(async () => {
    await resetDb();
    await clearEmmaTables();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
    await prisma.creatorMoNumber.create({
      data: {
        id: newId(), phoneNumber: composeMoNumber(BASE, '5678'), keyword: null, baseNumber: BASE,
        subCode: '5678', mode: 'DEDICATED', status: 'ASSIGNED', creatorId: fx.creatorId, providerId: 'emma',
        assignedAt: new Date(),
      },
    });
    await seedRegisteredDonor(fx.donorPhone);
  });

  it('부분 처리 뒤 도착한 1번 조각은 완료 표시만 하고 후원을 다시 만들지 않는다', async () => {
    const part = (seq: number, content: string, agoSec = 0) =>
      insertFakeMo({
        moRecipient: BASE, emoRecipient: '5678', from: fx.donorPhone, serviceType: '5', content,
        emsId: 901, emsTotal: 3, emsSeq: seq, receivedAgoSec: agoSec,
      });

    // 2·3번 조각만 4분 전에 도착 → 대기 상한(3분)을 넘겨 있는 것만으로 처리된다.
    await part(2, '둘째 ', 240);
    await part(3, '셋째', 240);
    const first = await runEmmaMoPolling();
    expect(first.handed).toBe(1);
    expect(await prisma.donation.count()).toBe(1);

    // 늦게 온 1번 조각
    const late = await part(1, '첫째 ');
    const second = await runEmmaMoPolling();

    expect(second.handed).toBe(0);
    expect(await prisma.donation.count()).toBe(1);
    expect(await readMoStatus(late, moTableSuffix())).toBe('9');
    expect(second.details.some((d) => (d.detail ?? '').includes('MMS_LATE_FRAGMENT'))).toBe(true);
  });
});

// ───────────────────── P1-4 멱등키만 남은 중단 건 ─────────────────────

describe('P1-4 멱등키만 잡고 중단된 문자는 유실되지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
    await seedRegisteredDonor(fx.donorPhone);
  });

  it('후원 없이 남은 멱등키에 걸리면 "나중에 다시" 를 돌려주고 수신 로그를 ERROR 로 남긴다', async () => {
    const messageId = `IDEM-${newId()}`;
    await prisma.idempotencyKey.create({
      data: {
        id: newId(), scope: 'donation', key: `${fx.creatorId}:${messageId}`, status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await inbound(moPayload({ to: fx.moNumber, messageId }));
    expect(res.result).toBe('DUPLICATE');
    expect(res.retryLater).toBe(true);
    expect(await prisma.donation.count()).toBe(0);
    const row = await prisma.moInboundMessage.findFirstOrThrow({ where: { providerMessageId: messageId } });
    expect(row.result).toBe('ERROR');
  });
});

// ───────────────────── P1-5 · P1-7 · 원천징수 ─────────────────────

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

describe('P1-5 이체파일 재발급을 거절할 때는 아무것도 바꾸지 않는다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await fundByLedger(fx.creatorId, 200_000n);
  });

  it('재발급 미확인이면 blocked 를 돌려주고 배치번호를 보존한다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    const first = await markPayoutFileIssued([a.id], 'admin', { allowReissue: false });
    expect(first.blocked).toBe(false);

    const b = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    const second = await markPayoutFileIssued([a.id, b.id], 'admin', { allowReissue: false });
    expect(second.blocked).toBe(true);
    expect(second.reissued).toEqual([a.id]);

    const rowA = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowA.payoutBatchNo).toBe(first.batchNo); // 이미 은행에 올린 배치번호가 그대로다
    expect(rowB.payoutIssuedAt).toBeNull(); // 새 건도 발급 상태로 갇히지 않는다

    // 명시적으로 재발급을 확인하면 그때만 진행된다.
    const third = await markPayoutFileIssued([a.id, b.id], 'admin', { allowReissue: true });
    expect(third.blocked).toBe(false);
    expect(third.reissued).toEqual([a.id]);
  });
});

describe('P1-7 지급실패 건 재지급은 다른 요청이 잡아 둔 금액을 고려한다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await fundByLedger(fx.creatorId, 100_000n);
  });

  it('실패 후 재요청이 대기 중이면 옛 실패 건을 다시 지급완료로 올릴 수 없다', async () => {
    const old = await createSettlementRequest(fx.creatorId, 50_000n, { resident: '9001011234567' });
    await prisma.settlementRequest.update({ where: { id: old.id }, data: { status: 'APPROVED' } });
    await markSettlementPaid(old.id, 'admin');
    await markSettlementPayoutFailed(old.id, '계좌 오류', 'admin');

    // 크리에이터가 다시 요청(아직 대기 중)
    await createSettlementRequest(fx.creatorId, 60_000n, { resident: '9001011234567' });
    const s = await getSettlementSummary(fx.creatorId);
    expect(s.balance).toBe(100_000n);
    expect(s.pending).toBe(60_000n);

    // 예전에는 잔액(100,000) ≥ 50,000 이라 통과했다 → 같은 돈이 두 번 나갈 수 있었다.
    await expect(markSettlementPaid(old.id, 'admin')).rejects.toThrow(/잔액이 부족/);
  });
});

describe('원천징수 정책 (2026-10-01): 최소 10,000원 · 전 건 징수', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    await fundByLedger(fx.creatorId, 100_000n);
  });

  it('최소 정산 요청 금액은 10,000원이다', async () => {
    expect(env.settlement.minRequestAmount).toBeGreaterThanOrEqual(10_000n);
    await expect(createSettlementRequest(fx.creatorId, 9_990n, { resident: '9001011234567' })).rejects.toThrow(
      /최소 정산 요청 금액/,
    );
  });

  it('10,000원 요청도 원천징수한다 (소득세 300 + 지방소득세 30)', async () => {
    const req = await createSettlementRequest(fx.creatorId, 10_000n, { resident: '9001011234567' });
    expect(req.incomeTax).toBe(300n);
    expect(req.localTax).toBe(30n);
    expect(req.withholding).toBe(330n);
    expect(req.payoutAmount).toBe(9_670n);
  });

  it('잘게 나눠 요청해도 원천징수 합계가 사라지지 않는다', async () => {
    const parts = [];
    for (let i = 0; i < 3; i += 1) {
      parts.push(await createSettlementRequest(fx.creatorId, 30_000n, { resident: '9001011234567' }));
    }
    const total = parts.reduce((a, r) => a + r.withholding, 0n);
    expect(total).toBe(calculateWithholding(30_000n).total * 3n);
    expect(total).toBeGreaterThan(0n);
  });
});

// ───────────────────── P1-6 부가세 수수료 환입 ─────────────────────

describe('P1-6 환불로 돌려준 수수료는 부가세 과세표준에서 빠진다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('전액 환불된 후원의 수수료 매출은 0원이다', async () => {
    const now = new Date();
    const base = { creatorId: fx.creatorId, occurredAt: now, settlementKey: kstMonthKey(now) };
    await prisma.settlementLedger.createMany({
      data: [
        { id: newId(), ...base, entryType: 'DONATION_GROSS', amount: 100_000n },
        { id: newId(), ...base, entryType: 'PLATFORM_FEE', amount: -15_000n },
        { id: newId(), ...base, entryType: 'REFUND', amount: -100_000n },
        { id: newId(), ...base, entryType: 'REFUND_FEE_RETURN', amount: 15_000n },
      ],
    });
    const ym = kstMonthKey(now);
    const totals = await getLedgerTotals(ym, true);
    expect(totals.platformFee).toBe(0n);
    expect(totals.platformFeeSupply).toBe(0n);
    expect(totals.platformFeeVat).toBe(0n);
    expect(totals.refund).toBe(100_000n);

    const rows = await getCreatorFeeRows(ym, true);
    expect(rows.every((r) => r.fee === 0n && r.vat === 0n)).toBe(true);
  });

  it('부가세 별도 정책이어도 원장 총액에서 세액을 한 번만 나눈다', async () => {
    const now = new Date();
    // 공급가 300 + 부가세 30 = 330 이 원장에 차감된다(computeFees 부가세 별도).
    await prisma.settlementLedger.create({
      data: {
        id: newId(), creatorId: fx.creatorId, occurredAt: now, settlementKey: kstMonthKey(now),
        entryType: 'PLATFORM_FEE', amount: -330n,
      },
    });
    const totals = await getLedgerTotals(kstMonthKey(now), false);
    expect(totals.platformFeeSupply).toBe(300n);
    expect(totals.platformFeeVat).toBe(30n);
  });
});

// ───────────────────── P1-9 문자 인증 대입 ─────────────────────

describe('P1-9 문자 인증번호는 동시 요청으로 대입할 수 없다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('동시에 틀린 코드 20개를 보낸 뒤에는 맞는 코드도 통과하지 못한다', async () => {
    const fd = new FormData();
    fd.set('phone', '01055556666');
    const sent = await requestLookupCode({ ok: false, step: 'phone' } as LookupState, fd);
    expect(sent.ok).toBe(true);
    const ticket = sent.ticket!;
    const code = sent.devCode;
    expect(code).toMatch(/^\d{6}$/);

    const wrong = code === '000000' ? '111111' : '000000';
    await Promise.all(
      Array.from({ length: 20 }, () => {
        const f = new FormData();
        f.set('ticket', ticket);
        f.set('code', wrong);
        return verifyAndLookup({ ok: false, step: 'code' } as LookupState, f);
      }),
    );

    const ok = new FormData();
    ok.set('ticket', ticket);
    ok.set('code', code!);
    const res = await verifyAndLookup({ ok: false, step: 'code' } as LookupState, ok);
    expect(res.ok).toBe(false);
    expect(res.step).toBe('phone');
  });

  it('정상 입력은 그대로 통과한다', async () => {
    const fd = new FormData();
    fd.set('phone', '01055557777');
    const sent = await requestLookupCode({ ok: false, step: 'phone' } as LookupState, fd);
    const f = new FormData();
    f.set('ticket', sent.ticket!);
    f.set('code', sent.devCode!);
    const res = await verifyAndLookup({ ok: false, step: 'code' } as LookupState, f);
    expect(res.ok).toBe(true);
    expect(res.step).toBe('result');
  });
});

// ───────────────────── P1-10 오픈 리다이렉트 ─────────────────────

describe('P1-10 로그인 후 이동 경로는 같은 사이트 내부로만', () => {
  it('탭·줄바꿈·역슬래시·이중 슬래시 우회를 막는다', () => {
    for (const bad of ['/\t/evil.com', '/\n/evil.com', '/\\evil.com', '//evil.com', '/%09/evil.com'.replace('%09', '\t'),
      'https://evil.com', 'javascript:alert(1)', '', '/ /evil.com']) {
      expect(safeInternalPath(bad)).toBeNull();
    }
  });

  it('정상 내부 경로는 그대로 허용한다', () => {
    expect(safeInternalPath('/studio/settlement?tab=request')).toBe('/studio/settlement?tab=request');
    expect(safeInternalPath('/admin')).toBe('/admin');
    expect(safeInternalPath('/c/TOR-ABCD')).toBe('/c/TOR-ABCD');
  });
});

// ───────────────────── P1-3 Redis 재접속 ─────────────────────

describe('P1-3 Redis 재접속 정책', () => {
  it('폴백을 허용한 환경(테스트·로컬)은 5번 뒤 포기한다', () => {
    expect(env.allowInMemoryFallback).toBe(true);
    expect(redisRetryStrategy(1)).toBe(300);
    expect(redisRetryStrategy(6)).toBeNull();
  });
});

// ───────────────────── P1-13 게임 익명 ─────────────────────

describe('P1-13 익명 후원자는 게임 화면에도 익명으로 나간다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  afterEach(() => vi.restoreAllMocks());

  it('anonymous 후원의 자동 참여 이름은 "익명의 후원자" 다', async () => {
    const gameId = await createGame(fx.creatorId, {
      type: 'RANKING', title: '익명 검증', items: [], config: { rankCount: 1 },
      entryMode: 'DONATION', donationMinAmount: 100, autoCloseSec: 0,
    });
    const roundId = await startRound(fx.creatorId, gameId);
    const donationId = newId();
    await prisma.donation.create({
      data: {
        id: donationId, transactionNo: donationId, creatorId: fx.creatorId, amount: 3_000n,
        displayName: '숨기고싶은닉네임', anonymous: true, message: 'test', status: 'BROADCASTED', paidAt: new Date(),
      },
    });

    await joinFromDonation(donationId);

    const p = await prisma.gameParticipant.findFirstOrThrow({ where: { roundId } });
    expect(p.displayName).toBe('익명의 후원자');
  });
});
