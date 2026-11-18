import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect, AdminTextarea } from '@/components/admin/controls';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { cancelSupportAction, createSupportAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { listSupports, SUPPORT_STATUS_LABEL } from '@/server/services/vote/support';
import { REWARD_TYPE_LABEL, REWARD_TYPES } from '@/server/services/vote/rewards';

export const dynamic = 'force-dynamic';

function kstInput(d: Date) {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16);
}

/** 최고관리자 > 팬투표 관리 > 서포트 (2026-11-18) */
export default async function AdminVoteSupportPage() {
  await requireAdminPage('/admin/vote/support');
  const list = await listSupports({ status: 'ALL', limit: 60 });
  const now = new Date();
  return (
    <div>
      <PageHeader title="서포트" description="팬들이 팬투표권을 모아 크리에이터 광고(신문 · 전광판 등)를 엽니다. 목표를 채우면 [순위 보상]에 집행 기록이 생기고, 기간 안에 못 채우거나 취소하면 참여한 팬투표권을 같은 종류로 모두 돌려줍니다." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="진행 중" value={`${list.filter((s) => s.status === 'OPEN').length}개`} tone="brand" />
        <StatTile label="성공" value={`${list.filter((s) => s.status === 'SUCCESS').length}개`} />
        <StatTile label="목표 미달" value={`${list.filter((s) => s.status === 'FAILED').length}개`} />
        <StatTile label="모인 팬투표권" value={`${list.reduce((a, s) => a + (s.status === 'FAILED' || s.status === 'CANCELLED' ? 0 : s.raisedTickets), 0).toLocaleString('ko-KR')}개`} />
      </div>
      <Card className="mt-4">
        <CardTitle>서포트 열기</CardTitle>
        <ActionForm action={createSupportAction} submitLabel="열기" className="mt-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <AdminField label="크리에이터 코드"><AdminInput name="code" required placeholder="TOR-ABCD" /></AdminField>
            <AdminField label="광고 종류">
              <AdminSelect name="rewardType" defaultValue="NEWSPAPER">
                {REWARD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {REWARD_TYPE_LABEL[t]}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
            <AdminField label="목표 팬투표권"><AdminInput name="goalTickets" inputMode="numeric" defaultValue={100000} /></AdminField>
            <AdminField label="제목" className="sm:col-span-3"><AdminInput name="title" required maxLength={60} placeholder="○○님 생일 축하 신문 광고" /></AdminField>
            <AdminField label="시작 (KST)"><AdminInput type="datetime-local" name="startsAt" defaultValue={kstInput(now)} required /></AdminField>
            <AdminField label="종료 (KST)"><AdminInput type="datetime-local" name="endsAt" defaultValue={kstInput(new Date(now.getTime() + 14 * 86_400_000))} required /></AdminField>
            <div />
            <AdminField label="설명" className="sm:col-span-3"><AdminTextarea name="description" rows={3} maxLength={500} placeholder="목표를 채우면 ○○일보에 축하 광고가 실립니다." /></AdminField>
            <div className="sm:col-span-3"><ImageUploadField name="bannerUrl" label="배너 (선택)" aspect="wide" uploadOnly /></div>
          </div>
        </ActionForm>
      </Card>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {list.map((s) => (
          <Card key={s.id}>
            <CardTitle>
              {s.title} <Badge tone={s.status === 'OPEN' ? 'success' : s.status === 'SUCCESS' ? 'brand' : 'neutral'}>{SUPPORT_STATUS_LABEL[s.status]}</Badge>
            </CardTitle>
            <p className="mt-1 text-[12.5px] text-ink-600">
              {s.creator?.displayName} · {REWARD_TYPE_LABEL[s.rewardType]} · {formatKst(s.startsAt, false).slice(0, 16)} ~ {formatKst(s.endsAt, false).slice(0, 16)}
            </p>
            <p className="mt-1 text-[13px] font-bold tabular-nums text-ink-800">
              {s.raisedTickets.toLocaleString('ko-KR')} / {s.goalTickets.toLocaleString('ko-KR')} ({Math.min(100, Math.round((s.raisedTickets / s.goalTickets) * 100))}%) · 참여 {s.participantCount}명
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/vote/support/${s.id}`} target="_blank" className="text-[12.5px] font-bold text-brand-800">
                공개 화면
              </Link>
              {s.status === 'SUCCESS' ? (
                <Link href="/admin/vote/rewards" className="text-[12.5px] font-bold text-brand-800">
                  집행 기록하기
                </Link>
              ) : null}
            </div>
            {s.status === 'OPEN' ? (
              <ActionForm action={cancelSupportAction} submitLabel="취소 · 전액 반환" variant="danger" compact className="mt-2" confirm="서포트를 취소하고 참여한 팬투표권을 모두 돌려줄까요?">
                <input type="hidden" name="supportId" value={s.id} />
                <AdminField label="취소 사유"><AdminInput name="reason" maxLength={100} /></AdminField>
              </ActionForm>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
