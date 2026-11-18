import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { pctLabel, pctText, won } from '@/components/admin/engage-bits';
import { SwitchField } from '@/components/admin/switch';
import { finalizeNowAction, saveVoteSettingsAction, saveVoteShareRateAction } from '@/app/actions/admin/engagement';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { kstStartOfDay } from '@/lib/datetime';
import { getVoteConfig } from '@/server/services/engagement/config';
import { getRanking } from '@/server/services/vote/ranking';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 팬투표 관리 > 팬투표 설정 · 현황 */
export default async function AdminVotePage() {
  await requireAdminPage('/admin/vote');
  const today = kstStartOfDay();
  const [cfg, live, week, todayCasts, todayOrders, todayOffer, outstanding, overrides] = await Promise.all([
    getVoteConfig(),
    getRanking('live', { limit: 10 }),
    getRanking('week', { limit: 10 }),
    prisma.voteCast.aggregate({ where: { createdAt: { gte: today }, voidedAt: null }, _sum: { votes: true }, _count: true }),
    prisma.voteTicketOrder.aggregate({ where: { status: 'PAID', paidAt: { gte: today } }, _sum: { price: true }, _count: true }),
    prisma.offerwallReward.aggregate({ where: { status: 'GRANTED', createdAt: { gte: today } }, _sum: { tickets: true }, _count: true }),
    prisma.voteTicketLot.aggregate({ where: { bucket: 'PAID', remaining: { gt: 0 } }, _sum: { remaining: true } }),
    prisma.creatorEngagementPolicy.count({ where: { voteShareRate: { not: null } } }),
  ]);

  return (
    <div>
      <PageHeader title="팬투표 설정" description="팬투표 규칙 · 팬투표권 유효기간 · 크리에이터 몫 비율을 관리합니다. 크리에이터별로 지정한 비율이 전역 값보다 우선합니다." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="오늘 팬투표" value={`${(todayCasts._sum.votes ?? 0).toLocaleString('ko-KR')}표`} sub={`${todayCasts._count.toLocaleString('ko-KR')}건`} tone="brand" />
        <StatTile label="오늘 충전 매출" value={won(todayOrders._sum.price ?? 0n)} sub={`${todayOrders._count}건 · 테스트 결제 포함`} />
        <StatTile label="오늘 무료 지급(오퍼월)" value={`${(todayOffer._sum.tickets ?? 0).toLocaleString('ko-KR')}개`} sub={`${todayOffer._count}건`} />
        <StatTile label="남은 유료 팬투표권" value={`${(outstanding._sum.remaining ?? 0).toLocaleString('ko-KR')}개`} sub="미사용 선수금 성격" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>팬투표 규칙</CardTitle>
          <ActionForm action={saveVoteSettingsAction} submitLabel="저장" className="mt-2" confirm="바로 적용됩니다. 저장할까요?">
            <p className="mb-1.5 text-[11.5px] font-extrabold text-ink-400">기능 켜기·끄기</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <SwitchField label="팬투표 기능" hint="끄면 모든 화면에서 팬투표를 받지 않습니다" name="enabled" value={cfg.enabled} tone="danger" />
              <SwitchField label="랭킹 공개" hint="끄면 순위를 숨기고 팬투표만 받습니다" name="rankingPublic" value={cfg.rankingPublic} onLabel="공개" offLabel="비공개" />
              <SwitchField label="결제 충전 판매" hint="팬투표권 구매(신용카드·간편계좌이체)" name="purchaseEnabled" value={cfg.purchaseEnabled} />
              <SwitchField label="오퍼월(무료 충전)" hint="광고 시청·퀴즈로 무료 팬투표권 지급" name="offerwallEnabled" value={cfg.offerwallEnabled} />
              <SwitchField label="휴대폰 연결 회원만 팬투표" hint="다계정 팬투표를 줄입니다 (운영 전 켜기 권장)" name="requirePhone" value={cfg.requirePhone} onLabel="예" offLabel="아니오" className="sm:col-span-2" />
            </div>
            <p className="mb-1.5 mt-4 text-[11.5px] font-extrabold text-ink-400">팬투표 규칙</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <AdminField label="1표당 소진 팬투표권" hint="예) 10 이면 1표에 팬투표권 10개"><AdminInput name="ticketsPerVote" inputMode="numeric" defaultValue={cfg.ticketsPerVote} /></AdminField>
              <AdminField label="한 번에 최대 표"><AdminInput name="maxVotesPerAction" inputMode="numeric" defaultValue={cfg.maxVotesPerAction} /></AdminField>
              <AdminField label="회원 하루 최대 표 (0=제한 없음)"><AdminInput name="dailyMaxVotesPerUser" inputMode="numeric" defaultValue={cfg.dailyMaxVotesPerUser} /></AdminField>
              <AdminField label="크리에이터 1명에게 하루 최대 (0=제한 없음)"><AdminInput name="dailyMaxVotesPerCreator" inputMode="numeric" defaultValue={cfg.dailyMaxVotesPerCreator} /></AdminField>
              <AdminField label="사용 순서">
                <AdminSelect name="spendOrder" defaultValue={cfg.spendOrder}>
                  <option value="FREE_FIRST">무료 → 보너스 → 유료</option>
                  <option value="PAID_FIRST">유료 → 보너스 → 무료</option>
                </AdminSelect>
              </AdminField>
              <AdminField label="무료 유효기간(일, 0=무기한)"><AdminInput name="freeExpiryDays" inputMode="numeric" defaultValue={cfg.freeExpiryDays} /></AdminField>
              <AdminField label="보너스 유효기간(일)"><AdminInput name="bonusExpiryDays" inputMode="numeric" defaultValue={cfg.bonusExpiryDays} /></AdminField>
              <AdminField label="유료 유효기간(일)"><AdminInput name="paidExpiryDays" inputMode="numeric" defaultValue={cfg.paidExpiryDays} /></AdminField>
              <AdminField label="미사용 결제 환불 기간(일)"><AdminInput name="refundDays" inputMode="numeric" defaultValue={cfg.refundDays} /></AdminField>
              <AdminField label="빠른 선택 표 수 (쉼표)" className="sm:col-span-2"><AdminInput name="quickVotes" defaultValue={cfg.quickVotes.join(', ')} /></AdminField>
            </div>
          </ActionForm>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle>유료 팬투표권 수익 — 크리에이터 몫 (전역)</CardTitle>
            <p className="mt-1 text-[12px] text-ink-500">
              유료 팬투표권으로 받은 표의 금액 가치 × 이 비율이 크리에이터 정산 원장(팬투표 수익 배분)에 적립됩니다. 0% 면 나누지 않습니다. 크리에이터별 지정 {overrides}건은 그 값이 우선합니다 —{' '}
              <Link href="/admin/talk/creators" className="font-bold text-brand-800">크리에이터별 요율·권한</Link>
            </p>
            <p className="mt-2 text-[22px] font-black text-ink-900">{pctLabel(cfg.shareRate)}</p>
            <ActionForm action={saveVoteShareRateAction} submitLabel="비율 저장" className="mt-2" confirm="이후 팬투표부터 적용됩니다.">
              <AdminField label="크리에이터 몫(%)"><AdminInput name="shareRate" inputMode="decimal" defaultValue={pctText(cfg.shareRate)} /></AdminField>
            </ActionForm>
          </Card>
          <Card>
            <CardTitle>기간 마감 확정</CardTitle>
            <p className="mt-1 text-[12px] text-ink-500">지난 일·주·월 순위와 끝난 회차는 화면을 열 때 자동 확정됩니다. 바로 점검하려면 누르세요. (만료된 팬투표권 정리 포함)</p>
            <ActionForm action={finalizeNowAction} submitLabel="지금 점검·확정" variant="secondary" className="mt-2" />
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {[live, week].map((v) => (
          <Card key={v.tab}>
            <CardTitle>{v.title} TOP 10</CardTitle>
            <div className="mt-2">
              <Table className="min-w-0">
                <thead><tr><Th>순위</Th><Th>크리에이터</Th><Th className="text-right">표</Th></tr></thead>
                <tbody>
                  {v.rows.length === 0 ? <tr><Td className="text-ink-400">팬투표 없음</Td><Td>{''}</Td><Td>{''}</Td></tr> : v.rows.map((r) => (
                    <tr key={r.creatorId}>
                      <Td>{r.rank}</Td>
                      <Td>{r.displayName} <span className="text-ink-400">{r.code}</span></Td>
                      <Td className="text-right tabular-nums">{r.votes.toLocaleString('ko-KR')}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
