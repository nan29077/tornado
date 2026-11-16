import { getFanHomeData } from '@/server/services/home-fan';
import { FanHome } from './fan-home';

/** 구독자 전용 탭 데이터를 불러와 그린다. 메인 화면은 Suspense 로 감싸 배너·탭을 먼저 보여 준다. */
export async function FanHomeLoader({ viewerId }: { viewerId: string | null }) {
  const data = await getFanHomeData(viewerId ? { id: viewerId } : null);
  return <FanHome data={data} loggedIn={Boolean(viewerId)} />;
}

export function FanHomeSkeleton() {
  return (
    <div className="mt-4 space-y-4" aria-busy="true" aria-label="구독자 전용 화면을 불러오는 중">
      <div className="h-[74px] animate-pulse rounded-2xl bg-brand-50" />
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
