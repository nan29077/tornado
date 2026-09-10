import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger, scrub } from '@/lib/logger';
import { getMoAdapter } from '@/server/adapters/mo';
import { handleMoInbound } from '@/server/services/donation-flow';
import { clientIpFromRequest } from '@/server/rate-limit';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MO 사업자 Webhook 수신 엔드포인트.
 *
 * 처리 순서
 *  1) 원문 보존 + 서명/IP 검증
 *  2) 사업자 payload 정규화
 *  3) 후원 흐름 실행 (중복/미등록/한도/금칙어 처리 포함)
 *  4) 항상 200 으로 응답해 사업자 재전송 폭주를 막고, 실패는 내부 상태로 관리한다.
 *     (단 서명 실패는 401 로 명확히 거절한다)
 */
/** MO 문자 본문은 길어야 수 KB 다. 인증 전 단계이므로 과도한 본문은 기록 없이 거절한다. */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  const started = Date.now();
  /**
   * **EMMA 폴링이 켜져 있으면 이 웹훅은 받지 않는다.**
   *
   * 수신 문자의 중복 방지는 `mo_inbound_message.provider_message_id` 유니크 하나에 걸려 있는데,
   * 그 값이 경로마다 다른 네임스페이스다.
   *   - EMMA 폴링   → `moKey`      (EMMA 테이블의 행 키)
   *   - MTONET 웹훅 → `messageId`  (통신사 메시지 id)
   * 두 경로가 동시에 살아 있으면 **같은 문자 한 통이 서로 다른 두 값으로 두 번 들어와**
   * 후원이 두 건 만들어지고 후원자가 두 번 결제된다. 유니크 제약은 이것을 잡지 못한다.
   *
   * 어느 한쪽만 쓰도록 강제한다. EMMA 를 쓰는 구성에서는 이 경로가 필요 없다.
   */
  if (env.emma.enabled) {
    logger.warn('EMMA 폴링이 켜져 있어 MO 웹훅을 거절했습니다. (수신 경로는 하나만 사용합니다)');
    return NextResponse.json(
      { ok: false, message: '이 서비스는 EMMA 폴링으로 수신합니다. MO 웹훅은 사용하지 않습니다.' },
      { status: 409 },
    );
  }
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

  const adapter = getMoAdapter();
  const verified = adapter.verify(raw, headerMap, ip);

  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    parsedBody = { _raw: raw.slice(0, 2000) };
  }

  const logRow = await prisma.webhookLog.create({
    data: {
      id: newId(),
      source: 'MO',
      endpoint: '/api/webhooks/mo',
      headersMask: scrub(headerMap) as object,
      bodyMasked: scrub(parsedBody) as object,
      signatureOk: verified.ok,
      ip: ip ?? null,
    },
  });

  const finish = async (statusCode: number, note: string, body: Record<string, unknown>) => {
    await prisma.webhookLog.update({
      where: { id: logRow.id },
      data: { statusCode, responseNote: note, latencyMs: Date.now() - started },
    });
    return NextResponse.json(body, { status: statusCode });
  };

  if (!verified.ok) {
    logger.warn('MO Webhook 서명 검증 실패', { reason: verified.reason, ip });
    return finish(401, verified.reason ?? '서명 검증 실패', { ok: false, message: '인증되지 않은 요청입니다.' });
  }

  try {
    const inbound = adapter.parse(parsedBody);
    const result = await handleMoInbound(inbound);
    return finish(200, result.result, {
      ok: true,
      result: result.result,
      status: result.status ?? null,
      message: result.message,
    });
  } catch (e) {
    logger.error('MO 처리 오류', { message: (e as Error).message });
    // 사업자에게는 200 으로 응답하되 내부적으로 오류를 남긴다(재전송 폭주 방지).
    return finish(200, `ERROR: ${(e as Error).message}`, { ok: false, message: '수신은 되었으나 처리에 실패했습니다.' });
  }
}
