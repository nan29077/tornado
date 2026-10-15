import { NextResponse } from 'next/server';
import { rejectCrossOrigin } from '@/server/request-guard';
import { requireCreator } from '@/server/auth';
import { readJsonObject } from '@/lib/json-body';
import {
  GameOverlaySettingError,
  setGameOverlayEnabled,
} from '@/server/services/game-overlay-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 게임 오버레이만 독립적으로 켜고 끈다. 후원 오버레이 설정은 변경하지 않는다. */
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
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: '사용 여부 값이 올바르지 않습니다.' }, { status: 400 });
    }
    const result = await setGameOverlayEnabled(creatorId, body.enabled);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const known = e instanceof GameOverlaySettingError;
    return NextResponse.json(
      { error: known ? e.message : '게임 오버레이 설정을 저장하지 못했습니다.' },
      { status: known ? 400 : 500 },
    );
  }
}
