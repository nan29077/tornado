import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { clientIpFromRequest, consumeRateLimit } from '@/server/rate-limit';
import { GameError, joinByCode } from '@/server/services/games';
import { publicConfig } from '@/server/services/game-state';
import { needsNickname, usesChoices } from '@/lib/game-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 시청자 참여 API.
 *
 * 인증이 없는 공개 경로다. 남용은 세 겹으로 막는다.
 *  1) IP 속도 제한 — 한 회선에서 쏟아지는 요청을 잘라낸다
 *  2) 회차 단위 유니크 제약 — 같은 기기(브라우저)는 한 번만 참여한다
 *  3) 정답·확률은 애초에 응답에 넣지 않는다
 *
 * 기기 식별은 브라우저가 만든 값을 쓴다. IP 로 묶으면 이동통신망 NAT 때문에
 * 서로 다른 시청자가 같은 사람으로 취급되어 정상 참여가 막힌다.
 */

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 참여 페이지가 그릴 수 있는 최소한의 정보만 내려보낸다. */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const round = await prisma.gameRound.findUnique({
    where: { joinCode: code.toUpperCase() },
    include: { game: { include: { creator: { select: { displayName: true } } } } },
  });
  if (!round) return badRequest('참여 코드를 찾을 수 없습니다.', 404);

  const game = round.game;
  const config = publicConfig(game.type, (game.config ?? {}) as Record<string, unknown>, false);
  const participantCount = await prisma.gameParticipant.count({ where: { roundId: round.id } });

  return NextResponse.json({
    roundId: round.id,
    status: round.status,
    type: game.type,
    title: game.title,
    creatorName: game.creator.displayName,
    entryMode: game.entryMode,
    needsNickname: needsNickname(game.type),
    choices: usesChoices(game.type) ? (config.choices ?? []) : [],
    topic: String(config.topic ?? ''),
    question: String(config.question ?? ''),
    range:
      game.type === 'NUMBER_GUESS'
        ? { min: Number(config.min ?? 0), max: Number(config.max ?? 0) }
        : null,
    closesAt: round.closesAt ? round.closesAt.toISOString() : null,
    participantCount,
    prize: String(config.prize ?? ''),
  });
}

const CLIENT_ID = /^[a-zA-Z0-9_-]{8,64}$/;

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;

  const ip = clientIpFromRequest(req);
  // 한 회선에서 분당 30건. 정상 시청자는 회차당 1건만 보낸다.
  const limited = await consumeRateLimit('game-join', ip, 30, 60);
  if (!limited.ok) return badRequest('참여 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);

  const body = await req.json().catch(() => ({}));
  const clientId = String(body.clientId ?? '');
  if (!CLIENT_ID.test(clientId)) return badRequest('참여 정보를 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요.');

  // 로그인한 후원자는 계정 기준으로 중복을 막는다(기기를 바꿔도 1회).
  let donorId: string | null = null;
  try {
    const user = await getSessionUser();
    if (user?.id) {
      const donor = await prisma.donorProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
      donorId = donor?.id ?? null;
    }
  } catch {
    /* 비로그인 참여는 정상 경로다 */
  }

  try {
    const result = await joinByCode(code, {
      name: String(body.name ?? ''),
      entry: String(body.entry ?? ''),
      deviceKey: clientId,
      donorId,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof GameError) return badRequest(e.message);
    return badRequest('참여에 실패했습니다. 잠시 후 다시 시도해 주세요.', 500);
  }
}
