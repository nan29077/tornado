import type { VideoItem } from '@/lib/video-hub';

const channelAvatars: Record<string, string> = {
  'UCNhofiqfw5nl-NeDJkXtPvw': 'https://yt3.ggpht.com/Sr5y4IxegXCEZ0SYNvFB749crrAZmNpurZqfq2KvPEpiCYeakoMjBWMnW_56rMuYW_HipJOBRtU=s88-c-k-c0x00ffffff-no-rj',
  'UCyn-K7rZLXjGl7VXGweIlcA': 'https://yt3.ggpht.com/tVvGKye5hDl70LaxrUsJBfm-rE9RES7bJDxSrjyO-vQDVb5EUJvUJefjUJ0dp-ixLIkrDYVX4A=s88-c-k-c0x00ffffff-no-rj',
};

/** 채널 피드가 비었을 때 소개할 공개 YouTube 영상. 후원 정보나 확인되지 않은 조회수는 넣지 않는다. */
const videos = [
  {
    id: 'lQq5EwP_Lyg',
    channelId: 'UCNhofiqfw5nl-NeDJkXtPvw',
    channelTitle: '빠니보틀 Pani Bottle',
    title: '자유인이 되어 바쁜 친구에게 벚꽃 나들이 힐링 여행 선물하기【하동】',
    category: 'travel',
    publishedAt: '2026-04-30',
  },
  {
    id: 'cJKmZb7EqUg',
    channelId: 'UCNhofiqfw5nl-NeDJkXtPvw',
    channelTitle: '빠니보틀 Pani Bottle',
    title: '오랜만에 울릉도를 다시 찾아간 두 남자【울릉도1】',
    category: 'travel',
    publishedAt: '2024-09-11',
  },
  {
    id: 'DnQ09ZZCjCs',
    channelId: 'UCyn-K7rZLXjGl7VXGweIlcA',
    channelTitle: '백종원 PAIK JONG WON',
    title: '초간단 김치찌개 · 백종원의 백종원 레시피',
    category: 'mukbang',
    publishedAt: '2019-06-13',
  },
] satisfies Pick<VideoItem, 'id' | 'channelId' | 'channelTitle' | 'title' | 'category' | 'publishedAt'>[];

export const PUBLIC_VIDEOS = videos.map((video): VideoItem => ({
  ...video,
  source: 'youtube',
  channelAvatarUrl: channelAvatars[video.channelId],
  thumbnail: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
  views: null,
  isShort: false,
  creator: null,
}));
