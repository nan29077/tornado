import { getLiveCreators, getVideoFeed } from '@/server/services/video-hub';
import { HomeVideoPane } from './home-video-pane';
import { CONTENT_CATEGORY_SLUGS, type VideoCategorySlug } from '@/lib/video-hub';

/**
 * 메인 화면용 데이터 로더 (서버 컴포넌트).
 * 메인에서는 <Suspense> 로 감싸 쓴다 — 유튜브 피드를 기다리는 동안에도 메인 화면은 먼저 뜬다.
 * 어떤 오류든 영상 영역만 비우고 메인 화면은 그대로 둔다.
 */
async function loadHomeVideos() {
  try {
    const [feed, lives] = await Promise.all([getVideoFeed(), getLiveCreators(20).catch(() => [])]);
    const count = new Map<string, number>();
    for (const v of feed.items) count.set(v.category, (count.get(v.category) ?? 0) + 1);
    const categories = CONTENT_CATEGORY_SLUGS.filter((slug) => (count.get(slug) ?? 0) > 0);
    const hasShorts = feed.items.some((v) => v.isShort);
    return { items: feed.items.slice(0, 60), now: feed.now, liveCount: lives.length, categories, hasShorts };
  } catch {
    return { items: [], now: 0, liveCount: 0, categories: [] as VideoCategorySlug[], hasShorts: false };
  }
}

export async function HomeVideoPaneLoader({ inDialog = false }: { inDialog?: boolean }) {
  const { items, now, liveCount, categories, hasShorts } = await loadHomeVideos();
  return <HomeVideoPane items={items} now={now} inDialog={inDialog} liveCount={liveCount} categories={categories} hasShorts={hasShorts} />;
}
