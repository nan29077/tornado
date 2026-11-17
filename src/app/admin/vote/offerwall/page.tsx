import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput } from '@/components/admin/controls';
import { Switch } from '@/components/admin/switch';
import { saveOfferwallAction } from '@/app/actions/admin/engagement';
import { formatKst } from '@/lib/datetime';
import { requestNowMs } from '@/lib/vote-period';
import { requireAdminPage } from '@/server/admin-guard';
import { prisma } from '@/server/db';
import { OFFERWALL_PROVIDERS, getOfferwallSettings, mockOfferwallAllowed } from '@/server/services/vote/offerwall';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 투표 관리 > 오퍼월 연동 */
export default async function AdminOfferwallPage() {
  await requireAdminPage('/admin/vote/offerwall');
  const since = new Date(requestNowMs() - 30 * 86_400_000);
  const [settings, recent, stats] = await Promise.all([
    getOfferwallSettings(),
    prisma.offerwallReward.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { email: true, name: true } } } }),
    prisma.offerwallReward.groupBy({ by: ['provider', 'status'], where: { createdAt: { gte: since } }, _sum: { tickets: true }, _count: true }),
  ]);
  return (
    <div>
      <PageHeader title="오퍼월 연동" description="광고 시청 · 퀴즈 등 참여형 광고로 무료 투표권을 지급합니다. 투표권은 광고사 서버 콜백으로만 지급되고, 같은 거래는 한 번만 지급됩니다." />
      <Notice tone="warning" title="실제 광고사는 계약 후 연동합니다">
        버즈빌 · 애드팝콘은 계약 전이라 꺼져 있습니다. 콜백 주소는 <code>/api/offerwall/광고사/callback</code> 로 준비되어 있으며, 연동 규격(서명 방식 · 파라미터)을 받으면 어댑터를 완성합니다. 그 전까지는 테스트 광고로 흐름을 확인할 수 있습니다{mockOfferwallAllowed() ? '' : ' (운영 환경이라 테스트 광고는 꺼져 있습니다)'}.
      </Notice>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>광고사 설정</CardTitle>
          <ActionForm action={saveOfferwallAction} submitLabel="저장" className="mt-2">
            <div className="space-y-2.5">
              {OFFERWALL_PROVIDERS.map((p) => (
                <div key={p.key} className="min-w-0 rounded-2xl border border-ink-100 bg-white p-3.5">
                  {/* 머리: 이름·상태 + 스위치 (줄 어디를 눌러도 켜고 끈다) */}
                  <label className="flex cursor-pointer items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-black text-ink-900">
                        {p.label}
                        {p.live ? <Badge tone="success">사용 가능</Badge> : <Badge tone="warning">연동 대기</Badge>}
                      </span>
                      <span className="mt-1 block text-[11.5px] leading-relaxed text-ink-400">{p.note}</span>
                    </span>
                    <Switch name={`${p.key}_enabled`} defaultChecked={settings.providers[p.key].enabled} ariaLabel={`${p.label} 사용`} className="shrink-0 pt-0.5" />
                  </label>
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-warm-50 px-3 py-2.5">
                    <label htmlFor={`${p.key}_ratio`} className="shrink-0 text-[12px] font-bold text-ink-600">전환 비율</label>
                    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-ink-500">
                      리워드 1 →
                      <span className="w-[72px] shrink-0">
                        <AdminInput id={`${p.key}_ratio`} name={`${p.key}_ratio`} inputMode="decimal" defaultValue={settings.providers[p.key].ratio} className="text-right" />
                      </span>
                      투표권
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle>최근 30일</CardTitle>
          <div className="mt-2">
            <Table className="min-w-0">
              <thead><tr><Th>광고사</Th><Th>상태</Th><Th className="text-right">건수</Th><Th className="text-right">투표권</Th></tr></thead>
              <tbody>
                {stats.length === 0 ? <tr><Td className="text-ink-400">기록 없음</Td><Td>{''}</Td><Td>{''}</Td><Td>{''}</Td></tr> : stats.map((s) => (
                  <tr key={`${s.provider}-${s.status}`}>
                    <Td>{OFFERWALL_PROVIDERS.find((p) => p.key === s.provider)?.label ?? s.provider}</Td>
                    <Td>{s.status === 'GRANTED' ? '지급' : s.status === 'REVOKED' ? '회수' : s.status}</Td>
                    <Td className="text-right">{s._count.toLocaleString('ko-KR')}</Td>
                    <Td className="text-right">{(s._sum.tickets ?? 0).toLocaleString('ko-KR')}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-[14px] font-bold text-ink-900">최근 지급 내역</h2>
      <Table>
        <thead><tr><Th>시각</Th><Th>광고사</Th><Th>회원</Th><Th>캠페인</Th><Th className="text-right">투표권</Th><Th>상태</Th><Th>거래 고유값</Th></tr></thead>
        <tbody>
          {recent.map((r) => (
            <tr key={r.id}>
              <Td>{formatKst(r.createdAt, false)}</Td>
              <Td>{r.provider}</Td>
              <Td>{r.user.name ?? '-'} <span className="text-ink-400">{r.user.email}</span></Td>
              <Td>{r.campaign ?? '-'}</Td>
              <Td className="text-right">{r.tickets}</Td>
              <Td>{r.status === 'GRANTED' ? <Badge tone="success">지급</Badge> : <Badge tone="danger">{r.status === 'REVOKED' ? '회수' : r.status}</Badge>}{r.reason ? <span className="ml-1 text-[11px] text-ink-400">{r.reason}</span> : null}</Td>
              <Td className="max-w-[200px] truncate font-mono text-[11px]">{r.rewardKey}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
