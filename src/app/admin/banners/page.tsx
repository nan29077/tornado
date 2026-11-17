import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { saveHomeBanner } from '@/app/actions/admin/home-banners';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { AdminField, AdminInput, AdminTextarea } from '@/components/admin/controls';
import { PageHeader } from '@/components/layout/console-shell';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { Badge, Card, CardTitle, cx } from '@/components/ui';
import { HOME_TAB_LABEL, isHomeTab, type HomeTab } from '@/lib/home-tab';
import { requireAdminPage } from '@/server/admin-guard';
import { getHomeBannerEntries } from '@/server/services/home-banners';

export const dynamic = 'force-dynamic';

export default async function AdminBannersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const admin = await requireAdminPage('/admin/banners');
  if (admin.adminPermission !== 'SUPER_ADMIN') redirect('/admin');

  const { tab: requestedTab } = await searchParams;
  const tab = isHomeTab(requestedTab) ? requestedTab : 'fan';
  const entries = await getHomeBannerEntries(tab);
  const tabs: HomeTab[] = ['creator', 'fan'];

  return (
    <>
      <PageHeader title="배너 관리" description="메인 화면의 탭별 상단 배너를 편집합니다." />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="상단 배너 관리 대상" className="flex flex-wrap gap-2">
          {tabs.map((candidate) => (
            <Link
              key={candidate}
              href={`/admin/banners?tab=${candidate}`}
              aria-current={tab === candidate ? 'page' : undefined}
              className={cx(
                'rounded-full border px-4 py-2 text-sm font-bold',
                tab === candidate ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-ink-100 bg-white text-ink-700 hover:border-brand-400',
              )}
            >
              {HOME_TAB_LABEL[candidate]} 페이지 배너 관리
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap gap-3 text-sm font-semibold text-brand-700">
          <Link href={`/?tab=${tab}`}>메인에서 보기</Link>
          <Link href="/admin/site#scheduled-banners">기간 지정 배너 관리</Link>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {entries.map(({ slot, banner, customized, imageInput }) => (
          <Card key={`${tab}-${slot}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle>{slot}번 배너</CardTitle>
                <Badge tone={customized ? 'brand' : 'neutral'}>{customized ? '편집됨' : '기본 배너'}</Badge>
                <Badge tone="neutral">{banner.video ? '영상' : '이미지'}</Badge>
              </div>
              {customized ? (
                <ActionButton
                  action={saveHomeBanner}
                  values={{ tab, slot: String(slot), intent: 'reset' }}
                  label="기본값 복원"
                  confirm={`${slot}번 배너의 수정 내용을 지우고 기본값을 복원합니다.`}
                />
              ) : null}
            </div>
            <div className={cx('relative mb-4 overflow-hidden rounded-xl bg-ink-900', tab === 'creator' ? 'aspect-video' : 'aspect-[3/1]')}>
              <Image src={banner.image} alt="" fill unoptimized loading={slot === 1 ? 'eager' : 'lazy'} sizes="500px" className="object-cover object-right" />
            </div>

            <ActionForm action={saveHomeBanner} submitLabel={`${slot}번 배너 저장`}>
              <input type="hidden" name="tab" value={tab} />
              <input type="hidden" name="slot" value={slot} />
              <ImageUploadField
                key={imageInput}
                name="image"
                label="배경 이미지"
                defaultValue={imageInput}
                hint="파일을 올리거나 이미지 주소를 입력할 수 있습니다. 비우면 기본 이미지가 적용됩니다."
              />
              <AdminField label="영상 분류 또는 상단 문구">
                <AdminInput name="eyebrow" defaultValue={banner.eyebrow} maxLength={40} />
              </AdminField>
              <AdminField label="제목 또는 대표 슬로건">
                <AdminTextarea name="title" defaultValue={banner.title} rows={2} required minLength={2} maxLength={90} />
              </AdminField>
              <AdminField label="배너·영상 소개">
                <AdminTextarea name="description" defaultValue={banner.description} rows={3} maxLength={220} />
              </AdminField>
              <div className="grid gap-3 sm:grid-cols-2">
                <AdminField label="버튼 이름">
                  <AdminInput name="cta" defaultValue={banner.cta} maxLength={30} />
                </AdminField>
                <AdminField label="버튼 연결 주소">
                  <AdminInput name="href" defaultValue={banner.href} maxLength={1000} />
                </AdminField>
              </div>
              <AdminField label="영상 주소" hint="MP4·WebM 파일 주소 또는 YouTube 영상 주소. 비우면 이미지 배너로 표시됩니다.">
                <AdminInput name="video" defaultValue={banner.video} maxLength={1000} />
              </AdminField>
              <AdminField label="영상 미리보기 이미지 주소">
                <AdminInput name="poster" defaultValue={banner.poster} maxLength={1000} />
              </AdminField>
            </ActionForm>
          </Card>
        ))}
      </div>
    </>
  );
}
