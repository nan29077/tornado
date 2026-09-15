import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import {
  updateCreatorTtsSetting,
  updatePlatformTtsSetting,
  testPlatformTts,
} from '@/app/actions/admin/broadcast';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { getPlatformTtsView } from '@/server/services/tts-platform';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

/** 선택 목록에 담을 크리에이터 수 상한. 넘어가면 검색형 입력으로 바꿔야 한다. */
const CREATOR_OPTION_LIMIT = 300;

/**
 * TTS·음성 연동 관리 (통합 관리자 전용).
 *
 * 화면은 두 층으로 나뉜다.
 *
 * 1) **전역 연동** — 도네이도가 계약한 음성 서비스(클로바 Voice)를 여기서 연결한다.
 *    저장하면 전 크리에이터에게 즉시 적용되고 서버 재시작이 필요 없다.
 *    예전에는 이 칸이 아예 없어서 `.env` 를 고치고 서버를 다시 띄우는 방법밖에 없었다.
 *
 * 2) **크리에이터별 읽기 옵션** — 사용 여부·최소 후원금·최대 글자 수·볼륨.
 *    화자·속도는 크리에이터가 `/studio/overlay` 에서 정하는 값이라 여기서는 읽기 전용이다.
 *    다만 전역 설정에서 [개별 설정 허용]을 끄면 제공사는 전역 값이 이긴다.
 */

const PROVIDER_LABEL: Record<string, string> = {
  browser: '브라우저 내장 음성',
  naver: '네이버 클로바 Voice',
};

export default async function AdminTtsPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/tts');

  const [platform, creators] = await Promise.all([
    getPlatformTtsView(),
    prisma.creatorProfile.findMany({
      // 승인된 채널만, 상한을 두고 읽는다. 예전에는 미승인·반려·정지 채널까지 전부 불러와
      // 각각 입력 8개짜리 카드를 렌더해 크리에이터가 늘면 페이지가 열리지 않았다.
      where: { status: 'APPROVED' },
      orderBy: { displayName: 'asc' },
      take: CREATOR_OPTION_LIMIT,
      select: { id: true, displayName: true, code: true, status: true, ttsSetting: true },
    }),
  ]);

  const enabledCount = creators.filter((c) => c.ttsSetting?.enabled ?? true).length;
  const serverSynthesis = platform.provider === 'naver' && platform.hasCredentials;
  // 개별 키를 따로 넣어 둔 크리에이터. 개별 설정을 막으면 이 키들은 더 이상 쓰이지 않는다.
  const ownKeyCount = creators.filter((c) => Boolean(c.ttsSetting?.naverClientIdEnc)).length;

  return (
    <>
      <PageHeader
        title="TTS·음성 연동"
        description="도네이도가 계약한 음성 서비스를 전역으로 연결하고, 크리에이터별 읽기 옵션을 관리합니다. 전역 설정은 저장 즉시 전 크리에이터에게 적용되며 서버 재시작이 필요 없습니다."
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile
            label="전역 제공사"
            value={PROVIDER_LABEL[platform.provider] ?? platform.provider}
            sub={platform.configured ? '이 화면에서 설정됨' : '.env 기본값 사용 중'}
            tone={serverSynthesis ? 'success' : 'warning'}
          />
          <StatTile
            label="전역 API 키"
            value={platform.hasCredentials ? '등록됨' : '미등록'}
            sub={platform.clientIdMasked ?? undefined}
            tone={platform.hasCredentials ? 'success' : 'warning'}
          />
          <StatTile
            label="개별 설정"
            value={platform.allowCreatorOverride ? '허용' : '차단(전역 강제)'}
            sub={ownKeyCount > 0 ? `개별 키 보유 ${formatNumber(ownKeyCount)}명` : undefined}
            tone={platform.allowCreatorOverride ? 'neutral' : 'brand'}
          />
          <StatTile
            label="TTS 사용 중"
            value={`${formatNumber(enabledCount)}명`}
            sub={`전체 ${formatNumber(creators.length)}명`}
            tone="brand"
          />
        </div>

        {/* ───────────────────────────────────── 전역 연동 */}
        <section>
          <SectionTitle
            title="전역 음성 연동"
            description="도네이도 계정으로 계약한 음성 서비스를 연결합니다. 저장하면 전 크리에이터에게 즉시 적용됩니다."
          />

          {serverSynthesis ? (
            <div className="mb-3">
              <Notice tone="success" title="서버 음성 합성이 켜져 있습니다">
                네이버 클로바 Voice 로 합성합니다. 기본 화자는 <strong>{platform.speaker}</strong> 이며, 크리에이터가
                화자를 따로 고르지 않았거나 클로바에 없는 이름을 쓰고 있으면 이 화자로 읽습니다.
                {platform.updatedAt ? ` (최종 변경 ${formatKst(new Date(platform.updatedAt), false)})` : null}
              </Notice>
            </div>
          ) : (
            <div className="mb-3">
              <Notice tone="warning" title="지금은 브라우저 내장 음성으로 읽고 있습니다">
                서버 합성이 연결되어 있지 않아 오버레이 브라우저 소스가 Web Speech API 로 대신 읽습니다.
                <strong> OBS 의 브라우저 소스에는 한국어 음성이 없는 경우가 많아 실제로는 무음이 되기 쉽습니다.</strong>{' '}
                아래에 클로바 Voice 의 Client ID·Secret 을 넣으면 곧바로 서버 합성으로 전환됩니다.
              </Notice>
            </div>
          )}

          <Card>
            <ActionForm
              action={updatePlatformTtsSetting}
              submitLabel="전역 설정 저장"
              confirm="전 크리에이터의 음성 합성 방식이 즉시 바뀝니다. 계속할까요?"
            >
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                <AdminField label="음성 제공사">
                  <AdminSelect name="provider" defaultValue={platform.provider}>
                    <option value="browser">브라우저 내장 음성 (서버 합성 안 함)</option>
                    <option value="naver">네이버 클로바 Voice (서버 합성)</option>
                  </AdminSelect>
                </AdminField>
                <AdminField label="기본 화자" hint="클로바 화자 이름 (예: nara, vdain, nminyoung)">
                  <AdminInput name="speaker" defaultValue={platform.speaker} placeholder="nara" />
                </AdminField>
                <AdminField
                  label="Client ID"
                  hint={platform.hasCredentials ? '비워 두면 기존 키를 그대로 둡니다.' : 'NCP 콘솔의 Client ID'}
                >
                  <AdminInput name="clientId" autoComplete="off" placeholder={platform.clientIdMasked ?? '입력'} />
                </AdminField>
                <AdminField label="Client Secret" hint="저장 후에는 다시 표시되지 않습니다.">
                  <AdminInput name="clientSecret" type="password" autoComplete="new-password" placeholder="입력" />
                </AdminField>
              </div>

              <label className="flex items-start gap-2.5 rounded-xl border border-ink-100 px-3 py-2.5">
                <input
                  type="checkbox"
                  name="allowCreatorOverride"
                  defaultChecked={platform.allowCreatorOverride}
                  className="mt-0.5 h-4 w-4"
                />
                <span className="text-[13px] leading-relaxed text-ink-900">
                  크리에이터의 개별 제공사·키 설정을 허용
                  <span className="mt-0.5 block text-[11.5px] text-ink-400">
                    끄면 크리에이터가 스튜디오에서 무엇을 골랐든 <strong>전역 설정이 이깁니다.</strong> 크리에이터에게
                    남는 선택지는 화자·속도뿐입니다. 도네이도 키 하나로 전 채널을 운영한다면 꺼 두는 편이 안전합니다.
                  </span>
                </span>
              </label>
            </ActionForm>
          </Card>

          <div className="mt-3">
            <Card>
              <CardTitle>연결 시험</CardTitle>
              <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-500">
                저장된 전역 키로 실제 합성을 한 번 요청해 봅니다. 키가 저장된 것과 그 키가 동작하는 것은 다른
                문제입니다. 방송 중에 처음 알게 되면 손쓸 수 없으니 저장 직후 확인해 주세요. (합성 결과는 버립니다)
              </p>
              <ActionForm action={testPlatformTts} submitLabel="클로바 Voice 연결 시험" variant="secondary" />
            </Card>
          </div>

          {!platform.allowCreatorOverride && ownKeyCount > 0 ? (
            <div className="mt-3">
              <Notice tone="warning" title={`개별 키를 등록해 둔 크리에이터가 ${ownKeyCount}명 있습니다`}>
                개별 설정을 막아 두었으므로 이 키들은 더 이상 사용되지 않습니다(삭제되지는 않습니다). 해당
                크리에이터의 클로바 사용량은 도네이도 계정으로 옮겨 갑니다.
              </Notice>
            </div>
          ) : null}

          {env.tts.provider === 'mock' && platform.configured ? (
            <div className="mt-3">
              <Notice tone="neutral" title="참고: .env 의 TTS_PROVIDER 는 아직 mock 입니다">
                서버 합성 경로는 이 화면의 전역 설정이 결정하므로 동작에는 문제가 없습니다.
                <span className="font-mono"> TTS_PROVIDER</span> 는 어댑터 진단용 표기로만 남아 있습니다.
              </Notice>
            </div>
          ) : null}
        </section>

        {/* ───────────────────────────────────── 크리에이터별 옵션 */}
        <section>
          <SectionTitle
            title="크리에이터별 읽기 옵션"
            description="TTS 는 오버레이에 표시되는 필터링된 메시지만 읽습니다. 금칙어·마스킹이 적용된 문장이 사용됩니다. 저장해도 크리에이터가 고른 화자·속도는 바뀌지 않습니다."
          />
          {creators.length === 0 ? (
            <EmptyState title="등록된 크리에이터가 없습니다" />
          ) : (
            <div className="space-y-2.5">
              {creators.map((c) => {
                const s = c.ttsSetting;
                const chosen = s?.provider === 'naver' ? 'naver' : 'browser';
                // 실제로 적용되는 제공사. 개별 설정을 막아 두었으면 전역 값이 이긴다.
                const effectiveProvider = platform.allowCreatorOverride
                  ? chosen === 'naver'
                    ? 'naver'
                    : platform.provider
                  : platform.provider;
                const overridden = !platform.allowCreatorOverride && chosen !== effectiveProvider;

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

                      {/* 화자·속도는 크리에이터 소유값이라 읽기 전용으로만 보여 준다. */}
                      <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2.5 text-[12px] text-ink-500">
                        <span className="font-semibold text-ink-700">현재 적용 값 (읽기 전용)</span>
                        <span className="mt-1 block">
                          제공사 <strong>{PROVIDER_LABEL[effectiveProvider] ?? effectiveProvider}</strong>
                          {overridden ? (
                            <span className="text-warning-600">
                              {' '}· 전역 설정이 크리에이터 선택({PROVIDER_LABEL[chosen]})을 덮어씀
                            </span>
                          ) : null}
                          {' · '}화자 <span className="font-mono">{s?.voice ?? '기본값'}</span> · 속도{' '}
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
