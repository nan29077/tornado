import { z } from 'zod';
import type { HomeTab } from '@/lib/home-tab';
import { parseVideoUrl } from '@/lib/shop-video-embed';
import { DEFAULT_HOME_BANNER } from '@/lib/site-images';

const isBannerUrl = (value: string) => {
  if (!value || /[\s\\"'<>]/u.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  if (!value.startsWith('https://') && !value.startsWith('http://')) return false;
  const url = URL.parse(value);
  return Boolean(url && !url.username && !url.password);
};

export function homeBannerVideo(url: string) {
  const parsed = parseVideoUrl(url);
  if (parsed?.platform === 'YOUTUBE') return { kind: 'youtube' as const, id: parsed.externalId };
  if (isBannerUrl(url) && /\.(mp4|webm)$/i.test(url.split(/[?#]/, 1)[0])) {
    return { kind: 'file' as const, url };
  }
  return null;
}

const optionalUrl = z.string().max(1000).refine((value) => !value || isBannerUrl(value), 'http(s) 주소 또는 /로 시작하는 내부 경로를 입력해 주세요.');

export const homeBannerSchema = z.object({
  image: optionalUrl,
  eyebrow: z.string().max(40),
  title: z.string().min(2).max(90),
  description: z.string().max(220),
  href: optionalUrl,
  cta: z.string().max(30),
  video: z.string().max(1000).refine((value) => !value || homeBannerVideo(value), 'MP4·WebM 파일 주소 또는 YouTube 영상 주소를 입력해 주세요.'),
  poster: optionalUrl,
}).refine((banner) => Boolean(banner.href) === Boolean(banner.cta), {
  path: ['href'],
  message: '버튼 이름과 연결 주소를 함께 입력해 주세요.',
});

export type HomeBanner = z.infer<typeof homeBannerSchema>;

export const DONAIDO_PROMO_VIDEO = '/videos/donaido-creator-promo.mp4';
export const DONAIDO_PROMO_POSTER = '/videos/donaido-creator-promo-poster.webp';

export const HOME_BANNER_DEFAULTS: Record<HomeTab, readonly HomeBanner[]> = {
  creator: [
    {
      image: DEFAULT_HOME_BANNER,
      eyebrow: 'MESSAGE TO LIVE',
      title: '문자 한 통이\n방송을 움직입니다',
      description: '진심을 담아 보낸 메시지가 결제 완료 후 라이브 화면과 음성으로 전달됩니다.',
      href: '/how-it-works',
      cta: '문자후원 알아보기',
      video: '',
      poster: '',
    },
    {
      image: '/assets/tornado-hero-viewer-v2.png',
      eyebrow: 'SIMPLE SUPPORT',
      title: '보는 순간 바로\n응원을 전하세요',
      description: '복잡한 앱 설치 없이 안내된 번호로 문자를 보내고 안전하게 후원하세요.',
      href: '/how-it-works',
      cta: '이용방법 보기',
      video: '',
      poster: '',
    },
    {
      image: '/assets/tornado-hero-studio-v2.png',
      eyebrow: 'FOR CREATORS',
      title: '후원의 순간을\n더 특별한 장면으로',
      description: '유튜브·OBS·PRISM·TTS를 연결해 크리에이터만의 후원 경험을 만드세요.',
      href: '/creator-apply',
      cta: '크리에이터 시작하기',
      video: '',
      poster: '',
    },
    {
      image: '/assets/tornado-hero-mascot-v1.png',
      eyebrow: 'MEET DONAIDO',
      title: '도네이도와 함께\n응원이 주인공이 됩니다',
      description: '마음을 담은 문자 한 통이 도네이도 캐릭터와 방송 효과로 살아납니다.',
      href: '/how-it-works',
      cta: '도네이도 경험하기',
      video: '',
      poster: '',
    },
  ],
  fan: [
    {
      image: '/banners/donaido-fan-welcome.webp',
      eyebrow: '',
      title: '좋아하는 방송에,\n당신의 응원을',
      description: '마음에 드는 크리에이터를 찾고, 문자 한 통으로 응원을 전해 보세요.',
      href: '/explore/creators',
      cta: '크리에이터 둘러보기',
      video: '',
      poster: '',
    },
    {
      image: '/banners/donaido-fan-message.webp',
      eyebrow: '대표 영상 · 문자 후원',
      title: '문자 한 통으로\n마음을 전하세요',
      description: '응원을 보내는 방법, 영상으로 확인해 보세요.',
      href: '/how-it-works',
      cta: '문자 후원 방법',
      video: `${DONAIDO_PROMO_VIDEO}#t=8,21`,
      poster: '/videos/donaido-fan-message-poster.webp',
    },
    {
      image: '/banners/donaido-fan-live.webp',
      eyebrow: '대표 영상 · 라이브 방송',
      title: '내 응원 문자가\n방송 화면에 그대로',
      description: '유튜브 채팅과 방송 화면에 바로 나타나요.',
      href: '/explore/live',
      cta: '라이브 둘러보기',
      video: `${DONAIDO_PROMO_VIDEO}#t=21,30`,
      poster: '/videos/donaido-fan-live-poster.webp',
    },
  ],
};
