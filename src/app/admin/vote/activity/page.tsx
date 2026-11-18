import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { SwitchField } from '@/components/admin/switch';
import { deleteCheerAdminAction, saveFanvoteExtrasAction } from '@/app/actions/admin/engagement';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { getVoteConfig, MISSION_KEYS } from '@/server/services/engagement/config';
import { listCheers, MISSION_META } from '@/server/services/vote/fan';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 팬투표 관리 > 출석 · 미션 · 초대 · 응원 (2026-11-18) */
export default async function AdminVoteActivityPage() {
  await requireAdminPage('/admin/vote/activity');
  const today = kstStartOfDay(new Date());
  const [cfg, att, missions, referrals, cheers, recentCheers] = await Promise.all([
    getVoteConfig(),
    prisma.voteAttendance.count({ where: { createdAt: { gte: today } } }),
    prisma.voteMissionClaim.count({ where: { createdAt: { gte: today } } }),
    prisma.voteReferral.count({ where: { status: 'REWARDED' } }),
    prisma.voteCheer.count({ where: { createdAt: { gte: today }, deletedAt: null } }),
    listCheers({ limit: 30 }),
  ]);
  return (
    <div>
      <PageHeader title="출석 · 미션 · 초대 · 응원" description="무료 팬투표권을 주는 팬 활동(출석 체크 · 일일 미션 · 친구 초대)과 응원 댓글 · 서포트 기본값을 정합니다. 지급되는 팬투표권은 모두 무료 팬투표권(유효기간 = 무료 팬투표권 유효기간)입니다." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="오늘 출석" value={`${att.toLocaleString('ko-KR')}명`} tone="brand" />
        <StatTile label="오늘 미션 보상" value={`${missions.toLocaleString('ko-KR')}건`} />
        <StatTile label="보상된 친구 초대" value={`${referrals.toLocaleString('ko-KR')}건`} />
        <StatTile label="오늘 응원 댓글" value={`${cheers.toLocaleString('ko-KR')}개`} />
      </div>
      <Card className="mt-4">
        <CardTitle>팬 활동 설정</CardTitle>
        <ActionForm action={saveFanvoteExtrasAction} submitLabel="저장" className="mt-2" confirm="바로 적용됩니다.">
          <p className="mb-1.5 text-[11.5px] font-extrabold text-ink-400">출석 체크</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <SwitchField label="출석 체크" hint="하루 1번 무료 팬투표권" name="attendanceEnabled" value={cfg.attendanceEnabled} />
            <AdminField label="출석 1회 지급 수"><AdminInput name="attendanceTickets" inputMode="numeric" defaultValue={cfg.attendanceTickets} /></AdminField>
            <AdminField label="연속 출석 보너스 (일수:보너스)" hint="예) 7:10, 30:50 → 7일마다 +10, 30일마다 +50">
              <AdminInput name="attendanceStreakBonus" defaultValue={cfg.attendanceStreakBonus.map((b) => `${b.days}:${b.bonus}`).join(', ')} />
            </AdminField>
          </div>
          <p className="mb-1.5 mt-4 text-[11.5px] font-extrabold text-ink-400">일일 미션 (지급 수 0 = 그 미션 끔)</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <SwitchField label="일일 미션" hint="매일 자정에 새로 시작" name="missionsEnabled" value={cfg.missionsEnabled} />
            {MISSION_KEYS.map((k) => (
              <AdminField key={k} label={MISSION_META[k].title} hint={MISSION_META[k].desc}>
                <AdminInput name={`mission_${k}`} inputMode="numeric" defaultValue={cfg.missionTickets[k] ?? 0} />
              </AdminField>
            ))}
          </div>
          <p className="mb-1.5 mt-4 text-[11.5px] font-extrabold text-ink-400">친구 초대</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <SwitchField label="친구 초대" hint="초대 코드 입력 · 첫 팬투표 보상" name="referralEnabled" value={cfg.referralEnabled} />
            <AdminField label="초대한 회원 보상" hint="친구가 첫 팬투표를 하면"><AdminInput name="referralInviterTickets" inputMode="numeric" defaultValue={cfg.referralInviterTickets} /></AdminField>
            <AdminField label="초대받은 회원 보상" hint="코드 입력 즉시"><AdminInput name="referralInviteeTickets" inputMode="numeric" defaultValue={cfg.referralInviteeTickets} /></AdminField>
            <AdminField label="가입 후 코드 입력 가능 기간(일)"><AdminInput name="referralCodeDays" inputMode="numeric" defaultValue={cfg.referralCodeDays} /></AdminField>
            <AdminField label="1명당 최대 초대 보상 (0=제한 없음)"><AdminInput name="referralMaxPerInviter" inputMode="numeric" defaultValue={cfg.referralMaxPerInviter} /></AdminField>
          </div>
          <p className="mb-1.5 mt-4 text-[11.5px] font-extrabold text-ink-400">응원 댓글 · 서포트</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <SwitchField label="응원 댓글" name="cheerEnabled" value={cfg.cheerEnabled} />
            <AdminField label="회원 하루 응원 댓글 수"><AdminInput name="cheerDailyLimit" inputMode="numeric" defaultValue={cfg.cheerDailyLimit} /></AdminField>
            <AdminField label="응원 댓글 최대 글자"><AdminInput name="cheerMaxLength" inputMode="numeric" defaultValue={cfg.cheerMaxLength} /></AdminField>
            <SwitchField label="서포트" hint="팬투표권 모아 광고 열기" name="supportEnabled" value={cfg.supportEnabled} />
            <AdminField label="서포트 1회 최소 참여"><AdminInput name="supportMinTickets" inputMode="numeric" defaultValue={cfg.supportMinTickets} /></AdminField>
          </div>
        </ActionForm>
      </Card>
      <Card className="mt-4">
        <CardTitle>최근 응원 댓글</CardTitle>
        {recentCheers.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">아직 응원 댓글이 없습니다.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-100">
            {recentCheers.map((c) => (
              <li key={c.id} className="flex items-start gap-2 py-2 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="text-[11.5px] text-ink-400">
                    <b className="text-ink-700">{c.name}</b> → {c.creatorName} ({c.creatorCode}) · {formatKst(c.createdAt, false).slice(5, 16)}
                  </p>
                  <p className="break-words text-ink-800">{c.body}</p>
                </div>
                <ActionForm action={deleteCheerAdminAction} submitLabel="삭제" variant="danger" compact confirm="이 응원 댓글을 삭제할까요?">
                  <input type="hidden" name="cheerId" value={c.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
