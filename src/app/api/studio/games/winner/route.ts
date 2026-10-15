import { NextResponse } from 'next/server';
import { rejectCrossOrigin } from '@/server/request-guard';
import { requireCreator } from '@/server/auth';
import { readJsonObject } from '@/lib/json-body';
import { GameError, setWinnerFulfilled } from '@/server/services/games';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 보상 전달 완료 체크. 금전 지급이 아니라 크리에이터의 확인 기록이다. */
export async function POST(req: Request) {
  // [CSRF] 쿠키 인증 상태 변경 라우트 — 다른 출처 요청은 거절한다.
  const crossOrigin = rejectCrossOrigin(req);
  if (crossOrigin) return crossOrigin;

  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const body = await readJsonObject(req);
    await setWinnerFulfilled(creatorId, String(body.winnerId ?? ''), Boolean(body.done));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof GameError ? e.message : '처리 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: e instanceof GameError ? 400 : 500 });
  }
}
