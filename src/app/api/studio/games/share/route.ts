import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import { shareGameLinkToChat } from '@/server/services/game-share';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 진행 중인 게임의 참여 링크를 유튜브 라이브 채팅에 올린다.
 * 크리에이터가 버튼을 눌렀을 때만 동작한다. 실패해도 게임 진행에는 영향이 없다.
 */
export async function POST() {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const result = await shareGameLinkToChat(creatorId);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    return NextResponse.json({ ok: true, message: result.message });
  } catch {
    return NextResponse.json({ error: '유튜브 채팅에 올리지 못했습니다.' }, { status: 500 });
  }
}
