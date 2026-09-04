import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionButton } from '@/components/admin/action-form';
import { shortId } from '@/components/admin/mask';
import { prisma } from '@/server/db';
import { disconnectYouTube } from '@/app/actions/admin/broadcast';
import { getYouTubeQuotaUsage } from '@/server/services/broadcast-dispatch';
import { env } from '@/lib/env';
import { formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import { deliveryStatusLabel } from '@/lib/labels';
import type { YouTubeConnectionStatus } from '@/generated/prisma/enums';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

const connStatusTone: Record<YouTubeConnectionStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  CONNECTED: 'success',
  EXPIRED: 'warning',
  REVOKED: 'neutral',
  ERROR: 'danger',
};

const connStatusText: Record<YouTubeConnectionStatus, string> = {
  CONNECTED: '연결됨',
  EXPIRED: '토큰 만료',
  REVOKED: '해제됨',
  ERROR: '오류',
};

export default async function AdminYouTubePage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/youtube');

  const todayStart = kstStartOfDay();

  const [connections, quota, recentFailures, todayDeliveries, broadcasts] = await Promise.all([
    prisma.youTubeConnection.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, creatorId: true, channelId: true, channelTitle: true, scope: true,
        status: true, expiresAt: true, lastError: true, lastCheckedAt: true, updatedAt: true,
        creator: { select: { id: true, displayName: true, code: true, status: true } },
      },
    }),
    getYouTubeQuotaUsage(),
    prisma.youTubeChatDelivery.findMany({
      where: { status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true, errorCode: true, errorMessage: true, createdAt: true, attempts: true,
        donation: { select: { creatorId: true, transactionNo: true, creator: { select: { displayName: true } } } },
      },
    }),
    prisma.youTubeChatDelivery.groupBy({
      by: ['status'],
      where: { createdAt: { gte: todayStart } },
      _count: { _all: true },
      _sum: { quotaUnits: true },
    }),
    prisma.youTubeBroadcast.findMany({
      orderBy: { detectedAt: 'desc' },
      take: 10,
      select: {
        id: true, broadcastId: true, title: true, lifeCycle: true, chatEnabled: true,
        startedAt: true, endedAt: true, detectedAt: true,
        creator: { select: { id: true, displayName: true } },
      },
    }),
  ]);

  const failureByCreator = new Map<string, number>();
  for (const f of recentFailures) {
    const key = f.donation.creatorId;
    failureByCreator.set(key, (failureByCreator.get(key) ?? 0) + 1);
  }

  const todaySent = todayDeliveries.find((d) => d.status === 'SENT')?._count._all ?? 0;
  const todayFailed = todayDeliveries.find((d) => d.status === 'FAILED')?._count._all ?? 0;
  const todaySkipped = todayDeliveries.find((d) => d.status === 'SKIPPED')?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="유튜브 연동 관리"
        description="크리에이터별 채널 연결 상태와 채팅 전송 실패를 확인합니다. 유튜브 전송 실패는 결제 결과를 바꾸지 않습니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="일일 할당량 사용"
          value={`${formatNumber(quota.used)} / ${formatNumber(quota.total)}`}
          sub={`잔여 약 ${formatNumber(quota.remainingMessages)}건 전송 가능`}
          tone={quota.used / Math.max(1, quota.total) > 0.8 ? 'warning' : 'brand'}
        />
        <StatTile label="오늘 전송 성공" value={formatNumber(todaySent)} tone="success" />
        <StatTile label="오늘 전송 실패" value={formatNumber(todayFailed)} tone={todayFailed > 0 ? 'danger' : 'neutral'} />
        <StatTile label="오늘 건너뜀" value={formatNumber(todaySkipped)} sub="방송 미감지·할당량 초과 등" />
      </div>

      {env.youtube.provider === 'mock' ? (
        <Notice tone="warning" title="유튜브 어댑터가 mock 으로 동작 중입니다">
          실제 유튜브 API 호출이 발생하지 않습니다. 화면의 전송 성공/실패는 모의 결과이며, OAuth 클라이언트와 API 키를
          등록하고 어댑터를 교체해야 실제 채팅 송출이 시작됩니다.
        </Notice>
      ) : null}

      <div className="mt-4">
        <SectionTitle
          title="API 연동 설정"
          description="YouTube Data API v3 키와 OAuth 클라이언트는 관리자만 설정합니다. 크리에이터는 자기 채널 연결만 수행합니다."
        />
        <div className="rounded-[20px] border border-ink-100 bg-white p-4 shadow-[0_10px_30px_rgba(23,22,26,0.05)] sm:p-5">
          <div className="grid gap-x-6 sm:grid-cols-2">
            <ConfigRow label="어댑터 모드" value={env.youtube.provider} ok={env.youtube.provider !== 'mock'} />
            <ConfigRow
              label="API 키 (YOUTUBE_API_KEY)"
              value={env.youtube.apiKey ? '등록됨' : '미등록'}
              ok={Boolean(env.youtube.apiKey)}
            />
            <ConfigRow label="일일 할당량" value={`${formatNumber(quota.total)} units`} ok />
            <ConfigRow label="전송 1건당 비용" value={`${formatNumber(quota.insertCost)} units`} ok />
          </div>
          <p className="mt-3 border-t border-ink-100 pt-3 text-[12px] leading-relaxed text-ink-400">
            키와 클라이언트 정보는 화면에 저장하지 않고 서버 환경변수(<span className="font-mono">.env</span>)로만
            관리합니다. 값을 바꾼 뒤에는 서버를 재시작해야 반영됩니다. 라이브 채팅 등록은 할당량 비용이 커서 증설 신청
            전에는 하루 전송 건수가 제한됩니다.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <SectionTitle title="채널 연결 상태" description={`전송 1건당 할당량 ${formatNumber(quota.insertCost)} 단위를 사용합니다.`} />
        {connections.length === 0 ? (
          <EmptyState title="연결된 유튜브 채널이 없습니다" description="크리에이터 스튜디오에서 채널을 연결하면 이곳에 표시됩니다." />
        ) : (
          <Table className="min-w-[1100px]">
            <thead>
              <tr>
                <Th>크리에이터</Th>
                <Th>채널</Th>
                <Th>상태</Th>
                <Th>토큰 만료</Th>
                <Th>마지막 점검</Th>
                <Th>마지막 오류</Th>
                <Th className="text-right">최근 실패</Th>
                <Th>처리</Th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => {
                const expired = c.expiresAt < new Date();
                const failures = failureByCreator.get(c.creatorId) ?? 0;
                return (
                  <tr key={c.id}>
                    <Td>
                      <Link href={`/admin/creators/${c.creator.id}`} className="font-semibold text-brand-700">
                        {c.creator.displayName}
                      </Link>
                      <span className="mt-0.5 block text-[11px] text-ink-400">{c.creator.code}</span>
                    </Td>
                    <Td>
                      {c.channelTitle ?? '-'}
                      <span className="mt-0.5 block font-mono text-[11px] text-ink-400">{shortId(c.channelId, 10, 4)}</span>
                    </Td>
                    <Td>
                      <Badge tone={connStatusTone[c.status]}>{connStatusText[c.status]}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {formatKst(c.expiresAt, false)}
                      {expired && c.status === 'CONNECTED' ? (
                        <span className="mt-0.5 block text-[11px] text-warning-600">만료됨 · 재인증 필요</span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(c.lastCheckedAt, false)}</Td>
                    <Td className="max-w-[220px] break-words">{c.lastError ?? '-'}</Td>
                    <Td className="text-right tabular-nums">
                      <span className={failures > 0 ? 'font-semibold text-danger-600' : ''}>{formatNumber(failures)}</span>
                    </Td>
                    <Td>
                      {c.status === 'REVOKED' ? (
                        <span className="text-[12px] text-ink-300">해제됨</span>
                      ) : (
                        <ActionButton
                          action={disconnectYouTube}
                          values={{ creatorId: c.creatorId }}
                          label="연결 강제 해제"
                          variant="danger"
                          confirm="연결을 해제하고 저장된 토큰을 폐기합니다. 크리에이터가 다시 연결해야 합니다."
                        />
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section>
          <SectionTitle title="최근 전송 실패" description="최근 실패 20건" />
          {recentFailures.length === 0 ? (
            <EmptyState title="최근 전송 실패가 없습니다" />
          ) : (
            <Table className="min-w-0">
              <thead>
                <tr>
                  <Th>시각</Th>
                  <Th>크리에이터</Th>
                  <Th>거래번호</Th>
                  <Th className="text-right">시도</Th>
                  <Th>오류</Th>
                </tr>
              </thead>
              <tbody>
                {recentFailures.slice(0, 20).map((f) => (
                  <tr key={f.id}>
                    <Td className="whitespace-nowrap">{formatKst(f.createdAt, false)}</Td>
                    <Td>{f.donation.creator.displayName}</Td>
                    <Td className="font-mono text-[11px]">{f.donation.transactionNo}</Td>
                    <Td className="text-right tabular-nums">{formatNumber(f.attempts)}</Td>
                    <Td className="max-w-[200px] break-words">
                      <span className="font-semibold text-danger-600">{f.errorCode ?? '-'}</span>
                      {f.errorMessage ? <span className="block text-ink-500">{f.errorMessage}</span> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section>
          <SectionTitle title="최근 감지된 방송" description="라이브 채팅 대상이 되는 방송 목록" />
          {broadcasts.length === 0 ? (
            <EmptyState title="감지된 방송이 없습니다" />
          ) : (
            <Table className="min-w-0">
              <thead>
                <tr>
                  <Th>감지 시각</Th>
                  <Th>크리에이터</Th>
                  <Th>제목</Th>
                  <Th>상태</Th>
                  <Th>채팅</Th>
                </tr>
              </thead>
              <tbody>
                {broadcasts.map((b) => (
                  <tr key={b.id}>
                    <Td className="whitespace-nowrap">{formatKst(b.detectedAt, false)}</Td>
                    <Td>
                      <Link href={`/admin/creators/${b.creator.id}`} className="font-semibold text-brand-700">
                        {b.creator.displayName}
                      </Link>
                    </Td>
                    <Td className="max-w-[200px] break-words">{b.title ?? '-'}</Td>
                    <Td>{b.lifeCycle ?? '-'}</Td>
                    <Td>
                      <Badge tone={b.chatEnabled ? 'success' : 'neutral'}>{b.chatEnabled ? '사용' : '비활성'}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>

      <div className="mt-5">
        <Notice tone="neutral" title="전송 상태 값">
          {(['SENT', 'FAILED', 'SKIPPED', 'PENDING'] as const)
            .map((s) => `${deliveryStatusLabel[s].text}(${s})`)
            .join(' · ')}{' '}
          — 할당량 초과나 방송 미감지로 건너뛴 건은 실패가 아니라 건너뜀으로 기록됩니다.
        </Notice>
      </div>
    </>
  );
}

/** 연동 설정 한 줄 (키 원문은 절대 표시하지 않고 등록 여부만 보여준다) */
function ConfigRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-100 py-2 last:border-b-0">
      <span className="text-[12.5px] font-semibold text-ink-500">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12.5px] text-ink-900">{value}</span>
        <Badge tone={ok ? 'success' : 'warning'}>{ok ? '정상' : '설정 필요'}</Badge>
      </span>
    </div>
  );
}
