import { HOME_BANNER_DEFAULTS, homeBannerSchema } from '@/lib/home-banners';
import type { HomeTab } from '@/lib/home-tab';
import { siteImageUrl } from '@/lib/site-images';
import { prisma } from '@/server/db';
import { getSiteImageSelection } from './site-images';

export function homeBannerKey(tab: HomeTab, slot: number): string {
  return `home_banner_${tab}_${slot}`;
}

export async function getHomeBannerEntries(tab: HomeTab, allowDefaultsOnFailure = false) {
  const defaults = HOME_BANNER_DEFAULTS[tab];
  const keys = defaults.map((_, index) => homeBannerKey(tab, index + 1));
  const settings = prisma.systemSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const [rows, preset] = await Promise.all([
    allowDefaultsOnFailure ? settings.catch(() => []) : settings,
    tab === 'creator' ? getSiteImageSelection('banner') : null,
  ]);
  const byKey = new Map(rows.map(({ key, value }) => [key, value]));

  return defaults.map((defaultBanner, index) => {
    const slot = index + 1;
    const key = keys[index];
    const override = homeBannerSchema.safeParse(byKey.get(key)).data;
    const defaultImage = (preset && slot === 1 && siteImageUrl('banner', preset)) || defaultBanner.image;
    const banner = override ?? defaultBanner;
    return {
      slot,
      customized: byKey.has(key),
      imageInput: override?.image ?? '',
      banner: { ...banner, image: override?.image || defaultImage },
    };
  });
}
