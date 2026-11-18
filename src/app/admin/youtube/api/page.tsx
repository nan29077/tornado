import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput } from '@/components/admin/controls';
import { YouTubeAdminTabs } from '@/components/admin/youtube-tabs';
import { requireAdminPage } from '@/server/admin-guard';
import { getYouTubeApiSettings, resolveYouTubeApiKey } from '@/server/services/youtube-api';
import { getYouTubeQuotaUsage } from '@/server/services/youtube-quota';
import { clearYouTubeApiKeyAction, saveYouTubeApiKeyAction, testYouTubeApiKeyAction } from '@/app/actions/admin/youtube-api';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

/** 최고관리자 > 유튜브 연동 > API 키 관리 (2026-11-18) */
export default async function AdminYouTubeApiPage() {
  const admin = await requireAdminPage('/admin/youtube/api');
  const settings = await getYouTubeApiSettings();
  const [key, quota] = await Promise.all([
    resolveYouTubeApiKey(settings),
    getYouTubeQuotaUsage().catch(() => null),
  ]);
  const isSuper = admin.adminPermission === 'SUPER_ADMIN';
  const superOnly = isSuper ? undefined : 'API 키 등록·삭제는 최고관리자만 할 수 있습니다.';

  return (
    <>
      <PageHeader
        title="유튜브 연동 관리"
        description="YouTube Data API v3 키를 등록하면 방송국(영상 허브)에 유튜브 영상을 수집해 조회수·채널 정보와 함께 보여 줄 수 있습니다."
      />
      <YouTubeAdminTabs active="api" />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="사용 중인 키"
          value={key.source === 'admin' ? '관리자 화면' : key.source === 'env' ? '환경변수' : '없음'}
          sub={key.masked ?? '등록 필요'}
          tone={key.source === 'none' ? 'warning' : 'brand'}
        />
        <StatTile
          label="마지막 확인"
          value={settings.lastTestOk == null ? '확인 전' : settings.lastTestOk ? '정상' : '실패'}
          sub={settings.lastTestAt ? formatKst(new Date(settings.lastTestAt), false) : '-'}
          tone={settings.lastTestOk === false ? 'danger' : settings.lastTestOk ? 'success' : 'neutral'}
        />
        <StatTile
          label="오늘 할당량 사용"
          value={quota && !quota.usageUnavailable ? `${formatNumber(quota.used)} / ${formatNumber(quota.total)}` : '확인 불가'}
          sub="채팅 송출·영상 수집 합계"
        />
        <StatTile label="영상 수집" value={settings.enabled ? '켜짐' : '꺼짐'} sub="영상 수집 탭에서 설정" />
      </div>

      {settings.lastTestOk === false && settings.lastTestMessage ? (
        <div className="mb-4">
          <Notice tone="danger" title="마지막 연결 확인에 실패했습니다">
            {settings.lastTestMessage}
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>API 키 등록</CardTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
            키는 암호화해 저장하며, 저장한 뒤에는 원문을 다시 볼 수 없습니다(앞뒤 4자리만 표시). 새 키를 저장하면 기존 키를 대체하고 바로 연결을 확인합니다.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-semibold text-ink-500">현재</span>
            {settings.keyEnc ? <Badge tone="success">관리자 화면 키 {settings.keyMasked}</Badge> : <Badge>화면 키 없음</Badge>}
            {key.source === 'env' ? <Badge tone="brand">환경변수 키 사용 중 {key.masked}</Badge> : null}
          </div>
          <ActionForm action={saveYouTubeApiKeyAction} submitLabel={settings.keyEnc ? '새 키로 바꾸기' : '키 저장하고 확인'} className="mt-3" disabledReason={superOnly}>
            <AdminField label="YouTube Data API v3 키">
              <AdminInput name="apiKey" type="password" autoComplete="off" spellCheck={false} placeholder="AIza…" required maxLength={80} />
            </AdminField>
          </ActionForm>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-100 pt-3">
            <ActionForm action={testYouTubeApiKeyAction} submitLabel="연결 확인 (1 unit)" variant="secondary" compact />
            {settings.keyEnc ? (
              <ActionForm
                action={clearYouTubeApiKeyAction}
                submitLabel="화면 키 삭제"
                variant="danger"
                compact
                confirm="관리자 화면에 저장한 API 키를 삭제할까요? 환경변수 키가 없으면 영상 수집이 멈춥니다."
                disabledReason={superOnly}
              />
            ) : null}
          </div>
          {settings.lastTestMessage && settings.lastTestOk ? <p className="mt-2 text-[12px] text-success-600">{settings.lastTestMessage}</p> : null}
        </Card>

        <Card>
          <CardTitle>키 만드는 방법</CardTitle>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-700">
            <li>Google Cloud 콘솔에서 프로젝트를 고르고 [API 및 서비스 &gt; 라이브러리]에서 YouTube Data API v3 를 사용 설정합니다.</li>
            <li>[사용자 인증 정보 &gt; 사용자 인증 정보 만들기 &gt; API 키]로 키를 만듭니다.</li>
            <li>키 제한에서 API 제한을 YouTube Data API v3 로 걸어 두면 안전합니다. (서버에서 호출하므로 HTTP 리퍼러 제한은 걸지 않습니다)</li>
            <li>만든 키를 왼쪽에 붙여 넣고 저장합니다.</li>
          </ol>
          <div className="mt-3">
            <Notice tone="neutral" title="할당량">
              무료 할당량은 하루 10,000 units(태평양 시간 자정 초기화)이며 라이브 채팅 송출과 함께 씁니다. 영상 수집은 채널 1개당 약 2 units 이고,
              하루 사용량이 70%를 넘으면 자동 수집을 멈춰 후원 채팅 송출 몫을 남깁니다.
            </Notice>
          </div>
        </Card>
      </div>
    </>
  );
}
