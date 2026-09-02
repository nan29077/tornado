import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import { createGame, listGames, listRoundHistory, GameError } from '@/server/services/games';
import { buildStudioState } from '@/server/services/game-state';
import { prisma } from '@/server/db';

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

  const [games, state, history, overlaySetting] = await Promise.all([
    listGames(creatorId),
    buildStudioState(creatorId),
    listRoundHistory(creatorId),
    prisma.overlaySetting.findUnique({ where: { creatorId }, select: { gameEnabled: true } }),
  ]);
  return NextResponse.json({
    games,
    state,
    history,
    overlayConfigured: Boolean(overlaySetting),
    gameEnabled: overlaySetting?.gameEnabled ?? false,
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
    const body = await req.json().catch(() => ({}));
    const id = await createGame(creatorId, {
      type: String(body.type ?? ''),
      title: String(body.title ?? ''),
      items: Array.isArray(body.items) ? body.items : [],
      config: body.config && typeof body.config === 'object' ? body.config : {},
      entryMode: String(body.entryMode ?? 'LINK'),
      donationMinAmount: Number(body.donationMinAmount ?? 0),
      autoCloseSec: Number(body.autoCloseSec ?? 0),
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return fail(e);
  }
}
