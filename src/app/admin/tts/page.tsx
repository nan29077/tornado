import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminInput } from '@/components/admin/controls';
import { updateCreatorTtsSetting } from '@/app/actions/admin/broadcast';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatNumber, formatWon } from '@/lib/money';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

/**
 * TTS 연동 관리 (통합 관리자 전용).
 *
 * **소유권 경계** — 음성·속도·제공사는 크리에이터가 `/studio/overlay` 간편 설정에서 정한다.
 * 이 화면은 운영 정책에 해당하는 읽기 옵션(사용 여부·최소 후원금·최대 글자 수·볼륨)만 다루고,
 * 크리에이터가 고른 음성 값은 읽기 전용으로 보여 준다.
 */

const PROVIDER_LABEL: Record<string, string> = {
  browser: '브라우저 내장 음성',
  naver: '네이버 클로바 Voice',
};

export default async function AdminTtsPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/tts');

  const creators = await prisma.creatorProfile.findMany({
    // 승인된 채널만, 상한을 두고 읽는다. 예전에는 미승인·반려·정지 채널까지 전부 불러와
    // 각각 입력 8개짜리 카드를 렌더해 크리에이터가 늘면 페이지가 열리지 않았다.
    where: { status: 'APPROVED' },
    orderBy: { displayName: 'asc' },
    take: CREATOR_OPTION_LIMIT,
    select: {
      id: true,
      displayName: true,
      code: true,
      status: true,
      ttsSetting: true,
    },
  });

  const isMock = env.tts.provider === 'mock';
  const enabledCount = creators.filter((c) => c.ttsSetting?.enabled ?? true).length;

  return (
    <>
      <PageHeader
        title="TTS 연동"
        description="음성 합성 서비스 연동 상태와 크리에이터별 읽기 옵션(사용 여부·최소 후원금·최대 글자 수·볼륨)을 관리합니다. 음성·속도·제공사는 크리에이터가 오버레이 설정에서 직접 고릅니다."
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="TTS provider" value={env.tts.provider} tone={isMock ? 'warning' : 'success'} />
          <StatTile label="API 키 등록" value={env.tts.apiKey ? '등록됨' : '미등록'} tone={env.tts.apiKey ? 'success' : 'warning'} />
          <StatTile label="크리에이터 수" value={formatNumber(creators.length)} />
          <StatTile label="TTS 사용 중" value={`${formatNumber(enabledCount)}명`} tone="brand" />
        </div>

        {isMock ? (
          <Notice tone="warning" title="현재 TTS 는 모의(mock) 상태입니다">
            상용 음성 합성 서비스와 계약되어 있지 않아, 오버레이 브라우저 소스가 브라우저 내장 음성 합성(Web Speech
            API)으로 대신 읽습니다. 음성·속도·볼륨은 브라우저와 운영체제에 따라 결과가 달라질 수 있습니다.
            <span className="mt-1.5 block">
              실연동 전환은 <span className="font-mono">.env</span> 의 <span className="font-mono">TTS_PROVIDER</span>
              와 <span className="font-mono">TTS_API_KEY</span> 를 설정한 뒤 서버를 재시작하면 적용됩니다. 키는 화면에
              저장하지 않고 서버 환경변수로만 관리합니다.
            </span>
          </Notice>
        ) : (
          <Notice tone="success" title={`TTS provider: ${env.tts.provider}`}>
            실연동 상태입니다. 아래 크리에이터별 설정이 실제 음성 합성에 그대로 적용됩니다.
          </Notice>
        )}

        <section>
          <SectionTitle
            title="크리에이터별 읽기 옵션"
            description="TTS 는 오버레이에 표시되는 필터링된 메시지만 읽습니다. 금칙어·마스킹이 적용된 문장이 사용됩니다. 저장해도 크리에이터가 고른 음성·속도·제공사는 바뀌지 않습니다."
          />
          {creators.length === 0 ? (
            <EmptyState title="등록된 크리에이터가 없습니다" />
          ) : (
            <div className="space-y-2.5">
              {creators.map((c) => {
                const s = c.ttsSetting;
                return (
                  <Card key={c.id}>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CardTitle>{c.displayName}</CardTitle>
                        <span className="font-mono text-[12px] text-ink-400">{c.code}</span>
                      </div>
                      <Badge tone={(s?.enabled ?? true) ? 'success' : 'neutral'}>
                        {(s?.enabled ?? true) ? 'TTS 사용' : 'TTS 미사용'}
                      </Badge>
                    </div>

                    <ActionForm action={updateCreatorTtsSetting} submitLabel="저장">
                      <input type="hidden" name="creatorId" value={c.id} />

                      <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-ink-100 px-3 py-2.5">
                        <label className="flex items-center gap-2 text-[13px] text-ink-900">
                          <input type="checkbox" name="enabled" defaultChecked={s?.enabled ?? true} className="h-4 w-4" />
                          TTS 사용
                        </label>
                        <label className="flex items-center gap-2 text-[13px] text-ink-900">
                          <input type="checkbox" name="readAmount" defaultChecked={s?.readAmount ?? true} className="h-4 w-4" />
                          후원금 읽기
                        </label>
                        <label className="flex items-center gap-2 text-[13px] text-ink-900">
                          <input type="checkbox" name="readName" defaultChecked={s?.readName ?? true} className="h-4 w-4" />
                          이름 읽기
                        </label>
                      </div>

                      {/* 음성·속도·제공사는 크리에이터 소유값이라 읽기 전용으로만 보여 준다. */}
                      <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2.5 text-[12px] text-ink-500">
                        <span className="font-semibold text-ink-700">크리에이터 설정(읽기 전용)</span>
                        <span className="mt-1 block">
                          제공사 {PROVIDER_LABEL[s?.provider ?? 'browser'] ?? (s?.provider ?? 'browser')} · 음성{' '}
                          <span className="font-mono">{s?.voice ?? '기본값'}</span> · 속도{' '}
                          {Math.round((s?.speed ?? 1) * 100)}%
                        </span>
                      </div>

                      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="block">
                          <span className="mb-1 block text-[12px] font-semibold text-ink-500">볼륨 (%)</span>
                          <AdminInput
                            name="volumePercent"
                            type="number"
                            min={0}
                            max={100}
                            step={10}
                            defaultValue={Math.round((s?.volume ?? 1) * 100)}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[12px] font-semibold text-ink-500">최소 후원금</span>
                          <AdminInput
                            name="minAmount"
                            inputMode="numeric"
                            defaultValue={(s?.minAmount ?? 3000n).toString()}
                          />
                          <span className="mt-1 block text-[11px] text-ink-400">
                            현재 {formatWon(s?.minAmount ?? 3000n)} 이상만 읽음
                          </span>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[12px] font-semibold text-ink-500">최대 글자 수</span>
                          <AdminInput name="maxChars" type="number" min={10} max={200} defaultValue={s?.maxChars ?? 80} />
                        </label>
                      </div>
                    </ActionForm>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
