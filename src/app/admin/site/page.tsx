import Image from 'next/image';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/admin/action-form';
import { Badge, Card, SectionTitle } from '@/components/ui';
import { SiteMarginPreview } from '@/components/public/creator-donate-backdrop';
import { saveSiteImage } from '@/app/actions/admin/site-images';
import { requireAdminPage } from '@/server/admin-guard';
import { getSiteImageSelection } from '@/server/services/site-images';
import {
  CLASSIC_MARGIN_IMAGE, DEFAULT_HOME_BANNER, DEFAULT_SITE_IMAGE, SITE_IMAGE_PRESETS, siteImageUrl, type SiteImageKind,
} from '@/lib/site-images';
import { ScheduledBanners } from './scheduled-banners';

export const dynamic = 'force-dynamic';

export default async function AdminSitePage() {
  const admin = await requireAdminPage('/admin/site');
  if (admin.adminPermission !== 'SUPER_ADMIN') redirect('/admin');

  const [margin, banner] = await Promise.all([getSiteImageSelection('margin'), getSiteImageSelection('banner')]);

  return (
    <>
      <PageHeader title="사이트 관리" description="공개 화면의 여백, 기본 배너, 기간 지정 배너를 관리합니다." />
      <nav aria-label="사이트 관리 항목" className="mb-5 flex flex-wrap gap-2">
        {[
          ['#margin', '여백 이미지 관리'],
          ['#banner', '배너 이미지 관리'],
          ['#scheduled-banners', '기간 지정 배너'],
        ].map(([href, label]) => (
          <a key={href} href={href} className="rounded-full border border-ink-100 bg-white px-4 py-2 text-sm font-bold text-ink-700 hover:border-brand-400">
            {label}
          </a>
        ))}
      </nav>
      <div className="space-y-8">
        <SiteImageGallery kind="margin" selected={margin} />
        <SiteImageGallery kind="banner" selected={banner} />
        <ScheduledBanners />
      </div>
    </>
  );
}

function SiteImageGallery({ kind, selected }: { kind: SiteImageKind; selected: string }) {
  const isMargin = kind === 'margin';
  const title = isMargin ? '여백 이미지 관리' : '배너 이미지 관리';
  const presets = SITE_IMAGE_PRESETS[kind];
  const groups = [
    { title: isMargin ? '움직이는 도네이도' : '도네이도 캐릭터', presets: presets.filter(({ id }) => !id.startsWith('photo-')) },
    { title: '실사풍 인물과 도네이도', presets: presets.filter(({ id }) => id.startsWith('photo-')) },
  ];

  function option(preset: { id: string; name: string; description?: string }) {
    return (
      <label key={preset.id} className="block cursor-pointer">
        <input type="radio" name="preset" value={preset.id} defaultChecked={selected === preset.id} className="peer sr-only" />
        <span className="block overflow-hidden rounded-xl border-2 border-ink-100 bg-white peer-checked:border-brand-500 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500">
          {isMargin ? (
            <SiteMarginPreview preset={preset.id} />
          ) : (
            <Image
              src={siteImageUrl('banner', preset.id) ?? DEFAULT_HOME_BANNER}
              alt=""
              width={480}
              height={240}
              sizes="(max-width: 640px) 45vw, 240px"
              className="aspect-[2/1] w-full bg-warm-50 object-cover"
            />
          )}
          <span className="flex flex-wrap items-center justify-between gap-1 px-2 py-1.5">
            <span className="text-sm font-bold text-ink-900">{preset.name}</span>
            {selected === preset.id ? <Badge tone="success">적용 중</Badge> : null}
          </span>
          {preset.description ? <span className="block px-2 pb-2 text-xs text-ink-500">{preset.description}</span> : null}
        </span>
      </label>
    );
  }

  return (
    <section id={kind} className="scroll-mt-24">
      <SectionTitle
        title={title}
        description={isMargin
          ? '공개 페이지와 후원 페이지의 PC 좌우 여백에 적용합니다.'
          : '홈 첫 배너와 공용 기본 배너를 사용하는 크리에이터 후원 페이지에 적용합니다.'}
      />
      <Card>
        <ActionForm action={saveSiteImage} submitLabel={isMargin ? '여백 이미지 적용' : '배너 이미지 적용'}>
          <input type="hidden" name="kind" value={kind} />
          <fieldset className="space-y-4">
            <legend className="sr-only">{title}</legend>
            {isMargin ? (
              <div>
                <h3 className="mb-2 text-sm font-bold text-ink-900">기본 이미지</h3>
                <div className="grid max-w-96 grid-cols-2 gap-2">
                  {option({ id: DEFAULT_SITE_IMAGE, name: '현재 기본 이미지' })}
                  {option({ id: CLASSIC_MARGIN_IMAGE, name: '이전 기본 이미지' })}
                </div>
              </div>
            ) : (
              <div className="max-w-48">{option({ id: DEFAULT_SITE_IMAGE, name: '기존 기본 이미지' })}</div>
            )}
            {groups.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 text-sm font-bold text-ink-900">{group.title}</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">{group.presets.map(option)}</div>
              </div>
            ))}
          </fieldset>
        </ActionForm>
      </Card>
    </section>
  );
}
