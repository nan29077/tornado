import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { clampOverlayLayout } from '@/lib/overlay-layout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 오버레이 배치 저장 (후원 알림 / 게임 각각).
 *
 * 서버 액션이 아니라 JSON 라우트로 둔다. 드래그로 조정한 뒤 바로 저장하는 화면이라
 * 서버 액션처럼 화면 전체를 다시 그리면 미리보기 iframe 이 다시 붙으면서 화면이 깜빡인다.
 */
export async function POST(req: Request) {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const target = body?.target === 'game' ? 'game' : body?.target === 'donation' ? 'donation' : null;
  if (!target) {
    return NextResponse.json({ error: '어느 화면의 배치인지 알 수 없습니다.' }, { status: 400 });
  }

  const layout = clampOverlayLayout(body);

  const setting = await prisma.overlaySetting.findUnique({ where: { creatorId }, select: { id: true } });
  if (!setting) {
    return NextResponse.json(
      { error: '먼저 [방송 준비]에서 연결 주소를 발급해 주세요.' },
      { status: 400 },
    );
  }

  await prisma.overlaySetting.update({
    where: { creatorId },
    data:
      target === 'game'
        ? { gameOffsetX: layout.offsetX, gameOffsetY: layout.offsetY, gameScalePct: layout.scalePct }
        : { offsetX: layout.offsetX, offsetY: layout.offsetY, scalePct: layout.scalePct },
  });

  return NextResponse.json({ ok: true, target, ...layout });
}
