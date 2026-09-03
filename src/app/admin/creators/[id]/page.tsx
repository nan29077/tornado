import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import {
  Badge, Card, CardTitle, DataRow, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th,
} from '@/components/ui';
import { ActionButton, ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { updateCreatorStatus, updateCreatorPaymentMode, reissueCreatorCode, updateCreatorAmountBounds, setSettlementAccountVerified } from '@/app/actions/admin/accounts';
import { reissueCreatorMoNumberAction } from '@/app/actions/admin/transactions';
import { formatMoNumber } from '@/server/emma';
import { prisma } from '@/server/db';
import { getSettlementSummary } from '@/server/services/settlement';
import { resolveFeePolicy } from '@/server/services/settlement';
import { env } from '@/lib/env';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { creatorStatusLabel, donationStatusLabel, paymentModeLabel, moNumberStatusLabel } from '@/lib/labels';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { bankLabel, shortId } from '@/components/admin/mask';
import { hasDirectTriggerWrittenApproval } from '@/server/services/financial-approval';
import { requireAdminPage } from '@/server/admin-guard';

/** 소수 요율(0.018)을 사람이 읽는 퍼센트(1.8%)로 바꾼다. */
function percentText(rate: unknown): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export const dynamic = 'force-dynamic';

export default async function AdminCreatorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/creators');

  const { id } = await params;

  const creator = await prisma.creatorProfile.findUnique({
    where: { id },
    select: {
      id: true, displayName: true, channelName: true, description: true, code: true, status: true,
      donationAmount: true, minAmount: true, maxAmount: true, paymentMode: true, businessNo: true,
      approvedAt: true, suspendedAt: true, createdAt: true,
      user: { select: { email: true, name: true, phoneMasked: true, status: true } },
      codes: { orderBy: { issuedAt: 'desc' }, take: 10, select: { id: true, code: true, active: true, issuedAt: true, revokedAt: true } },
      moRoutes: {
        orderBy: { assignedAt: 'desc' },
        select: { id: true, phoneNumber: true, keyword: true, mode: true, status: true, monthlyCost: true, assignedAt: true },
      },
      youtubeConnection: {
        select: { channelTitle: true, channelId: true, status: true, expiresAt: true, lastError: true, lastCheckedAt: true },
      },
      settlementAccount: { select: { bankName: true, accountTail4: true, holderMasked: true, verified: true, verifiedAt: true } },
      overlaySetting: { select: { enabled: true, durationMs: true, anonymize: true, showAmount: true, showMessage: true } },
      ttsSetting: { select: { enabled: true, voice: true, minAmount: true, maxChars: true } },
    },
  });
  if (!creator) notFound();

  const [summary, feePolicy, donations, donationAgg] = await Promise.all([
    getSettlementSummary(id),
    resolveFeePolicy(id),
    prisma.donation.findMany({
      where: { creatorId: id },
      orderBy: { receivedAt: 'desc' },
      take: 20,
      select: {
        id: true, transactionNo: true, amount: true, status: true, receivedAt: true, paidAt: true,
        donor: { select: { phoneMasked: true } },
      },
    }),
    prisma.donation.aggregate({ where: { creatorId: id }, _count: { _all: true }, _sum: { amount: true } }),
  ]);

  /**
   * 즉시형 결제를 **열 수 있는 조건은 두 가지**다 — 환경 플래그 + 금융사 서면승인 등록.
   * 화면이 플래그만 보고 옵션을 열어 두면, 선택은 되는데 저장은 서버에서 거절되어
   * 운영자는 왜 선택지가 열려 있었는지 알 수 없다. 서버 액션과 같은 조건을 쓴다.
   */
  const writtenApproval = await hasDirectTriggerWrittenApproval().catch(() => false);
  const directBlocked = !env.safety.allowDirectTrigger || !writtenApproval;

  return (
    <>
      <PageHeader
        title={creator.displayName}
        description={`코드 ${creator.code} · ${creator.channelName ?? '채널명 미등록'}`}
        action={
          <Link href="/admin/creators" className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700">
            목록으로
          </Link>
        }
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="정산 잔액" value={formatWon(summary.balance)} tone="brand" />
          <StatTile label="정산 요청 보류" value={formatWon(summary.pending)} tone={summary.pending > 0n ? 'warning' : 'neutral'} />
          <StatTile label="정산 가능" value={formatWon(summary.available)} tone="success" />
          <StatTile
            label="누적 후원"
            value={formatWon(donationAgg._sum.amount ?? 0n)}
            sub={`${formatNumber(donationAgg._count._all)}건 (전 상태 포함)`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle>프로필</CardTitle>
            <div className="mt-2">
              <DataRow
                label="심사 상태"
                value={<Badge tone={creatorStatusLabel[creator.status].tone}>{creatorStatusLabel[creator.status].text}</Badge>}
              />
              <DataRow label="담당자" value={`${creator.user.name ?? '-'} / ${creator.user.email ?? '-'}`} />
              <DataRow label="연락처" value={creator.user.phoneMasked ?? '-'} />
              {/* 개인사업자에게 사업자등록번호는 사실상 개인 식별자다. 마스킹해 표시한다. */}
              <DataRow label="사업자번호" value={creator.businessNo ? shortId(creator.businessNo) : '미등록'} />
              <DataRow label="1건 후원금" value={formatWon(creator.donationAmount)} />
              <DataRow label="허용 범위" value={`${formatWon(creator.minAmount)} ~ ${formatWon(creator.maxAmount)}`} />
              <DataRow label="신청일" value={formatKst(creator.createdAt)} />
              <DataRow label="승인일" value={formatKst(creator.approvedAt)} />
              <DataRow label="정지일" value={formatKst(creator.suspendedAt)} />
            </div>
            <div className="mt-3 rounded-xl border border-ink-100 px-3 py-3">
              <p className="mb-2 text-[12.5px] font-bold text-ink-900">1건 후원금 허용 범위 변경</p>
              <ActionForm
                action={updateCreatorAmountBounds}
                submitLabel="범위 저장"
                confirm="이 크리에이터의 1건 후원금 허용 범위를 변경합니다. 현재 설정 금액이 범위를 벗어나면 자동 보정됩니다."
              >
                <input type="hidden" name="creatorId" value={creator.id} />
                <div className="grid grid-cols-2 gap-2">
                  <AdminField label="1건 최소 (원)">
                    <AdminInput name="minAmount" inputMode="numeric" defaultValue={creator.minAmount.toString()} required />
                  </AdminField>
                  <AdminField label="1건 최대 (원)">
                    <AdminInput name="maxAmount" inputMode="numeric" defaultValue={creator.maxAmount.toString()} required />
                  </AdminField>
                </div>
              </ActionForm>
            </div>
            <div className="mt-3">
              <SelectActionForm
                        ariaLabel="크리에이터 심사 상태 변경"
                action={updateCreatorStatus}
                values={{ creatorId: creator.id }}
                name="status"
                defaultValue={creator.status}
                options={[
                  { value: 'PENDING', label: '심사대기' },
                  { value: 'APPROVED', label: '승인' },
                  { value: 'REJECTED', label: '반려' },
                  { value: 'SUSPENDED', label: '정지' },
                ]}
                submitLabel="심사 상태 변경"
                confirm="심사 상태를 변경합니다."
              />
            </div>
          </Card>

          <Card>
            <CardTitle>결제 모드</CardTitle>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
              현재 설정: {creator.paymentMode ? paymentModeLabel[creator.paymentMode] : '전역 설정 사용'}
            </p>
            <div className="mt-3">
              <SelectActionForm
                        ariaLabel="크리에이터 심사 상태 변경"
                action={updateCreatorPaymentMode}
                values={{ creatorId: creator.id }}
                name="paymentMode"
                defaultValue={creator.paymentMode ?? ''}
                options={[
                  { value: '', label: '전역 설정 사용' },
                  { value: 'CONFIRM_LINK', label: paymentModeLabel.CONFIRM_LINK },
                  {
                    value: 'DIRECT_TRIGGER',
                    label: `${paymentModeLabel.DIRECT_TRIGGER}${directBlocked ? ' — 사용 불가' : ''}`,
                    disabled: directBlocked,
                  },
                ]}
                submitLabel="결제 모드 변경"
                confirm="결제 모드를 변경합니다. 변경 내역은 감사로그에 기록됩니다."
              />
            </div>
            {directBlocked ? (
              <div className="mt-3">
                <Notice tone="danger" title="즉시형 결제 선택 불가">
                  {!writtenApproval && !env.safety.allowDirectTrigger
                    ? '금융사 서면승인이 등록되지 않았고 ALLOW_DIRECT_TRIGGER 도 꺼져 있습니다. 둘 다 갖춰야 선택할 수 있습니다.'
                    : !writtenApproval
                      ? '금융사 서면승인이 등록되지 않았습니다. 서면승인을 등록해야 선택할 수 있습니다.'
                      : 'ALLOW_DIRECT_TRIGGER 가 꺼져 있습니다. 환경 설정을 켜야 선택할 수 있습니다.'}
                </Notice>
              </div>
            ) : null}

            <div className="mt-4">
              <CardTitle>수수료 정책</CardTitle>
              <div className="mt-2">
                <DataRow label="적용 범위" value={feePolicy ? feePolicy.scope : '기본값(정책 미등록)'} />
                {/* 요율을 소수 원문(0.018)으로 보여 주면 1.8% 인지 0.018% 인지 즉시 알 수 없다. */}
                <DataRow
                  label="결제 수수료"
                  value={
                    feePolicy
                      ? `${percentText(feePolicy.pgFeeRate)} + ${formatWon(feePolicy.pgFixedFee)}`
                      : `${percentText(0.018)} (기본값)`
                  }
                />
                <DataRow
                  label="플랫폼 수수료"
                  value={feePolicy ? percentText(feePolicy.platformFeeRate) : `${percentText(0.15)} (기본값)`}
                />
                <DataRow
                  label="부가세"
                  value={
                    (feePolicy ? feePolicy.vatIncluded : true)
                      ? '요율에 포함 (추가 차감 없음)'
                      : '별도 (수수료의 10% 추가 차감)'
                  }
                />
                <DataRow label="문자 원가" value={feePolicy ? formatWon(feePolicy.smsCost) : '-'} />
              </div>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>크리에이터 코드</CardTitle>
              <ActionButton
                action={reissueCreatorCode}
                values={{ creatorId: creator.id }}
                label="코드 재발급"
                variant="danger"
                confirm="코드를 재발급하면 기존 후원 링크가 즉시 무효화됩니다. 계속할까요?"
              />
            </div>
            <div className="mt-3">
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>코드</Th>
                    <Th>상태</Th>
                    <Th>발급</Th>
                    <Th>폐기</Th>
                  </tr>
                </thead>
                <tbody>
                  {creator.codes.map((c) => (
                    <tr key={c.id}>
                      <Td className="font-mono text-[12px]">{c.code}</Td>
                      <Td>{c.active ? <Badge tone="success">활성</Badge> : <Badge tone="neutral">폐기</Badge>}</Td>
                      <Td className="whitespace-nowrap">{formatKst(c.issuedAt, false)}</Td>
                      <Td className="whitespace-nowrap">{formatKst(c.revokedAt, false)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>

          <Card>
            <CardTitle>MO 수신 번호</CardTitle>
            <div className="mt-3">
              {creator.moRoutes.length === 0 ? (
                <EmptyState
                  title="배정된 MO 번호가 없습니다"
                  description="MO 번호 관리 화면에서 수신 번호를 배정해야 문자후원이 접수됩니다."
                />
              ) : (
                <Table className="min-w-0">
                  <thead>
                    <tr>
                      <Th>번호</Th>
                      <Th>키워드</Th>
                      <Th>모드</Th>
                      <Th>상태</Th>
                      <Th className="text-right">월 비용</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {creator.moRoutes.map((m) => (
                      <tr key={m.id}>
                        <Td className="font-mono text-[12px]">{formatMoNumber(m.phoneNumber)}</Td>
                        <Td>{m.keyword ?? '-'}</Td>
                        <Td>{m.mode === 'DEDICATED' ? '전용번호' : '대표번호 공유'}</Td>
                        <Td>
                          <Badge tone={moNumberStatusLabel[m.status].tone}>{moNumberStatusLabel[m.status].text}</Badge>
                        </Td>
                        <Td className="text-right tabular-nums">{formatWon(m.monthlyCost)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <div className="mt-3 border-t border-ink-100 pt-3">
                <p className="text-[12px] font-semibold text-ink-900">번호 재발급</p>
                <p className="mt-1 mb-2 text-[11.5px] leading-relaxed text-ink-400">
                  번호 유출·오배정 신고처럼 지금 쓰는 번호를 버려야 할 때만 사용합니다. 실행하면 후원자가 알고 있던
                  번호가 즉시 바뀌므로, 크리에이터에게 방송 안내 문구 교체를 알려야 합니다. 옛 번호는 회수되어
                  냉각기간 동안 다른 크리에이터에게 배정되지 않습니다.
                </p>
                <ActionForm
                  action={reissueCreatorMoNumberAction}
                  submitLabel="MO 번호 재발급"
                  variant="danger"
                  compact
                  confirm={`${creator.displayName} 님의 MO 번호를 새 번호로 바꿉니다. 지금 쓰는 번호로 오는 후원 문자는 더 이상 접수되지 않습니다. 진행할까요?`}
                >
                  <input type="hidden" name="creatorId" value={creator.id} />
                  <AdminField label="사유 (감사로그에 남습니다)">
                    <AdminInput name="reason" placeholder="예: 번호 유출 신고" />
                  </AdminField>
                </ActionForm>
              </div>

              <div className="mt-3">
                <Link href="/admin/mo-numbers" className="text-[12px] font-semibold text-brand-700">
                  MO 번호 관리로 이동
                </Link>
              </div>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardTitle>유튜브 연결</CardTitle>
            <div className="mt-2">
              {creator.youtubeConnection ? (
                <>
                  <DataRow label="채널" value={creator.youtubeConnection.channelTitle ?? creator.youtubeConnection.channelId} />
                  <DataRow label="상태" value={creator.youtubeConnection.status} />
                  <DataRow label="토큰 만료" value={formatKst(creator.youtubeConnection.expiresAt)} />
                  <DataRow label="마지막 점검" value={formatKst(creator.youtubeConnection.lastCheckedAt)} />
                  <DataRow label="마지막 오류" value={creator.youtubeConnection.lastError ?? '-'} />
                </>
              ) : (
                <p className="text-[13px] text-ink-400">연결된 유튜브 채널이 없습니다.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle>정산 계좌</CardTitle>
            <div className="mt-2">
              {creator.settlementAccount ? (
                <>
                  <DataRow
                    label="계좌"
                    // 마스킹 규칙을 직접 조립하지 않고 공용 헬퍼를 쓴다(두 벌로 갈라지면 한쪽만 고쳐진다).
                    value={bankLabel(creator.settlementAccount.bankName, creator.settlementAccount.accountTail4)}
                  />
                  <DataRow label="예금주" value={creator.settlementAccount.holderMasked} />
                  <DataRow
                    label="인증"
                    value={
                      creator.settlementAccount.verified ? (
                        <Badge tone="success">인증 완료</Badge>
                      ) : (
                        <Badge tone="warning">미인증</Badge>
                      )
                    }
                  />
                  <DataRow label="인증일" value={formatKst(creator.settlementAccount.verifiedAt)} />
                </>
              ) : (
                <p className="text-[13px] text-ink-400">등록된 정산 계좌가 없습니다.</p>
              )}
            </div>

            {creator.settlementAccount ? (
              <div className="mt-3 border-t border-ink-100 pt-3">
                <p className="mb-2 text-[12px] leading-relaxed text-ink-500">
                  예금주 실명확인 API 연동 전까지는 증빙(통장사본·사업자등록증)을 확인한 뒤 수동으로 처리합니다.
                  인증되지 않은 계좌로는 정산을 요청할 수 없습니다.
                </p>
                {creator.settlementAccount.verified ? (
                  <ActionButton
                    action={setSettlementAccountVerified}
                    values={{ creatorId: creator.id, verified: 'false' }}
                    label="인증 해제"
                    variant="danger"
                    confirm="정산 계좌 인증을 해제합니다. 재확인 전까지 이 크리에이터는 정산을 요청할 수 없습니다."
                  />
                ) : (
                  <ActionButton
                    action={setSettlementAccountVerified}
                    values={{ creatorId: creator.id, verified: 'true' }}
                    label="실명확인 완료 처리"
                    confirm="증빙 확인이 끝났습니까? 인증 완료로 처리하면 이 크리에이터가 정산을 요청할 수 있습니다."
                  />
                )}
              </div>
            ) : null}
          </Card>

          <Card>
            <CardTitle>방송 설정 요약</CardTitle>
            <div className="mt-2">
              <DataRow label="오버레이" value={creator.overlaySetting ? (creator.overlaySetting.enabled ? '사용' : '중지') : '미설정'} />
              <DataRow label="표시 시간" value={creator.overlaySetting ? `${creator.overlaySetting.durationMs}ms` : '-'} />
              <DataRow label="익명 처리" value={creator.overlaySetting?.anonymize ? '적용' : '미적용'} />
              <DataRow label="TTS" value={creator.ttsSetting ? (creator.ttsSetting.enabled ? '사용' : '중지') : '미설정'} />
              <DataRow label="TTS 최소 금액" value={creator.ttsSetting ? formatWon(creator.ttsSetting.minAmount) : '-'} />
            </div>
          </Card>
        </div>

        <section>
          <SectionTitle title="정산 요약" description="원장 합계 기준. 원장은 append-only 이며 수정할 수 없습니다." />
          <Card>
            <DataRow label="후원 총액" value={formatWon(summary.totalGross)} />
            <DataRow label="결제 수수료" value={formatWon(-summary.totalPgFee)} />
            <DataRow label="플랫폼 수수료" value={formatWon(-summary.totalPlatformFee)} />
            <DataRow label="환불(수수료 환입 포함)" value={formatWon(-summary.totalRefund)} />
            <DataRow label="조정" value={formatWon(summary.totalAdjustment)} />
            <DataRow label="지급 완료" value={formatWon(-summary.totalPaid)} />
            <DataRow label="현재 잔액" value={<span className="text-brand-700">{formatWon(summary.balance)}</span>} />
          </Card>
        </section>

        <section>
          <SectionTitle title="최근 후원 20건" />
          {donations.length === 0 ? (
            <EmptyState title="후원 내역이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>거래번호</Th>
                  <Th>후원자</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>수신</Th>
                  <Th>결제</Th>
                </tr>
              </thead>
              <tbody>
                {donations.map((d) => (
                  <tr key={d.id}>
                    <Td className="font-mono text-[12px]">{d.transactionNo}</Td>
                    <Td>{d.donor?.phoneMasked ?? '-'}</Td>
                    <Td className="text-right tabular-nums">{formatWon(d.amount)}</Td>
                    <Td>
                      <Badge tone={donationStatusLabel[d.status].tone}>{donationStatusLabel[d.status].text}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(d.receivedAt, false)}</Td>
                    <Td className="whitespace-nowrap">{formatKst(d.paidAt, false)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
