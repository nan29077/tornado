import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, seedRegisteredDonor, moPayload, matureDonations, type Fixture } from './helpers';
import { handleMoInbound } from '@/server/services/donation-flow';
import { mockMoAdapter } from '@/server/adapters/mo';
import {
  createSettlementRequest,
  markSettlementPaid,
  markPayoutFileIssued,
  buildPayoutRows,
  assertPayable,
  getSettlementSummary,
  calculateWithholding,
} from '@/server/services/settlement';
import { notifySuperAdmins } from '@/server/services/notifications';
import { buildSettlementSchedule } from '@/server/services/settlement-schedule';
import { subscribeOverlay } from '@/server/services/overlay-bus';
import { buildOverlayPayload } from '@/server/services/broadcast-dispatch';

/**
 * 정산 프로세스 전 구간 검수 + 오버레이 파이프라인 검수.
 * "크리에이터 요청이 최고관리자에게 제대로 들어오는가" 를 실행으로 확인한다.
 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => handleMoInbound(mockMoAdapter.parse(p));

async function accumulate(times = 4) {
  await seedRegisteredDonor(fx.donorPhone);
  await prisma.donationLimitPolicy.updateMany({
    data: { velocityMaxCount: 100, cooldownAfterCount: 100, newDonorFirstDayLimit: 10_000_000n },
  });
  for (let i = 0; i < times; i += 1) {
    await inbound(moPayload({ to: fx.moNumber, text: `적립 ${i}` }));
  }
  // 보류 기간을 지난 상태로 만든다(정산일 규칙 자체는 settlement-schedule 테스트가 본다).
  await matureDonations(fx.creatorId);
}

describe('정산 프로세스 — 요청부터 지급까지', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('크리에이터 요청이 최고관리자 알림함과 관리자 목록에 모두 들어온다', async () => {
    await accumulate();
    const summary = await getSettlementSummary(fx.creatorId);
    expect(summary.available).toBeGreaterThan(0n);

    // 최고관리자 계정 준비
    const adminUser = await prisma.user.create({
      data: { id: newId(), email: `sa${newId()}@t.kr`, passwordHash: 'x', role: 'ADMIN', status: 'ACTIVE' },
    });
    await prisma.adminProfile.create({
      data: { id: newId(), userId: adminUser.id, permission: 'SUPER_ADMIN' },
    });

    const req = await createSettlementRequest(fx.creatorId, summary.available, { resident: '9010101234560' });

    // 액션이 하는 알림을 동일하게 재현한다.
    await notifySuperAdmins({
      title: '새 정산 요청이 접수되었습니다',
      body: `요청금 ${req.amount.toString()}원`,
      linkUrl: '/admin/settlements',
    });

    // (1) 최고관리자 알림함에 들어왔는가
    const notes = await prisma.notification.findMany({ where: { userId: adminUser.id } });
    expect(notes.length).toBe(1);
    expect(notes[0].title).toContain('새 정산 요청');
    expect(notes[0].linkUrl).toBe('/admin/settlements');
    expect(notes[0].readAt).toBeNull();

    // (2) 관리자 정산 목록 조회 조건으로 실제로 잡히는가
    const adminList = await prisma.settlementRequest.findMany({
      where: { status: { in: ['REQUESTED', 'REVIEWING', 'APPROVED', 'PAID', 'PAYOUT_FAILED', 'REJECTED'] } },
      orderBy: [{ status: 'asc' }, { requestedAt: 'asc' }],
      include: { creator: { select: { displayName: true, code: true } } },
    });
    expect(adminList.map((r) => r.id)).toContain(req.id);
    // 관리자 화면이 크리에이터 이름·코드를 함께 보여줄 수 있어야 한다.
    const listed = adminList.find((r) => r.id === req.id)!;
    expect(listed.creator.displayName).toBeTruthy();
    expect(listed.creator.code).toBeTruthy();

    // (3) 요청 즉시 잔액이 보류로 잡혀 이중 요청이 불가능한가
    const after = await getSettlementSummary(fx.creatorId);
    expect(after.pending).toBe(req.amount);
    expect(after.available).toBe(0n);
    await expect(createSettlementRequest(fx.creatorId, 1000n)).rejects.toThrow(/초과/);
  });

  it('승인 전에는 이체파일에 들어가지 않는다', async () => {
    await accumulate();
    const summary = await getSettlementSummary(fx.creatorId);
    const req = await createSettlementRequest(fx.creatorId, summary.available, { resident: '9010101234560' });

    // REQUESTED 상태는 이체 대상이 아니다
    expect(await buildPayoutRows([req.id])).toEqual([]);
    expect((await assertPayable(req.id)).ok).toBe(false);

    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
    const rows = await buildPayoutRows([req.id]);
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(req.payoutAmount);
    expect(rows[0].account).toMatch(/^\d+$/); // 복호화된 계좌번호
    expect((await assertPayable(req.id)).ok).toBe(true);
  });

  it('요청→승인→이체파일→지급 전 구간에서 원장과 잔액이 맞아떨어진다', async () => {
    await accumulate();
    const before = await getSettlementSummary(fx.creatorId);
    const req = await createSettlementRequest(fx.creatorId, before.available, { resident: '9010101234560' });
    const wh = calculateWithholding(before.available);
    expect(req.withholding).toBe(wh.total);

    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
    const issue = await markPayoutFileIssued([req.id], 'admin-test');
    expect(issue.batchNo).toBeTruthy();

    await markSettlementPaid(req.id, 'admin-test', issue.batchNo);

    // 원장: 지급 + 원천징수 분개가 남고, 합계가 0 이 된다.
    const entries = await prisma.settlementLedger.findMany({ where: { requestId: req.id } });
    expect(entries.map((e) => e.entryType).sort()).toEqual(['PAYOUT', 'PAYOUT_WITHHOLDING']);
    const sum = entries.reduce((a, e) => a + e.amount, 0n);
    expect(-sum).toBe(before.available); // 지급+원천징수 = 요청금 전액

    const after = await getSettlementSummary(fx.creatorId);
    expect(after.balance).toBe(0n);
    expect(after.available).toBe(0n);
    expect(after.pending).toBe(0n);

    // 같은 건을 다시 지급 처리해도 분개가 늘지 않는다(멱등).
    await markSettlementPaid(req.id, 'admin-test');
    expect((await prisma.settlementLedger.findMany({ where: { requestId: req.id } })).length).toBe(2);
  });

  it('후원일별 정산 예정일이 계산되어 캘린더 데이터로 나온다', async () => {
    await accumulate(2);
    const rows = await buildSettlementSchedule(
      fx.creatorId,
      new Date(Date.now() - 40 * 86_400_000),
      new Date(Date.now() + 86_400_000),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.settlementDate > r.donationDate).toBe(true);
      expect(r.count).toBeGreaterThan(0);
      expect(r.gross).toBeGreaterThan(0n);
    }
  });
});

describe('오버레이 파이프라인 (OBS·PRISM 브라우저 소스)', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('결제 성공 후원이 오버레이 이벤트로 발행된다', async () => {
    await seedRegisteredDonor(fx.donorPhone);

    const received: unknown[] = [];
    const unsubscribe = subscribeOverlay(fx.creatorId, (p) => received.push(p));
    try {
      await inbound(moPayload({ to: fx.moNumber, text: '오버레이 확인' }));
      // 이벤트 전달은 동기 EventEmitter 라 즉시 도착한다.
      expect(received.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it('오버레이 페이로드에 금액·메시지·표시시간이 담긴다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await inbound(moPayload({ to: fx.moNumber, text: '고맙습니다' }));

    const donation = await prisma.donation.findFirstOrThrow();
    const payload = await buildOverlayPayload(donation.id);
    expect(payload).not.toBeNull();
    expect(payload!.creatorId).toBe(fx.creatorId);
    expect(payload!.donationId).toBe(donation.id);
    expect(BigInt(payload!.amount)).toBe(donation.amount);
    expect(payload!.durationMs).toBeGreaterThan(0);
    expect(payload!.isTest).toBe(false);
    expect(payload!.eventId).toBeTruthy();
  });

  it('익명 설정이면 후원자 이름이 노출되지 않는다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.overlaySetting.updateMany({ where: { creatorId: fx.creatorId }, data: { anonymize: true } });
    await inbound(moPayload({ to: fx.moNumber, text: '익명 확인' }));

    const donation = await prisma.donation.findFirstOrThrow();
    const payload = await buildOverlayPayload(donation.id);
    expect(payload!.donorName).toBe('익명의 후원자');
  });

  it('메시지 숨김 설정이면 메시지가 비어서 나간다', async () => {
    await seedRegisteredDonor(fx.donorPhone);
    await prisma.overlaySetting.updateMany({ where: { creatorId: fx.creatorId }, data: { showMessage: false } });
    await inbound(moPayload({ to: fx.moNumber, text: '이 문구는 가려져야 한다' }));

    const donation = await prisma.donation.findFirstOrThrow();
    const payload = await buildOverlayPayload(donation.id);
    expect(payload!.message).toBe('');
  });

  it('결제되지 않은 후원은 오버레이로 나가지 않는다', async () => {
    // 미등록 후원자 → 결제 자체가 일어나지 않는다
    const received: unknown[] = [];
    const unsubscribe = subscribeOverlay(fx.creatorId, (p) => received.push(p));
    try {
      await inbound(moPayload({ to: fx.moNumber, text: '미등록 후원' }));
      expect(received.length).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});
