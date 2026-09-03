import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import {
  Badge, Card, CardTitle, DataRow, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th,
} from '@/components/ui';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { bankLabel } from '@/components/admin/mask';
import { PAID_DONATION_STATUSES } from '@/components/admin/constants';
import { unlockDonor, setDonorBlock, updateDonorLimitsByAdmin } from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import {
  donationStatusLabel,
  donorOnboardingStatusLabel,
  paymentTxStatusLabel,
  riskLevelLabel,
  riskTypeLabel,
} from '@/lib/labels';
import { resolvePolicy } from '@/server/services/limits';

import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

export default async function AdminDonorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/donors');

  const { id } = await params;

  const donor = await prisma.donorProfile.findUnique({
    where: { id },
    select: {
      id: true, userId: true, phoneHash: true, phoneMasked: true, displayName: true,
      ageVerified: true, dailyLimit: true, monthlyLimit: true, failCount: true,
      lockedUntil: true, blockedAt: true, blockedReason: true,
      firstSeenAt: true, registeredAt: true, createdAt: true,
      onboardingStatus: true, registrationLinkSentAt: true,
      user: { select: { email: true, name: true, status: true } },
      paymentTokens: {
        orderBy: { registeredAt: 'desc' },
        select: { id: true, status: true, bankName: true, accountTail4: true, registeredAt: true, revokedAt: true },
      },
      creatorLinks: {
        orderBy: { totalAmount: 'desc' },
        take: 10,
        select: {
          id: true, totalAmount: true, totalCount: true, donorBlockedAt: true, lastDonatedAt: true,
          creator: {
            select: {
              id: true, displayName: true, code: true,
              // 크리에이터 -> 후원자 방향 차단은 blocked_donor 에 있다.
              blockedDonors: { where: { donorId: id }, select: { createdAt: true } },
            },
          },
        },
      },
    },
  });
  if (!donor) notFound();

  const [donations, transactions, consents, risks, agg, policy] = await Promise.all([
    prisma.donation.findMany({
      where: { donorId: id },
      orderBy: { receivedAt: 'desc' },
      take: 30,
      select: {
        id: true, transactionNo: true, amount: true, status: true, receivedAt: true, paidAt: true,
        creator: { select: { displayName: true } },
      },
    }),
    prisma.paymentTransaction.findMany({
      where: { donation: { donorId: id } },
      orderBy: { requestedAt: 'desc' },
      take: 30,
      select: {
        id: true, orderNo: true, amount: true, status: true, resultCode: true, resultMessage: true,
        requestedAt: true, approvedAt: true, canceledAt: true,
        donation: { select: { transactionNo: true } },
      },
    }),
    prisma.consentRecord.findMany({
      where: {
        OR: [{ phoneHash: donor.phoneHash }, ...(donor.userId ? [{ userId: donor.userId }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, type: true, agreed: true, createdAt: true, ip: true,
        terms: { select: { version: true, title: true, required: true } },
      },
    }),
    prisma.riskDetection.findMany({
      where: { donorId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, type: true, level: true, resolved: true, createdAt: true, resolvedAt: true, detail: true },
    }),
    prisma.donation.aggregate({
      where: { donorId: id, status: { in: PAID_DONATION_STATUSES } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    resolvePolicy(null, id),
  ]);

  const now = new Date();
  const locked = donor.lockedUntil != null && donor.lockedUntil > now;
  const activeToken = donor.paymentTokens.find((t) => t.status === 'ACTIVE');

  return (
    <>
      <PageHeader
        title={`후원자 ${donor.phoneMasked}`}
        description="후원·결제·동의·이상거래 내역을 한 화면에서 확인합니다."
        action={
          <Link href="/admin/donors" className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700">
            목록으로
          </Link>
        }
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="누적 후원" value={formatWon(agg._sum.amount ?? 0n)} sub={`${formatNumber(agg._count._all)}건`} tone="brand" />
          <StatTile label="결제 실패 누적" value={formatNumber(donor.failCount)} tone={donor.failCount > 0 ? 'warning' : 'neutral'} />
          <StatTile label="잠금 상태" value={locked ? '잠김' : '정상'} sub={locked ? formatKst(donor.lockedUntil, false) : '-'} tone={locked ? 'danger' : 'success'} />
          <StatTile label="이용 제한" value={donor.blockedAt ? '제한' : '없음'} sub={donor.blockedReason ?? '-'} tone={donor.blockedAt ? 'danger' : 'success'} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle>기본 정보</CardTitle>
            <div className="mt-2">
              <DataRow label="연락처" value={donor.phoneMasked} />
              <DataRow label="표시 이름" value={donor.displayName ?? '-'} />
              <DataRow label="연결 회원" value={donor.user ? `${donor.user.email ?? '-'} (${donor.user.status})` : '비회원(문자 후원)'} />
              <DataRow label="성인 확인" value={donor.ageVerified ? '완료' : '미확인'} />
              <DataRow label="최초 수신" value={formatKst(donor.firstSeenAt)} />
              <DataRow
                label="내통장결제 가입 상태"
                value={
                  <Badge tone={donorOnboardingStatusLabel[donor.onboardingStatus].tone}>
                    {donorOnboardingStatusLabel[donor.onboardingStatus].text}
                  </Badge>
                }
              />
              <DataRow
                label="최초 가입 링크 발송"
                value={donor.registrationLinkSentAt ? formatKst(donor.registrationLinkSentAt) : '발송 전'}
              />
              <DataRow label="계좌 등록" value={donor.registeredAt ? formatKst(donor.registeredAt) : '미등록'} />
              <DataRow
                label="활성 결제수단"
                value={activeToken ? bankLabel(activeToken.bankName, activeToken.accountTail4) : '없음'}
              />
            </div>
          </Card>

          <Card>
            <CardTitle>운영 처리</CardTitle>
            <div className="mt-3 space-y-4">
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  action={unlockDonor}
                  values={{ donorId: donor.id }}
                  label="결제 실패 잠금 해제"
                  disabled={!locked && donor.failCount === 0}
                  confirm="잠금을 해제하고 실패 횟수를 0으로 되돌립니다."
                />
                {donor.blockedAt ? (
                  <ActionButton
                    action={setDonorBlock}
                    values={{ donorId: donor.id, next: 'UNBLOCK' }}
                    label="이용 제한 해제"
                    confirm="이용 제한을 해제합니다."
                  />
                ) : null}
              </div>

              {!donor.blockedAt ? (
                <ActionForm action={setDonorBlock} submitLabel="이용 제한 적용" variant="danger" confirm="이후 이 후원자의 문자후원이 접수되지 않습니다.">
                  <input type="hidden" name="donorId" value={donor.id} />
                  <input type="hidden" name="next" value="BLOCK" />
                  <AdminField label="제한 사유">
                    <AdminInput name="reason" placeholder="예: 반복 분쟁 신고" />
                  </AdminField>
                </ActionForm>
              ) : null}

              <ActionForm action={updateDonorLimitsByAdmin} submitLabel="개인 한도 저장" variant="secondary">
                <input type="hidden" name="donorId" value={donor.id} />
                <div className="grid grid-cols-2 gap-2">
                  <AdminField label="일 한도" hint={`정책값 ${formatWon(policy.donorDailyLimit)}`}>
                    <AdminInput name="dailyLimit" inputMode="numeric" defaultValue={donor.dailyLimit?.toString() ?? ''} />
                  </AdminField>
                  <AdminField label="월 한도" hint={`정책값 ${formatWon(policy.donorMonthlyLimit)}`}>
                    <AdminInput name="monthlyLimit" inputMode="numeric" defaultValue={donor.monthlyLimit?.toString() ?? ''} />
                  </AdminField>
                </div>
              </ActionForm>
            </div>
          </Card>
        </div>

        <section>
          <SectionTitle title="크리에이터별 후원" description="상위 10명" />
          {donor.creatorLinks.length === 0 ? (
            <EmptyState title="후원한 크리에이터가 없습니다" />
          ) : (
            <Table className="min-w-0">
              <thead>
                <tr>
                  <Th>크리에이터</Th>
                  <Th className="text-right">누적 금액</Th>
                  <Th className="text-right">건수</Th>
                  <Th>최근 후원</Th>
                  <Th>차단</Th>
                </tr>
              </thead>
              <tbody>
                {donor.creatorLinks.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      <Link href={`/admin/creators/${l.creator.id}`} className="font-semibold text-brand-700">
                        {l.creator.displayName}
                      </Link>
                      <span className="ml-1 text-[11px] text-ink-400">{l.creator.code}</span>
                    </Td>
                    <Td className="text-right tabular-nums">{formatWon(l.totalAmount)}</Td>
                    <Td className="text-right tabular-nums">{formatNumber(l.totalCount)}</Td>
                    <Td className="whitespace-nowrap">{formatKst(l.lastDonatedAt, false)}</Td>
                    <Td className="space-x-1 whitespace-nowrap">
                      {l.donorBlockedAt ? <Badge tone="danger">후원자 차단</Badge> : null}
                      {l.creator.blockedDonors.length > 0 ? <Badge tone="warning">크리에이터 차단</Badge> : null}
                      {!l.donorBlockedAt && l.creator.blockedDonors.length === 0 ? (
                        <Badge tone="neutral">없음</Badge>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle title="후원 내역" description="최근 30건" />
          {donations.length === 0 ? (
            <EmptyState title="후원 내역이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>거래번호</Th>
                  <Th>크리에이터</Th>
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
                    <Td>{d.creator.displayName}</Td>
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

        <section>
          <SectionTitle title="결제 내역" description="최근 30건" />
          {transactions.length === 0 ? (
            <EmptyState title="결제 내역이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>주문번호</Th>
                  <Th>거래번호</Th>
                  <Th className="text-right">금액</Th>
                  <Th>상태</Th>
                  <Th>결과</Th>
                  <Th>요청</Th>
                  <Th>승인·취소</Th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id}>
                    <Td className="font-mono text-[12px]">{t.orderNo}</Td>
                    <Td className="font-mono text-[12px]">{t.donation.transactionNo}</Td>
                    <Td className="text-right tabular-nums">{formatWon(t.amount)}</Td>
                    <Td>
                      <Badge tone={paymentTxStatusLabel[t.status].tone}>{paymentTxStatusLabel[t.status].text}</Badge>
                    </Td>
                    <Td className="max-w-[200px] break-words">
                      {t.resultCode ? <span className="font-semibold">{t.resultCode}</span> : '-'}
                      {t.resultMessage ? <span className="block text-ink-500">{t.resultMessage}</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(t.requestedAt, false)}</Td>
                    <Td className="whitespace-nowrap">{formatKst(t.approvedAt ?? t.canceledAt, false)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <SectionTitle title="동의 이력" description="약관 버전과 함께 보존됩니다" />
            {consents.length === 0 ? (
              <EmptyState title="동의 이력이 없습니다" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>시각</Th>
                    <Th>유형</Th>
                    <Th>버전</Th>
                    <Th>동의</Th>
                  </tr>
                </thead>
                <tbody>
                  {consents.map((c) => (
                    <tr key={c.id}>
                      <Td className="whitespace-nowrap">{formatKst(c.createdAt, false)}</Td>
                      <Td>{c.type}</Td>
                      <Td>
                        {c.terms.version}
                        <span className="block text-[11px] text-ink-400">{c.terms.title}</span>
                      </Td>
                      <Td>
                        <Badge tone={c.agreed ? 'success' : 'neutral'}>{c.agreed ? '동의' : '미동의'}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <section>
            <SectionTitle title="이상거래 탐지" description="최근 20건" />
            {risks.length === 0 ? (
              <EmptyState title="탐지 내역이 없습니다" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>시각</Th>
                    <Th>유형</Th>
                    <Th>레벨</Th>
                    <Th>해결</Th>
                  </tr>
                </thead>
                <tbody>
                  {risks.map((r) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap">{formatKst(r.createdAt, false)}</Td>
                      <Td>{riskTypeLabel[r.type]}</Td>
                      <Td>
                        <Badge tone={riskLevelLabel[r.level].tone}>{riskLevelLabel[r.level].text}</Badge>
                      </Td>
                      <Td>
                        {r.resolved ? (
                          <Badge tone="success">해결 {formatKst(r.resolvedAt, false)}</Badge>
                        ) : (
                          <Badge tone="danger">미해결</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </div>

        <Notice tone="neutral" title="결제수단 이력">
          빌키 원문은 저장·표시하지 않으며 은행명과 계좌 끝 4자리만 보관합니다. 등록 이력은 아래와 같습니다.
          <ul className="mt-2 space-y-1">
            {donor.paymentTokens.length === 0 ? (
              <li>등록된 결제수단이 없습니다.</li>
            ) : (
              donor.paymentTokens.map((t) => (
                <li key={t.id}>
                  {bankLabel(t.bankName, t.accountTail4)} · {t.status} · 등록 {formatKst(t.registeredAt, false)}
                  {t.revokedAt ? ` · 해지 ${formatKst(t.revokedAt, false)}` : ''}
                </li>
              ))
            )}
          </ul>
        </Notice>
      </div>
    </>
  );
}
