/**
 * 크리에이터 SNS 플랫폼 정의.
 *
 * 링크 검증(서버 액션)과 화면 표시(스튜디오 설정 · 후원 페이지)가 **같은 목록**을 봐야 한다.
 * 예전에는 검증 규칙이 서버 액션 안에만 있고 화면은 따로 문구를 적어 두어서, 플랫폼을 하나
 * 추가할 때마다 두 곳을 고쳐야 했고 한쪽이 늘 뒤처졌다.
 *
 * 이 파일은 브라우저에서도 import 되므로 서버 전용 코드를 넣지 않는다.
 */

export const SNS_PLATFORM_VALUES = ['YOUTUBE', 'INSTAGRAM', 'TIKTOK', 'FACEBOOK'] as const;
export type SnsPlatform = (typeof SNS_PLATFORM_VALUES)[number];

export interface SnsPlatformMeta {
  value: SnsPlatform;
  label: string;
  /** CreatorProfile 의 링크 컬럼 */
  urlField: 'youtubeLiveUrl' | 'instagramLiveUrl' | 'tiktokLiveUrl' | 'facebookLiveUrl';
  /** CreatorProfile 의 "지금 방송 중" 컬럼 */
  liveField: 'youtubeLive' | 'instagramLive' | 'tiktokLive' | 'facebookLive';
  /** 링크 버튼 색. 플랫폼 상징색을 옅게 깔아 한눈에 구분되게 한다. */
  color: string;
  /** 허용 호스트 안내 문구 */
  hostHint: string;
  placeholder: string;
  /** 호스트 검증 */
  test: (url: string) => boolean;
}

function hostMatches(url: string, pattern: RegExp, extraHosts: string[] = []): boolean {
  try {
    const host = new URL(url).hostname;
    return pattern.test(host) || extraHosts.includes(host);
  } catch {
    return false;
  }
}

/**
 * 표시·검사 순서. **파생 라이브 상태의 우선순위이기도 하다.**
 * 여러 플랫폼에 동시송출 중이면 이 순서에서 앞선 플랫폼이 대표(livePlatform)가 된다.
 */
export const SNS_PLATFORMS: readonly SnsPlatformMeta[] = [
  {
    value: 'YOUTUBE',
    label: '유튜브',
    urlField: 'youtubeLiveUrl',
    liveField: 'youtubeLive',
    color: '#FF0000',
    hostHint: 'youtube.com 또는 youtu.be',
    placeholder: 'https://www.youtube.com/@채널이름',
    test: (url) => hostMatches(url, /(^|\.)youtube\.com$/, ['youtu.be']),
  },
  {
    value: 'INSTAGRAM',
    label: '인스타그램',
    urlField: 'instagramLiveUrl',
    liveField: 'instagramLive',
    color: '#C13584',
    hostHint: 'instagram.com',
    placeholder: 'https://www.instagram.com/계정',
    test: (url) => hostMatches(url, /(^|\.)instagram\.com$/),
  },
  {
    value: 'TIKTOK',
    label: '틱톡',
    urlField: 'tiktokLiveUrl',
    liveField: 'tiktokLive',
    color: '#111827',
    hostHint: 'tiktok.com',
    placeholder: 'https://www.tiktok.com/@계정',
    test: (url) => hostMatches(url, /(^|\.)tiktok\.com$/),
  },
  {
    value: 'FACEBOOK',
    label: '페이스북',
    urlField: 'facebookLiveUrl',
    liveField: 'facebookLive',
    color: '#1877F2',
    hostHint: 'facebook.com 또는 fb.com',
    placeholder: 'https://www.facebook.com/페이지',
    test: (url) => hostMatches(url, /(^|\.)facebook\.com$/, ['fb.com', 'www.fb.com', 'fb.watch']),
  },
] as const;

export function snsPlatform(value: SnsPlatform): SnsPlatformMeta {
  const found = SNS_PLATFORMS.find((p) => p.value === value);
  if (!found) throw new Error(`알 수 없는 SNS 플랫폼입니다: ${value}`);
  return found;
}

export function isSnsPlatform(value: string): value is SnsPlatform {
  return (SNS_PLATFORM_VALUES as readonly string[]).includes(value);
}

/** 후원 페이지·스튜디오가 함께 쓰는, 플랫폼 하나의 현재 상태 */
export interface SnsLinkState {
  platform: SnsPlatformMeta;
  url: string;
  live: boolean;
}

/**
 * 크리에이터 레코드에서 SNS 링크 목록을 뽑는다.
 * 주소가 없는 플랫폼은 제외한다(빈 버튼을 후원 페이지에 그리지 않는다).
 */
export function readSnsLinks(
  creator: Partial<Record<SnsPlatformMeta['urlField'], string | null>> &
    Partial<Record<SnsPlatformMeta['liveField'], boolean | null>>,
): SnsLinkState[] {
  const out: SnsLinkState[] = [];
  for (const platform of SNS_PLATFORMS) {
    const url = (creator[platform.urlField] ?? '').trim();
    if (!url) continue;
    out.push({ platform, url, live: Boolean(creator[platform.liveField]) });
  }
  return out;
}

/**
 * 플랫폼별 스위치에서 liveOn / livePlatform / liveUrl 파생값을 만든다.
 *
 * 이 세 컬럼을 남겨 두는 이유: 후원 페이지 말고도 "방송 중인가"만 알면 되는 곳이 생기는데,
 * 그때마다 네 컬럼을 OR 로 묶게 하면 한 군데만 빠뜨려도 화면끼리 어긋난다.
 */
export function deriveLiveState(links: SnsLinkState[]): {
  liveOn: boolean;
  livePlatform: SnsPlatform | null;
  liveUrl: string | null;
} {
  const primary = links.find((l) => l.live && l.url);
  if (!primary) return { liveOn: false, livePlatform: null, liveUrl: null };
  return { liveOn: true, livePlatform: primary.platform.value, liveUrl: primary.url };
}
