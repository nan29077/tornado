import { cache } from 'react';
import { prisma } from '@/server/db';
import { DEFAULT_SITE_IMAGE, isSiteImageSelection, type SiteImageKind } from '@/lib/site-images';

export const SITE_IMAGE_KEYS = {
  margin: 'site_margin_image',
  banner: 'site_banner_image',
} as const satisfies Record<SiteImageKind, string>;

export const getSiteImageSelection = cache(async (kind: SiteImageKind) => {
  const row = await prisma.systemSetting.findUnique({
    where: { key: SITE_IMAGE_KEYS[kind] },
    select: { value: true },
  }).catch(() => null);
  return isSiteImageSelection(kind, row?.value) ? row.value : DEFAULT_SITE_IMAGE;
});
