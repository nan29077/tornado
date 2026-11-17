import { Suspense, cache } from 'react';
import { getFanHomeData } from '@/server/services/home-fan';
import { FanHome } from './fan-home';
import { WatchingCounter } from './watching-counter';
import { VoteRankingSection } from './vote-ranking-section';

/** 한 요청 안에서 헤더 시청 현황과 본문이 같은 데이터를 한 번만 불러오게 한다. */
const loadFanHome = cache((viewerId: string | null) => getFanHomeData(viewerId ? { id: viewerId } : null));

/** 구독자 전용 탭 데이터를 불러와 그린다. 메인 화면은 Suspense 로 감싸 배너·탭을 먼저 보여 준다. */
export async function FanHomeLoader({ viewerId }: { viewerId: string | null }) {
  const data = await loadFanHome(viewerId);
  return (
    <FanHome
      data={data}
      loggedIn={Boolean(viewerId)}
      voteSection={
        <Suspense fallback={<div className="mt-8 h-[320px] animate-pulse rounded-[26px] bg-ink-50" aria-hidden />}>
          <VoteRankingSection viewerId={viewerId} />
        </Suspense>
      }
    />
  );
}

/** 상단 헤더의 "지금 N명이 시청 중" (구독자 전용 탭일 때만, 2026-11-17) */
export async function FanHeaderWatchingLoader({ viewerId }: { viewerId: string | null }) {
  const data = await loadFanHome(viewerId).catch(() => null);
  if (!data) return null;
  return <WatchingCounter viewers={data.watching.viewers} liveCount={data.watching.liveCount} />;
}

export function FanHomeSkeleton() {
  return (
    <div className="mt-4 space-y-4" aria-busy="true" aria-label="구독자 전용 화면을 불러오는 중">
      <div className="h-[150px] animate-pulse rounded-2xl bg-ink-50" />
      <div className="flex gap-2.5 overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="aspect-video w-[200px] shrink-0 animate-pulse rounded-2xl bg-ink-50" />
        ))}
      </div>
      <div className="h-[220px] animate-pulse rounded-2xl bg-ink-50" />
    </div>
  );
}
