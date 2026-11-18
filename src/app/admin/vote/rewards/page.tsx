import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { createManualGrantAction, createRewardPolicyAction, rewardPolicyOpAction, updateRewardGrantAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { GRANT_STATUS_LABEL, listRewardGrants, listRewardPolicies, REWARD_TYPE_LABEL, REWARD_TYPES } from '@/server/services/vote/rewards';
import { cx } from '@/components/ui';

export const dynamic = 'force-dynamic';

const PERIOD_LABEL: Record<string, string> = { DAY: '일간', WEEK: '주간', MONTH: '월간' };

function kstDate(d: Date | null) {
  return d ? new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10) : '';
}

/** 최고관리자 > 팬투표 관리 > 순위 보상 (신문 광고 등) (2026-11-18) */
export default async function AdminVoteRewardsPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  await requireAdminPage('/admin/vote/rewards');
  const sp = await searchParams;
  const status = sp.s && ['PENDING', 'SCHEDULED', 'PUBLISHED', 'CANCELLED'].includes(sp.s) ? sp.s : null;
  const [policies, grants, counts, rounds] = await Promise.all([
    listRewardPolicies(),
    listRewardGrants({ status, limit: 80 }),
    prisma.voteRewardGrant.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.voteRound.findMany({ where: { status: { in: ['DRAFT', 'OPEN'] } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, title: true } }),
  ]);
  const count = (k: string) => counts.find((c) => c.status === k)?._count._all ?? 0;
  return (
    <div>
      <PageHeader
        title="순위 보상 (신문 광고 등)"
        description="보상 정책을 정해 두면 일간 · 주간 · 월간 순위가 확정되거나 이벤트가 끝날 때 해당 순위 크리에이터의 보상 집행 기록이 자동으로 생깁니다. 광고 매체 계약 · 결제는 이 시스템 밖에서 진행하고, 여기서는 진행 상황과 인증 사진을 기록해 팬투표 [보상] 화면에 공개합니다."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="준비 중" value={`${count('PENDING')}건`} tone={count('PENDING') > 0 ? 'warning' : 'neutral'} />
        <StatTile label="집행 예정" value={`${count('SCHEDULED')}건`} />
        <StatTile label="집행 완료" value={`${count('PUBLISHED')}건`} tone="brand" />
        <StatTile label="보상 정책" value={`${policies.filter((p) => p.active).length}개`} sub={`전체 ${policies.length}개`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>보상 정책 추가</CardTitle>
          <ActionForm action={createRewardPolicyAction} submitLabel="추가" className="mt-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <AdminField label="대상">
                <AdminSelect name="scope" defaultValue="PERIOD">
                  <option value="PERIOD">기간 랭킹 (일간 · 주간 · 월간)</option>
                  <option value="ROUND">이벤트 · 왕중왕전 결과</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="기간 (기간 랭킹일 때)">
                <AdminSelect name="periodType" defaultValue="MONTH">
                  <option value="MONTH">월간</option>
                  <option value="WEEK">주간</option>
                  <option value="DAY">일간</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="이벤트 (이벤트일 때 · 비우면 모든 이벤트)">
                <AdminSelect name="roundId" defaultValue="">
                  <option value="">모든 이벤트 · 왕중왕전</option>
                  {rounds.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
              <AdminField label="보상 종류">
                <AdminSelect name="rewardType" defaultValue="NEWSPAPER">
                  {REWARD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {REWARD_TYPE_LABEL[t]}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
              <AdminField label="시작 순위"><AdminInput name="rankFrom" inputMode="numeric" defaultValue={1} /></AdminField>
              <AdminField label="끝 순위"><AdminInput name="rankTo" inputMode="numeric" defaultValue={1} /></AdminField>
              <AdminField label="보상 이름" className="sm:col-span-2"><AdminInput name="title" required maxLength={60} placeholder="일간지 전면 축하 광고" /></AdminField>
              <AdminField label="설명 (선택)" className="sm:col-span-2"><AdminTextarea name="description" rows={2} maxLength={300} placeholder="확정 후 2주 안에 집행합니다" /></AdminField>
            </div>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle>보상 정책</CardTitle>
          {policies.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-500">아직 보상 정책이 없습니다.</p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-100">
              {policies.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <b>{p.scope === 'PERIOD' ? `${PERIOD_LABEL[p.periodType ?? ''] ?? ''} 랭킹` : p.roundId ? `이벤트(${rounds.find((r) => r.id === p.roundId)?.title ?? '지정'})` : '모든 이벤트'}</b> {p.rankFrom === p.rankTo ? `${p.rankFrom}위` : `${p.rankFrom}~${p.rankTo}위`} → {p.title}{' '}
                    <span className="text-ink-400">({REWARD_TYPE_LABEL[p.rewardType]})</span>
                  </span>
                  <Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? '사용' : '꺼짐'}</Badge>
                  <ActionForm action={rewardPolicyOpAction} submitLabel={p.active ? '끄기' : '켜기'} compact variant="secondary">
                    <input type="hidden" name="policyId" value={p.id} />
                    <input type="hidden" name="op" value={p.active ? 'off' : 'on'} />
                  </ActionForm>
                  <ActionForm action={rewardPolicyOpAction} submitLabel="삭제" compact variant="danger" confirm="보상 정책을 삭제할까요? 이미 생긴 보상 기록은 남습니다.">
                    <input type="hidden" name="policyId" value={p.id} />
                    <input type="hidden" name="op" value="delete" />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-3 rounded-xl bg-ink-50 px-3 py-2">
            <summary className="cursor-pointer text-[12.5px] font-bold text-ink-600">특별 보상 직접 추가</summary>
            <ActionForm action={createManualGrantAction} submitLabel="추가" className="mt-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <AdminField label="크리에이터 코드"><AdminInput name="code" required placeholder="TOR-ABCD" /></AdminField>
                <AdminField label="보상 종류">
                  <AdminSelect name="rewardType" defaultValue="BIRTHDAY_AD">
                    {REWARD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {REWARD_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </AdminSelect>
                </AdminField>
                <AdminField label="보상 이름"><AdminInput name="title" required maxLength={60} /></AdminField>
                <AdminField label="사유 (화면 표시)"><AdminInput name="sourceLabel" maxLength={60} placeholder="생일 기념" /></AdminField>
              </div>
            </ActionForm>
          </details>
        </Card>
      </div>

      <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-black text-ink-900">보상 집행 기록</h2>
        <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5 text-[12px] font-bold">
          {[{ k: '', l: '전체' }, { k: 'PENDING', l: '준비 중' }, { k: 'SCHEDULED', l: '집행 예정' }, { k: 'PUBLISHED', l: '집행 완료' }, { k: 'CANCELLED', l: '취소' }].map((t) => (
            <Link key={t.k} href={t.k ? `/admin/vote/rewards?s=${t.k}` : '/admin/vote/rewards'} className={cx('rounded-md px-2 py-1', (status ?? '') === t.k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500')}>
              {t.l}
            </Link>
          ))}
        </div>
      </div>
      {grants.length === 0 ? (
        <Card>
          <p className="text-[13px] text-ink-500">보상 기록이 없습니다.</p>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {grants.map((g) => (
            <Card key={g.id}>
              <CardTitle>
                {g.creator?.displayName ?? '크리에이터'} <Badge tone={g.status === 'PUBLISHED' ? 'success' : g.status === 'CANCELLED' ? 'neutral' : 'warning'}>{GRANT_STATUS_LABEL[g.status]}</Badge>
              </CardTitle>
              <p className="mt-1 text-[12.5px] text-ink-600">
                {g.sourceLabel}
                {g.rank ? ` ${g.rank}위` : ''} · <b>{g.title}</b> ({REWARD_TYPE_LABEL[g.rewardType]}) · 생성 {formatKst(g.createdAt, false).slice(0, 10)}
              </p>
              <ActionForm action={updateRewardGrantAction} submitLabel="저장" className="mt-2">
                <input type="hidden" name="grantId" value={g.id} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <AdminField label="진행 상태">
                    <AdminSelect name="status" defaultValue={g.status}>
                      <option value="PENDING">준비 중</option>
                      <option value="SCHEDULED">집행 예정</option>
                      <option value="PUBLISHED">집행 완료</option>
                      <option value="CANCELLED">취소</option>
                    </AdminSelect>
                  </AdminField>
                  <AdminField label="매체 · 장소"><AdminInput name="mediaName" defaultValue={g.mediaName ?? ''} maxLength={60} placeholder="○○일보 · 강남역" /></AdminField>
                  <AdminField label="집행 예정일"><AdminInput type="date" name="scheduledAt" defaultValue={kstDate(g.scheduledAt)} /></AdminField>
                  <AdminField label="집행일"><AdminInput type="date" name="publishedAt" defaultValue={kstDate(g.publishedAt)} /></AdminField>
                  <AdminField label="메모 (공개)" className="sm:col-span-2"><AdminInput name="note" defaultValue={g.note ?? ''} maxLength={300} /></AdminField>
                  <div className="sm:col-span-2">
                    <ImageUploadField name="proofImageUrl" label="인증 사진" aspect="wide" uploadOnly defaultValue={g.proofImageUrl ?? ''} />
                  </div>
                </div>
              </ActionForm>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
