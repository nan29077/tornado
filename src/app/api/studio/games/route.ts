import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import { createGame, listGames, listRoundHistory, GameError } from '@/server/services/games';
import { buildStudioState } from '@/server/services/game-state';
import { prisma } from '@/server/db';
import { isRecord, readJsonObject, stringList } from '@/lib/json-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 크리에이터 게임 목록 · 생성.
 *
 * 컨트롤 화면은 방송 중에 빠르게 반응해야 해서 서버 액션 대신 이 JSON 라우트를 쓴다.
 * (서버 액션은 화면 전체를 다시 그리게 만들어 진행 버튼의 체감 지연이 커진다)
 */

function fail(e: unknown) {
  const message = e instanceof GameError ? e.message : '처리 중 오류가 발생했습니다.';
  const status = e instanceof GameError ? 400 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const [games, state, history, overlaySetting, youtube] = await Promise.all([
    listGames(creatorId),
    buildStudioState(creatorId),
    listRoundHistory(creatorId),
    prisma.overlaySetting.findUnique({ where: { creatorId }, select: { gameEnabled: true } }),
    /**
     * 유튜브 연결 여부.
     *
     * [유튜브 채팅에 올리기] 버튼이 **연결하지 않은 크리에이터에게도 보였다.**
     * 누르면 "유튜브를 먼저 연결해 주세요" 오류만 나온다. 쓸 수 없는 버튼을 방송 중에
     * 눌러 보게 만드는 셈이라, 연결돼 있을 때만 버튼을 그리도록 상태를 함께 내려준다.
     */
    prisma.youTubeConnection.findFirst({
      where: { creatorId, status: { not: 'REVOKED' } },
      select: { id: true },
    }),
  ]);
  return NextResponse.json({
    games,
    state,
    history,
    overlayConfigured: Boolean(overlaySetting),
    gameEnabled: overlaySetting?.gameEnabled ?? false,
    youtubeConnected: Boolean(youtube),
  });
}

export async function POST(req: Request) {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const body = await readJsonObject(req);
    const id = await createGame(creatorId, {
      type: String(body.type ?? ''),
      title: String(body.title ?? ''),
      items: stringList(body.items),
      config: isRecord(body.config) ? body.config : {},
      entryMode: String(body.entryMode ?? 'LINK'),
      donationMinAmount: Number(body.donationMinAmount ?? 0),
      autoCloseSec: Number(body.autoCloseSec ?? 0),
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return fail(e);
  }
}
