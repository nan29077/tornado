import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import {
  GameError,
  closeRound,
  endRound,
  reopenRound,
  revealRound,
  spinRound,
  startRound,
  traceLadder,
  undoReveal,
} from '@/server/services/games';
import { buildStudioState } from '@/server/services/game-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 방송 중 진행 조작.
 *
 * 진행 버튼(시작 · 돌리기 · 마감 · 발표)에는 확인 알림창을 두지 않는다.
 * 방송 중에 확인창이 뜨면 타이밍을 놓친다. 대신 되돌릴 수 있는 경로를 함께 제공한다.
 *   - 마감 → reopen (마감 취소)
 *   - 발표 → undo   (발표 취소, 5초 실행취소 토스트)
 * 되돌릴 수 없는 동작(게임 삭제)만 화면에서 확인창을 띄운다.
 */
export async function POST(req: Request) {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');
    const gameId = String(body.gameId ?? '');
    const roundId = String(body.roundId ?? '');

    switch (action) {
      case 'start':
        await startRound(creatorId, gameId);
        break;
      case 'spin':
        await spinRound(
          creatorId,
          roundId,
          typeof body.selectedIndex === 'number' ? body.selectedIndex : undefined,
        );
        break;
      case 'close':
        await closeRound(creatorId, roundId);
        break;
      case 'reopen':
        await reopenRound(creatorId, roundId);
        break;
      case 'reveal':
        await revealRound(creatorId, roundId);
        break;
      case 'undo':
        await undoReveal(creatorId, roundId);
        break;
      case 'trace':
        // 결과가 나온 사다리에서 따라 그릴 줄만 바꾼다 (결과는 건드리지 않는다)
        await traceLadder(creatorId, roundId, Number(body.selectedIndex));
        break;
      case 'end':
        await endRound(creatorId, roundId);
        break;
      default:
        return NextResponse.json({ error: '알 수 없는 요청입니다.' }, { status: 400 });
    }

    // 조작 직후의 상태를 함께 돌려준다. SSE 를 기다리지 않고 화면이 바로 반응한다.
    const state = await buildStudioState(creatorId);
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    const message = e instanceof GameError ? e.message : '처리 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: e instanceof GameError ? 400 : 500 });
  }
}
