import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import { GameError, setWinnerFulfilled } from '@/server/services/games';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 보상 전달 완료 체크. 금전 지급이 아니라 크리에이터의 확인 기록이다. */
export async function POST(req: Request) {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    await setWinnerFulfilled(creatorId, String(body.winnerId ?? ''), Boolean(body.done));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof GameError ? e.message : '처리 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: e instanceof GameError ? 400 : 500 });
  }
}
