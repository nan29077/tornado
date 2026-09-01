import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { prisma } from '@/server/db';
import { publicConfig } from '@/server/services/game-state';
import { needsNickname, usesChoices, usesEntries, GAME_TYPE_META, type GameType } from '@/lib/game-catalog';
import { PlayClient } from './play-client';

/**
 * 시청자 참여 페이지.
 *
 * 방송 화면의 QR 을 찍어 들어오는 모바일 화면이다.
 *  - 로그인·앱 설치 없이 참여한다.
 *  - 결과는 방송 화면에서 발표된다. 이 페이지는 결과를 계속 조회하지 않는다.
 *    시청자 수천 명이 동시에 접속하는 화면이라, 각자 폴링을 돌리면 서버가 먼저 무너진다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '도네이도 게임 참여',
  robots: { index: false, follow: false },
};

export default async function PlayPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const round = await prisma.gameRound.findUnique({
    where: { joinCode: code.toUpperCase() },
    include: { game: { include: { creator: { select: { displayName: true } } } } },
  });
  if (!round || !usesEntries(round.game.type)) notFound();

  const game = round.game;
  const config = publicConfig(game.type, (game.config ?? {}) as Record<string, unknown>, false);
  const participantCount = await prisma.gameParticipant.count({ where: { roundId: round.id } });
  const meta = GAME_TYPE_META[game.type as GameType];

  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">게임 참여</span>
        </div>

        <PlayClient
          code={code.toUpperCase()}
          status={round.status}
          type={game.type}
          typeLabel={meta?.label ?? '게임'}
          title={game.title}
          creatorName={game.creator.displayName}
          entryMode={game.entryMode}
          needsNickname={needsNickname(game.type)}
          choices={usesChoices(game.type) ? ((config.choices as string[]) ?? []) : []}
          topic={String(config.topic ?? '')}
          question={String(config.question ?? '')}
          range={
            game.type === 'NUMBER_GUESS'
              ? { min: Number(config.min ?? 0), max: Number(config.max ?? 0) }
              : null
          }
          prize={String(config.prize ?? '')}
          closesAt={round.closesAt ? round.closesAt.toISOString() : null}
          participantCount={participantCount}
        />

        <p className="mt-6 text-center text-[11px] leading-relaxed text-ink-300">
          결과는 방송 화면에서 발표됩니다. 참여에는 후원이나 결제가 필요하지 않습니다.
        </p>
      </div>
    </main>
  );
}
