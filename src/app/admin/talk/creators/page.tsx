import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, FilterBar } from '@/components/admin/controls';
import { pctLabel, pctText, won } from '@/components/admin/engage-bits';
import { clearCreatorPolicyAction, saveCreatorPolicyAction } from '@/app/actions/admin/engagement';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { SOURCE_LABEL, getTalkConfig, getVoteConfig, resolveEngagement } from '@/server/services/engagement/config';

export const dynamic = 'force-dynamic';

type Row = Awaited<ReturnType<typeof prisma.creatorEngagementPolicy.findFirst>>;

function PolicyFields({ p, code }: { p: Row; code?: string }) {
  const m = (v: bigint | null | undefined) => (v == null ? '' : v.toString());
  const r = (v: unknown) => (v == null ? '' : pctText(Number(v)));
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-4">
        <AdminField label="크리에이터 코드"><AdminInput name="creatorCode" defaultValue={code ?? ''} required readOnly={Boolean(code)} placeholder="TOR-XXXX" /></AdminField>
        <AdminField label="팬투표 수익 크리에이터 몫(%)"><AdminInput name="voteShareRate" inputMode="decimal" defaultValue={r(p?.voteShareRate)} placeholder="전역" /></AdminField>
        <AdminField label="1:1 채팅 허용">
          <AdminSelect name="sessionAllowed" defaultValue={p?.sessionAllowed == null ? '' : p.sessionAllowed ? 'allow' : 'deny'}>
            <option value="">전역 그대로</option><option value="allow">허용</option><option value="deny">이 크리에이터만 막기</option>
          </AdminSelect>
        </AdminField>
        <AdminField label="메모"><AdminInput name="memo" defaultValue={p?.memo ?? ''} maxLength={200} /></AdminField>
      </div>
      <p className="mt-2 text-[11.5px] font-bold text-ink-600">팬챗 월 구독</p>
      <div className="grid gap-2 sm:grid-cols-5">
        <AdminField label="가격 방식(권한)">
          <AdminSelect name="talkSubPriceMode" defaultValue={p?.talkSubPriceMode ?? ''}><option value="">전역</option><option value="FIXED">관리자 고정</option><option value="CREATOR">크리에이터가 정함</option></AdminSelect>
        </AdminField>
        <AdminField label="고정 가격"><AdminInput name="talkSubPrice" inputMode="numeric" defaultValue={m(p?.talkSubPrice)} placeholder="전역" /></AdminField>
        <AdminField label="최소"><AdminInput name="talkSubPriceMin" inputMode="numeric" defaultValue={m(p?.talkSubPriceMin)} placeholder="전역" /></AdminField>
        <AdminField label="최대"><AdminInput name="talkSubPriceMax" inputMode="numeric" defaultValue={m(p?.talkSubPriceMax)} placeholder="전역" /></AdminField>
        <AdminField label="수수료(%)"><AdminInput name="talkSubFeeRate" inputMode="decimal" defaultValue={r(p?.talkSubFeeRate)} placeholder="전역" /></AdminField>
      </div>
      <p className="mt-2 text-[11.5px] font-bold text-ink-600">1:1 채팅</p>
      <div className="grid gap-2 sm:grid-cols-5">
        <AdminField label="가격 방식(권한)">
          <AdminSelect name="sessionPriceMode" defaultValue={p?.sessionPriceMode ?? ''}><option value="">전역</option><option value="FIXED">관리자 고정</option><option value="CREATOR">크리에이터가 정함</option></AdminSelect>
        </AdminField>
        <AdminField label="고정 가격"><AdminInput name="sessionPrice" inputMode="numeric" defaultValue={m(p?.sessionPrice)} placeholder="전역" /></AdminField>
        <AdminField label="최소"><AdminInput name="sessionPriceMin" inputMode="numeric" defaultValue={m(p?.sessionPriceMin)} placeholder="전역" /></AdminField>
        <AdminField label="최대"><AdminInput name="sessionPriceMax" inputMode="numeric" defaultValue={m(p?.sessionPriceMax)} placeholder="전역" /></AdminField>
        <AdminField label="수수료(%)"><AdminInput name="sessionFeeRate" inputMode="decimal" defaultValue={r(p?.sessionFeeRate)} placeholder="전역" /></AdminField>
      </div>
    </>
  );
}

/** 최고관리자 > 팬챗 관리 > 크리에이터별 요율·권한 (팬투표 수익 몫 · 팬챗/1:1 가격·수수료·가격 권한 · 1:1 허용) */
export default async function AdminCreatorPolicyPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  await requireAdminPage('/admin/talk/creators');
  const code = ((await searchParams).code ?? '').trim().toUpperCase();
  const [vote, talk, policies, target] = await Promise.all([
    getVoteConfig(),
    getTalkConfig(),
    prisma.creatorEngagementPolicy.findMany({ orderBy: { updatedAt: 'desc' }, include: { creator: { select: { code: true, displayName: true, talkRoom: { select: { subPrice: true, sessionPrice: true } } } } } }),
    code ? prisma.creatorProfile.findFirst({ where: { code }, select: { id: true, code: true, displayName: true, engagementPolicy: true } }) : null,
  ]);
  return (
    <div>
      <PageHeader title="크리에이터별 요율·권한" description="여기서 지정한 값이 전역 설정보다 항상 우선합니다. 비워 둔 칸은 전역 값을 따릅니다. 바꾼 값은 이후 결제·팬투표부터 적용됩니다." />
      <Card className="mb-4">
        <CardTitle>전역 기본값</CardTitle>
        <p className="mt-1 text-[12.5px] text-ink-600">
          팬투표 수익 몫 {pctLabel(vote.shareRate)} · 팬챗 구독 {talk.subPriceMode === 'FIXED' ? '관리자 고정' : '크리에이터가 정함'} {won(talk.subPrice)} (범위 {won(talk.subPriceMin)}~{won(talk.subPriceMax)}) 수수료 {pctLabel(talk.subFeeRate)} · 1:1 {talk.sessionPriceMode === 'FIXED' ? '관리자 고정' : '크리에이터가 정함'} {won(talk.sessionPrice)} 수수료 {pctLabel(talk.sessionFeeRate)}
        </p>
      </Card>
      <Card className="mb-4">
        <CardTitle>{target ? `${target.displayName} (${target.code}) 지정` : '크리에이터 지정 추가 · 수정'}</CardTitle>
        <div className="mt-2"><FilterBar action="/admin/talk/creators"><AdminInput name="code" defaultValue={code} placeholder="크리에이터 코드로 불러오기" className="w-56" /></FilterBar></div>
        {code && !target ? <p className="mt-2 text-[12.5px] text-danger-600">크리에이터를 찾을 수 없습니다.</p> : null}
        <ActionForm action={saveCreatorPolicyAction} submitLabel="저장" className="mt-3" confirm="이 크리에이터에게 전역보다 우선 적용됩니다.">
          <PolicyFields p={target?.engagementPolicy ?? null} code={target?.code} />
        </ActionForm>
      </Card>
      <h2 className="mb-2 text-[14px] font-bold text-ink-900">지정된 크리에이터 ({policies.length})</h2>
      <Table>
        <thead><tr><Th>크리에이터</Th><Th>팬투표 몫</Th><Th>팬챗 구독 (실제 판매가)</Th><Th>1:1 (실제 판매가)</Th><Th>1:1 허용</Th><Th>메모</Th><Th>{''}</Th></tr></thead>
        <tbody>
          {policies.map((p) => {
            const e = resolveEngagement(vote, talk, p, p.creator.talkRoom);
            return (
              <tr key={p.id}>
                <Td><a href={`/admin/talk/creators?code=${p.creator.code}`} className="font-bold text-brand-800">{p.creator.displayName}</a> <span className="text-ink-400">{p.creator.code}</span></Td>
                <Td>{pctLabel(e.voteShareRate)} <span className="text-[11px] text-ink-400">{SOURCE_LABEL[e.voteShareSource]}</span></Td>
                <Td>{won(e.talkSub.price)} · {e.talkSub.mode === 'CREATOR' ? '크리에이터 결정' : '고정'} · 수수료 {pctLabel(e.talkSub.feeRate)}</Td>
                <Td>{won(e.session.price)} · {e.session.mode === 'CREATOR' ? '크리에이터 결정' : '고정'} · 수수료 {pctLabel(e.session.feeRate)}</Td>
                <Td>{e.session.allowed ? '허용' : '막힘'}</Td>
                <Td className="max-w-[160px] truncate">{p.memo ?? ''}</Td>
                <Td>
                  <ActionForm action={clearCreatorPolicyAction} submitLabel="지정 해제" variant="ghost" compact confirm="지정을 지우면 전역 값을 따릅니다.">
                    <input type="hidden" name="creatorId" value={p.creatorId} />
                  </ActionForm>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
