import { requireAdmin, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { kstMonthRange, kstMonthKey, formatKst } from '@/lib/datetime';
import { ledgerEntryLabel } from '@/lib/labels';
import { getLedgerTotals, isFeeVatIncluded } from '@/server/services/tax';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 세무 자료 다운로드.
 *
 *   GET /api/admin/tax/export?kind=vat&year=2026&quarter=3
 *   GET /api/admin/tax/export?kind=ledger&month=2026-09
 *
 * 원천징수 지급명세서(주민등록번호 포함)는 **여기가 아니라**
 * `/api/admin/settlements/withholding` 이 담당한다. 개인식별정보가 들어가는 경로를
 * 하나로 좁혀 두어야 접근 통제와 감사로그를 한 곳에서 지킬 수 있다.
 * 이 경로의 자료에는 주민등록번호가 들어가지 않는다.
 *
 * ── 접근통제 ────────────────────────────────────────────────────────────
 * 사업자등록번호와 매출 자료가 들어간다. 특정 등급만 배제하는 블랙리스트는
 * 등급이 추가되면 바로 뚫린다(AdminPermission 기본값은 READ_ONLY 다). 화이트리스트로 유지할 것.
 */
const ALLOWED_PERMISSIONS = new Set(['SUPER_ADMIN', 'FINANCE']);

/** 한 번에 내려줄 원장 분개 수 상한. 브라우저가 받아 열 수 있는 크기로 자른다. */
const LEDGER_ROW_LIMIT = 50_000;

function csvCell(v: string): string {
  const needsQuote = /[",\n]/.test(v) || /^[=+\-@]/.test(v);
  // 엑셀 수식 주입 방지. '=' 로 시작하는 값이 그대로 수식으로 실행되면 안 된다.
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return needsQuote ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvResponse(filename: string, lines: string[]): Response {
  // BOM 을 붙여야 엑셀이 UTF-8 로 읽는다. 없으면 한글이 전부 깨진다.
  const body = '﻿' + lines.join('\r\n') + '\r\n';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: Request) {
  // 미인증 요청이 500 으로 떨어지지 않도록 여기서 401 로 정리한다.
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return new Response('관리자 로그인이 필요합니다.', { status: 401 });
  if (!ALLOWED_PERMISSIONS.has(String(admin.adminPermission))) {
    return new Response('세무 자료는 재무(FINANCE) 또는 최고관리자만 내려받을 수 있습니다.', { status: 403 });
  }

  const sp = new URL(req.url).searchParams;
  const kind = sp.get('kind') ?? 'ledger';
  const vatIncluded = await isFeeVatIncluded();

  if (kind === 'vat') {
    const year = Number(sp.get('year'));
    const quarter = Number(sp.get('quarter'));
    if (!Number.isInteger(year) || year < 2020 || year > 2100 || ![1, 2, 3, 4].includes(quarter)) {
      return new Response('year(2020~2100) 와 quarter(1~4) 를 올바르게 지정해 주세요.', { status: 400 });
    }

    const months = [0, 1, 2].map((i) => `${year}-${String((quarter - 1) * 3 + 1 + i).padStart(2, '0')}`);
    const totals = await Promise.all(months.map((k) => getLedgerTotals(k, vatIncluded)));

    await writeAudit({
      adminUserId: admin.id,
      action: 'TAX_EXPORT_VAT',
      targetType: 'SettlementLedger',
      targetId: `${year}Q${quarter}`,
      after: { year, quarter, months, permission: admin.adminPermission },
    });

    const lines = [
      ['월', '후원총액(참고,과세표준아님)', '플랫폼수수료', '과세표준(공급가액)', '매출세액', 'PG수수료(매입)', '환불'].join(','),
    ];
    for (let i = 0; i < months.length; i += 1) {
      const t = totals[i];
      lines.push(
        [
          months[i],
          t.donationGross.toString(),
          t.platformFee.toString(),
          t.platformFeeSupply.toString(),
          t.platformFeeVat.toString(),
          t.pgFee.toString(),
          t.refund.toString(),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const sum = (pick: (t: (typeof totals)[number]) => bigint) => totals.reduce((a, t) => a + pick(t), 0n);
    lines.push(
      [
        '분기합계',
        sum((t) => t.donationGross).toString(),
        sum((t) => t.platformFee).toString(),
        sum((t) => t.platformFeeSupply).toString(),
        sum((t) => t.platformFeeVat).toString(),
        sum((t) => t.pgFee).toString(),
        sum((t) => t.refund).toString(),
      ]
        .map(csvCell)
        .join(','),
    );
    lines.push('');
    lines.push(
      csvCell(
        '주의: 도네이도는 후원금을 대신 받아 전달하는 위치이므로 후원 총액은 부가세 과세표준이 아닙니다. ' +
          '과세표준은 플랫폼 수수료뿐입니다.',
      ),
    );

    return csvResponse(`donaido-vat-${year}Q${quarter}.csv`, lines);
  }

  if (kind === 'ledger') {
    const { key, start, end } = kstMonthRange(sp.get('month') ?? kstMonthKey());

    const rows = await prisma.settlementLedger.findMany({
      where: { occurredAt: { gte: start, lt: end } },
      orderBy: { occurredAt: 'asc' },
      take: LEDGER_ROW_LIMIT,
      select: {
        occurredAt: true, settlementKey: true, entryType: true, amount: true, memo: true,
        donationId: true, refundId: true, requestId: true,
        creator: { select: { displayName: true, code: true, taxType: true, businessNo: true } },
      },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'TAX_EXPORT_LEDGER',
      targetType: 'SettlementLedger',
      targetId: key,
      after: { month: key, rows: rows.length, permission: admin.adminPermission },
    });

    const lines = [
      ['발생시각', '정산월', '크리에이터', '코드', '과세유형', '사업자번호', '분개유형', '금액(부호포함)', '메모', '후원ID', '환불ID', '정산ID'].join(','),
    ];
    for (const r of rows) {
      lines.push(
        [
          formatKst(r.occurredAt),
          r.settlementKey,
          r.creator.displayName,
          r.creator.code,
          r.creator.taxType,
          r.creator.businessNo ?? '',
          ledgerEntryLabel[r.entryType],
          r.amount.toString(),
          r.memo ?? '',
          r.donationId ?? '',
          r.refundId ?? '',
          r.requestId ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    if (rows.length === LEDGER_ROW_LIMIT) {
      lines.push('');
      lines.push(csvCell(`주의: 상한 ${LEDGER_ROW_LIMIT}건에서 잘렸습니다. 기간을 더 짧게 나눠 다시 받아 주세요.`));
    }

    return csvResponse(`donaido-ledger-${key}.csv`, lines);
  }

  return new Response('kind 는 vat 또는 ledger 만 지원합니다.', { status: 400 });
}
