import { prisma } from '@/server/db';
import { authorizeOverlay } from '@/server/services/overlay-access';
import { findOverlayTtsGrant } from '@/server/services/overlay-bus';
import { consumeRateLimit } from '@/server/rate-limit';
import {
  normalizeTtsProvider,
  resolveNaverCredentials,
  synthesizeWithNaver,
} from '@/server/services/tts/naver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 서버 TTS 합성 (오버레이 전용).
 *
 *   GET /api/tts/synthesize?creatorId=...&token=...&eventId=...
 *
 * 규칙
 *  - 오버레이 토큰(또는 스튜디오 미리보기 세션)으로만 접근할 수 있다.
 *  - **읽을 문장은 요청자가 정하지 않는다.** 실제로 발행된 오버레이 이벤트의 문장만 합성한다.
 *    예전에는 text 를 쿼리로 그대로 받았는데, 오버레이 토큰은 OBS 브라우저 소스 URL 에
 *    늘 노출되는 값이라 그것을 아는 사람이 아무 문장이나 무제한으로 유료 합성시킬 수 있었고
 *    (크리에이터의 클로바 API 가 호출 수만큼 과금된다), 후원 메시지에 적용한 금칙어도
 *    이 경로에서는 아무 의미가 없었다.
 *  - 크리에이터가 고른 제공사가 서버 합성이 아니면 400 으로 거절한다.
 *    (오버레이 클라이언트는 실패 시 브라우저 음성으로 되돌아간다)
 *  - 합성 실패는 결제/방송 상태에 영향을 주지 않는다.
 */

/** 한 크리에이터가 1분에 요청할 수 있는 합성 횟수. 재생 실패 재시도까지 감안한 값이다. */
const RATE_MAX_PER_MIN = 60;

/** 오버레이 이벤트 기록에서 문장을 복원할 수 있는 시간. 인메모리 허가와 같은 값으로 둔다. */
const DB_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * 합성해도 되는 문장을 찾는다.
 *
 * 1차는 인메모리 허가다. 그런데 그 허가는 **이벤트를 발행했거나 Redis 로 전달받은 인스턴스**
 * 에만 있다. 다중 인스턴스에서 Redis 전파가 실패하면 오버레이는 DB 보충 조회로 이벤트를
 * 받지만 그 인스턴스에는 허가가 없어 404 가 되고, 브라우저 음성으로 되돌아간다.
 * OBS 의 브라우저 소스에는 한국어 음성이 없으므로 결과는 **무음**이다.
 *
 * 2차로 `overlay_event.payload` 에서 문장을 읽는다. 이 값은 서버가 만들어 저장한 것이므로
 * 요청자가 문장을 정하는 문제(임의 문장 유료 합성)는 생기지 않는다.
 */
async function resolveTtsGrant(eventId: string, creatorId: string) {
  const memory = findOverlayTtsGrant(eventId, creatorId);
  if (memory) return memory;

  const event = await prisma.overlayEvent.findUnique({
    where: { id: eventId },
    select: { creatorId: true, payload: true, createdAt: true },
  });
  if (!event || event.creatorId !== creatorId) return null;
  if (Date.now() - event.createdAt.getTime() > DB_GRANT_TTL_MS) return null;

  const payload = (event.payload ?? {}) as { tts?: { enabled?: boolean; text?: string; voice?: string; speed?: number; pitch?: number; volume?: number } };
  const tts = payload.tts;
  if (!tts?.enabled || !tts.text) return null;

  return {
    creatorId,
    text: tts.text,
    voice: tts.voice ?? '',
    speed: Number(tts.speed ?? 1),
    pitch: Number(tts.pitch ?? 1),
    volume: Number(tts.volume ?? 1),
    expiresAt: event.createdAt.getTime() + DB_GRANT_TTL_MS,
  };
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const creatorId = sp.get('creatorId') ?? '';
  const token = sp.get('token') ?? '';
  const preview = sp.get('preview') === '1';
  const eventId = sp.get('eventId') ?? '';

  if (!creatorId || !eventId || (!preview && !token)) {
    return new Response('unauthorized', { status: 401 });
  }

  const access = await authorizeOverlay(creatorId, token, preview);
  if (!access.ok) {
    return new Response('unauthorized', { status: 401 });
  }

  // 토큰이 유출되더라도 과금이 폭주하지 않도록 한 겹 더 둔다.
  const rate = await consumeRateLimit('tts', creatorId, RATE_MAX_PER_MIN, 60);
  if (!rate.ok) {
    return new Response('too many requests', { status: 429 });
  }

  // 서버가 발행한 문장만 합성한다. 모르는 이벤트면 클라이언트가 브라우저 음성으로 되돌아간다.
  const grant = await resolveTtsGrant(eventId, creatorId);
  if (!grant) {
    return new Response('unknown event', { status: 404 });
  }

  const setting = await prisma.ttsSetting.findUnique({
    where: { creatorId },
    select: { provider: true },
  });
  const provider = normalizeTtsProvider(setting?.provider);
  if (provider !== 'naver') {
    return new Response('server tts disabled', { status: 400 });
  }

  const cred = await resolveNaverCredentials(creatorId);
  if (!cred) {
    return new Response('tts credentials missing', { status: 503 });
  }

  const result = await synthesizeWithNaver(cred, {
    text: grant.text,
    speaker: grant.voice,
    speed: grant.speed,
    volume: grant.volume,
    pitch: grant.pitch,
  });

  if (!result.ok || !result.audio) {
    return new Response(result.message ?? 'tts failed', { status: 502 });
  }

  return new Response(result.audio, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(result.audio.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
