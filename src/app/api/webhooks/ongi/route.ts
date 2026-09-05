import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 온기(Ongi) 결제 노티 웹훅.
 *
 * 현재 상태: 501 Not Implemented.
 * 온기로부터 웹훅 경로 및 서명 규격을 수령한 뒤 구현한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO(온기 제공 대기): 구현 전 확인해야 할 항목
 *
 * 1. 웹훅 URL 을 온기가 고정하는가, 가맹점이 지정하는가?
 *    - 가맹점 지정이라면 온기 대시보드(또는 계약 서류)에
 *      이 경로({APP_BASE_URL}/api/webhooks/ongi)를 등록해야 한다.
 *
 * 2. 서명 검증 방식
 *    - 현재 ongi.ts verifyWebhookSignature() 는 다음 형식을 가정한다:
 *        서명 헤더: x-ongi-signature
 *        서명 값:   sha256=HMAC-SHA256(ONGI_WEBHOOK_SECRET, "{timestamp}.{rawBody}")
 *    - 온기 규격과 다르면 ongi.ts ONGI_WEBHOOK_HEADER 와 verifyWebhookSignature 를 수정한다.
 *
 * 3. 요청 바디 형태(JSON 필드명)
 *    - paymentId / orderId / status / amount / canceledAt 등 필드 이름 확인 필요.
 *
 * 4. 성공 응답 형식
 *    - 온기가 기대하는 성공 응답: HTTP 200 + 특정 JSON 바디인지 확인한다.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: 'Not Implemented',
      message:
        '온기 웹훅 경로 및 서명 규격 수령 후 구현 예정입니다. ' +
        'ONGI_SPEC.paymentCreatePath 등 ONGI_SPEC 블록을 채운 뒤 이 핸들러를 완성하세요.',
    },
    { status: 501 },
  );
}
