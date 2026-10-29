import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { isStrictMonthKey, kstMonthKey } from '@/lib/datetime';
import { encrypt } from '@/lib/crypto';
import { csvCell, csvRow, csvTextCell } from '@/lib/csv';
import {
  createSettlementRequest,
  latestPayoutIssueAt,
  markPayoutFileIssued,
  markSettlementPaid,
} from '@/server/services/settlement';
import { getTaxDeadlines } from '@/server/services/tax';
import { resetDb, seedBasics, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/** 권한 등급을 테스트마다 바꿀 수 있게 둔다(기본 FINANCE). */
const session = vi.hoisted(() => ({ permission: 'FINANCE' as string }));
vi.mock('@/server/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...actual,
    requireAdmin: vi.fn(async () => ({
      id: 'admin-r4', email: null, name: '재무', role: 'ADMIN', avatarIndex: 0, adminPermission: session.permission,
    })),
    writeAudit: vi.fn(async () => undefined),
  };
});

const { updateSettlementRequestStatus, bulkUpdateSettlementAction, applyPayoutResultsAction } = await import(
  '@/app/actions/admin/settlement'
);
const { updateCreatorTaxProfile } = await import('@/app/actions/admin/tax');
const { createHolidayAction, deleteHolidayAction, updateHolidayAction } = await import('@/app/actions/admin/holidays');
const withholdingRoute = await import('@/app/api/admin/settlements/withholding/route');
const payoutRoute = await import('@/app/api/admin/settlements/payout/route');
const taxExportRoute = await import('@/app/api/admin/tax/export/route');

/**
 * 2026-10-29 4차 점검 — 정산·세무 영역 회귀 테스트. 항목 번호는 4차 점검 보고서를 따른다.
 */

let fx: Fixture;
const RESIDENT = '9001011234567';
const initial = { ok: false, message: '' } as never;

function form(values: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) {
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return fd;
}

async function fund(creatorId: string, amount: bigint) {
  await prisma.settlementAccount.upsert({
    where: { creatorId },
    create: {
      id: newId(), creatorId, bankCode: '004', bankName: '국민은행',
      accountEnc: encrypt('00122233344455'), accountTail4: '4455',
      holderNameEnc: encrypt('김도네'), holderMasked: '김*네', verified: true, verifiedAt: new Date(),
    },
    // 앞자리 0 이 있는 계좌번호로 맞춘다(SET-1 확인용).
    update: { accountEnc: encrypt('00122233344455'), verified: true, verifiedAt: new Date() },
  });
  await prisma.settlementLedger.create({
    data: {
      id: newId(), creatorId, entryType: 'DONATION_GROSS', amount,
      occurredAt: new Date(Date.now() - 40 * 86_400_000), settlementKey: kstMonthKey(),
    },
  });
}

async function approved(amount = 30_000n) {
  const r = await createSettlementRequest(fx.creatorId, amount, { resident: RESIDENT });
  await prisma.settlementRequest.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
  return r;
}

beforeEach(async () => {
  await resetDb();
  session.permission = 'FINANCE';
  fx = await seedBasics();
  await fund(fx.creatorId, 200_000n);
});

// ───────────────────── SET-1 ─────────────────────

describe('SET-1 식별번호 열은 엑셀에서 앞자리 0·자릿수를 지킨다', () => {
  it('숫자·하이픈 식별번호는 ="..." 형태, 그 밖은 기존 csvCell 규칙', () => {
    expect(csvTextCell('004')).toBe('"=""004"""');
    expect(csvTextCell('0001013234567')).toBe('"=""0001013234567"""');
    expect(csvTextCell('123-45-67890')).toBe('"=""123-45-67890"""');
    expect(csvTextCell('')).toBe('');
    // 수식 주입 시도는 식별번호 형태로 감싸지 않고 기존 방어를 탄다.
    expect(csvTextCell('=1+1')).toBe(csvCell('=1+1'));
    expect(csvTextCell('-1+2')).toBe(csvCell('-1+2'));
    expect(csvTextCell('TOR-AB12')).toBe('TOR-AB12');
    // 금액 열은 숫자 그대로(엑셀 합계).
    expect(csvRow(['004', '-12000', '0012'], ['text', 'auto'])).toBe('"=""004""",-12000,0012');
  });

  it('원천징수 자료: 주민등록번호는 텍스트 형태, 금액은 숫자 그대로', async () => {
    const r = await approved(30_000n);
    await markSettlementPaid(r.id, 'admin');
    const res = await withholdingRoute.GET(new Request('http://localhost/api/admin/settlements/withholding'));
    expect(res.status).toBe(200);
    const body = await res.text();
    const line = body.split('\r\n')[1]!;
    expect(line).toContain(`"=""${RESIDENT}"""`);
    expect(line).toContain(',30000,');
  });

  it('이체파일(은행 업로드용)은 은행코드·계좌번호를 원문 숫자 그대로 둔다', async () => {
    const r = await approved(30_000n);
    const res = await payoutRoute.GET(
      new Request(`http://localhost/api/admin/settlements/payout?ids=${r.id}`, { headers: { 'sec-fetch-site': 'same-origin' } }),
    );
    expect(res.status).toBe(200);
    const line = (await res.text()).split('\r\n')[1]!;
    expect(line.startsWith('1,004,00122233344455,')).toBe(true);
    expect(line).not.toContain('=');
  });
});

// ───────────────────── SET-2 / P2-8 / P2-11 ─────────────────────

describe('SET-2 수동 지급 완료의 지급일은 이체파일 발급 시각', () => {
  it('단건 [지급 완료]: 발급 시각이 지급일이 된다', async () => {
    const r = await approved();
    await markPayoutFileIssued([r.id], 'admin');
    const issuedAt = new Date(Date.now() - 15 * 86_400_000);
    await prisma.settlementRequest.update({ where: { id: r.id }, data: { payoutIssuedAt: issuedAt } });

    const res = await updateSettlementRequestStatus(initial, form({ requestId: r.id, status: 'PAID' }));
    expect(res.ok).toBe(true);
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PAID');
    expect(row.paidAt?.getTime()).toBe(issuedAt.getTime());
  });

  it('일괄 [지급 완료]: 발급 시각, 이체파일이 없는 건은 처리 시각', async () => {
    const a = await approved();
    const b = await approved();
    await markPayoutFileIssued([a.id], 'admin');
    const issuedAt = new Date(Date.now() - 10 * 86_400_000);
    await prisma.settlementRequest.update({ where: { id: a.id }, data: { payoutIssuedAt: issuedAt } });

    const before = Date.now();
    const res = await bulkUpdateSettlementAction(initial, form({ bulkAction: 'PAY', requestId: [a.id, b.id] }));
    expect(res.ok).toBe(true);
    const rowA = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowA.paidAt?.getTime()).toBe(issuedAt.getTime());
    expect(rowB.paidAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('P2-8 재발급하면 마지막 재발급 시각이 지급일 기준', () => {
  it('재발급 시각을 남기고, 은행 결과(날짜 없음)와 수동 지급 완료 모두 그 시각을 쓴다', async () => {
    const a = await approved();
    const b = await approved();
    await markPayoutFileIssued([a.id, b.id], 'admin');
    const first = new Date(Date.now() - 30 * 86_400_000);
    await prisma.settlementRequest.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { payoutIssuedAt: first } });

    const re = await markPayoutFileIssued([a.id, b.id], 'admin', { allowReissue: true });
    expect(re.reissued.sort()).toEqual([a.id, b.id].sort());
    const rowA = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(rowA.payoutIssuedAt?.getTime()).toBe(first.getTime()); // 최초 발급 시각은 보존
    expect(rowA.payoutReissuedAt).toBeTruthy();
    expect(latestPayoutIssueAt(rowA)?.getTime()).toBe(rowA.payoutReissuedAt!.getTime());

    const res = await applyPayoutResultsAction(initial, form({ batchNo: re.batchNo, results: `${a.id},SUCCESS` }));
    expect(res.ok).toBe(true);
    const paidA = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(paidA.paidAt?.getTime()).toBe(rowA.payoutReissuedAt!.getTime());

    const resB = await updateSettlementRequestStatus(initial, form({ requestId: b.id, status: 'PAID' }));
    expect(resB.ok).toBe(true);
    const paidB = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: b.id } });
    expect(paidB.paidAt?.getTime()).toBe(paidB.payoutReissuedAt!.getTime());
  });

  it('발급 취소 후 다시 받으면 재발급 시각은 비워지고 새 최초 발급이 된다', async () => {
    const a = await approved();
    await markPayoutFileIssued([a.id], 'admin');
    await markPayoutFileIssued([a.id], 'admin', { allowReissue: true });
    const cancel = await updateSettlementRequestStatus(initial, form({ requestId: a.id, status: 'CANCEL_ISSUE', memo: '파일 분실' }));
    expect(cancel.ok).toBe(true);
    let row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.payoutIssuedAt).toBeNull();
    expect(row.payoutReissuedAt).toBeNull();
    await markPayoutFileIssued([a.id], 'admin');
    row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.payoutIssuedAt).toBeTruthy();
    expect(row.payoutReissuedAt).toBeNull();
  });
});

describe('P2-11 수동 지급 완료는 락 안에서 승인 상태를 다시 확인한다', () => {
  it('expectedStatus=APPROVED 이면 지급실패 건을 지급 완료로 올리지 않는다(분개 없음)', async () => {
    const r = await approved();
    await prisma.settlementRequest.update({ where: { id: r.id }, data: { status: 'PAYOUT_FAILED' } });
    await expect(markSettlementPaid(r.id, 'admin', undefined, { expectedStatus: 'APPROVED' })).rejects.toThrow('승인(APPROVED)');
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PAYOUT_FAILED');
    expect(await prisma.settlementLedger.count({ where: { requestId: r.id } })).toBe(0);
  });

  it('expectedStatus 를 주면 이미 지급된 건도 조용히 성공 처리하지 않는다', async () => {
    const r = await approved();
    await markSettlementPaid(r.id, 'admin', undefined, { expectedStatus: 'APPROVED' });
    await expect(markSettlementPaid(r.id, 'admin', undefined, { expectedStatus: 'APPROVED' })).rejects.toThrow('이미 지급 완료');
    expect(await prisma.settlementLedger.count({ where: { requestId: r.id, entryType: 'PAYOUT' } })).toBe(1);
  });

  it('지급일이 속한 달의 원천징수 신고기한이 지났으면 [수정신고 필요] 표시를 남긴다', async () => {
    const r = await approved();
    const oldPaidAt = new Date(Date.now() - 70 * 86_400_000); // 두 달 이상 전 → 그 달 신고기한은 이미 지남
    const paid = await markSettlementPaid(r.id, 'admin', undefined, { expectedStatus: 'APPROVED', paidAt: oldPaidAt });
    expect(paid.status).toBe('PAID');
    expect(paid.adminMemo ?? '').toContain('[수정신고 필요]');

    const r2 = await approved();
    const fresh = await markSettlementPaid(r2.id, 'admin', undefined, { expectedStatus: 'APPROVED' });
    expect(fresh.adminMemo ?? '').not.toContain('[수정신고 필요]');
  });

  it('은행 결과 경로(expectedStatus 없음)는 지급실패 건도 그대로 반영한다', async () => {
    const r = await approved();
    await prisma.settlementRequest.update({ where: { id: r.id }, data: { status: 'PAYOUT_FAILED' } });
    const paid = await markSettlementPaid(r.id, 'admin', undefined, { fromBankResult: true });
    expect(paid.status).toBe('PAID');
  });
});

// ───────────────────── P2-9 ─────────────────────

describe('P2-9 세무 일정은 각 기한의 다음 도래분', () => {
  const at = (iso: string) => new Date(`${iso}+09:00`);
  const find = (list: ReturnType<typeof getTaxDeadlines>, title: string) => list.find((d) => d.title === title)!;

  it('1~3월에는 올해 3월의 전년 귀속 기한이 보인다', () => {
    const list = getTaxDeadlines(at('2027-02-15T10:00:00'));
    expect(find(list, '사업소득 지급명세서(연간)')).toMatchObject({ dueDate: '2027-03-10' });
    expect(find(list, '사업소득 지급명세서(연간)').detail).toContain('2026년 귀속');
    expect(find(list, '법인세 신고·납부')).toMatchObject({ dueDate: '2027-03-31' });
    // 2월 10일이 지났으므로 원천징수 신고는 3월 10일(2월 지급분)
    expect(find(list, '원천징수 이행상황신고·납부')).toMatchObject({ dueDate: '2027-03-10' });
    expect(find(list, '원천징수 이행상황신고·납부').detail).toContain('2027-02 지급분');
    // 간이지급명세서는 매월: 1월 지급분 → 2월 말일
    expect(find(list, '사업소득 간이지급명세서')).toMatchObject({ dueDate: '2027-02-28' });
    expect(find(list, '사업소득 간이지급명세서').detail).toContain('2027-01 지급분');
    expect(find(list, '부가가치세 신고')).toMatchObject({ dueDate: '2027-04-25' });
    expect(list.every((d) => d.daysLeft >= 0)).toBe(true);
  });

  it('12월 말에는 다음 해 1월 기한으로 넘어간다', () => {
    const list = getTaxDeadlines(at('2026-12-20T09:00:00'));
    expect(find(list, '원천징수 이행상황신고·납부')).toMatchObject({ dueDate: '2027-01-10' });
    expect(find(list, '원천징수 이행상황신고·납부').detail).toContain('2026-12 지급분');
    expect(find(list, '사업소득 간이지급명세서')).toMatchObject({ dueDate: '2026-12-31' });
    expect(find(list, '부가가치세 신고')).toMatchObject({ dueDate: '2027-01-25' });
    expect(find(list, '부가가치세 신고').detail).toContain('2026년 2기 확정');
  });

  it('기한 당일은 오늘(0일)로 남고, 다음 날 다음 달로 넘어간다', () => {
    const today = getTaxDeadlines(at('2026-11-10T23:30:00'));
    expect(find(today, '원천징수 이행상황신고·납부')).toMatchObject({ dueDate: '2026-11-10', daysLeft: 0 });
    const next = getTaxDeadlines(at('2026-11-11T00:10:00'));
    expect(find(next, '원천징수 이행상황신고·납부')).toMatchObject({ dueDate: '2026-12-10', daysLeft: 29 });
  });
});

// ───────────────────── P2-10 ─────────────────────

describe('P2-10 세무 자료 다운로드는 범위를 벗어난 연·월을 400 으로 거절한다', () => {
  it('isStrictMonthKey', () => {
    const now = new Date('2026-10-29T03:00:00Z');
    expect(isStrictMonthKey('2026-10', now)).toBe(true);
    expect(isStrictMonthKey('2027-12', now)).toBe(true);
    expect(isStrictMonthKey('2028-01', now)).toBe(false);
    expect(isStrictMonthKey('2019-12', now)).toBe(false);
    expect(isStrictMonthKey('2026-13', now)).toBe(false);
    expect(isStrictMonthKey('2026-1', now)).toBe(false);
  });

  it('부가세 분기: 먼 미래 연도는 400, 올해는 200', async () => {
    const year = Number(kstMonthKey().slice(0, 4));
    const bad = await taxExportRoute.GET(new Request(`http://localhost/api/admin/tax/export?kind=vat&year=2099&quarter=1`));
    expect(bad.status).toBe(400);
    const ok = await taxExportRoute.GET(new Request(`http://localhost/api/admin/tax/export?kind=vat&year=${year}&quarter=1`));
    expect(ok.status).toBe(200);
    const lines = (await ok.text()).split('\r\n');
    expect(lines[1]!.startsWith(`${year}-01,`)).toBe(true);
    expect(lines[3]!.startsWith(`${year}-03,`)).toBe(true);
  });

  it('원장: 잘못된 월은 이번 달로 바꾸지 않고 400', async () => {
    for (const m of ['2099-01', '2026-13', 'abc']) {
      const res = await taxExportRoute.GET(new Request(`http://localhost/api/admin/tax/export?kind=ledger&month=${m}`));
      expect(res.status).toBe(400);
    }
    const ok = await taxExportRoute.GET(new Request(`http://localhost/api/admin/tax/export?kind=ledger&month=${kstMonthKey()}`));
    expect(ok.status).toBe(200);
  });
});

// ───────────────────── 공휴일 권한 ─────────────────────

describe('공휴일 등록·수정·삭제는 최고관리자·재무만', () => {
  it('운영·고객지원은 거절, 재무·최고관리자는 허용', async () => {
    for (const p of ['OPERATION', 'SUPPORT']) {
      session.permission = p;
      const res = await createHolidayAction(initial, form({ date: '2030-05-01', name: '근로자의 날', kind: 'BANK_ONLY' }));
      expect(res.ok).toBe(false);
      expect(res.message).toContain('재무 권한(FINANCE)');
    }
    expect(await prisma.publicHoliday.count({ where: { date: '2030-05-01' } })).toBe(0);

    session.permission = 'FINANCE';
    expect((await createHolidayAction(initial, form({ date: '2030-05-01', name: '근로자의 날', kind: 'BANK_ONLY' }))).ok).toBe(true);
    const h = await prisma.publicHoliday.findUniqueOrThrow({ where: { date: '2030-05-01' } });

    session.permission = 'OPERATION';
    expect((await updateHolidayAction(initial, form({ id: h.id, name: '변경', kind: 'BANK_ONLY' }))).ok).toBe(false);
    expect((await deleteHolidayAction(initial, form({ id: h.id }))).ok).toBe(false);
    expect(await prisma.publicHoliday.count({ where: { id: h.id } })).toBe(1);

    session.permission = 'SUPER_ADMIN';
    expect((await deleteHolidayAction(initial, form({ id: h.id }))).ok).toBe(true);
  });
});

// ───────────────────── 안내 문구 ─────────────────────

describe('과세유형 변경 안내는 "다음 정산 요청부터"', () => {
  it('원천징수는 정산 요청 시점에 계산되므로 문구가 그 시점을 가리킨다', async () => {
    const res = await updateCreatorTaxProfile(
      initial,
      form({ creatorId: fx.creatorId, taxType: 'GENERAL', businessNo: '123-45-67890' }),
    );
    expect(res.ok).toBe(true);
    expect(res.message).toContain('다음 정산 요청부터');
    expect(res.message).not.toContain('다음 지급부터');
  });
});
