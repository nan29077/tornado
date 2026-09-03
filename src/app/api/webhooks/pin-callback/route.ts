import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env, isLocal } from '@/lib/env';
import { safeEqual, verifySignature } from '@/lib/crypto';
import { logger, scrub } from '@/lib/logger';
import { completePinAuthorization, failPinAuthorization } from '@/server/services/pin-authorization';
import { isMockPaymentAllowed } from '@/server/mock-guard';
import { clientIpFromRequest, consumeRateLimit, ipMatchesAllowlist } from '@/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PIN 인증 완료 콜백 (결제사 → 토네이도).
 *
 * 후원자가 결제사 화면에서 PIN 을 입력하면 결제사가 이 엔드포인트를 호출하고,
 * 그때 비로소 승인(출금)이 실행된다. 브라우저 리턴이 오지 않아도
 * 이 서버 통지만으로 결제가 마무리되어야 한다.
 *
 * 처리 순서
 *  1) 본문 크기 제한 → 원문 보존(WebhookLog)
 *  2) 서명 검증 (현재는 X-Pin-Secret 공유 비밀. TODO: 실연동 시 결제사 서명으로 교체)
 *  3) 결과코드 검증 → 성공 코드가 아니면 인증 실패로 확정(승인하지 않는다)
 *  4) 인증 세션 확인 + 멱등 처리 → executePayment
 *  5) 재전송 폭주를 막기 위해 처리 결과는 200 으로 응답한다.
 *     (서명 실패만 401 로 명확히 거절한다)
 *
 * Mock 단계에서는 모의 PIN 화면(/mock/pg/pin)과 수동 테스트가 이 엔드포인트를 사용한다.
 */

/** 콜백 본문은 아무리 커도 수 KB 다. 인증 전 단계이므로 과도한 본문은 기록 없이 거절한다. */
const MAX_BODY_BYTES = 16 * 1024;

interface PinCallbackBody {
  sessionId?: unknown;
  donationId?: unknown;
  resultCode?: unknown;
  resultMessage?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 콜백 인증. **MO 웹훅과 같은 수준(서명 + IP + 재생 방어)으로 맞춘다.**
 *
 * 공유 비밀 하나만 대조하면, 그 비밀이 한 번 유출됐을 때 누구나
 * `{donationId, resultCode:"0000"}` 만 보내 **후원자가 PIN 을 입력하지 않은 채 출금**을
 * 강제할 수 있다. 본문 서명이 없으니 본문을 마음대로 바꿔도 통과했고, 타임스탬프도 없어
 * 한 번 캡처한 요청을 그대로 재전송할 수 있었다.
 *
 * 검증 순서
 *  1) IP 허용목록 (PAYMENT_PIN_ALLOWED_IPS). 운영에서 비어 있으면 기동 자체가 막힌다.
 *  2) 서명: `X-Pin-Timestamp` + 본문에 대한 HMAC(`X-Pin-Signature`). 있으면 이것만 인정한다.
 *  3) 서명 헤더가 없으면 기존 공유 비밀(`X-Pin-Secret`)로 물러선다(결제사 규격 확정 전 호환).
 */
function verifyCallback(
  headers: Record<string, string>,
  rawBody: string,
  ip: string | undefined,
): { ok: boolean; reason?: string } {
  const expected = env.payment.pinCallbackSecret;
  if (!expected) {
    if (isLocal) return { ok: true };
    return { ok: false, reason: 'PAYMENT_PIN_CALLBACK_SECRET 미설정' };
  }

  // (1) 발신 IP 허용목록. 목록이 비어 있으면 로컬에서만 통과시킨다(fail-closed).
  const allowed = env.payment.pinAllowedIps;
  if (allowed.length === 0) {
    if (!isLocal) return { ok: false, reason: 'PAYMENT_PIN_ALLOWED_IPS 미설정' };
  } else if (!ipMatchesAllowlist(ip, allowed)) {
    return { ok: false, reason: '허용되지 않은 발신 IP' };
  }

  // (2) 타임스탬프 + 본문 서명
  const signature = headers['x-pin-signature'] ?? null;
  const timestamp = headers['x-pin-timestamp'] ?? null;
  if (signature) {
    if (!timestamp) return { ok: false, reason: 'X-Pin-Timestamp 헤더 없음' };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: '타임스탬프 형식 오류' };
    // 초 단위·밀리초 단위 모두 허용한다.
    const tsMs = ts > 1e12 ? ts : ts * 1000;
    const skewSec = Math.abs(Date.now() - tsMs) / 1000;
    if (skewSec > env.payment.pinCallbackToleranceSec) {
      return { ok: false, reason: '타임스탬프 허용 오차 초과(재생 요청 의심)' };
    }
    return verifySignature(`${timestamp}.${rawBody}`, signature, expected)
      ? { ok: true }
      : { ok: false, reason: '본문 서명 불일치' };
  }

  // (3) 구 방식(공유 비밀만) — 결제사 서명 규격이 확정되면 제거한다.
  const headerSecret = headers['x-pin-secret'] ?? null;
  if (!headerSecret) return { ok: false, reason: 'X-Pin-Signature 또는 X-Pin-Secret 헤더 없음' };
  return safeEqual(expected, headerSecret) ? { ok: true } : { ok: false, reason: '공유 비밀 불일치' };
}

/**
 * 결과코드 판정.
 *
 * PAYMENT_PIN_SUCCESS_CODES 에 없는 코드는 인증 실패로 본다. 결제사가 실패를 통지했는데
 * 승인으로 넘어가면 인증되지 않은 출금이 일어난다.
 *
 * 결과코드가 아예 없는 요청은 mock 어댑터 환경(모의 PIN 화면, 수동 테스트)에서만 성공으로
 * 인정한다. 실제 결제사가 연결된 환경에서는 코드 없는 통지를 신뢰하지 않는다(fail-closed).
 */
function verifyResultCode(code: string | null): { ok: boolean; reason?: string } {
  if (!code) {
    return isMockPaymentAllowed()
      ? { ok: true }
      : { ok: false, reason: 'resultCode 가 없습니다.' };
  }
  return env.payment.pinSuccessCodes.includes(code.toUpperCase())
    ? { ok: true }
    : { ok: false, reason: `성공 코드가 아닙니다 (resultCode=${code})` };
}

export async function POST(req: Request) {
  const started = Date.now();
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, message: '요청 본문이 너무 큽니다.' }, { status: 413 });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, message: '요청 본문이 너무 큽니다.' }, { status: 413 });
  }

  const headerMap: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headerMap[k.toLowerCase()] = v;
  });
  // 발신 IP 는 신뢰 프록시가 붙인 **마지막** 홉만 쓴다.
  // 첫 홉은 클라이언트가 직접 써 넣는 값이라, 허용 IP 를 헤더에 적기만 하면
  // 허용목록 검사를 그대로 통과한다(2중 방어가 시크릿 하나로 줄어든다).
  const ip = clientIpFromRequest(req) ?? undefined;

  const verified = verifyCallback(headerMap, raw, ip);

  let parsed: PinCallbackBody = {};
  try {
    parsed = JSON.parse(raw) as PinCallbackBody;
  } catch {
    parsed = {};
  }

  const logRow = await prisma.webhookLog.create({
    data: {
      id: newId(),
      source: 'PIN_CALLBACK',
      endpoint: '/api/webhooks/pin-callback',
      headersMask: scrub(headerMap) as object,
      bodyMasked: scrub(parsed) as object,
      signatureOk: verified.ok,
      ip: ip ?? null,
    },
  });

  const finish = async (statusCode: number, note: string, body: Record<string, unknown>) => {
    await prisma.webhookLog.update({
      where: { id: logRow.id },
      data: { statusCode, responseNote: note.slice(0, 500), latencyMs: Date.now() - started },
    });
    return NextResponse.json(body, { status: statusCode });
  };

  if (!verified.ok) {
    logger.warn('PIN 콜백 서명 검증 실패', { reason: verified.reason, ip });
    return finish(401, verified.reason ?? '서명 검증 실패', { ok: false, message: '인증되지 않은 요청입니다.' });
  }

  const sessionId = str(parsed.sessionId);
  const donationId = str(parsed.donationId);
  if (!sessionId && !donationId) {
    return finish(400, 'sessionId/donationId 없음', {
      ok: false,
      message: 'sessionId 또는 donationId 가 필요합니다.',
    });
  }
  /**
   * `donationId` 단독 통지는 **mock 환경에서만** 받는다.
   *
   * 실연동에서는 결제사가 발급한 세션 식별자가 반드시 함께 온다. donationId 만으로 승인을
   * 진행할 수 있게 두면, 비밀이 유출됐을 때 후원 ID 하나만 알아도 출금을 강제할 수 있다.
   */
  if (!sessionId && !isMockPaymentAllowed()) {
    return finish(400, 'sessionId 없음(실연동)', {
      ok: false,
      message: 'sessionId 가 필요합니다.',
    });
  }

  const resultCode = str(parsed.resultCode);
  const resultMessage = str(parsed.resultMessage);

  // 인증을 통과한 뒤에도 같은 발신지에서 쏟아지는 요청은 잘라낸다.
  const limited = await consumeRateLimit('pin-callback', ip ?? 'unknown', 600, 60);
  if (!limited.ok) {
    return finish(429, '속도 제한', { ok: false, message: '요청이 너무 많습니다.' });
  }

  try {
    // 결제사가 실패를 통지한 건은 절대 승인 단계로 넘기지 않는다.
    const verdict = verifyResultCode(resultCode);
    if (!verdict.ok) {
      const failed = await failPinAuthorization(
        { sessionId, donationId },
        [verdict.reason, resultMessage].filter(Boolean).join(' / '),
      );
      logger.warn('PIN 콜백 - 인증 실패 통지', { reason: verdict.reason, code: failed.code });
      return finish(200, failed.code, {
        ok: false,
        code: failed.code,
        status: failed.status ?? null,
        message: failed.message,
      });
    }

    const result = await completePinAuthorization({
      sessionId,
      donationId,
      resultCode,
      resultMessage,
    });
    return finish(200, result.code, {
      ok: result.ok,
      code: result.code,
      status: result.status ?? null,
      message: result.message,
    });
  } catch (e) {
    logger.error('PIN 콜백 처리 오류', { message: (e as Error).message });
    // 결제사에는 200 으로 응답하되 내부적으로 오류를 남긴다(재전송 폭주 방지).
    return finish(200, `ERROR: ${(e as Error).message}`, {
      ok: false,
      message: '수신은 되었으나 처리에 실패했습니다.',
    });
  }
}
