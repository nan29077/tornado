import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { ActionForm } from '@/components/admin/action-form';
import { updateCreatorTaxProfile, markWithholdingFiled } from '@/app/actions/admin/tax';
import { prisma } from '@/server/db';
import { requireAdminPage, financeDenyReason } from '@/server/admin-guard';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstMonthKey, kstMonthRange, kstMonthEndKey } from '@/lib/datetime';
import { TAX_TYPES, taxTypeLabel, normalizeTaxType, type TaxType } from '@/lib/labels';
import {
  getCreatorFeeRows,
  getCreatorPayoutRows,
  getLedgerTotals,
  getPayoutTotals,
  getTaxDeadlines,
  isFeeVatIncluded,
} from '@/server/services/tax';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

/**
 * 세무 관리 (최고관리자 전용).
 *
 * 왜 정산 화면과 따로 두는가
 * --------------------------
 * 정산 화면은 **크리에이터에게 얼마를 언제 주는가**를 다룬다. 처리 주체는 운영이고 주기는 매일이다.
 * 세무 화면은 **국가에 무엇을 신고하는가**를 다룬다. 처리 주체는 재무이고 주기는 월·분기다.
 * 두 일을 한 화면에 두면 매일 쓰는 화면에 한 달에 한 번 쓰는 버튼이 섞여 오조작이 생긴다.
 *
 * 이 화면은 **읽기 위주**다. 금액을 만들어 내지 않고 확정된 원장을 다시 세어 보여 준다.
 * 유일한 쓰기는 (1) 크리에이터 세무유형 저장 (2) 원천징수 신고 완료 표시 두 가지다.
 *
 * 접근 통제: 사업자등록번호·지급명세서 자료가 들어가므로 최고관리자/재무만 볼 수 있다.
 */

const TABS = [
  { key: 'overview', label: '세무 요약' },
  { key: 'creators', label: '크리에이터 세무유형' },
  { key: 'withholding', label: '원천징수·지급명세서' },
  { key: 'invoices', label: '수수료 세금계산서' },
  { key: 'vat', label: '부가세 신고자료' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** 세무유형 편집 목록에 담을 크리에이터 수 상한. 넘어가면 검색으로 좁혀야 한다. */
const CREATOR_LIMIT = 200;

const VIEW_PERMISSIONS = new Set(['SUPER_ADMIN', 'FINANCE']);

function hrefWith(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/admin/tax?${s}` : '/admin/tax';
}

export default async function AdminTaxPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; month?: string; q?: string; type?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  const admin = await requireAdminPage('/admin/tax');
  if (!VIEW_PERMISSIONS.has(String(admin.adminPermission))) {
    // 사업자번호·지급명세서 자료가 들어가는 화면이다. 등급이 맞지 않으면 대시보드로 돌려보낸다.
    redirect('/admin');
  }
  // 열람 등급과 변경 등급은 다르다(FINANCE 는 둘 다, 그 외는 액션이 막힌다).
  // 액션 가드와 같은 기준으로 버튼도 잠가, 눌러 본 뒤에야 거절을 알게 되는 일을 없앤다.
  const denyReason = financeDenyReason(admin, '세무 정보 변경');

  const sp = await searchParams;
  const tab: TabKey = (TABS.some((t) => t.key === sp.tab) ? sp.tab : 'overview') as TabKey;
  const { key: month, prevKey, nextKey } = kstMonthRange(sp.month ?? kstMonthKey());
  const q = (sp.q ?? '').trim();
  const typeFilter = TAX_TYPES.includes(sp.type as TaxType) ? (sp.type as TaxType) : undefined;

  const vatIncluded = await isFeeVatIncluded();

  return (
    <>
      <PageHeader
        title="세무 관리"
        description="도네이도의 매출은 플랫폼 수수료뿐이며, 후원 총액은 크리에이터에게 줄 정산채무입니다. 비사업자 크리에이터에게 지급할 때는 사업소득 3.3%를 원천징수합니다."
      />

      {/* 탭 */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-ink-100 pb-px">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={hrefWith({ tab: t.key, month, q, type: typeFilter })}
            className={
              tab === t.key
                ? 'whitespace-nowrap border-b-2 border-brand-500 px-3.5 py-2 text-[13px] font-extrabold text-brand-700'
                : 'whitespace-nowrap border-b-2 border-transparent px-3.5 py-2 text-[13px] font-semibold text-ink-400 hover:text-ink-900'
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* 기준 월 (세무유형 탭은 월과 무관하므로 감춘다) */}
      {tab !== 'creators' ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link
            href={hrefWith({ tab, month: prevKey })}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50"
          >
            ← {prevKey}
          </Link>
          <span className="rounded-lg bg-ink-50 px-3 py-1.5 text-[13px] font-black tabular-nums text-ink-900">
            {month}
          </span>
          <Link
            href={hrefWith({ tab, month: nextKey })}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50"
          >
            {nextKey} →
          </Link>
          <span className="text-[11.5px] text-ink-400">
            기준: 원장은 발생일, 원천징수는 <strong>지급일</strong>
          </span>
        </div>
      ) : null}

      {tab === 'overview' ? <OverviewTab month={month} vatIncluded={vatIncluded} /> : null}
      {tab === 'creators' ? <CreatorsTab q={q} typeFilter={typeFilter} denyReason={denyReason} /> : null}
      {tab === 'withholding' ? <WithholdingTab month={month} denyReason={denyReason} /> : null}
      {tab === 'invoices' ? <InvoicesTab month={month} vatIncluded={vatIncluded} /> : null}
      {tab === 'vat' ? <VatTab month={month} vatIncluded={vatIncluded} /> : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────── 1. 세무 요약

async function OverviewTab({ month, vatIncluded }: { month: string; vatIncluded: boolean }) {
  const [ledger, payout, deadlines, typeCounts] = await Promise.all([
    getLedgerTotals(month, vatIncluded),
    getPayoutTotals(month),
    Promise.resolve(getTaxDeadlines()),
    prisma.creatorProfile.groupBy({
      by: ['taxType'],
      where: { status: 'APPROVED' },
      _count: { _all: true },
    }),
  ]);

  const countOf = (t: TaxType) => typeCounts.find((c) => normalizeTaxType(c.taxType) === t)?._count._all ?? 0;
  const unregistered = countOf('INDIVIDUAL');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="도네이도 매출 (플랫폼 수수료)"
          value={formatWon(ledger.platformFee)}
          sub={vatIncluded ? `공급가액 ${formatWon(ledger.platformFeeSupply)} · 부가세 ${formatWon(ledger.platformFeeVat)}` : '부가세 별도 정책'}
          tone="brand"
        />
        <StatTile
          label="원천징수 합계"
          value={formatWon(payout.withholding)}
          sub={`지급 ${formatNumber(payout.count)}건 · 다음 달 10일까지 신고`}
          tone={payout.withholding > 0n ? 'warning' : 'neutral'}
        />
        <StatTile
          label="크리에이터 지급총액"
          value={formatWon(payout.amount)}
          sub={`실지급 ${formatWon(payout.payoutAmount)}`}
        />
        <StatTile
          label="후원 총액 (거래대금)"
          value={formatWon(ledger.donationGross)}
          sub="도네이도 매출이 아닙니다 (정산채무)"
        />
      </div>

      {payout.missingResident > 0 ? (
        <Notice tone="danger" title={`주민등록번호가 없는 원천징수 건이 ${payout.missingResident}건 있습니다`}>
          원천징수는 했는데 지급명세서에 적을 주민등록번호가 없습니다. 이 상태로는 신고를 마칠 수 없습니다.
          해당 크리에이터에게 정산 화면에서 주민등록번호를 다시 받아 주세요.
        </Notice>
      ) : null}

      {unregistered > 0 ? (
        <Notice tone="warning" title={`과세유형이 비사업자로 남아 있는 크리에이터가 ${unregistered}명 있습니다`}>
          비사업자로 두면 지급할 때마다 3.3%를 원천징수하고 지급명세서를 제출해야 합니다. 실제로는 사업자인데
          확인이 안 된 경우라면 <Link href="/admin/tax?tab=creators&type=INDIVIDUAL" className="font-bold text-brand-700 underline">크리에이터 세무유형</Link> 에서
          사업자등록번호를 등록해 주세요.
        </Notice>
      ) : null}

      <section>
        <SectionTitle
          title="다가오는 세무 일정"
          description="기한이 토·일·공휴일이면 다음 영업일로 밀립니다. 최종 기한은 홈택스 안내를 확인해 주세요."
        />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {deadlines.map((d) => (
            <Card key={`${d.title}-${d.dueDate}`}>
              <div className="flex items-start justify-between gap-2">
                <CardTitle>{d.title}</CardTitle>
                <Badge tone={d.daysLeft < 0 ? 'danger' : d.daysLeft <= 7 ? 'warning' : 'neutral'}>
                  {d.daysLeft < 0 ? `${-d.daysLeft}일 지남` : d.daysLeft === 0 ? '오늘' : `D-${d.daysLeft}`}
                </Badge>
              </div>
              <p className="mt-1 font-mono text-[12px] font-bold text-ink-700">{d.dueDate}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-500">{d.detail}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle title="승인 크리에이터 과세유형 분포" description="승인 상태인 크리에이터만 셉니다." />
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {TAX_TYPES.map((t) => (
            <StatTile
              key={t}
              label={taxTypeLabel[t].text}
              value={`${formatNumber(countOf(t))}명`}
              sub={taxTypeLabel[t].hint}
              tone={taxTypeLabel[t].tone}
            />
          ))}
        </div>
      </section>

      <Notice tone="neutral" title="이 화면의 숫자가 어디서 오는가">
        모든 금액은 <strong>정산 원장(settlement_ledger)</strong> 과 <strong>정산 요청(settlement_request)</strong> 을 다시
        센 값입니다. 이 화면은 금액을 만들거나 고치지 않습니다. 금액이 틀렸다면 정산 화면의
        <strong> 조정 분개</strong>로 바로잡아야 하며, 여기서 고칠 수 있는 것은 세무유형과 신고 완료 표시뿐입니다.
      </Notice>
    </div>
  );
}

// ─────────────────────────────────────────────────── 2. 크리에이터 세무유형

async function CreatorsTab({
  q,
  typeFilter,
  denyReason,
}: {
  q: string;
  typeFilter?: TaxType;
  /** 등급 때문에 저장이 막힌 사유. 있으면 버튼을 잠그고 그대로 보여 준다. */
  denyReason?: string;
}) {
  const where: Prisma.CreatorProfileWhereInput = {
    // 반려·정지 채널은 지급 대상이 아니라 세무 대상도 아니다.
    status: { in: ['APPROVED', 'PENDING'] },
    ...(typeFilter ? { taxType: typeFilter } : {}),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: 'insensitive' as const } },
            { code: { contains: q.toUpperCase() } },
            { businessNo: { contains: q } },
            { businessName: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, creators] = await Promise.all([
    prisma.creatorProfile.count({ where }),
    prisma.creatorProfile.findMany({
      where,
      // 확인이 안 된 건(비사업자·미확인)을 먼저 처리하도록 세무 확인 시각이 없는 순으로 본다.
      orderBy: [{ taxUpdatedAt: 'asc' }, { displayName: 'asc' }],
      take: CREATOR_LIMIT,
      select: {
        id: true, displayName: true, code: true, status: true,
        taxType: true, businessNo: true, businessName: true, taxInvoiceEmail: true,
        taxMemo: true, taxUpdatedAt: true,
        user: { select: { email: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-4">
      <Notice tone="neutral" title="과세유형이 지급 방식을 결정합니다">
        <strong>비사업자(개인)</strong> 는 지급할 때 사업소득 3.3%를 원천징수하고 지급명세서를 제출합니다.
        <strong> 사업자(일반·간이·면세)</strong> 는 원천징수하지 않고 크리에이터가 계산서를 발행합니다.
        변경은 <strong>다음 지급부터</strong> 적용되며 이미 지급된 건에는 소급되지 않습니다.
      </Notice>

      <FilterBar action="/admin/tax" resetHref="/admin/tax?tab=creators">
        <input type="hidden" name="tab" value="creators" />
        <AdminField label="검색 (이름/코드/사업자번호/상호)" className="w-64">
          <AdminInput name="q" defaultValue={q} placeholder="도네이도 또는 123-45-67890" />
        </AdminField>
        <AdminField label="과세유형" className="w-40">
          <AdminSelect name="type" defaultValue={typeFilter ?? ''}>
            <option value="">전체</option>
            {TAX_TYPES.map((t) => (
              <option key={t} value={t}>
                {taxTypeLabel[t].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </FilterBar>

      {total > CREATOR_LIMIT ? (
        <Notice tone="warning" title={`${formatNumber(total)}명 중 ${CREATOR_LIMIT}명만 표시하고 있습니다`}>
          위 검색으로 대상을 좁혀 주세요. 세무 확인이 오래된 순으로 먼저 보여 줍니다.
        </Notice>
      ) : null}

      {creators.length === 0 ? (
        <EmptyState title="조건에 맞는 크리에이터가 없습니다" />
      ) : (
        <div className="space-y-2.5">
          {creators.map((c) => {
            const current = normalizeTaxType(c.taxType);
            const label = taxTypeLabel[current];
            return (
              <Card key={c.id}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/creators/${c.id}`} className="text-[14px] font-extrabold text-brand-700">
                      {c.displayName}
                    </Link>
                    <span className="font-mono text-[12px] text-ink-400">{c.code}</span>
                    {c.status === 'PENDING' ? <Badge tone="neutral">심사대기</Badge> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={label.tone}>{label.text}</Badge>
                    <span className="text-[11px] text-ink-400">
                      {c.taxUpdatedAt ? `확인 ${formatKst(c.taxUpdatedAt, false)}` : '세무 정보 미확인'}
                    </span>
                  </div>
                </div>

                {/*
                  과세유형이 바뀌면 **다음 지급부터 원천징수 여부가 달라진다.**
                  개인(3.3% 징수) ↔ 사업자(징수 없음) 를 잘못 저장하면 원천징수의무 불이행이 되어
                  도네이도가 가산세를 부담한다. 저장 직전에 무엇이 달라지는지 한 번 더 확인받는다.
                */}
                <ActionForm
                  action={updateCreatorTaxProfile}
                  submitLabel="세무 정보 저장"
                  confirm={
                    `${c.displayName} 님의 세무 정보를 저장합니다.\n\n` +
                    `현재 과세유형: ${label.text} (${label.withholding ? '원천징수 3.3% 적용' : '원천징수 없음'})\n` +
                    '과세유형을 바꾸면 다음 지급부터 원천징수 여부가 달라집니다. ' +
                    '이미 지급된 건에는 소급되지 않습니다.'
                  }
                  disabledReason={denyReason}
                >
                  <input type="hidden" name="creatorId" value={c.id} />
                  <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                    <AdminField label="과세유형" hint={label.hint}>
                      <AdminSelect name="taxType" defaultValue={current}>
                        {TAX_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {taxTypeLabel[t].text}
                          </option>
                        ))}
                      </AdminSelect>
                    </AdminField>
                    <AdminField label="사업자등록번호" hint="사업자로 지정하려면 필수입니다.">
                      <AdminInput name="businessNo" defaultValue={c.businessNo ?? ''} placeholder="123-45-67890" />
                    </AdminField>
                    <AdminField label="상호 (사업자등록증)">
                      <AdminInput name="businessName" defaultValue={c.businessName ?? ''} placeholder="주식회사 예시" />
                    </AdminField>
                    <AdminField label="세금계산서 이메일" hint={c.user.email ? `비우면 ${c.user.email} 로 보냅니다.` : undefined}>
                      <AdminInput
                        name="taxInvoiceEmail"
                        type="email"
                        defaultValue={c.taxInvoiceEmail ?? ''}
                        placeholder="tax@example.com"
                      />
                    </AdminField>
                  </div>
                  <AdminField label="세무 메모 (관리자 전용)">
                    <AdminInput name="taxMemo" maxLength={200} defaultValue={c.taxMemo ?? ''} placeholder="예: 2026-09 사업자등록증 사본 확인" />
                  </AdminField>
                </ActionForm>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────── 3. 원천징수 · 지급명세서

async function WithholdingTab({ month, denyReason }: { month: string; denyReason?: string }) {
  const [totals, rows] = await Promise.all([getPayoutTotals(month), getCreatorPayoutRows(month)]);
  const mismatched = rows.filter((r) => r.mismatch);
  const monthEnd = kstMonthEndKey(month);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="지급 건수" value={`${formatNumber(totals.count)}건`} />
        <StatTile label="지급총액 (과세소득)" value={formatWon(totals.amount)} />
        <StatTile
          label="원천징수 합계"
          value={formatWon(totals.withholding)}
          sub={`소득세 ${formatWon(totals.incomeTax)} · 지방소득세 ${formatWon(totals.localTax)}`}
          tone="brand"
        />
        <StatTile
          label="신고 대기"
          value={`${formatNumber(totals.unfiled)}건`}
          tone={totals.unfiled > 0 ? 'warning' : 'success'}
          sub="신고 완료 표시가 안 된 건"
        />
      </div>

      <Notice tone="neutral" title="신고 기한과 순서">
        {month} 지급분은 <strong>다음 달 10일</strong>까지 원천징수 이행상황신고서와 함께 납부합니다.
        아래 [자료 받기]로 CSV 를 내려받아 홈택스에 입력한 뒤, 실제 신고를 마치고 나서
        [신고 완료 표시]를 눌러 주세요. 표시는 <strong>기록일 뿐 신고가 아닙니다.</strong>
      </Notice>

      {mismatched.length > 0 ? (
        <Notice tone="danger" title={`과세유형과 실제 징수가 어긋난 크리에이터가 ${mismatched.length}명 있습니다`}>
          비사업자인데 원천징수가 0원이거나, 사업자인데 원천징수가 있는 건입니다. 신고 전에 반드시 확인해 주세요.
          과다 징수분은 정산 화면의 <strong>조정 분개</strong>로 돌려주고, 미징수분은 다음 지급에서 조정합니다.
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {/* Link 는 화면에 보이면 prefetch 로 GET 을 미리 호출해 주민번호 복호화·감사로그가 클릭 없이 쌓인다. */}
        <a
          href={`/api/admin/settlements/withholding?from=${month}-01&to=${monthEnd}`}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50"
        >
          {month} 지급명세서 산출 자료 받기 (CSV)
        </a>
        <span className="text-[11.5px] text-ink-400">주민등록번호가 포함됩니다. 내려받은 기록은 감사로그에 남습니다.</span>
      </div>

      <Card>
        <CardTitle>원천징수 신고 완료 표시</CardTitle>
        <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-500">
          홈택스 신고를 마친 뒤 눌러 주세요. {month} 지급분 중 아직 표시되지 않은 건에만 적용되며, 여러 번 눌러도
          안전합니다. 금액은 바뀌지 않습니다.
        </p>
        <ActionForm
          action={markWithholdingFiled}
          submitLabel={`${month} 신고 완료로 표시`}
          confirm={`${month} 지급분을 원천징수 신고 완료로 표시합니다. 실제 신고를 마친 뒤에만 눌러 주세요.`}
          disabledReason={denyReason}
        >
          <input type="hidden" name="month" value={month} />
        </ActionForm>
      </Card>

      <section>
        <SectionTitle
          title="크리에이터별 지급·원천징수"
          description="지급명세서 작성 단위입니다. 금액 상위 300명까지 계산합니다."
        />
        {rows.length === 0 ? (
          <EmptyState title={`${month} 에 지급 완료된 건이 없습니다`} />
        ) : (
          <Table className="min-w-[1000px]">
            <thead>
              <tr>
                <Th>크리에이터</Th>
                <Th>과세유형</Th>
                <Th>사업자번호</Th>
                <Th className="text-right">건수</Th>
                <Th className="text-right">지급총액</Th>
                <Th className="text-right">소득세</Th>
                <Th className="text-right">지방소득세</Th>
                <Th className="text-right">실지급액</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.creatorId}>
                  <Td>
                    <Link href={`/admin/creators/${r.creatorId}`} className="font-semibold text-brand-700">
                      {r.displayName}
                    </Link>
                    <span className="mt-0.5 block text-[11px] text-ink-400">{r.code}</span>
                  </Td>
                  <Td>
                    <Badge tone={taxTypeLabel[r.taxType].tone}>{taxTypeLabel[r.taxType].text}</Badge>
                    {r.mismatch ? (
                      <span className="mt-0.5 block text-[11px] font-bold text-danger-600">
                        {taxTypeLabel[r.taxType].withholding ? '원천징수 누락' : '과다 징수'}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="font-mono text-[12px]">{r.businessNo ?? '-'}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(r.count)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(r.incomeTax)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(r.localTax)}</Td>
                  <Td className="text-right font-semibold tabular-nums">{formatWon(r.payoutAmount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────── 4. 플랫폼 수수료 세금계산서

async function InvoicesTab({ month, vatIncluded }: { month: string; vatIncluded: boolean }) {
  const rows = await getCreatorFeeRows(month, vatIncluded);
  const issuable = rows.filter((r) => r.taxType === 'GENERAL' || r.taxType === 'EXEMPT');
  const notIssuable = rows.filter((r) => r.taxType === 'INDIVIDUAL' || r.taxType === 'SIMPLIFIED');
  const sum = (list: typeof rows) => list.reduce((a, b) => a + b.fee, 0n);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="수수료 합계" value={formatWon(sum(rows))} tone="brand" />
        <StatTile
          label="계산서 발행 대상"
          value={`${formatNumber(issuable.length)}명`}
          sub={formatWon(sum(issuable))}
          tone="success"
        />
        <StatTile
          label="발행 대상 아님"
          value={`${formatNumber(notIssuable.length)}명`}
          sub="비사업자·간이과세"
        />
        <StatTile
          label="이메일 미등록"
          value={`${formatNumber(issuable.filter((r) => !r.taxInvoiceEmail).length)}명`}
          tone={issuable.some((r) => !r.taxInvoiceEmail) ? 'warning' : 'neutral'}
        />
      </div>

      <Notice tone="neutral" title="누가 누구에게 발행하는가">
        도네이도가 크리에이터에게 <strong>플랫폼 수수료에 대한 세금계산서를 발행</strong>합니다(공급자 = 도네이도).
        정산금 자체는 재화·용역의 공급이 아니므로 계산서 대상이 아닙니다.
        <strong> 간이과세·비사업자</strong> 크리에이터에게는 발행하지 않습니다.
        {vatIncluded
          ? ' 현재 수수료 정책은 부가세 포함 기준이므로, 아래 공급가액은 수수료를 1.1로 나눈 값입니다.'
          : ' 현재 수수료 정책은 부가세 별도 기준이므로, 수수료 전액이 공급가액입니다.'}
      </Notice>

      {rows.length === 0 ? (
        <EmptyState title={`${month} 에 발생한 플랫폼 수수료가 없습니다`} />
      ) : (
        <Table className="min-w-[1000px]">
          <thead>
            <tr>
              <Th>크리에이터</Th>
              <Th>과세유형</Th>
              <Th>사업자번호 / 상호</Th>
              <Th>계산서 이메일</Th>
              <Th className="text-right">공급가액</Th>
              <Th className="text-right">부가세</Th>
              <Th className="text-right">합계</Th>
              <Th>발행</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const canIssue = r.taxType === 'GENERAL' || r.taxType === 'EXEMPT';
              return (
                <tr key={r.creatorId}>
                  <Td>
                    <Link href={`/admin/creators/${r.creatorId}`} className="font-semibold text-brand-700">
                      {r.displayName}
                    </Link>
                    <span className="mt-0.5 block text-[11px] text-ink-400">{r.code}</span>
                  </Td>
                  <Td>
                    <Badge tone={taxTypeLabel[r.taxType].tone}>{taxTypeLabel[r.taxType].text}</Badge>
                  </Td>
                  <Td>
                    <span className="block font-mono text-[12px]">{r.businessNo ?? '-'}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-400">{r.businessName ?? '상호 미등록'}</span>
                  </Td>
                  <Td className="max-w-[200px] break-all text-[12px]">{r.taxInvoiceEmail ?? '-'}</Td>
                  <Td className="text-right tabular-nums">{formatWon(r.supply)}</Td>
                  <Td className="text-right tabular-nums">{formatWon(r.vat)}</Td>
                  <Td className="text-right font-semibold tabular-nums">{formatWon(r.fee)}</Td>
                  <Td>
                    {canIssue ? (
                      r.taxInvoiceEmail ? (
                        <Badge tone="success">발행 대상</Badge>
                      ) : (
                        <Badge tone="warning">이메일 필요</Badge>
                      )
                    ) : (
                      <Badge tone="neutral">대상 아님</Badge>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}

// ────────────────────────────────────────────── 5. 부가세 신고자료

async function VatTab({ month, vatIncluded }: { month: string; vatIncluded: boolean }) {
  // 부가세는 분기 단위로 신고한다. 기준 월이 속한 분기 3개월을 함께 보여 준다.
  const [y, m] = month.split('-').map(Number);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const months = [0, 1, 2].map((i) => `${y}-${String(quarterStartMonth + i).padStart(2, '0')}`);
  const half = m <= 6 ? '1기' : '2기';

  const totals = await Promise.all(months.map((k) => getLedgerTotals(k, vatIncluded)));
  const sum = (pick: (t: (typeof totals)[number]) => bigint) => totals.reduce((a, t) => a + pick(t), 0n);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label={`${y}년 ${half} · ${months[0]}~${months[2]}`} value="분기 합계" />
        <StatTile label="과세표준 (공급가액)" value={formatWon(sum((t) => t.platformFeeSupply))} tone="brand" />
        <StatTile label="매출세액" value={formatWon(sum((t) => t.platformFeeVat))} />
        <StatTile label="PG 수수료 (매입)" value={formatWon(sum((t) => t.pgFee))} sub="매입세액 공제 대상 여부는 계약서 확인" />
      </div>

      <Notice tone="warning" title="과세표준은 후원 총액이 아니라 플랫폼 수수료입니다">
        도네이도는 후원금을 대신 받아 크리에이터에게 전달하는 위치이므로, 후원 총액은 부가세 과세표준이 아닙니다.
        과세표준은 도네이도가 실제로 벌어들인 <strong>플랫폼 수수료</strong>뿐입니다. 후원 총액을 매출로 잡으면
        과세표준이 수십 배로 부풀려집니다. 최종 신고 전 세무 대리인 확인을 권합니다.
      </Notice>

      <Table className="min-w-[860px]">
        <thead>
          <tr>
            <Th>월</Th>
            <Th className="text-right">후원 총액 (참고)</Th>
            <Th className="text-right">플랫폼 수수료</Th>
            <Th className="text-right">과세표준(공급가액)</Th>
            <Th className="text-right">매출세액</Th>
            <Th className="text-right">PG 수수료</Th>
            <Th className="text-right">환불</Th>
          </tr>
        </thead>
        <tbody>
          {months.map((k, i) => (
            <tr key={k}>
              <Td className="font-mono text-[13px] font-semibold">{k}</Td>
              <Td className="text-right tabular-nums text-ink-400">{formatWon(totals[i].donationGross)}</Td>
              <Td className="text-right tabular-nums">{formatWon(totals[i].platformFee)}</Td>
              <Td className="text-right font-semibold tabular-nums">{formatWon(totals[i].platformFeeSupply)}</Td>
              <Td className="text-right tabular-nums">{formatWon(totals[i].platformFeeVat)}</Td>
              <Td className="text-right tabular-nums">{formatWon(totals[i].pgFee)}</Td>
              <Td className="text-right tabular-nums">{formatWon(totals[i].refund)}</Td>
            </tr>
          ))}
          <tr>
            <Td className="font-black">분기 합계</Td>
            <Td className="text-right tabular-nums text-ink-400">{formatWon(sum((t) => t.donationGross))}</Td>
            <Td className="text-right font-black tabular-nums">{formatWon(sum((t) => t.platformFee))}</Td>
            <Td className="text-right font-black tabular-nums text-brand-700">{formatWon(sum((t) => t.platformFeeSupply))}</Td>
            <Td className="text-right font-black tabular-nums">{formatWon(sum((t) => t.platformFeeVat))}</Td>
            <Td className="text-right font-black tabular-nums">{formatWon(sum((t) => t.pgFee))}</Td>
            <Td className="text-right font-black tabular-nums">{formatWon(sum((t) => t.refund))}</Td>
          </tr>
        </tbody>
      </Table>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/api/admin/tax/export?kind=vat&year=${y}&quarter=${Math.floor((m - 1) / 3) + 1}`}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50"
        >
          분기 부가세 자료 받기 (CSV)
        </a>
        <a
          href={`/api/admin/tax/export?kind=ledger&month=${month}`}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-bold text-ink-700 hover:bg-ink-50"
        >
          {month} 기장 자료 받기 (CSV)
        </a>
        <span className="text-[11.5px] text-ink-400">세무 대리인에게 그대로 전달할 수 있는 형식입니다.</span>
      </div>
    </div>
  );
}
