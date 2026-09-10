import { requireAdmin, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { buildPayoutBatch, markPayoutFileIssued } from '@/server/services/settlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 지급대행(쿠콘) 대량이체 파일 다운로드.
 *
 * 승인(APPROVED) 상태의 선택 건을 CSV 로 내려준다.
 * 컬럼은 국내 펌뱅킹 대량이체 표준(은행코드·계좌번호·예금주·금액·적요)에 맞췄으며,
 * 쿠콘 연동규격서 수령 시 이 헤더/열 순서만 맞추면 그대로 업로드할 수 있다.
 *
 * ?ids=a,b,c  (승인 건 요청 ID 목록)
 */
function csvCell(v: string): string {
  // CSV 인젝션(=,+,-,@ 로 시작) 방지 + 콤마/따옴표 이스케이프
  const needsQuote = /[",\n]/.test(v) || /^[=+\-@]/.test(v);
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return needsQuote ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * 이 파일에는 **복호화된 계좌번호와 예금주 실명**이 들어간다.
 * requireAdmin() 만으로는 조회 전용(READ_ONLY, 기본값) 관리자까지 통과하므로
 * 반드시 화이트리스트로 유지할 것.
 */
const ALLOWED_PERMISSIONS = new Set(['SUPER_ADMIN', 'FINANCE']);

export async function GET(req: Request) {
  // 미인증 요청이 500 으로 떨어지지 않도록 여기서 401 로 정리한다.
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return new Response('관리자 로그인이 필요합니다.', { status: 401 });
  if (!ALLOWED_PERMISSIONS.has(String(admin.adminPermission))) {
    return new Response('지급대행 이체파일은 재무(FINANCE) 또는 최고관리자만 내려받을 수 있습니다.', { status: 403 });
  }

  /**
   * 이 GET 은 발급 이력을 남기는 **상태 변경**을 동반한다(내려받은 순간 배치가 확정된다).
   * 세션 쿠키가 SameSite=Lax 라 최상위 내비게이션에는 쿠키가 실리므로, 외부 페이지의 링크나
   * 프리페치로 호출되면 응답을 못 읽어도 배치 번호가 갱신되고 감사로그에 유령 기록이 남는다.
   * 브라우저가 붙이는 Sec-Fetch-* 로 교차 사이트 요청과 프리페치를 걸러낸다.
   */
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return new Response('외부 사이트에서 직접 호출할 수 없습니다.', { status: 403 });
  }
  const purpose = req.headers.get('sec-purpose') ?? req.headers.get('purpose');
  if (purpose && purpose.toLowerCase().includes('prefetch')) {
    return new Response('프리페치로는 발급할 수 없습니다.', { status: 403 });
  }

  const url = new URL(req.url);
  const ids = (url.searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return new Response('선택된 정산 요청이 없습니다.', { status: 400 });
  }

  const { rows, excluded } = await buildPayoutBatch(ids);

  /**
   * 다운로드 전 확인 단계(preview).
   *
   * 제외 건을 조용히 건너뛰던 것이 문제였다. 화면이 "선택 5건 중 2건 제외" 를 미리
   * 보여 줄 수 있도록 JSON 으로 돌려준다. **상태를 바꾸지 않는다** — 배치번호를 발급하지
   * 않으므로 미리보기를 여러 번 눌러도 이체파일 발급 이력이 더럽혀지지 않는다.
   * 계좌번호·예금주 원문은 절대 담지 않는다(그 값은 CSV 다운로드에만 들어간다).
   */
  if (url.searchParams.get('preview') === '1') {
    const reissue = rows.length
      ? await prisma.settlementRequest.findMany({
          where: { id: { in: rows.map((r) => r.requestId) }, payoutIssuedAt: { not: null } },
          select: { id: true, payoutBatchNo: true, payoutIssuedAt: true },
        })
      : [];
    return Response.json(
      {
        selected: ids.length,
        included: rows.map((r) => ({
          requestId: r.requestId,
          creatorName: r.creatorName,
          creatorCode: r.creatorCode,
          bankName: r.bankName,
          amount: r.amount.toString(),
        })),
        excluded: excluded.map((e) => ({
          requestId: e.requestId,
          creatorName: e.creatorName,
          creatorCode: e.creatorCode,
          payoutAmount: e.payoutAmount.toString(),
          reason: e.reason,
        })),
        totalAmount: rows.reduce((a, r) => a + r.amount, 0n).toString(),
        reissue: reissue.map((r) => ({ requestId: r.id, previousBatchNo: r.payoutBatchNo })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 이체파일 발급 이력을 남긴다. 같은 건을 두 번 받아 두 번 업로드하면 이중이체가 되는데,
  // 기록이 없으면 사고가 난 뒤에도 흔적을 찾을 수 없다.
  const issue = await markPayoutFileIssued(
    rows.map((r) => r.requestId),
    admin.id,
  );

  /**
   * **이미 이체파일이 나간 건이 섞여 있으면 파일을 내주지 않는다.**
   *
   * `markPayoutFileIssued` 는 조건부 갱신으로 원자적으로 선점하므로, 재무 담당 두 명이
   * 동시에 눌러도 한 명만 `reissued: []` 를 받는다. 그런데 예전에는 그 결과를 감사로그에만
   * 적고 **양쪽 모두에게 CSV 를 그대로 내려 줬다.** 두 파일을 다 올리면 돈이 두 번 나가고,
   * 그 뒤 `markSettlementPaid` 는 두 번째 호출을 `status === 'PAID'` 조기 반환으로 무시하므로
   * **원장에는 지급이 한 번만 남는다** — 실제 이체 두 번, 장부 한 번이라 사고를 눈치채기 어렵다.
   *
   * 그래서 선점하지 못한 쪽은 409 로 돌려보낸다. 일부러 다시 받아야 하는 경우(파일 분실 등)는
   * `confirmReissue=1` 을 붙여 명시적으로 요청하게 한다.
   */
  if (issue.reissued.length > 0 && url.searchParams.get('confirmReissue') !== '1') {
    return Response.json(
      {
        error: 'reissue_confirm_required',
        message:
          '이미 이체파일이 발급된 정산 건이 포함돼 있습니다. 다른 담당자가 방금 내려받았을 수 있습니다. 이중이체가 되지 않도록 확인한 뒤 다시 요청해 주세요.',
        reissued: issue.reissued,
        batchNo: issue.batchNo,
      },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  await writeAudit({
    adminUserId: admin.id,
    action: 'SETTLEMENT_PAYOUT_FILE_EXPORT',
    targetType: 'SettlementRequest',
    after: {
      batchNo: issue.batchNo,
      rows: rows.length,
      totalAmount: rows.reduce((a, r) => a + r.amount, 0n).toString(),
      reissuedRequestIds: issue.reissued,
      // 왜 빠졌는지를 감사로그에도 남긴다. 나중에 "지급된 줄 알았다" 는 분쟁의 근거가 된다.
      excluded: excluded.map((e) => ({ requestId: e.requestId, reason: e.reason })),
      permission: admin.adminPermission,
    },
  });

  const header = ['순번', '은행코드', '계좌번호', '예금주', '이체금액', '적요', '요청ID', '크리에이터', '코드'];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push(
      [
        String(i + 1),
        r.bankCode,
        r.account,
        r.holder,
        r.amount.toString(),
        r.note,
        r.requestId,
        r.creatorName,
        r.creatorCode,
      ]
        .map(csvCell)
        .join(','),
    );
  });

  // Excel 이 UTF-8 한글을 바로 열도록 BOM 을 붙인다.
  const body = '﻿' + lines.join('\r\n') + '\r\n';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // 파일명에 배치번호를 넣어 어떤 파일이 어떤 배치인지 사람이 바로 구분할 수 있게 한다.
      'Content-Disposition': `attachment; filename="donaido-payout-${issue.batchNo}-${rows.length}.csv"`,
      'Cache-Control': 'no-store',
      // 재발급 건이 섞여 있으면 헤더로도 알린다(운영자 스크립트 대응).
      'X-Payout-Reissued': String(issue.reissued.length),
    },
  });
}
