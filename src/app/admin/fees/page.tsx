import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, CreatorOptions } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { createFeePolicy, deactivateFeePolicy } from '@/app/actions/admin/settlement';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { computeFees } from '@/server/services/settlement';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

function ratePercent(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `${(n * 100).toFixed(2)}%`;
}

export default async function AdminFeesPage() {
  const [policies, creators] = await Promise.all([
    prisma.feePolicy.findMany({
      orderBy: [{ active: 'desc' }, { effectiveFrom: 'desc' }],
      take: 100,
      select: {
        id: true, scope: true, creatorId: true, pgFeeRate: true, pgFixedFee: true,
        platformFeeRate: true, smsCost: true, vatIncluded: true, active: true,
        effectiveFrom: true, effectiveTo: true, createdAt: true,
        creator: { select: { id: true, displayName: true, code: true } },
      },
    }),
    prisma.creatorProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, code: true },
      take: CREATOR_OPTION_LIMIT,
    }),
  ]);

  const activeGlobal = policies.find((p) => p.active && p.scope === 'GLOBAL');
  const activeCreatorCount = policies.filter((p) => p.active && p.scope === 'CREATOR').length;

  // 실제 정산과 같은 함수로 계산한 예시. 요율만 보고는 부가세 반영 결과를 알기 어렵다.
  const SAMPLE = 3_000n;
  const sample = computeFees(SAMPLE, {
    pgFeeRate: activeGlobal ? activeGlobal.pgFeeRate.toString() : '0.018',
    pgFixedFee: activeGlobal?.pgFixedFee ?? 0n,
    platformFeeRate: activeGlobal ? activeGlobal.platformFeeRate.toString() : '0.15',
    vatIncluded: activeGlobal ? activeGlobal.vatIncluded : true,
  });

  return (
    <>
      <PageHeader
        title="수수료 정책"
        description="정책은 수정하지 않고 새 버전을 추가하는 방식으로 관리합니다. 기존 정책은 마감 처리되어 이력이 보존됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="전역 결제 수수료"
          value={activeGlobal ? ratePercent(activeGlobal.pgFeeRate.toString()) : '미설정'}
          sub={activeGlobal ? `고정비 ${formatWon(activeGlobal.pgFixedFee)}` : '기본값 1.80% 적용'}
          tone="brand"
        />
        <StatTile
          label="전역 플랫폼 수수료"
          value={activeGlobal ? ratePercent(activeGlobal.platformFeeRate.toString()) : '미설정'}
          sub={activeGlobal ? `문자 원가 ${formatWon(activeGlobal.smsCost)}` : '기본값 15.00% 적용'}
        />
        <StatTile label="크리에이터 개별 정책" value={formatNumber(activeCreatorCount)} />
        <StatTile label="전체 정책 이력" value={formatNumber(policies.length)} sub="최근 100건" />
      </div>

      <Card className="mt-4">
        <CardTitle>{formatWon(SAMPLE)} 후원 기준 계산 예시</CardTitle>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
          현재 활성 전역 정책({sample.vatIncluded ? '부가세 포함 요율' : '부가세 별도 요율'})을 실제 정산 계산식에
          그대로 넣은 결과입니다.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <StatTile label="후원 총액" value={formatWon(sample.gross)} />
          <StatTile
            label="결제 수수료"
            value={formatWon(sample.pgFee)}
            sub={sample.pgFeeVat > 0n ? `공급가 ${formatWon(sample.pgFeeSupply)} + 부가세 ${formatWon(sample.pgFeeVat)}` : '부가세 포함 요율'}
          />
          <StatTile
            label="플랫폼 수수료"
            value={formatWon(sample.platformFee)}
            sub={sample.platformFeeVat > 0n ? `공급가 ${formatWon(sample.platformFeeSupply)} + 부가세 ${formatWon(sample.platformFeeVat)}` : '부가세 포함 요율'}
          />
          <StatTile label="부가세 합계" value={formatWon(sample.vat)} />
          <StatTile label="크리에이터 정산금" value={formatWon(sample.net)} tone="brand" />
        </div>
      </Card>

      <div className="mt-4">
      <Notice tone="warning" title="정책 변경은 과거 거래에 소급되지 않습니다">
        수수료는 결제 승인 시점의 활성 정책으로 계산되어 정산 원장에 확정 기록됩니다. 새 정책을 등록해도 이미 쌓인
        원장 분개는 변경되지 않으며, 정정이 필요하면 조정(ADJUSTMENT) 분개를 사용해야 합니다.
      </Notice>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>새 정책 등록</CardTitle>
          <p className="mt-1 mb-3 text-[12px] leading-relaxed text-ink-400">
            같은 적용 범위의 기존 활성 정책은 자동으로 마감 처리됩니다.
          </p>
          <ActionForm action={createFeePolicy} submitLabel="정책 등록" confirm="새 수수료 정책을 등록하고 기존 정책을 마감합니다.">
            <AdminField label="적용 범위">
              <AdminSelect name="scope" defaultValue="GLOBAL">
                <option value="GLOBAL">전역 (GLOBAL)</option>
                <option value="CREATOR">크리에이터 개별 (CREATOR)</option>
              </AdminSelect>
            </AdminField>
            <AdminField label="크리에이터" hint="적용 범위가 크리에이터일 때만 사용됩니다.">
              <AdminSelect name="creatorId" defaultValue="">
                <CreatorOptions creators={creators} allLabel="선택 안 함" />
              </AdminSelect>
            </AdminField>
            <div className="grid grid-cols-2 gap-2">
              <AdminField label="결제 수수료율" hint="예: 0.018 = 1.8%">
                <AdminInput name="pgFeeRate" defaultValue="0.018" required />
              </AdminField>
              <AdminField label="건당 고정비 (원)">
                <AdminInput name="pgFixedFee" inputMode="numeric" defaultValue="0" required />
              </AdminField>
              <AdminField label="플랫폼 수수료율" hint="예: 0.15 = 15%">
                <AdminInput name="platformFeeRate" defaultValue="0.15" required />
              </AdminField>
              <AdminField label="문자 원가 (원)">
                <AdminInput name="smsCost" inputMode="numeric" defaultValue="0" required />
              </AdminField>
            </div>
            <AdminField label="적용 시작일 (KST)">
              <AdminInput type="date" name="effectiveFrom" defaultValue={kstDateKey()} />
            </AdminField>
            <label className="flex items-center gap-2 text-[13px] text-ink-700">
              <input type="checkbox" name="vatIncluded" defaultChecked className="h-4 w-4 rounded border-ink-300" />
              부가세 포함 요율
            </label>
            <p className="text-[11.5px] leading-relaxed text-ink-400">
              체크하면 위 요율에 부가세가 이미 포함된 것으로 보고 부가세를 추가로 차감하지 않습니다. 체크를 해제하면
              (부가세 별도) 각 수수료의 10%가 부가세로 추가 차감됩니다.
            </p>
          </ActionForm>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="정책 이력" description="활성 정책이 위에 표시됩니다." />
          {policies.length === 0 ? (
            <EmptyState title="등록된 수수료 정책이 없습니다" description="정책이 없으면 코드 기본값(1.8% / 15%)이 적용됩니다." />
          ) : (
            <Table className="min-w-[900px]">
              <thead>
                <tr>
                  <Th>적용 범위</Th>
                  <Th className="text-right">결제 수수료</Th>
                  <Th className="text-right">고정비</Th>
                  <Th className="text-right">플랫폼 수수료</Th>
                  <Th className="text-right">문자 원가</Th>
                  <Th>부가세</Th>
                  <Th>적용 기간</Th>
                  <Th>상태</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      {p.scope === 'GLOBAL' ? (
                        <Badge tone="brand">전역</Badge>
                      ) : p.creator ? (
                        <Link href={`/admin/creators/${p.creator.id}`} className="font-semibold text-brand-700">
                          {p.creator.displayName}
                        </Link>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{ratePercent(p.pgFeeRate.toString())}</Td>
                    <Td className="text-right tabular-nums">{formatWon(p.pgFixedFee)}</Td>
                    <Td className="text-right tabular-nums">{ratePercent(p.platformFeeRate.toString())}</Td>
                    <Td className="text-right tabular-nums">{formatWon(p.smsCost)}</Td>
                    <Td>{p.vatIncluded ? '포함' : '별도'}</Td>
                    <Td className="whitespace-nowrap text-[12px]">
                      {formatKst(p.effectiveFrom, false)}
                      <span className="block text-ink-400">~ {p.effectiveTo ? formatKst(p.effectiveTo, false) : '현재'}</span>
                    </Td>
                    <Td>
                      <Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? '활성' : '마감'}</Badge>
                    </Td>
                    <Td>
                      {p.active ? (
                        <ActionButton
                          action={deactivateFeePolicy}
                          values={{ id: p.id }}
                          label="마감"
                          confirm="이 정책을 마감합니다. 마감 후에는 상위 범위 정책 또는 기본값이 적용됩니다."
                        />
                      ) : (
                        <span className="text-[12px] text-ink-300">-</span>
                      )}
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
