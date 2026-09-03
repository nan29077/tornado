import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { JsonView } from '@/components/admin/controls';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst, kstStartOfDay } from '@/lib/datetime';
import { deliveryStatusLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

export default async function AdminOverlayPage() {
  const todayStart = kstStartOfDay();

  const [creators, events, todayStats] = await Promise.all([
    prisma.creatorProfile.findMany({
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      take: CREATOR_OPTION_LIMIT,
      select: {
        id: true, displayName: true, code: true,
        overlaySetting: {
          select: {
            enabled: true, showAmount: true, showMessage: true, maxMessageLen: true,
            anonymize: true, position: true, durationMs: true, theme: true, stickerSet: true,
            tokenMasked: true, updatedAt: true,
          },
        },
        ttsSetting: {
          select: { enabled: true, voice: true, speed: true, volume: true, readAmount: true, readName: true, minAmount: true, maxChars: true },
        },
      },
    }),
    prisma.overlayEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, creatorId: true, donationId: true, status: true, isTest: true, playedAt: true, createdAt: true, payload: true },
    }),
    prisma.overlayEvent.groupBy({
      by: ['status'],
      where: { createdAt: { gte: todayStart } },
      _count: { _all: true },
    }),
  ]);

  const creatorNameMap = new Map(creators.map((c) => [c.id, c.displayName]));
  const countOf = (s: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED') =>
    todayStats.find((t) => t.status === s)?._count._all ?? 0;

  const overlayOn = creators.filter((c) => c.overlaySetting?.enabled).length;
  const ttsOn = creators.filter((c) => c.ttsSetting?.enabled).length;

  return (
    <>
      <PageHeader
        title="오버레이·TTS 관리"
        description="크리에이터별 방송 노출 설정과 최근 오버레이 이벤트 상태를 확인합니다. 오버레이 접근 토큰은 마스킹 값만 표시합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="오버레이 사용" value={`${formatNumber(overlayOn)} / ${formatNumber(creators.length)}`} tone="brand" />
        <StatTile label="TTS 사용" value={`${formatNumber(ttsOn)} / ${formatNumber(creators.length)}`} />
        <StatTile label="오늘 송출 성공" value={formatNumber(countOf('SENT'))} tone="success" />
        <StatTile label="오늘 송출 실패" value={formatNumber(countOf('FAILED'))} tone={countOf('FAILED') > 0 ? 'danger' : 'neutral'} />
      </div>

      {env.tts.provider === 'mock' ? (
        <Notice tone="warning" title="TTS 어댑터가 mock 으로 동작 중입니다">
          실제 음성 합성이 이루어지지 않고 텍스트만 생성됩니다. TTS 사업자 키를 등록하고 어댑터를 교체해야 실제 음성이
          재생됩니다.
        </Notice>
      ) : null}

      <div className="mt-5">
        <SectionTitle title="크리에이터별 설정 요약" />
        {creators.length === 0 ? (
          <EmptyState title="승인된 크리에이터가 없습니다" />
        ) : (
          <Table className="min-w-[1200px]">
            <thead>
              <tr>
                <Th>크리에이터</Th>
                <Th>오버레이</Th>
                <Th>표시 시간</Th>
                <Th>금액·메시지</Th>
                <Th>익명 처리</Th>
                <Th>위치·테마</Th>
                <Th>TTS</Th>
                <Th>TTS 기준</Th>
                <Th>접근 토큰</Th>
              </tr>
            </thead>
            <tbody>
              {creators.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`/admin/creators/${c.id}`} className="font-semibold text-brand-700">
                      {c.displayName}
                    </Link>
                    <span className="mt-0.5 block text-[11px] text-ink-400">{c.code}</span>
                  </Td>
                  <Td>
                    {c.overlaySetting ? (
                      <Badge tone={c.overlaySetting.enabled ? 'success' : 'neutral'}>
                        {c.overlaySetting.enabled ? '사용' : '중지'}
                      </Badge>
                    ) : (
                      <Badge tone="warning">미설정</Badge>
                    )}
                  </Td>
                  <Td className="tabular-nums">{c.overlaySetting ? `${formatNumber(c.overlaySetting.durationMs)}ms` : '-'}</Td>
                  <Td className="text-[12px]">
                    {c.overlaySetting ? (
                      <>
                        <span className="block">금액 {c.overlaySetting.showAmount ? '표시' : '숨김'}</span>
                        <span className="block">
                          메시지 {c.overlaySetting.showMessage ? `표시 (최대 ${c.overlaySetting.maxMessageLen}자)` : '숨김'}
                        </span>
                      </>
                    ) : (
                      '-'
                    )}
                  </Td>
                  <Td>
                    {c.overlaySetting ? (
                      <Badge tone={c.overlaySetting.anonymize ? 'brand' : 'neutral'}>
                        {c.overlaySetting.anonymize ? '익명 처리' : '실명 표시'}
                      </Badge>
                    ) : (
                      '-'
                    )}
                  </Td>
                  <Td className="text-[12px]">
                    {c.overlaySetting ? `${c.overlaySetting.position} / ${c.overlaySetting.theme}` : '-'}
                  </Td>
                  <Td>
                    {c.ttsSetting ? (
                      <Badge tone={c.ttsSetting.enabled ? 'success' : 'neutral'}>
                        {c.ttsSetting.enabled ? '사용' : '중지'}
                      </Badge>
                    ) : (
                      <Badge tone="warning">미설정</Badge>
                    )}
                  </Td>
                  <Td className="text-[12px]">
                    {c.ttsSetting ? (
                      <>
                        <span className="block">최소 {formatWon(c.ttsSetting.minAmount)}</span>
                        <span className="block">
                          {c.ttsSetting.voice} · 최대 {c.ttsSetting.maxChars}자
                        </span>
                      </>
                    ) : (
                      '-'
                    )}
                  </Td>
                  <Td className="font-mono text-[11px]">{c.overlaySetting?.tokenMasked ?? '-'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="mt-6">
        <SectionTitle title="최근 오버레이 이벤트 30건" description="결제 성공 건만 오버레이로 송출됩니다." />
        {events.length === 0 ? (
          <EmptyState title="오버레이 이벤트가 없습니다" />
        ) : (
          <Table className="min-w-[900px]">
            <thead>
              <tr>
                <Th>생성 시각</Th>
                <Th>크리에이터</Th>
                <Th>상태</Th>
                <Th>테스트</Th>
                <Th>재생 시각</Th>
                <Th>페이로드</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap">{formatKst(e.createdAt, false)}</Td>
                  <Td>{creatorNameMap.get(e.creatorId) ?? e.creatorId}</Td>
                  <Td>
                    <Badge tone={deliveryStatusLabel[e.status].tone}>{deliveryStatusLabel[e.status].text}</Badge>
                  </Td>
                  <Td>{e.isTest ? <Badge tone="warning">테스트</Badge> : <Badge tone="neutral">실제</Badge>}</Td>
                  <Td className="whitespace-nowrap">{formatKst(e.playedAt, false)}</Td>
                  <Td>
                    <details>
                      <summary className="cursor-pointer text-[12px] text-brand-700">보기</summary>
                      <div className="mt-1.5">
                        <JsonView value={e.payload} maxLength={500} />
                      </div>
                    </details>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="mt-5">
        <Notice tone="neutral" title="오버레이 설정은 크리에이터 스튜디오에서 변경합니다">
          통합 관리자에서는 현황 확인만 제공합니다. 문제가 있는 설정은 크리에이터에게 안내하거나, 심각한 경우
          크리에이터 상태를 정지 처리해 송출을 중단하세요.
        </Notice>
      </div>
    </>
  );
}
