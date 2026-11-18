import { requestNowMs } from '@/lib/vote-period';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { SwitchField } from '@/components/admin/switch';
import { saveFanchatAdvancedAction } from '@/app/actions/admin/engagement';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { getTalkConfig } from '@/server/services/engagement/config';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 팬챗 관리 > 버블형 · 팬레터 · 묶음 구독 (2026-11-18) */
export default async function AdminTalkAdvancedPage() {
  await requireAdminPage('/admin/talk/advanced');
  const since = new Date(requestNowMs() - 30 * 86_400_000);
  const [cfg, letters, bundles, reactions, voice] = await Promise.all([
    getTalkConfig(),
    prisma.talkLetter.count({ where: { createdAt: { gte: since } } }),
    prisma.talkBundleOrder.count({ where: { status: 'PAID', createdAt: { gte: since } } }),
    prisma.talkReaction.count({ where: { createdAt: { gte: since } } }),
    prisma.talkMessage.count({ where: { mediaType: { not: null }, createdAt: { gte: since } } }),
  ]);
  return (
    <div>
      <PageHeader title="버블형 · 팬레터 · 묶음 구독" description="팬챗(버블형)의 답장 규칙 · 구독 일수별 글자 수 · 팬레터 · 묶음 구독 할인 · 음성 메시지 길이를 정합니다." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="최근 30일 팬레터" value={`${letters.toLocaleString('ko-KR')}통`} tone="brand" />
        <StatTile label="최근 30일 묶음 구독" value={`${bundles.toLocaleString('ko-KR')}건`} />
        <StatTile label="최근 30일 팬 하트" value={`${reactions.toLocaleString('ko-KR')}개`} />
        <StatTile label="최근 30일 음성·영상" value={`${voice.toLocaleString('ko-KR')}개`} />
      </div>
      <Card className="mt-4">
        <CardTitle>팬챗 고급 설정</CardTitle>
        <ActionForm action={saveFanchatAdvancedAction} submitLabel="저장" className="mt-2" confirm="바로 적용됩니다.">
          <p className="mb-1.5 text-[11.5px] font-extrabold text-ink-400">답장 규칙 (버블형)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <AdminField label="크리에이터 메시지 1개당 답장 수 (0=제한 없음)" hint="새 메시지가 오면 다시 채워집니다">
              <AdminInput name="replyPerMessage" inputMode="numeric" defaultValue={cfg.replyPerMessage} />
            </AdminField>
            <AdminField label="구독 일수별 답장 글자 수 (일수:글자)" hint={`예) 0:50, 14:80, 100:200 · 최대 ${cfg.fanReplyMaxLength}자(팬챗 설정의 팬 메시지 최대 글자)`}>
              <AdminInput name="replyLengthTiers" defaultValue={cfg.replyLengthTiers.map((t) => `${t.days}:${t.length}`).join(', ')} />
            </AdminField>
            <AdminField label="구독 기념일 (D+, 쉼표로)" hint="이날 팬챗방에 축하 문구가 떠요">
              <AdminInput name="dayMilestones" defaultValue={cfg.dayMilestones.join(', ')} />
            </AdminField>
            <AdminField label="음성 메시지 최대 길이(초)">
              <AdminInput name="voiceMaxSeconds" inputMode="numeric" defaultValue={cfg.voiceMaxSeconds} />
            </AdminField>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <SwitchField label="새 메시지 알림" hint="크리에이터가 메시지를 보내면(예약 포함) 구독자에게 알림" name="notifyOnBroadcast" value={cfg.notifyOnBroadcast} />
          </div>

          <p className="mb-1.5 mt-4 text-[11.5px] font-extrabold text-ink-400">팬레터</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <SwitchField label="팬레터 받기" hint="구독자가 크리에이터에게 편지를 보냅니다" name="letterEnabled" value={cfg.letterEnabled} />
            <AdminField label="편지 최대 글자">
              <AdminInput name="letterMaxLength" inputMode="numeric" defaultValue={cfg.letterMaxLength} />
            </AdminField>
            <AdminField label="크리에이터 1명에게 7일 최대 편지 수">
              <AdminInput name="letterPerWeek" inputMode="numeric" defaultValue={cfg.letterPerWeek} />
            </AdminField>
          </div>

          <p className="mb-1.5 mt-4 text-[11.5px] font-extrabold text-ink-400">묶음 구독</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <SwitchField label="묶음 구독" hint="여러 크리에이터를 한 번에 구독하면 할인" name="bundleEnabled" value={cfg.bundleEnabled} />
            <AdminField label="할인 (인원:할인%)" hint="예) 2:5, 3:10, 5:15 · 가장 큰 구간 하나만 적용 · 최대 50%">
              <AdminInput name="bundleDiscounts" defaultValue={cfg.bundleDiscounts.map((b) => `${b.count}:${Math.round(b.rate * 1000) / 10}`).join(', ')} />
            </AdminField>
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-400">묶음 구독 할인은 크리에이터별 정가 비율대로 나눠 각 크리에이터 구독료에 반영되고, 수수료는 크리에이터별 요율로 계산됩니다. 환불은 크리에이터 1명 구독 단위로 부분 취소됩니다.</p>
        </ActionForm>
      </Card>
    </div>
  );
}
