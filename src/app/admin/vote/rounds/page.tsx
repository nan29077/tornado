import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { OnOff } from '@/components/admin/engage-bits';
import { createRoundAction, setRoundStatusAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { ROUND_KIND_LABEL, ROUND_STATUS_LABEL } from '@/server/services/vote/rounds';
import { roundRanking } from '@/server/services/vote/ranking';
import { VIDEO_CATEGORIES } from '@/lib/video-hub';
import { ImageUploadField } from '@/components/studio/image-upload-field';

export const dynamic = 'force-dynamic';

/** datetime-local 기본값 (KST) */
function kstInput(d: Date) {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16);
}

/** 최고관리자 > 팬투표 관리 > 왕중왕전 · 이벤트 팬투표 */
export default async function AdminVoteRoundsPage() {
  await requireAdminPage('/admin/vote/rounds');
  const rounds = await prisma.voteRound.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { _count: { select: { candidates: true } } } });
  const tops = await Promise.all(rounds.map((r) => roundRanking(r.id, { limit: 3 })));
  const now = new Date();
  return (
    <div>
      <PageHeader title="왕중왕전 · 이벤트 팬투표" description="왕중왕전은 후보를 비워 두면 지난달 월간 TOP N 이 자동으로 들어갑니다. 회차 팬투표는 일·주·월 랭킹과 따로 집계되고, 종료 시각이 지나면 자동으로 결과가 확정됩니다. 이벤트는 팬투표 [이벤트] 화면에 공개됩니다." />
      <Card className="mb-4">
        <CardTitle>회차 만들기</CardTitle>
        <ActionForm action={createRoundAction} submitLabel="만들기" className="mt-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <AdminField label="종류">
              <AdminSelect name="kind" defaultValue="CHAMPION"><option value="CHAMPION">왕중왕전</option><option value="EVENT">이벤트 팬투표</option></AdminSelect>
            </AdminField>
            <AdminField label="제목" className="sm:col-span-2"><AdminInput name="title" required maxLength={60} placeholder="2026년 11월 왕중왕전" /></AdminField>
            <AdminField label="시작 (KST)"><AdminInput type="datetime-local" name="startsAt" defaultValue={kstInput(now)} required /></AdminField>
            <AdminField label="종료 (KST)"><AdminInput type="datetime-local" name="endsAt" defaultValue={kstInput(new Date(now.getTime() + 7 * 86_400_000))} required /></AdminField>
            <AdminField label="자동 후보 수 (코드 비울 때)"><AdminInput name="topN" inputMode="numeric" defaultValue={10} /></AdminField>
            <AdminField label="카테고리 왕중왕전 (선택)" hint="고르면 그 카테고리의 지난달 상위 N명이 자동 후보가 됩니다">
              <AdminSelect name="category" defaultValue="">
                <option value="">전체 카테고리</option>
                {VIDEO_CATEGORIES.filter((c) => c.slug !== 'all' && c.slug !== 'donaido').map((c) => (
                  <option key={c.slug} value={c.slug}>{c.label}</option>
                ))}
              </AdminSelect>
            </AdminField>
            <AdminField label="후보 코드 (쉼표 · 줄바꿈)" className="sm:col-span-3" hint="이벤트 팬투표는 반드시 입력"><AdminTextarea name="codes" rows={2} placeholder="TOR-ABCD, TOR-EFGH" /></AdminField>
            <AdminField label="설명" className="sm:col-span-2"><AdminInput name="description" maxLength={300} placeholder="우승자는 12월 메인 배너에 노출됩니다" /></AdminField>
            <AdminField label="1인 하루 최대 표 (0=제한 없음)"><AdminInput name="dailyMaxVotes" inputMode="numeric" defaultValue={0} /></AdminField>
            <AdminField label="보상 안내 (이벤트 화면에 크게 표시)" className="sm:col-span-2" hint="예) 1위 신문 광고 · 2~3위 메인 배너. 실제 보상 집행은 [순위 보상]의 이벤트 보상 정책으로 기록됩니다"><AdminInput name="rewardText" maxLength={120} /></AdminField>
            <div className="sm:col-span-3"><ImageUploadField name="bannerUrl" label="이벤트 배너 (선택)" aspect="wide" uploadOnly /></div>
            <AdminField label="바로 열기">
              <OnOff name="openNow" value onLabel="바로 열기" offLabel="준비 상태로" />
            </AdminField>
          </div>
        </ActionForm>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        {rounds.map((r, i) => (
          <Card key={r.id}>
            <CardTitle>
              {r.title} <Badge tone={r.status === 'OPEN' ? 'success' : r.status === 'CLOSED' ? 'neutral' : 'warning'}>{ROUND_STATUS_LABEL[r.status]}</Badge> <Badge>{ROUND_KIND_LABEL[r.kind]}</Badge>
            </CardTitle>
            <p className="mt-1 text-[12px] text-ink-500">{formatKst(r.startsAt, false)} ~ {formatKst(r.endsAt, false)} · 후보 {r._count.candidates}명</p>
            <ol className="mt-2 space-y-0.5 text-[12.5px]">
              {tops[i].map((t) => <li key={t.creatorId}>{t.rank}위 {t.displayName} · {t.votes.toLocaleString('ko-KR')}표</li>)}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              {r.status === 'DRAFT' ? (
                <ActionForm action={setRoundStatusAction} submitLabel="열기" compact>
                  <input type="hidden" name="roundId" value={r.id} /><input type="hidden" name="status" value="OPEN" />
                </ActionForm>
              ) : null}
              {r.status !== 'CLOSED' ? (
                <ActionForm action={setRoundStatusAction} submitLabel="종료 · 결과 확정" variant="danger" compact confirm="종료하면 다시 열 수 없고 결과가 확정됩니다.">
                  <input type="hidden" name="roundId" value={r.id} /><input type="hidden" name="status" value="CLOSED" />
                </ActionForm>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
