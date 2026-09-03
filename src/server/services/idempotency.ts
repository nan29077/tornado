import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { addDays } from '@/lib/datetime';
import { Prisma } from '@/generated/prisma/client';

/**
 * 멱등성 유틸.
 * 같은 MO Webhook 이 재전송되어도 결제가 중복 승인되지 않도록
 * (scope, key) 유니크 제약으로 1차 방어한다.
 *
 * 전체 방어 체계
 *  1) mo_inbound_message.provider_message_id UNIQUE  ← 사업자 재전송
 *  2) idempotency_key (scope,key) UNIQUE             ← 거래 생성
 *  3) 후원자 행 잠금(SELECT ... FOR UPDATE) + 판정 트랜잭션  ← 동시성
 *  4) PG 주문번호 재사용 + 거래결과조회               ← 외부 확정
 */

export type IdempotencyOutcome<T> =
  | { status: 'ACQUIRED'; release: (resourceId: string) => Promise<void>; abort: () => Promise<void> }
  | { status: 'DUPLICATE'; resourceId: string | null; value?: T };

export async function acquireIdempotency<T = unknown>(
  scope: string,
  key: string,
  ttlDays = 7,
): Promise<IdempotencyOutcome<T>> {
  try {
    const row = await prisma.idempotencyKey.create({
      data: {
        id: newId(),
        scope,
        key,
        status: 'IN_PROGRESS',
        expiresAt: addDays(new Date(), ttlDays),
      },
    });
    return {
      status: 'ACQUIRED',
      release: async (resourceId: string) => {
        await prisma.idempotencyKey.update({
          where: { id: row.id },
          data: { status: 'DONE', resourceId },
        });
      },
      abort: async () => {
        await prisma.idempotencyKey.delete({ where: { id: row.id } }).catch(() => undefined);
      },
    };
  } catch (e) {
    // 유니크 충돌(P2002)만 "중복 요청"으로 취급한다. 그 외 DB 오류(연결 끊김 등)까지
    // 중복으로 삼키면 실제로는 생성되지 않은 거래가 조용히 무시된다.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
    const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
    return { status: 'DUPLICATE', resourceId: existing?.resourceId ?? null };
  }
}

export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const r = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return r.count;
}

/**
 * 선점만 하고 끝내지 못한 멱등키를 풀어 준다.
 *
 * `abort()` 는 예외가 났을 때만 실행된다. 프로세스가 강제로 죽으면(SIGKILL, 컨테이너 교체,
 * OOM) 실행되지 않아 키가 `IN_PROGRESS` 로 **7일** 남는다. 그동안 사업자가 같은 문자를
 * 재전송해도 전부 중복으로 반려되어, 후원자는 문자 요금만 내고 후원은 만들어지지 않는다.
 *
 * 처리에 정상적으로 걸리는 시간(수 초)보다 훨씬 긴 유예를 두고, 그 뒤에도 완료되지 않았고
 * 자원(resourceId)도 붙지 않은 키만 지운다. 진행 중인 요청을 끊을 위험이 없다.
 */
export async function releaseStaleIdempotencyKeys(
  staleMinutes = 10,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
  const r = await prisma.idempotencyKey.deleteMany({
    where: { status: 'IN_PROGRESS', resourceId: null, createdAt: { lt: cutoff } },
  });
  return r.count;
}


/**
 * 오래된 웹훅 원문 로그를 지운다.
 *
 * `webhook_log.body_masked` 에는 마스킹을 거쳤어도 문자 원문 성격의 값이 남을 수 있다.
 * 사고 조사에 필요한 기간만 남기고 정리한다(기본 30일).
 * 보존 기간은 WEBHOOK_LOG_RETENTION_DAYS 로 조정한다.
 */
export async function purgeOldWebhookLogs(now = new Date()): Promise<number> {
  const days = Math.max(7, Number(process.env.WEBHOOK_LOG_RETENTION_DAYS) || 30);
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const r = await prisma.webhookLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return r.count;
}
