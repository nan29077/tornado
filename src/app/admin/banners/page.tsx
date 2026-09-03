import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, EmptyState, Notice, SectionTitle, StatTile } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { saveBanner, deleteBanner } from '@/app/actions/admin/content';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst, kstDateKey } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

const POSITIONS = ['HOME_TOP', 'HOME_MIDDLE', 'SUPPORT_TOP', 'CONSOLE_TOP'];

function dateValue(d: Date | null): string {
  return d ? kstDateKey(d) : '';
}

/**
 * 종료일 입력칸에 되돌려 줄 값.
 * 저장은 '그날 24시'(= 다음 날 0시)로 하므로, 화면에는 하루를 빼서 사람이 입력한 날짜를 보여 준다.
 */
function endDateValue(d: Date | null): string {
  return d ? kstDateKey(new Date(d.getTime() - 1)) : '';
}

export default async function AdminBannersPage() {
  const banners = await prisma.banner.findMany({
    orderBy: [{ position: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });

  const now = new Date();
  const liveCount = banners.filter(
    (b) => b.active && (!b.startsAt || b.startsAt <= now) && (!b.endsAt || b.endsAt >= now),
  ).length;

  return (
    <>
      <PageHeader title="배너 관리" description="노출 위치와 기간을 지정해 서비스 화면에 배너를 표시합니다." />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 배너" value={formatNumber(banners.length)} />
        <StatTile label="현재 노출" value={formatNumber(liveCount)} tone="success" />
        <StatTile label="비활성" value={formatNumber(banners.filter((b) => !b.active).length)} />
        <StatTile label="노출 위치" value={formatNumber(new Set(banners.map((b) => b.position)).size)} />
      </div>

      <Notice tone="neutral" title="이미지·링크 주소 규칙">
        이미지와 연결 주소는 http(s) 로 시작하는 절대 주소 또는 / 로 시작하는 내부 경로만 허용합니다. 외부 스크립트가
        실행될 수 있는 주소는 입력할 수 없습니다.
      </Notice>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>새 배너 등록</CardTitle>
          <div className="mt-3">
            <ActionForm action={saveBanner} submitLabel="배너 등록">
              <AdminField label="노출 위치">
                <AdminSelect name="position" defaultValue={POSITIONS[0]}>
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
              <AdminField label="제목">
                <AdminInput name="title" required placeholder="문자 한 통으로 응원하기" />
              </AdminField>
              <AdminField label="부제목">
                <AdminInput name="subtitle" placeholder="선택 입력" />
              </AdminField>
              <AdminField label="이미지 주소">
                <AdminInput name="imageUrl" placeholder="/images/banner.png" />
              </AdminField>
              <AdminField label="연결 주소">
                <AdminInput name="linkUrl" placeholder="/how-it-works" />
              </AdminField>
              <div className="grid grid-cols-2 gap-2">
                <AdminField label="정렬 순서">
                  <AdminInput name="sortOrder" inputMode="numeric" defaultValue="0" required />
                </AdminField>
                <AdminField label="노출 시작일">
                  <AdminInput type="date" name="startsAt" />
                </AdminField>
                <AdminField label="노출 종료일">
                  <AdminInput type="date" name="endsAt" />
                </AdminField>
              </div>
              <label className="flex items-center gap-2 text-[13px] text-ink-700">
                <input type="checkbox" name="active" defaultChecked className="h-4 w-4 rounded border-ink-300" />
                활성화
              </label>
            </ActionForm>
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SectionTitle title="등록된 배너" />
          {banners.length === 0 ? (
            <EmptyState title="등록된 배너가 없습니다" />
          ) : (
            <div className="space-y-3">
              {banners.map((b) => (
                <Card key={b.id}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="brand">{b.position}</Badge>
                      <CardTitle>{b.title}</CardTitle>
                      <Badge tone={b.active ? 'success' : 'neutral'}>{b.active ? '활성' : '비활성'}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-ink-400">등록 {formatKst(b.createdAt, false)}</span>
                      <ActionButton
                        action={deleteBanner}
                        values={{ id: b.id }}
                        label="삭제"
                        variant="danger"
                        confirm={`배너 "${b.title}" 을(를) 삭제합니다.`}
                      />
                    </div>
                  </div>

                  <ActionForm action={saveBanner} submitLabel="저장" variant="secondary">
                    <input type="hidden" name="id" value={b.id} />
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      <AdminField label="노출 위치">
                        <AdminSelect name="position" defaultValue={b.position}>
                          {[...new Set([...POSITIONS, b.position])].map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </AdminSelect>
                      </AdminField>
                      <AdminField label="제목">
                        <AdminInput name="title" defaultValue={b.title} required />
                      </AdminField>
                      <AdminField label="부제목">
                        <AdminInput name="subtitle" defaultValue={b.subtitle ?? ''} />
                      </AdminField>
                      <AdminField label="정렬 순서">
                        <AdminInput name="sortOrder" inputMode="numeric" defaultValue={String(b.sortOrder)} required />
                      </AdminField>
                      <AdminField label="이미지 주소">
                        <AdminInput name="imageUrl" defaultValue={b.imageUrl ?? ''} />
                      </AdminField>
                      <AdminField label="연결 주소">
                        <AdminInput name="linkUrl" defaultValue={b.linkUrl ?? ''} />
                      </AdminField>
                      <AdminField label="노출 시작일">
                        <AdminInput type="date" name="startsAt" defaultValue={dateValue(b.startsAt)} />
                      </AdminField>
                      <AdminField label="노출 종료일">
                        <AdminInput type="date" name="endsAt" defaultValue={endDateValue(b.endsAt)} />
                      </AdminField>
                    </div>
                    <label className="flex items-center gap-2 text-[13px] text-ink-700">
                      <input
                        type="checkbox"
                        name="active"
                        defaultChecked={b.active}
                        className="h-4 w-4 rounded border-ink-300"
                      />
                      활성화
                    </label>
                  </ActionForm>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
