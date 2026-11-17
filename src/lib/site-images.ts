export const DEFAULT_SITE_IMAGE = 'default';
export const CLASSIC_MARGIN_IMAGE = 'classic';
export const CLASSIC_PUBLIC_MARGIN_URL = '/assets/donaido-mascot-world-bg-v1.png';
export const CREATOR_HOME_BANNER_IMAGES = {
  broadcast: '/banners/donaido-creator-broadcast-v3.webp',
  viewer: '/banners/donaido-creator-viewer-v3.webp',
  studio: '/banners/donaido-creator-studio-v3.webp',
  mascot: '/banners/donaido-creator-mascot-v3.webp',
} as const;
export const DEFAULT_HOME_BANNER = CREATOR_HOME_BANNER_IMAGES.broadcast;

const legacyBannerImages = new Map<string, string>([
  ['/assets/tornado-hero-creator-v1.png', CREATOR_HOME_BANNER_IMAGES.broadcast],
  ['/assets/tornado-hero-creator-v2.png', CREATOR_HOME_BANNER_IMAGES.broadcast],
  ['/assets/tornado-hero-viewer-v1.png', CREATOR_HOME_BANNER_IMAGES.viewer],
  ['/assets/tornado-hero-viewer-v2.png', CREATOR_HOME_BANNER_IMAGES.viewer],
  ['/assets/tornado-hero-studio-v1.png', CREATOR_HOME_BANNER_IMAGES.studio],
  ['/assets/tornado-hero-studio-v2.png', CREATOR_HOME_BANNER_IMAGES.studio],
  ['/assets/tornado-hero-mascot-v1.png', CREATOR_HOME_BANNER_IMAGES.mascot],
]);

/** 운영자가 저장한 예전 기본 배너 주소로도 최신 이미지를 보여 준다. */
export function currentBannerImageUrl(url: string, siteUrl?: string): string {
  if (url.startsWith('/')) return legacyBannerImages.get(url.split(/[?#]/, 1)[0]) ?? url;
  if (!siteUrl) return url;
  const absolute = URL.parse(url);
  if (!absolute || absolute.origin !== URL.parse(siteUrl)?.origin) return url;
  return legacyBannerImages.get(absolute.pathname) ?? url;
}

export const SITE_IMAGE_PRESETS = {
  margin: [
    { id: 'airy-cloud-post', name: '구름 위 편지', description: '크림빛 구름과 작은 응원 편지' },
    { id: 'airy-paper-stars', name: '종이별 모빌', description: '라벤더 종이공예와 별자리 장식' },
    { id: 'airy-heart-ribbon', name: '살구빛 하트 리본', description: '부드러운 리본 곡선과 하트 패턴' },
    { id: 'airy-watercolor-garden', name: '수채화 꽃바람', description: '세이지 잎사귀와 노란 들꽃' },
    { id: 'airy-retro-music', name: '레트로 음악 산책', description: '민트·코랄 음표와 레코드 패턴' },
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

export function isAiryMarginImage(value: string): boolean {
  return value.startsWith('airy-') && SITE_IMAGE_PRESETS.margin.some((preset) => preset.id === value);
}

export function isSiteImageSelection(kind: SiteImageKind, value: unknown): value is string {
  return value === DEFAULT_SITE_IMAGE
    || (kind === 'margin' && value === CLASSIC_MARGIN_IMAGE)
    || SITE_IMAGE_PRESETS[kind].some((preset) => preset.id === value);
}

export function siteImageUrl(kind: SiteImageKind, value: string): string | undefined {
  if (value === DEFAULT_SITE_IMAGE || !isSiteImageSelection(kind, value)) return undefined;
  if (value === CLASSIC_MARGIN_IMAGE) return CLASSIC_PUBLIC_MARGIN_URL;
  if (kind === 'margin' && value === 'cafe') return '/site-images/margin/cafe-v2.webp';
  return `/site-images/${kind}/${value}.webp`;
}

export function siteMarginPanelUrl(value: string, side: 'left' | 'right'): string {
  if (value === CLASSIC_MARGIN_IMAGE) return `/assets/donaido-donation-margin-${side}-v1.webp`;
  if (isAiryMarginImage(value)) return `/site-images/margin/${value}.webp`;
  if (value === 'cafe' && side === 'left') return '/site-images/margin/full/cafe-left-v2.webp';
  const preset = isSiteImageSelection('margin', value) ? value : DEFAULT_SITE_IMAGE;
  return `/site-images/margin/full/${preset}-${side}.webp`;
}
