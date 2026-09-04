import { Badge, Card, CardTitle, DataRow, EmptyState, LinkButton, Notice, SectionTitle, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { one, type SearchParamsRecord } from '@/components/studio/shared';
import { disconnectYouTubeAction, refreshYouTubeBroadcastAction } from '@/app/actions/studio';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatChatMessage, getYouTubeAdapter } from '@/server/adapters/youtube';
import { createYouTubeOAuthState } from '@/server/services/youtube-connection';
import { getYouTubeQuotaUsage } from '@/server/services/youtube-quota';
import { formatKst } from '@/lib/datetime';
import { deliveryStatusLabel, youtubeDeliveryReasonLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

/**
 * 크리에이터 유튜브 화면.
 *
 * 크리에이터가 하는 일은 "내 채널 연결" 하나뿐이다.
 * API 키·OAuth 클라이언트·일일 할당량 같은 연동 설정은 통합 관리자가 처리하므로
 * 이 화면에는 노출하지 않는다. (관리자: /admin/youtube)
 */

const CONNECTION_LABEL = {
  CONNECTED: { text: '연결됨', tone: 'success' as const },
  EXPIRED: { text: '토큰 만료', tone: 'warning' as const },
  REVOKED: { text: '연결 해제', tone: 'neutral' as const },
  ERROR: { text: '오류', tone: 'danger' as const },
};

const CALLBACK_MESSAGE: Record<string, { tone: 'success' | 'warning' | 'danger'; text: string }> = {
  connected: { tone: 'success', text: '유튜브 채널을 연결했습니다.' },
  denied: { tone: 'warning', text: '채널 연결 동의가 거부되었습니다.' },
  invalid: { tone: 'danger', text: '인증 응답이 올바르지 않습니다. 다시 시도해 주세요.' },
  state_mismatch: { tone: 'danger', text: '요청 검증에 실패했습니다(state 불일치). 다시 시도해 주세요.' },
  state_expired: {
    tone: 'warning',
    text: '연결 요청이 만료되었거나 이미 사용되었습니다. 이 화면에서 [구글 계정으로 채널 연결]을 다시 눌러 주세요.',
  },
  scope_missing: {
    tone: 'danger',
    text: '구글 동의 화면에서 "실시간 채팅 관리" 권한이 허용되지 않았습니다. 이 권한이 없으면 후원 메시지를 채팅에 올릴 수 없습니다. 다시 연결하면서 모든 항목에 동의해 주세요.',
  },
  token_failed: { tone: 'danger', text: '액세스 토큰 발급에 실패했습니다.' },
  channel_failed: { tone: 'danger', text: '채널 정보 조회에 실패했습니다.' },
  error: { tone: 'danger', text: '연결 처리 중 오류가 발생했습니다.' },
};

export default async function StudioYouTubePage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const { creatorId } = await requireCreator();
  const sp = await searchParams;
  const callback = CALLBACK_MESSAGE[one(sp.youtube)];

  const [connection, broadcast, deliveries, quota] = await Promise.all([
    prisma.youTubeConnection.findUnique({ where: { creatorId } }),
    prisma.youTubeBroadcast.findFirst({ where: { creatorId }, orderBy: { detectedAt: 'desc' } }),
    prisma.youTubeChatDelivery.findMany({
      where: { donation: { creatorId } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        attempts: true,
        errorCode: true,
        errorMessage: true,
        sentAt: true,
        createdAt: true,
        donation: { select: { id: true, transactionNo: true, displayName: true } },
      },
    }),
    // 할당량 저장소가 죽어도 이 화면은 열려야 한다. 조회 실패는 "확인 불가"로 표시한다.
    getYouTubeQuotaUsage().catch(() => null),
  ]);

  let authUrl: string | null = null;
  let adapterMode = 'mock';
  let adapterUnavailable = false;
  try {
    const adapter = getYouTubeAdapter();
    adapterMode = adapter.info().mode;
    authUrl = adapter.getAuthUrl(await createYouTubeOAuthState(creatorId));
  } catch {
    // 어댑터 예외 원문에는 설정 키 이름·경로가 담긴다. 크리에이터 화면에 그대로 노출하지 않는다.
    // (관리자 화면 /admin/youtube 에서 설정 상태를 확인한다)
    adapterUnavailable = true;
  }

  const connected = connection?.status === 'CONNECTED';
  const connLabel = connection ? CONNECTION_LABEL[connection.status] : null;

  const preview = formatChatMessage({
    donorName: '홍길동',
    amount: 3000n,
    message: '오늘 방송 재미있어요',
  });

  return (
    <>
      <PageHeader
        title="유튜브 채널 연결"
        description="내 유튜브 채널을 연결하면 결제가 완료된 후원 메시지가 라이브 채팅에 자동으로 올라갑니다."
      />

      <div className="space-y-5">
        {callback ? <Notice tone={callback.tone}>{callback.text}</Notice> : null}

        {adapterUnavailable ? (
          <Notice tone="danger" title="유튜브 연동이 아직 준비되지 않았습니다">
            구글 OAuth 승인 절차가 끝나지 않아 지금은 채널을 연결할 수 없습니다. 통합 관리자가 설정을 마치면 이 화면에서
            바로 연결할 수 있습니다.
          </Notice>
        ) : adapterMode === 'mock' ? (
          <Notice tone="warning" title="현재 모의(mock) 연동 상태입니다">
            실제 구글 계정과 연결되지 않으며 채팅 전송도 실제로 이루어지지 않습니다. API 키와 구글 OAuth 승인은 통합
            관리자가 처리하며, 완료되면 이 화면에서 바로 실제 채널을 연결할 수 있습니다.
          </Notice>
        ) : null}

        {connected && quota ? (
          <Notice
            tone={quota.remainingMessages <= 0 ? 'danger' : quota.remainingMessages < 20 ? 'warning' : 'neutral'}
            title={
              quota.remainingMessages <= 0
                ? '오늘 유튜브 채팅 전송 한도를 모두 썼습니다'
                : `오늘 남은 유튜브 채팅 전송: 약 ${quota.remainingMessages.toLocaleString()}건`
            }
          >
            유튜브가 허용하는 하루 전송량에는 상한이 있습니다. 한도를 넘으면 후원 메시지가 라이브 채팅에 올라가지
            않지만 <strong>결제와 정산은 정상 처리</strong>되고 방송 화면 오버레이도 그대로 표시됩니다. 한도는 태평양시
            자정(한국시간 오후 4~5시경)에 초기화됩니다.
          </Notice>
        ) : null}

        <section>
          <SectionTitle title="내 채널" description="구글 계정으로 로그인해 채널 사용 권한을 허용하면 연결됩니다." />
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{connection?.channelTitle ?? '연결된 채널 없음'}</CardTitle>
              {connLabel ? <Badge tone={connLabel.tone}>{connLabel.text}</Badge> : <Badge tone="neutral">미연결</Badge>}
            </div>

            {connection?.status === 'EXPIRED' ? (
              <div className="mb-3">
                <Notice tone="warning" title="로그인 유효기간이 만료되었습니다">
                  일시적인 오류일 수 있습니다. 아래 [현재 라이브 방송 조회]를 눌러 자동 복구를 한 번 시도해 보시고,
                  계속 실패하면 [다른 채널로 다시 연결]로 구글 계정 연결을 새로 해 주세요. 복구 전까지는 후원 메시지가
                  라이브 채팅에 올라가지 않습니다.
                </Notice>
              </div>
            ) : null}

            {connection ? (
              <div>
                <DataRow label="채널 ID" value={<span className="font-mono text-[12px]">{connection.channelId}</span>} />
                <DataRow label="연결 갱신" value={formatKst(connection.lastCheckedAt)} />
                <DataRow
                  label="연결 상태 점검"
                  value={
                    connection.lastError ? (
                      // 구글 API 응답 원문에는 내부 설정 정보가 섞일 수 있어 그대로 노출하지 않는다.
                      <span className="text-danger-600">
                        마지막 시도에서 문제가 있었습니다. [현재 라이브 방송 조회]로 재시도해 보세요.
                      </span>
                    ) : (
                      '정상'
                    )
                  }
                />
              </div>
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-500">
                아직 연결된 채널이 없습니다. 아래 버튼을 눌러 구글 계정으로 로그인하고 채널을 연결해 주세요. 연결 후에는
                결제가 완료된 후원만 라이브 채팅에 표시됩니다.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-start gap-2">
              {authUrl ? (
                <LinkButton href={authUrl} prefetch={false} size="sm">
                  {connection ? '다른 채널로 다시 연결' : '구글 계정으로 채널 연결'}
                </LinkButton>
              ) : null}
              {connected ? (
                <ActionForm
                  action={disconnectYouTubeAction}
                  submitLabel="연결 해제"
                  variant="secondary"
                  size="sm"
                  confirmMessage="유튜브 채널 연결을 해제하시겠습니까? 이후 후원 메시지가 라이브 채팅에 등록되지 않습니다."
                />
              ) : null}
            </div>
          </Card>
        </section>

        <section>
          <SectionTitle title="현재 라이브 방송" description="연결된 채널에서 진행 중인 방송을 조회합니다." />
          <Card>
            {broadcast ? (
              <div className="mb-3">
                <DataRow label="방송 제목" value={broadcast.title ?? '-'} />
                <DataRow
                  label="채팅 활성 여부"
                  value={
                    <Badge tone={broadcast.chatEnabled ? 'success' : 'danger'}>
                      {broadcast.chatEnabled ? '활성' : '비활성'}
                    </Badge>
                  }
                />
                <DataRow label="시작 시각" value={formatKst(broadcast.startedAt)} />
                <DataRow label="마지막 조회" value={formatKst(broadcast.detectedAt)} />
              </div>
            ) : (
              <p className="mb-3 text-[13px] leading-relaxed text-ink-500">
                아직 조회된 라이브 방송이 없습니다. 방송을 시작한 뒤 아래 버튼으로 조회해 주세요.
              </p>
            )}
            <ActionForm
              action={refreshYouTubeBroadcastAction}
              submitLabel="현재 라이브 방송 조회"
              variant="secondary"
              size="sm"
            />
          </Card>
        </section>

        <section>
          <SectionTitle title="채팅에 표시되는 형식" />
          <Card>
            <p className="rounded-xl bg-ink-50 px-4 py-3 text-[13.5px] leading-relaxed text-ink-900">{preview}</p>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-500">
              유튜브 공식 슈퍼챗이 아니며 연결된 채널 계정으로 표시됩니다. 유튜브에는 결제 정보가 전달되지 않습니다.
            </p>
          </Card>
        </section>

        <section>
          <SectionTitle title="최근 전송 결과" description="최근 20건입니다. 전송 실패는 결제 결과에 영향을 주지 않습니다." />
          {deliveries.length === 0 ? (
            <EmptyState title="전송 내역이 없습니다" description="결제가 완료된 후원이 발생하면 여기에 기록됩니다." />
          ) : (
            <Table className="min-w-full">
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>거래번호</Th>
                  <Th>표시명</Th>
                  <Th>상태</Th>
                  <Th>시도</Th>
                  <Th>오류</Th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const tone = deliveryStatusLabel[d.status];
                  return (
                    <tr key={d.id}>
                      <Td className="whitespace-nowrap tabular-nums">{formatKst(d.sentAt ?? d.createdAt, false)}</Td>
                      <Td className="font-mono text-[12px]">{d.donation.transactionNo}</Td>
                      <Td className="whitespace-nowrap">{d.donation.displayName}</Td>
                      <Td>
                        <Badge tone={tone.tone}>{tone.text}</Badge>
                      </Td>
                      <Td className="tabular-nums">{d.attempts}</Td>
                      <Td>{youtubeDeliveryReasonLabel(d.errorCode)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
