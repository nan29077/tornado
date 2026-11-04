export const DEFAULT_SITE_IMAGE = 'default';
export const CLASSIC_MARGIN_IMAGE = 'classic';
export const CLASSIC_PUBLIC_MARGIN_URL = '/assets/donaido-mascot-world-bg-v1.png';
export const DEFAULT_HOME_BANNER = '/assets/tornado-hero-creator-v2.png';

export const SITE_IMAGE_PRESETS = {
  margin: [
    { id: 'clouds', name: '구름 위 하트', description: '움직이는 3D 일러스트' },
    { id: 'garden', name: '햇살 정원', description: '움직이는 정원 속 도네이도' },
    { id: 'cafe', name: '창가의 카페', description: '움직이는 카페 속 도네이도' },
    { id: 'stars', name: '별빛 동화', description: '움직이는 종이 공예풍 일러스트' },
    { id: 'waves', name: '파도 산책', description: '움직이는 바닷가 일러스트' },
    { id: 'photo-park', name: '벚꽃 공원' },
    { id: 'photo-library', name: '도서관에서 만나요' },
    { id: 'photo-market', name: '꽃시장의 아침' },
    { id: 'photo-beach', name: '해 질 녘 바닷가' },
    { id: 'photo-workshop', name: '햇살 도자기 공방' },
  ],
  banner: [
    { id: 'broadcast', name: '심야 방송 스튜디오' },
    { id: 'festival', name: '크리에이터 축제' },
    { id: 'arcade', name: '하트 아케이드' },
    { id: 'postcard', name: '노을빛 응원 편지' },
    { id: 'gift', name: '도네이도의 선물' },
    { id: 'photo-studio', name: '크리에이터와 함께' },
    { id: 'photo-street', name: '비 갠 서울 골목' },
    { id: 'photo-field', name: '들꽃 사이에서' },
    { id: 'photo-coast', name: '저녁 바다 산책' },
    { id: 'photo-desk', name: '카페에서 온 편지' },
  ],
} as const;

export type SiteImageKind = keyof typeof SITE_IMAGE_PRESETS;

export function isSiteImageSelection(kind: SiteImageKind, value: unknown): value is string {
  return value === DEFAULT_SITE_IMAGE
    || (kind === 'margin' && value === CLASSIC_MARGIN_IMAGE)
    || SITE_IMAGE_PRESETS[kind].some((preset) => preset.id === value);
}

export function siteImageUrl(kind: SiteImageKind, value: string): string | undefined {
  if (value === DEFAULT_SITE_IMAGE || !isSiteImageSelection(kind, value)) return undefined;
  if (value === CLASSIC_MARGIN_IMAGE) return CLASSIC_PUBLIC_MARGIN_URL;
  return `/site-images/${kind}/${value}.webp`;
}

export function siteMarginPanelUrl(value: string, side: 'left' | 'right'): string {
  if (value === CLASSIC_MARGIN_IMAGE) return `/assets/donaido-donation-margin-${side}-v1.webp`;
  const preset = isSiteImageSelection('margin', value) ? value : DEFAULT_SITE_IMAGE;
  return `/site-images/margin/full/${preset}-${side}.webp`;
}
