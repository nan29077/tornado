import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import { encrypt } from '@/lib/crypto';
import { csvCell } from '@/lib/csv';
import {
  AMENDED_FILING_TAG,
  buildPayoutBatch,
  createSettlementRequest,
  fileWithholdingAndPurgeResident,
  markPayoutFileIssued,
  markSettlementPaid,
  markSettlementPayoutFailed,
  purgeStaleFailedResidents,
} from '@/server/services/settlement';
import { resetDb, seedBasics, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/**
 * 관리자 액션은 세션·요청 헤더에 기대므로, 인증과 감사로그만 대체한다.
 * (권한 판정 로직 자체는 shared.ts 의 실제 코드를 탄다)
 */
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    requireAdmin: vi.fn(async () => ({
      id: 'admin-r3', email: null, name: '재무', role: 'ADMIN', avatarIndex: 0, adminPermission: 'FINANCE',
    })),
    writeAudit: vi.fn(async (input: Record<string, unknown>) => {
      audit.calls.push(input);
    }),
  };
});

const { updateSettlementRequestStatus, applyPayoutResultsAction } = await import('@/app/actions/admin/settlement');
const { markWithholdingFiled } = await import('@/app/actions/admin/tax');

/**
 * 2026-10-15 3차 점검 — 정산·세무 영역 회귀 테스트. 항목 번호는 3차 점검 보고서를 따른다.
 */

let fx: Fixture;
const RESIDENT = '9001011234567';

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
  await addLedger(creatorId, 'DONATION_GROSS', amount);
}

async function addLedger(creatorId: string, entryType: 'DONATION_GROSS' | 'ADJUSTMENT', amount: bigint) {
  await prisma.settlementLedger.create({
    data: {
      id: newId(), creatorId, entryType, amount,
      occurredAt: new Date(Date.now() - 40 * 86_400_000), settlementKey: kstMonthKey(),
    },
  });
}

async function approve(...ids: string[]) {
  await prisma.settlementRequest.updateMany({ where: { id: { in: ids } }, data: { status: 'APPROVED', approvedAt: new Date() } });
}

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

const initial = { ok: false, message: '' } as never;

beforeEach(async () => {
  await resetDb();
  audit.calls.length = 0;
  fx = await seedBasics();
  await fundByLedger(fx.creatorId, 100_000n);
});

// ───────────────────── SET-A ─────────────────────

describe('SET-A 앞선 배치에서 결과 대기 중인 승인 건을 잔액에서 뺀다', () => {
  it('1차 배치 발급 후 잔액이 줄면 2차 배치의 같은 크리에이터 건은 제외된다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    const b = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id, b.id);
    await markPayoutFileIssued([a.id], 'admin');

    // 그 사이 환불·감액으로 잔액이 60,000원이 됐다. A(50,000) 는 이미 은행에 나갔다.
    await addLedger(fx.creatorId, 'ADJUSTMENT', -40_000n);

    const batch2 = await buildPayoutBatch([b.id]);
    expect(batch2.rows).toEqual([]);
    expect(batch2.excluded[0]?.reason).toContain('앞선 배치');
  });

  it('잔액이 충분하면 2차 배치도 그대로 나간다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    const b = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id, b.id);
    await markPayoutFileIssued([a.id], 'admin');
    const batch2 = await buildPayoutBatch([b.id]);
    expect(batch2.rows.map((r) => r.requestId)).toEqual([b.id]);
  });

  it('재발급 건이 같은 배치에 섞여도 그 금액을 두 번 빼지 않는다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    const b = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id, b.id);
    await markPayoutFileIssued([a.id], 'admin');

    // A 재발급 + B 신규: 잔액 100,000 = 50,000 + 50,000 → 둘 다 들어가야 한다.
    const both = await buildPayoutBatch([a.id, b.id]);
    expect(both.rows.map((r) => r.requestId).sort()).toEqual([a.id, b.id].sort());

    // 잔액이 60,000 이면 A 만 들어가고 B 는 빠진다.
    await addLedger(fx.creatorId, 'ADJUSTMENT', -40_000n);
    const short = await buildPayoutBatch([a.id, b.id]);
    expect(short.rows.map((r) => r.requestId)).toEqual([a.id]);
    expect(short.excluded.map((e) => e.requestId)).toEqual([b.id]);
  });
});

// ───────────────────── SET-C ─────────────────────

describe('SET-C 상태 전이는 허용표에 있는 것만', () => {
  it('지급실패 건은 승인·검토중으로 되돌릴 수 없다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await prisma.settlementRequest.update({ where: { id: a.id }, data: { status: 'PAYOUT_FAILED' } });

    const toApproved = await updateSettlementRequestStatus(initial, form({ requestId: a.id, status: 'APPROVED' }));
    expect(toApproved.ok).toBe(false);
    expect(toApproved.message).toContain('바꿀 수 없습니다');

    const toReviewing = await updateSettlementRequestStatus(initial, form({ requestId: a.id, status: 'REVIEWING' }));
    expect(toReviewing.ok).toBe(false);

    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('PAYOUT_FAILED');
  });

  it('접수 → 승인, 승인(미발급) → 검토중은 허용된다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    expect((await updateSettlementRequestStatus(initial, form({ requestId: a.id, status: 'APPROVED' }))).ok).toBe(true);
    expect((await updateSettlementRequestStatus(initial, form({ requestId: a.id, status: 'REVIEWING' }))).ok).toBe(true);
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('REVIEWING');
  });
});

// ───────────────────── SET-D ─────────────────────

describe('SET-D 발급 순간 승인 상태가 아니면 발급 전체를 되돌린다', () => {
  it('파일을 만든 뒤 반려된 건이 섞이면 blocked + notApproved, 아무것도 발급되지 않는다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 30_000n, { resident: RESIDENT });
    const b = await createSettlementRequest(fx.creatorId, 30_000n, { resident: RESIDENT });
    await approve(a.id, b.id);

    const built = await buildPayoutBatch([a.id, b.id]);
    expect(built.rows.length).toBe(2);
    // 이체파일 행을 만든 직후 다른 관리자가 B 를 반려했다.
    await prisma.settlementRequest.update({ where: { id: b.id }, data: { status: 'REJECTED' } });

    const issue = await markPayoutFileIssued(built.rows.map((r) => r.requestId), 'admin');
    expect(issue.blocked).toBe(true);
    expect(issue.notApproved).toEqual([b.id]);

    const rows = await prisma.settlementRequest.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((r) => r.payoutIssuedAt === null && r.payoutBatchNo === null)).toBe(true);
  });
});

// ───────────────────── SET-B ─────────────────────

describe('SET-B 이체파일이 나간 지급실패 건은 주민번호를 바로 지우지 않는다', () => {
  it('은행 결과 FAIL 반영 후에도 보관하고, 보관 기간이 지나면 정리 배치가 파기한다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    const issue = await markPayoutFileIssued([a.id], 'admin');

    const res = await applyPayoutResultsAction(
      initial,
      form({ batchNo: issue.batchNo, results: `${a.id},FAIL,계좌오류` }),
    );
    expect(res.ok).toBe(true);
    let row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('PAYOUT_FAILED');
    expect(row.residentEnc).toBeTruthy();

    // 은행이 나중에 성공으로 정정하면 그대로 신고할 수 있다.
    await purgeStaleFailedResidents(new Date());
    row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.residentEnc).toBeTruthy();

    const purged = await purgeStaleFailedResidents(new Date(Date.now() + 91 * 86_400_000));
    expect(purged).toBe(1);
    row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.residentEnc).toBeNull();
    expect(row.residentPurgedAt).not.toBeNull();
  });
});

// ───────────────────── SET-E · P2-5 ─────────────────────

describe('SET-E 세무 화면 신고 완료 표시도 주민번호를 파기한다', () => {
  it('월 신고 완료 시 withholdingFiledAt 과 함께 주민번호 원문이 파기된다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    const paid = await markSettlementPaid(a.id, 'admin');

    const res = await markWithholdingFiled(initial, form({ month: kstMonthKey(paid.paidAt!) }));
    expect(res.ok).toBe(true);
    expect(res.message).toContain('1건을 파기');

    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.withholdingFiledAt).not.toBeNull();
    expect(row.residentEnc).toBeNull();
    expect(row.residentMasked).toBe('900101-1******');
    expect(audit.calls.some((c) => c.action === 'WITHHOLDING_MARK_FILED')).toBe(true);
  });

  it('P2-5 잘못된 월 문자열은 이번 달로 바꾸지 않고 거절한다', async () => {
    for (const month of ['2026-13', '2026-9', 'abc', '']) {
      const res = await markWithholdingFiled(initial, form({ month }));
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/형식|범위/);
    }
  });
});

// ───────────────────── P2-4 ─────────────────────

describe('P2-4 신고 처리는 지급 담당자와 최초 신고 시각을 덮어쓰지 않는다', () => {
  it('adminId 유지, 두 번째 신고 처리에도 withholdingFiledAt 은 그대로', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    await markSettlementPaid(a.id, 'payer-admin');

    await fileWithholdingAndPurgeResident(a.id, 'filer-admin');
    const first = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(first.adminId).toBe('payer-admin');

    const again = await fileWithholdingAndPurgeResident(a.id, 'filer-admin');
    expect(again.alreadyFiled).toBe(true);
    const second = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(second.withholdingFiledAt?.getTime()).toBe(first.withholdingFiledAt?.getTime());
  });
});

// ───────────────────── P2-6 ─────────────────────

describe('P2-6 신고 완료 후 지급실패로 정정되면 수정신고 표시가 남는다', () => {
  it('처리 메모에 [수정신고 필요] 가 붙는다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    await markSettlementPaid(a.id, 'admin');
    await fileWithholdingAndPurgeResident(a.id, 'admin');
    const failed = await markSettlementPayoutFailed(a.id, '은행 반송', 'admin');
    expect(failed.adminMemo).toContain(AMENDED_FILING_TAG);
  });
});

// ───────────────────── SET-G · P2-1 ─────────────────────

describe('SET-G CSV 셀: 음수 숫자는 그대로, 수식은 막는다', () => {
  it('숫자', () => {
    expect(csvCell('-12000')).toBe('-12000');
    expect(csvCell('12000')).toBe('12000');
    expect(csvCell('-0.15')).toBe('-0.15');
  });
  it('수식·텍스트', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('-1+2')).toBe(`"'-1+2"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('+82')).toBe(`"'+82"`);
    expect(csvCell('\t=1')).toBe(`"'\t=1"`);
  });
  it('따옴표·줄바꿈·제어문자', () => {
    expect(csvCell('a\rb')).toBe('"a\rb"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\u0000b\u0007c')).toBe('abc');
    expect(csvCell('김도네')).toBe('김도네');
  });
});

// ───────────────────── SET-J ─────────────────────

describe('SET-J 같은 요청ID 가 여러 줄이면 전체를 거절한다', () => {
  it('SUCCESS 와 FAIL 이 함께 있으면 아무것도 반영하지 않는다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    const issue = await markPayoutFileIssued([a.id], 'admin');

    const res = await applyPayoutResultsAction(
      initial,
      form({ batchNo: issue.batchNo, results: `${a.id},SUCCESS\n${a.id},FAIL,잔액부족` }),
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain(a.id);

    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('APPROVED');
    expect(await prisma.settlementLedger.count({ where: { requestId: a.id } })).toBe(0);
  });
});

// ───────────────────── SET-K ─────────────────────

describe('SET-K 지급일은 이체일(발급일) 기준', () => {
  it('날짜가 없으면 이체파일 발급 시각이 지급일이 된다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    const issue = await markPayoutFileIssued([a.id], 'admin');
    const issuedAt = new Date(Date.now() - 20 * 86_400_000);
    await prisma.settlementRequest.update({ where: { id: a.id }, data: { payoutIssuedAt: issuedAt } });

    const res = await applyPayoutResultsAction(initial, form({ batchNo: issue.batchNo, results: `${a.id},SUCCESS` }));
    expect(res.ok).toBe(true);
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('PAID');
    expect(row.paidAt?.getTime()).toBe(issuedAt.getTime());

    const auditRow = audit.calls.find((c) => c.action === 'SETTLEMENT_PAYOUT_RESULT');
    expect((auditRow?.after as { batchNo: string; paidRequestIds: string[] }).batchNo).toBe(issue.batchNo);
    expect((auditRow?.after as { paidRequestIds: string[] }).paidRequestIds).toEqual([a.id]);
  });

  it('세 번째 칸에 이체일이 있으면 그 날짜(KST)로 기록한다', async () => {
    const a = await createSettlementRequest(fx.creatorId, 50_000n, { resident: RESIDENT });
    await approve(a.id);
    const issue = await markPayoutFileIssued([a.id], 'admin');
    await prisma.settlementRequest.update({
      where: { id: a.id },
      data: { payoutIssuedAt: new Date(Date.now() - 20 * 86_400_000) },
    });
    const day = kstDateKey(new Date(Date.now() - 10 * 86_400_000));

    const res = await applyPayoutResultsAction(
      initial,
      form({ batchNo: issue.batchNo, results: `${a.id},SUCCESS,${day},정상` }),
    );
    expect(res.ok).toBe(true);
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(kstDateKey(row.paidAt!)).toBe(day);
    expect(row.payoutRef).toBe('정상');
  });
});
