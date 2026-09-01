import { NextResponse } from 'next/server';
import { requireCreator } from '@/server/auth';
import { deleteGame, updateGame, GameError } from '@/server/services/games';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const message = e instanceof GameError ? e.message : '처리 중 오류가 발생했습니다.';
  const status = e instanceof GameError ? 400 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    await updateGame(creatorId, id, {
      type: '',
      title: String(body.title ?? ''),
      items: Array.isArray(body.items) ? body.items : [],
      config: body.config && typeof body.config === 'object' ? body.config : {},
      entryMode: String(body.entryMode ?? 'LINK'),
      donationMinAmount: Number(body.donationMinAmount ?? 0),
      autoCloseSec: Number(body.autoCloseSec ?? 0),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let creatorId: string;
  try {
    creatorId = (await requireCreator()).creatorId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  try {
    const { id } = await ctx.params;
    await deleteGame(creatorId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
