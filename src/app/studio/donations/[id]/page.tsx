import { notFound } from 'next/navigation';
import { Badge, Card, CardTitle, DataRow, EmptyState, LinkButton, Notice, SectionTitle, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { blockDonorAction, replayOverlayTestAction } from '@/app/actions/studio';
import { requireCreator } from '@/server/auth';
import { replyToDonationAction } from '@/app/actions/donation-replies';
import { prisma } from '@/server/db';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import {
  deliveryStatusLabel,
  donationStatusLabel,
  paymentModeLabel,
  paymentTxStatusLabel,
  refundStatusLabel,
} from '@/lib/labels';

export const dynamic = 'force-dynamic';

export default async function StudioDonationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { creatorId } = await requireCreator();
  const { id } = await params;

  /**
   * 최상위를 `select` 로 명시한다.
   *
   * `include` 는 Donation 의 모든 스칼라를 함께 가져오므로 문자 원문 암호문(`messageRawEnc`)이
   * 이 화면 렌더러의 손에 들어온다. 화면은 필터링본만 쓰고 "문자 원문은 제공되지 않습니다"라고
   * 안내하는데, 데이터는 이미 넘어와 있어 유출 한 발짝 전이었다.
   */
  const donation = await prisma.donation.findFirst({
    where: { id, creatorId },
    select: {
      id: true,
      transactionNo: true,
      creatorId: true,
      donorId: true,
      amount: true,
      displayName: true,
      message: true,
      reply: { select: { body: true } },
      anonymous: true,
      channel: true,
      paymentMode: true,
      status: true,
      statusReason: true,
      mtStatus: true,
      overlayStatus: true,
      youtubeStatus: true,
      isTest: true,
      receivedAt: true,
      paidAt: true,
      broadcastedAt: true,
      createdAt: true,
      pgFee: true,
      platformFee: true,
      feeVat: true,
      netAmount: true,
      donor: { select: { id: true, phoneMasked: true, displayName: true } },
      statusLogs: { orderBy: { createdAt: 'asc' } },
      transactions: {
        orderBy: { requestedAt: 'desc' },
        include: { attempts: { orderBy: { attemptNo: 'asc' } } },
      },
      chatDeliveries: { orderBy: { createdAt: 'desc' } },
      mtMessages: { orderBy: { createdAt: 'desc' } },
      refunds: { orderBy: { requestedAt: 'desc' } },
    },
  });

  if (!donation) notFound();

  const st = donationStatusLabel[donation.status];
  const blocked = donation.donor
    ? await prisma.blockedDonor.findUnique({
        where: { creatorId_donorId: { creatorId, donorId: donation.donor.id } },
        select: { createdAt: true },
      })
    : null;

  return (
    <>
      <PageHeader
        title="후원 상세"
        description={donation.transactionNo}
        action={
          <LinkButton href="/studio/donations" variant="secondary" size="sm">
            목록으로
          </LinkButton>
        }
      />

      <div className="space-y-5">
        <div className="grid gap-2.5 lg:grid-cols-3">
          <Card>
            <CardTitle>거래 정보</CardTitle>
            <div className="mt-2">
              <DataRow label="거래번호" value={<span className="font-mono text-[12px]">{donation.transactionNo}</span>} />
              <DataRow label="후원 상태" value={<Badge tone={st.tone}>{st.text}</Badge>} />
              <DataRow label="후원금" value={formatWon(donation.amount)} />
              <DataRow label="결제 모드" value={paymentModeLabel[donation.paymentMode]} />
              <DataRow label="수신시각" value={formatKst(donation.receivedAt)} />
              <DataRow label="결제시각" value={formatKst(donation.paidAt)} />
              <DataRow label="송출시각" value={formatKst(donation.broadcastedAt)} />
              {donation.statusReason ? <DataRow label="상태 사유" value={donation.statusReason} /> : null}
              {donation.isTest ? <DataRow label="테스트 여부" value={<Badge tone="warning">테스트 거래</Badge>} /> : null}
            </div>
          </Card>

          <Card>
            <CardTitle>후원자 · 메시지</CardTitle>
            <div className="mt-2">
              <DataRow label="후원자 번호" value={donation.donor?.phoneMasked ?? '-'} />
              <DataRow label="표시명" value={donation.anonymous ? '익명의 후원자' : donation.displayName} />
              <DataRow label="익명 처리" value={donation.anonymous ? '사용' : '미사용'} />
            </div>
            <p className="mt-3 rounded-xl bg-ink-50 px-3 py-2.5 text-[13px] leading-relaxed text-ink-700">
              {donation.message || '(내용 없음)'}
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
              방송 노출용 필터링 결과만 표시됩니다. 문자 원문과 후원자 전화번호 전체는 크리에이터에게 제공되지 않습니다.
            </p>
          </Card>

          <Card>
            <CardTitle>정산 금액</CardTitle>
            <div className="mt-2">
              <DataRow label="후원 총액" value={formatWon(donation.amount)} />
              <DataRow label="결제수수료" value={formatWon(donation.pgFee)} />
              <DataRow label="플랫폼수수료" value={formatWon(donation.platformFee)} />
              {donation.feeVat > 0n ? (
                <DataRow label="수수료 부가세" value={`${formatWon(donation.feeVat)} (위 수수료에 포함)`} />
              ) : null}
              <DataRow label="정산 예정금" value={formatWon(donation.netAmount)} />
            </div>
            <div className="mt-2">
              <DataRow label="유튜브 전송" value={<Badge tone={deliveryStatusLabel[donation.youtubeStatus].tone}>{deliveryStatusLabel[donation.youtubeStatus].text}</Badge>} />
              <DataRow label="오버레이" value={<Badge tone={deliveryStatusLabel[donation.overlayStatus].tone}>{deliveryStatusLabel[donation.overlayStatus].text}</Badge>} />
              <DataRow label="MT 안내" value={<Badge tone={deliveryStatusLabel[donation.mtStatus].tone}>{deliveryStatusLabel[donation.mtStatus].text}</Badge>} />
            </div>
          </Card>
        </div>

        <section>
          <SectionTitle title="후원 메시지에 답글" description="이 후원자에게만 표시됩니다. 문자 발송·방송 송출·결제에는 영향을 주지 않습니다." />
          {donation.donorId ? <Card className="mb-5">
            <ActionForm action={replyToDonationAction} submitLabel={donation.reply ? '답글 수정' : '답글 보내기'}>
              <input type="hidden" name="donationId" value={donation.id} />
              <label htmlFor="donation-reply" className="mb-2 block text-sm font-bold">크리에이터 답글</label>
              <textarea id="donation-reply" name="body" defaultValue={donation.reply?.body ?? ''} required maxLength={1000} rows={4} placeholder="응원해 주신 후원자에게 마음을 전해 보세요." className="mb-3 w-full resize-y rounded-xl border border-ink-200 bg-white p-3 text-sm leading-relaxed text-ink-900 focus:border-brand-500 focus:outline-none" />
              <p className="mb-3 text-xs text-ink-500">최대 1,000자 · 후원자는 내 문자후원 내역과 마이페이지에서 확인할 수 있습니다.</p>
            </ActionForm>
          </Card> : <Notice tone="neutral">연결된 후원자 정보가 없어 답글을 보낼 수 없습니다.</Notice>}
          <SectionTitle title="조치" description="아래 동작은 후원 상태를 변경하지 않습니다." />
          <div className="grid gap-2.5 lg:grid-cols-2">
            <Card>
              <CardTitle>오버레이 테스트 재생</CardTitle>
              <p className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-500">
                동일한 표시명·금액·메시지로 오버레이에 테스트 이벤트를 한 번 더 재생합니다. 실제 재송출이 아니며 후원
                상태, 유튜브 전송, 정산에는 아무 영향이 없습니다.
              </p>
              <ActionForm
                action={replayOverlayTestAction}
                submitLabel="테스트 재생"
                pendingLabel="재생 중"
                variant="secondary"
                size="sm"
                confirmTitle="오버레이에 다시 재생할까요?"
                confirmMessage="같은 표시명 · 금액 · 메시지로 오버레이에 한 번 더 표시됩니다. 방송 중이라면 시청자 화면에도 보입니다. 후원 상태 · 유튜브 전송 · 정산에는 영향이 없습니다."
                confirmActionLabel="재생"
                doneTitle="테스트 재생을 보냈습니다"
              >
                <input type="hidden" name="donationId" value={donation.id} />
              </ActionForm>
            </Card>

            <Card>
              <CardTitle>후원자 차단</CardTitle>
              {donation.donor ? (
                blocked ? (
                  <Notice tone="warning">
                    이미 차단된 후원자입니다. ({formatKst(blocked.createdAt, false)} 차단) 해제는 금칙어·차단 메뉴에서
                    할 수 있습니다.
                  </Notice>
                ) : (
                  <>
                    <p className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-500">
                      차단하면 이 후원자({donation.donor.phoneMasked})의 이후 문자는 후원으로 접수되지 않습니다.
                    </p>
                    <ActionForm
                      action={blockDonorAction}
                      submitLabel="후원자 차단"
                      variant="danger"
                      size="sm"
                      confirmMessage="이 후원자를 차단하시겠습니까? 이후 문자는 후원으로 접수되지 않습니다."
                    >
                      <input type="hidden" name="donorId" value={donation.donor.id} />
                      <input type="hidden" name="reason" value={`후원 상세(${donation.transactionNo})에서 차단`} />
                    </ActionForm>
                  </>
                )
              ) : (
                <Notice tone="neutral">연결된 후원자 프로필이 없어 차단할 수 없습니다.</Notice>
              )}
            </Card>
          </div>
        </section>

        <section>
          <SectionTitle title="상태 이력" />
          {donation.statusLogs.length === 0 ? (
            <EmptyState title="상태 이력이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>이전 상태</Th>
                  <Th>변경 상태</Th>
                  <Th>사유</Th>
                  <Th>처리자</Th>
                </tr>
              </thead>
              <tbody>
                {donation.statusLogs.map((log) => (
                  <tr key={log.id}>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(log.createdAt)}</Td>
                    <Td>{log.fromStatus ? donationStatusLabel[log.fromStatus].text : '-'}</Td>
                    <Td>
                      <Badge tone={donationStatusLabel[log.toStatus].tone}>{donationStatusLabel[log.toStatus].text}</Badge>
                    </Td>
                    <Td>{log.reason ?? '-'}</Td>
                    <Td>{log.actor ?? '-'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle title="결제 시도" description="카드번호·계좌 등 금융정보는 표시되지 않습니다." />
          {donation.transactions.length === 0 ? (
            <EmptyState title="결제 시도 내역이 없습니다" />
          ) : (
            <div className="space-y-2.5">
              {donation.transactions.map((tx) => {
                const tone = paymentTxStatusLabel[tx.status];
                return (
                  <Card key={tx.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12px] font-semibold text-ink-900">{tx.orderNo}</span>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                        <span className="text-[12px] text-ink-400">{tx.provider}</span>
                      </div>
                      <span className="text-[13px] font-semibold tabular-nums">{formatWon(tx.amount)}</span>
                    </div>
                    <div className="mt-2">
                      <DataRow label="요청시각" value={formatKst(tx.requestedAt)} />
                      <DataRow label="승인시각" value={formatKst(tx.approvedAt)} />
                      {tx.resultCode || tx.resultMessage ? (
                        <DataRow label="결과" value={`${tx.resultCode ?? '-'} ${tx.resultMessage ?? ''}`.trim()} />
                      ) : null}
                    </div>
                    {tx.attempts.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {tx.attempts.map((a) => (
                          <li key={a.id} className="rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">
                            <span className="font-semibold">
                              {a.attemptNo}차 · {a.operation}
                            </span>
                            <span className="ml-2 text-ink-400">{formatKst(a.createdAt)}</span>
                            {a.latencyMs != null ? <span className="ml-2 text-ink-400">{a.latencyMs}ms</span> : null}
                            {a.errorCode ? (
                              <span className="ml-2 text-danger-600">
                                {a.errorCode} {a.errorMessage ?? ''}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <SectionTitle title="유튜브 전송 로그" />
          {donation.chatDeliveries.length === 0 ? (
            <EmptyState title="유튜브 전송 시도가 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>상태</Th>
                  <Th>시도</Th>
                  <Th>라이브 채팅 ID</Th>
                  <Th>할당량</Th>
                  <Th>오류</Th>
                </tr>
              </thead>
              <tbody>
                {donation.chatDeliveries.map((d) => {
                  const tone = deliveryStatusLabel[d.status];
                  return (
                    <tr key={d.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(d.sentAt ?? d.createdAt)}</Td>
                      <Td>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                      </Td>
                      <Td className="tabular-nums">{d.attempts}</Td>
                      <Td className="font-mono text-[12px]">{d.liveChatId ?? '-'}</Td>
                      <Td className="tabular-nums">{d.quotaUnits}</Td>
                      <Td>{d.errorCode ? `${d.errorCode} ${d.errorMessage ?? ''}`.trim() : '-'}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle title="MT 발송 로그" description="발송 본문은 보안 링크 토큰이 제거된 마스킹 값입니다." />
          {donation.mtMessages.length === 0 ? (
            <EmptyState title="MT 발송 내역이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>상태</Th>
                  <Th>수신번호</Th>
                  <Th>템플릿</Th>
                  <Th>본문(마스킹)</Th>
                  <Th>결과</Th>
                </tr>
              </thead>
              <tbody>
                {donation.mtMessages.map((m) => {
                  const tone = deliveryStatusLabel[m.status];
                  return (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(m.sentAt ?? m.createdAt)}</Td>
                      <Td>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap">{m.phoneMasked}</Td>
                      <Td>{m.templateCode ?? '-'}</Td>
                      <Td className="max-w-[320px]">
                        <span className="line-clamp-2">{m.bodyMasked}</span>
                      </Td>
                      <Td>{m.resultCode ? `${m.resultCode} ${m.resultMessage ?? ''}`.trim() : '-'}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>

        {donation.refunds.length > 0 ? (
          <section>
            <SectionTitle title="환불 내역" />
            <Table>
              <thead>
                <tr>
                  <Th>요청시각</Th>
                  <Th>상태</Th>
                  <Th className="text-right">금액</Th>
                  <Th>사유</Th>
                  <Th>처리시각</Th>
                </tr>
              </thead>
              <tbody>
                {donation.refunds.map((r) => {
                  const tone = refundStatusLabel[r.status];
                  return (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(r.requestedAt)}</Td>
                      <Td>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{formatWon(r.amount)}</Td>
                      <Td>{r.reason ?? '-'}</Td>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(r.processedAt)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </section>
        ) : null}
      </div>
    </>
  );
}
