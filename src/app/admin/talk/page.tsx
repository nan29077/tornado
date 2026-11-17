import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { OnOff, pctLabel, pctText, won } from '@/components/admin/engage-bits';
import { saveTalkPricingAction, saveTalkSettingsAction, setSessionSwitchAction } from '@/app/actions/admin/engagement';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { getTalkConfig } from '@/server/services/engagement/config';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 소통 관리 > 소통 설정 (★ 1:1 채팅 스위치 포함) */
export default async function AdminTalkPage() {
  await requireAdminPage('/admin/talk');
  const now = new Date();
  const [cfg, rooms, subs, pending, overrides] = await Promise.all([
    getTalkConfig(),
    prisma.talkRoom.count({ where: { open: true } }),
    prisma.talkSubscription.findMany({ where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } }, distinct: ['userId', 'creatorId'], select: { id: true } }),
    prisma.talkSession.count({ where: { status: { in: ['REQUESTED', 'ACCEPTED'] }, startsAt: { gt: now } } }),
    prisma.creatorEngagementPolicy.count(),
  ]);

  return (
    <div>
      <PageHeader title="소통 설정" description="크리에이터별 소통방(월 구독)과 1:1 예약 채팅을 관리합니다. 크리에이터별로 지정한 가격 · 수수료 · 권한이 전역 값보다 우선합니다." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="열린 소통방" value={`${rooms}개`} tone="brand" />
        <StatTile label="이용 중 구독" value={`${subs.length.toLocaleString('ko-KR')}건`} />
        <StatTile label="시작 전 1:1 예약" value={`${pending}건`} />
        <StatTile label="크리에이터별 지정" value={`${overrides}명`} sub="요율·가격·권한" />
      </div>

      <Card className="mt-4 border-2 border-ink-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>1:1 채팅 {cfg.sessionEnabled ? <Badge tone="success">켜짐</Badge> : <Badge tone="danger">꺼짐</Badge>}</CardTitle>
            <p className="mt-1 text-[12.5px] text-ink-500">끄면 1:1 채팅이 크리에이터 샵 · 소통 화면 · 마이페이지 · 스튜디오 어디에도 보이지 않고, 서버도 신청 · 수락 · 대화를 모두 거절합니다.</p>
          </div>
          {cfg.sessionEnabled ? (
            <ActionForm action={setSessionSwitchAction} submitLabel="1:1 채팅 끄기" variant="danger" confirm="1:1 채팅을 끌까요? 모든 화면에서 사라집니다.">
              <input type="hidden" name="enable" value="0" />
              <AdminField label={`시작 전 예약 ${pending}건 처리`}>
                <AdminSelect name="pending" defaultValue="keep">
                  <option value="keep">그대로 두기 (나중에 예약 관리에서 처리)</option>
                  <option value="cancel">전부 취소 · 전액 환불</option>
                </AdminSelect>
              </AdminField>
            </ActionForm>
          ) : (
            <ActionForm action={setSessionSwitchAction} submitLabel="1:1 채팅 켜기" confirm="1:1 채팅을 켜면 모든 크리에이터 화면에 노출됩니다. (크리에이터가 신청 받기를 켜야 팬이 신청할 수 있습니다)">
              <input type="hidden" name="enable" value="1" />
            </ActionForm>
          )}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>운영 설정</CardTitle>
          <ActionForm action={saveTalkSettingsAction} submitLabel="저장" className="mt-2" confirm="바로 적용됩니다.">
            <div className="grid gap-2 sm:grid-cols-2">
              <AdminField label="소통 기능"><OnOff name="enabled" value={cfg.enabled} /></AdminField>
              <AdminField label="소통방 방식">
                <AdminSelect name="roomMode" defaultValue={cfg.roomMode}>
                  <option value="GROUP">1:N 단체방 (구독자끼리도 보임)</option>
                  <option value="BUBBLE">버블형 (팬 메시지는 크리에이터만)</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="구독 1회 기간(일)"><AdminInput name="subPeriodDays" inputMode="numeric" defaultValue={cfg.subPeriodDays} /></AdminField>
              <AdminField label="구독 환불 안내 기간(일)"><AdminInput name="subRefundDays" inputMode="numeric" defaultValue={cfg.subRefundDays} /></AdminField>
              <AdminField label="팬 하루 최대 메시지 (0=제한 없음)"><AdminInput name="fanReplyDailyLimit" inputMode="numeric" defaultValue={cfg.fanReplyDailyLimit} /></AdminField>
              <AdminField label="팬 메시지 최대 글자"><AdminInput name="fanReplyMaxLength" inputMode="numeric" defaultValue={cfg.fanReplyMaxLength} /></AdminField>
              <AdminField label="1:1 1회 시간 선택지(분, 쉼표)"><AdminInput name="sessionMinutesOptions" defaultValue={cfg.sessionMinutesOptions.join(', ')} /></AdminField>
              <AdminField label="1:1 승인 기한(시간)"><AdminInput name="sessionApprovalHours" inputMode="numeric" defaultValue={cfg.sessionApprovalHours} /></AdminField>
              <AdminField label="1:1 최소 신청 시간(몇 시간 뒤부터)"><AdminInput name="sessionLeadHours" inputMode="numeric" defaultValue={cfg.sessionLeadHours} /></AdminField>
              <AdminField label="1:1 일정표 공개 기간(일)"><AdminInput name="sessionBookDays" inputMode="numeric" defaultValue={cfg.sessionBookDays} /></AdminField>
              <AdminField label="전액 환불 기준(시작 N시간 전)"><AdminInput name="sessionFullRefundHours" inputMode="numeric" defaultValue={cfg.sessionFullRefundHours} /></AdminField>
              <AdminField label="그 이후 취소 환불 비율(%)"><AdminInput name="sessionLateRefundRate" inputMode="decimal" defaultValue={pctText(cfg.sessionLateRefundRate)} /></AdminField>
              <AdminField label="크리에이터 불참 판정(분)"><AdminInput name="sessionNoShowMinutes" inputMode="numeric" defaultValue={cfg.sessionNoShowMinutes} /></AdminField>
              <AdminField label="1:1 성인 인증 회원만"><OnOff name="sessionRequireAdult" value={cfg.sessionRequireAdult} onLabel="예" offLabel="아니오" /></AdminField>
            </div>
          </ActionForm>
        </Card>

        <Card>
          <CardTitle>가격 · 플랫폼 수수료 (전역)</CardTitle>
          <p className="mt-1 text-[12px] text-ink-500">
            기본은 관리자 고정 가격입니다. 크리에이터가 정함으로 바꾸면 크리에이터가 최소~최대 범위 안에서 정합니다. 크리에이터마다 다르게 하려면{' '}
            <Link href="/admin/talk/creators" className="font-bold text-brand-800">크리에이터별 요율·권한</Link>에서 지정하세요(그 값이 우선).
          </p>
          <p className="mt-2 text-[12.5px] text-ink-700">현재: 구독 {won(cfg.subPrice)} · 수수료 {pctLabel(cfg.subFeeRate)} / 1:1 {won(cfg.sessionPrice)} · 수수료 {pctLabel(cfg.sessionFeeRate)}</p>
          <ActionForm action={saveTalkPricingAction} submitLabel="저장" className="mt-2" confirm="이후 결제부터 적용됩니다.">
            <p className="text-[12px] font-bold text-ink-700">소통 월 구독</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <AdminField label="가격 방식">
                <AdminSelect name="subPriceMode" defaultValue={cfg.subPriceMode}><option value="FIXED">관리자 고정</option><option value="CREATOR">크리에이터가 정함</option></AdminSelect>
              </AdminField>
              <AdminField label="기본(고정) 가격"><AdminInput name="subPrice" inputMode="numeric" defaultValue={cfg.subPrice} /></AdminField>
              <AdminField label="플랫폼 수수료(%)"><AdminInput name="subFeeRate" inputMode="decimal" defaultValue={pctText(cfg.subFeeRate)} /></AdminField>
              <AdminField label="최소 가격"><AdminInput name="subPriceMin" inputMode="numeric" defaultValue={cfg.subPriceMin} /></AdminField>
              <AdminField label="최대 가격"><AdminInput name="subPriceMax" inputMode="numeric" defaultValue={cfg.subPriceMax} /></AdminField>
            </div>
            <p className="mt-2 text-[12px] font-bold text-ink-700">1:1 채팅 (1회)</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <AdminField label="가격 방식">
                <AdminSelect name="sessionPriceMode" defaultValue={cfg.sessionPriceMode}><option value="FIXED">관리자 고정</option><option value="CREATOR">크리에이터가 정함</option></AdminSelect>
              </AdminField>
              <AdminField label="기본(고정) 가격"><AdminInput name="sessionPrice" inputMode="numeric" defaultValue={cfg.sessionPrice} /></AdminField>
              <AdminField label="플랫폼 수수료(%)"><AdminInput name="sessionFeeRate" inputMode="decimal" defaultValue={pctText(cfg.sessionFeeRate)} /></AdminField>
              <AdminField label="최소 가격"><AdminInput name="sessionPriceMin" inputMode="numeric" defaultValue={cfg.sessionPriceMin} /></AdminField>
              <AdminField label="최대 가격"><AdminInput name="sessionPriceMax" inputMode="numeric" defaultValue={cfg.sessionPriceMax} /></AdminField>
            </div>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
