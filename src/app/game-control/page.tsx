import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { GameStudio } from '@/components/studio/game-studio';
import { getSessionUser } from '@/server/auth';

/**
 * 게임 진행 전용 팝아웃 창.
 *
 * 크리에이터는 방송 중에 OBS 를 전체화면으로 띄워 둔다. 브라우저 창을 오가지 않도록
 * 컨트롤만 담은 작은 창을 따로 연다. OBS 의 [사용자 정의 브라우저 도크]에 이 주소를
 * 넣으면 OBS 안에서 그대로 진행할 수 있다.
 *
 * 스튜디오 좌측 메뉴를 그리지 않기 위해 /studio 아래에 두지 않는다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '게임 진행 | 도네이도',
  robots: { index: false, follow: false },
};

export default async function GameControlPage() {
  const user = await getSessionUser().catch(() => null);
  if (!user?.creatorId || user.creatorStatus !== 'APPROVED') redirect('/login?next=/game-control');

  return (
    <main className="min-h-screen bg-ink-50 px-3 pb-8 pt-3">
      <div className="mb-2.5 flex items-center justify-between">
        <Logo />
        <span className="text-[11px] font-semibold text-ink-300">게임 진행</span>
      </div>
      <GameStudio creatorId={user.creatorId} compact />
      <p className="mt-3 text-center text-[11px] leading-relaxed text-ink-300">
        OBS 의 [보기] → [도크] → [사용자 정의 브라우저 도크]에 이 주소를 넣으면 OBS 안에서 바로 진행할 수 있습니다.
      </p>
    </main>
  );
}
