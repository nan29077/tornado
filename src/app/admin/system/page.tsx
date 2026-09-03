import { Database, Server, Signal, TriangleAlert } from 'lucide-react';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, SectionTitle, StatTile, Table, Th, Td, Badge, EmptyState, Notice, DataRow } from '@/components/ui';
import { SafetyBanner } from '@/components/admin/safety-banner';
import { shortId } from '@/components/admin/mask';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { env } from '@/lib/env';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { getYouTubeQuotaUsage } from '@/server/services/broadcast-dispatch';
import { readEmmaPollHealth } from '@/server/emma';
import { moResultLabel } from '@/lib/labels';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

async function checkDatabase(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, detail: '정상', latencyMs: Date.now() - t0 };
  } catch (e) {
    // 예외 원문에는 호스트·포트·DB명·사용자명이 섞여 나온다. 화면에는 분류만 남긴다.
    logger.error('시스템 상태 점검 실패(DB)', { message: (e as Error).message });
    return { ok: false, detail: '연결 실패 (자세한 내용은 서버 로그를 확인해 주세요)', latencyMs: Date.now() - t0 };
  }
}

async function checkCache(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    await kv.set('health:admin:ping', '1', 10);
    const v = await kv.get('health:admin:ping');
    return v === '1'
      ? { ok: true, detail: '정상', latencyMs: Date.now() - t0 }
      : { ok: false, detail: '읽기/쓰기 결과 불일치', latencyMs: Date.now() - t0 };
  } catch (e) {
    // 예외 원문에는 호스트·포트·DB명·사용자명이 섞여 나온다. 화면에는 분류만 남긴다.
    logger.error('시스템 상태 점검 실패(캐시)', { message: (e as Error).message });
    return { ok: false, detail: '연결 실패 (자세한 내용은 서버 로그를 확인해 주세요)', latencyMs: Date.now() - t0 };
  }
}

export default async function AdminSystemPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/system');

  /**
   * **이 화면은 장애 중에도 반드시 열려야 한다.**
   *
   * 예전에는 할당량 조회와 목록 조회 네 개가 무방비였다. 운영 권장값인
   * `ALLOW_INMEMORY_FALLBACK=false` 에서는 Redis 장애가 그대로 예외로 올라오고,
   * DB 장애면 목록 조회가 던진다. 그러면 `checkDatabase()`/`checkCache()` 가 "오류" 타일을
   * 정성껏 그려도 페이지 전체가 500 이 되어 **장애를 진단할 수단이 장애 때 사라졌다.**
   * 모든 부가 조회를 개별적으로 감싸고, 실패하면 "조회 실패"로 표시한다.
   */
  const [db, cache, quota, webhooks, moErrors, paymentErrors, emmaPoll] = await Promise.all([
    checkDatabase(),
    checkCache(),
    getYouTubeQuotaUsage().catch(() => null),
    prisma.webhookLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, source: true, endpoint: true, method: true, signatureOk: true,
        statusCode: true, latencyMs: true, ip: true, responseNote: true, createdAt: true,
      },
    }).catch(() => []),
    prisma.moInboundMessage.findMany({
      where: { result: { in: ['ERROR', 'UNKNOWN_ROUTE'] } },
      orderBy: { receivedAt: 'desc' },
      take: 10,
      select: { id: true, receivedNumber: true, result: true, resultDetail: true, receivedAt: true },
    }).catch(() => []),
    prisma.paymentAttempt.findMany({
      where: { errorCode: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, operation: true, errorCode: true, errorMessage: true, latencyMs: true, createdAt: true,
        transaction: { select: { orderNo: true, status: true } },
      },
    }).catch(() => []),
    /**
     * EMMA MO 폴링 생존 여부(E-8).
     *
     * 배치가 멈추면 문자가 들어와도 후원이 만들어지지 않는데 어디에도 오류가 뜨지 않는다.
     * 스케줄러 주기는 1분이므로, 5분 넘게 흔적이 없으면 멈춘 것으로 본다.
     */
    readEmmaPollHealth().catch(() => ({ at: null, ageSec: null, stalled: true })),
  ]);

  const emmaStalled = env.emma.enabled && emmaPoll.stalled;

  const providers: Array<{ label: string; mode: string }> = [
    { label: '결제(PG)', mode: env.payment.provider },
    { label: 'MO 수신', mode: env.mo.provider },
    { label: 'MT 발송', mode: env.mt.provider },
    { label: '유튜브', mode: env.youtube.provider },
    { label: 'TTS', mode: env.tts.provider },
    { label: '암호화', mode: env.crypto.provider },
  ];

  const signatureFailures = webhooks.filter((w) => !w.signatureOk).length;

  return (
    <>
      <PageHeader
        title="시스템 상태"
        description="/api/health 와 동일한 점검을 관리자 화면에서 직접 수행합니다. 새로고침할 때마다 재점검합니다."
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile
            label="데이터베이스"
            value={db.ok ? '정상' : '오류'}
            sub={`${db.latencyMs}ms · ${db.ok ? 'PostgreSQL 연결' : db.detail.slice(0, 60)}`}
            tone={db.ok ? 'success' : 'danger'}
          />
          <StatTile
            label="캐시(Redis)"
            value={cache.ok ? '정상' : '오류'}
            sub={`${cache.latencyMs}ms · ${env.redisUrl ? 'Redis' : `인메모리 폴백 ${env.allowInMemoryFallback ? '허용' : '금지'}`}`}
            tone={cache.ok ? 'success' : 'danger'}
          />
          <StatTile
            label="유튜브 할당량"
            value={quota ? `${formatNumber(quota.used)} / ${formatNumber(quota.total)}` : '확인 불가'}
            sub={
              quota
                ? `전송 1건당 ${formatNumber(quota.insertCost)} · 잔여 약 ${formatNumber(quota.remainingMessages)}건 · 태평양시 자정 초기화`
                : '카운터 저장소(Redis)에 연결하지 못했습니다.'
            }
            tone={!quota ? 'danger' : quota.used / Math.max(1, quota.total) > 0.8 ? 'warning' : 'neutral'}
          />
          <StatTile
            label="Webhook 서명 실패"
            value={`${formatNumber(signatureFailures)} / ${formatNumber(webhooks.length)}`}
            sub="최근 30건 기준"
            tone={signatureFailures > 0 ? 'danger' : 'success'}
          />
        </div>

        <SafetyBanner />

        <section>
          <SectionTitle title="외부 연동 모드" description="mock 은 실제 외부 호출 없이 모의 응답을 반환합니다." />
          <Card>
            {providers.map((p) => (
              <DataRow
                key={p.label}
                label={p.label}
                value={
                  <Badge tone={p.mode === 'mock' || p.mode === 'local' ? 'warning' : 'success'}>{p.mode}</Badge>
                }
              />
            ))}
            <DataRow label="APP_BASE_URL" value={env.baseUrl} />
            <DataRow label="MO 허용 IP" value={env.mo.allowedIps.length > 0 ? env.mo.allowedIps.join(', ') : '미설정'} />
            <DataRow
              label="EMMA MO 폴링"
              value={
                !env.emma.enabled ? (
                  <Badge tone="neutral">사용 안 함</Badge>
                ) : (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={emmaStalled ? 'danger' : 'success'}>{emmaStalled ? '정지 의심' : '정상'}</Badge>
                    <span className="text-[12px] text-ink-400">
                      {emmaPoll.at
                        ? `마지막 폴링 ${formatKst(emmaPoll.at)} (${formatNumber(emmaPoll.ageSec ?? 0)}초 전)`
                        : '기록 없음 — 폴링 배치(/api/cron/emma-mo)가 한 번도 성공하지 않았습니다.'}
                    </span>
                  </span>
                )
              }
            />
          </Card>
        </section>

        <section>
          <SectionTitle
            title="최근 Webhook 로그 30건"
            description="서명 검증 결과와 응답 지연을 함께 확인합니다. 본문은 마스킹 스냅샷만 저장됩니다."
          />
          {webhooks.length === 0 ? (
            <EmptyState title="수신된 Webhook 이 없습니다" description="MO 사업자 연동 전에는 시뮬레이터로 흐름을 검증하세요." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>수신 시각</Th>
                  <Th>출처</Th>
                  <Th>엔드포인트</Th>
                  <Th>서명</Th>
                  <Th className="text-right">상태코드</Th>
                  <Th className="text-right">지연</Th>
                  <Th>IP</Th>
                  <Th>비고</Th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id}>
                    <Td className="whitespace-nowrap">{formatKst(w.createdAt)}</Td>
                    <Td>{w.source}</Td>
                    <Td className="font-mono text-[12px]">{`${w.method} ${w.endpoint}`}</Td>
                    <Td>
                      <Badge tone={w.signatureOk ? 'success' : 'danger'}>{w.signatureOk ? '검증 성공' : '검증 실패'}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{w.statusCode ?? '-'}</Td>
                    <Td className="text-right tabular-nums">{w.latencyMs != null ? `${w.latencyMs}ms` : '-'}</Td>
                    <Td>{w.ip ?? '-'}</Td>
                    <Td className="max-w-[220px] break-words">{w.responseNote ?? '-'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <SectionTitle title="최근 MO 처리 오류" description="라우팅 실패 및 처리 오류 최근 10건" />
            {moErrors.length === 0 ? (
              <EmptyState title="최근 MO 처리 오류가 없습니다" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>시각</Th>
                    <Th>수신번호</Th>
                    <Th>결과</Th>
                    <Th>상세</Th>
                  </tr>
                </thead>
                <tbody>
                  {moErrors.map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap">{formatKst(m.receivedAt, false)}</Td>
                      <Td>{m.receivedNumber}</Td>
                      <Td>
                        <Badge tone={moResultLabel[m.result].tone}>{moResultLabel[m.result].text}</Badge>
                      </Td>
                      <Td className="max-w-[200px] break-words">{m.resultDetail ?? '-'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <section>
            <SectionTitle title="최근 결제 오류" description="PG 호출 실패 최근 10건" />
            {paymentErrors.length === 0 ? (
              <EmptyState title="최근 결제 오류가 없습니다" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>시각</Th>
                    <Th>주문번호</Th>
                    <Th>동작</Th>
                    <Th>오류</Th>
                    <Th className="text-right">지연</Th>
                  </tr>
                </thead>
                <tbody>
                  {paymentErrors.map((a) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap">{formatKst(a.createdAt, false)}</Td>
                      <Td className="font-mono text-[12px]">{shortId(a.transaction.orderNo, 8, 4)}</Td>
                      <Td>{a.operation}</Td>
                      <Td className="max-w-[200px] break-words">
                        <span className="font-semibold text-danger-500">{a.errorCode}</span>
                        {a.errorMessage ? <span className="block text-ink-500">{a.errorMessage}</span> : null}
                      </Td>
                      <Td className="text-right tabular-nums">{a.latencyMs != null ? `${a.latencyMs}ms` : '-'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Database size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>데이터베이스</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              운영에서는 RDS Proxy 또는 PgBouncer 를 경유하고, 마이그레이션은 DIRECT_DATABASE_URL 로 수행합니다.
            </p>
          </Card>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Server size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>캐시</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              한도·속도 제한 카운터는 캐시에 저장되고 DonationCounter 가 영속 원본입니다. 운영에서는 인메모리 폴백을
              금지해야 합니다.
            </p>
          </Card>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-50 text-brand-700">
                <Signal size={16} strokeWidth={1.7} />
              </span>
              <CardTitle>유튜브 할당량</CardTitle>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-500">
              일일 할당량이 소진되면 채팅 전송이 건너뛰어집니다. 결제 결과에는 영향을 주지 않습니다.
            </p>
          </Card>
        </div>

        {!db.ok || !cache.ok ? (
          <Notice tone="danger" title="점검 실패 항목이 있습니다">
            <span className="flex items-start gap-1.5">
              <TriangleAlert size={14} strokeWidth={1.7} className="mt-0.5 shrink-0" />
              <span>
                {!db.ok ? `DB: ${db.detail}` : ''}
                {!db.ok && !cache.ok ? ' / ' : ''}
                {!cache.ok ? `캐시: ${cache.detail}` : ''}
              </span>
            </span>
          </Notice>
        ) : null}
      </div>
    </>
  );
}
