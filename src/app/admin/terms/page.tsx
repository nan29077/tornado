import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { ActionForm } from '@/components/admin/action-form';
import { createTermsVersion } from '@/app/actions/admin/policy';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';
import type { ConsentType } from '@/generated/prisma/enums';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

const TYPES: Array<{ value: ConsentType; label: string }> = [
  { value: 'TERMS_SERVICE', label: '서비스 이용약관' },
  { value: 'PRIVACY', label: '개인정보 처리방침' },
  { value: 'E_FINANCE', label: '전자금융거래 이용약관' },
  { value: 'WITHDRAWAL_AGREE', label: '출금이체 동의' },
  { value: 'AGE_CONFIRM', label: '연령 확인' },
  { value: 'MARKETING', label: '마케팅 수신 동의' },
];

const typeLabel = Object.fromEntries(TYPES.map((t) => [t.value, t.label])) as Record<ConsentType, string>;

export default async function AdminTermsPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/terms');

  const [versions, consentCounts] = await Promise.all([
    prisma.termsVersion.findMany({
      orderBy: [{ type: 'asc' }, { effectiveFrom: 'desc' }],
      take: 100,
      select: {
        id: true, type: true, version: true, title: true, required: true,
        effectiveFrom: true, active: true, createdAt: true,
        _count: { select: { consents: true } },
      },
    }),
    prisma.consentRecord.count(),
  ]);

  const activeCount = versions.filter((v) => v.active).length;

  return (
    <>
      <PageHeader
        title="약관 버전 관리"
        description="새 버전을 등록하면 같은 유형의 기존 버전은 비활성 처리됩니다. 기존 버전은 동의 이력 보존을 위해 삭제하지 않습니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 버전" value={formatNumber(versions.length)} />
        <StatTile label="활성 버전" value={formatNumber(activeCount)} tone="success" />
        <StatTile label="약관 유형" value={formatNumber(TYPES.length)} />
        <StatTile label="누적 동의 기록" value={formatNumber(consentCounts)} tone="brand" />
      </div>

      <Notice tone="danger" title="기존 버전을 삭제하지 마세요">
        동의 이력(ConsentRecord)은 동의 당시의 약관 버전과 연결되어 보존됩니다. 버전을 삭제하면 어떤 내용에 동의했는지
        증명할 수 없게 되어 분쟁·감독 대응이 불가능해집니다. 내용 수정이 필요하면 반드시 새 버전을 등록하세요.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>새 버전 등록</CardTitle>
          <div className="mt-3">
            <ActionForm
              action={createTermsVersion}
              submitLabel="버전 등록"
              confirm="새 약관 버전을 등록하고 같은 유형의 기존 버전을 비활성 처리합니다."
            >
              <AdminField label="약관 유형">
                <AdminSelect name="type" defaultValue="TERMS_SERVICE">
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
              <AdminField label="버전" hint="1.0 또는 2026-01-01 형식">
                <AdminInput name="version" placeholder="1.0" required />
              </AdminField>
              <AdminField label="제목">
                <AdminInput name="title" required />
              </AdminField>
              <AdminField label="시행일 (KST)">
                <AdminInput type="date" name="effectiveFrom" defaultValue={kstDateKey()} />
              </AdminField>
              <AdminField label="본문">
                <AdminTextarea name="content" rows={10} required />
              </AdminField>
              <label className="flex items-center gap-2 text-[13px] text-ink-700">
                <input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded border-ink-300" />
                필수 동의 항목
              </label>
            </ActionForm>
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="약관 버전 목록" />
          {versions.length === 0 ? (
            <EmptyState title="등록된 약관 버전이 없습니다" />
          ) : (
            <Table className="min-w-[800px]">
              <thead>
                <tr>
                  <Th>유형</Th>
                  <Th>버전</Th>
                  <Th>제목</Th>
                  <Th>필수</Th>
                  <Th>시행일</Th>
                  <Th className="text-right">동의 건수</Th>
                  <Th>상태</Th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <Td>{typeLabel[v.type] ?? v.type}</Td>
                    <Td className="font-mono text-[12px]">{v.version}</Td>
                    <Td className="max-w-[220px] break-words">{v.title}</Td>
                    <Td>
                      <Badge tone={v.required ? 'brand' : 'neutral'}>{v.required ? '필수' : '선택'}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(v.effectiveFrom, false)}</Td>
                    <Td className="text-right tabular-nums">{formatNumber(v._count.consents)}</Td>
                    <Td>
                      <Badge tone={v.active ? 'success' : 'neutral'}>{v.active ? '활성' : '비활성'}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </>
  );
}
