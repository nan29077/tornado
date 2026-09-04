import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { expireStalePinSessions, recoverStalePinCompletions } from '@/server/services/pin-authorization';
import { expireStaleConfirmations, recoverStaleConfirmedDonations } from '@/server/services/donation-confirm';
import {
  purgeExpiredIdempotencyKeys,
  releaseStaleIdempotencyKeys,
  purgeOldWebhookLogs,
} from '@/server/services/idempotency';
import { purgeExpiredResetTokens } from '@/server/services/password-reset';
import { retryAllPendingRefundRecoveries } from '@/server/services/refund';
import {
  reconcileStuckPendingPayments,
  recoverStuckMoMessages,
  redispatchMissedBroadcasts,
  retryFailedMtMessages,
} from '@/server/services/donation-flow';
import { retryFailedYouTubeDeliveries } from '@/server/services/broadcast-dispatch';
import { checkEmmaMtQueueBacklog } from '@/server/emma';
import { retryFailedBillKeyRevocations } from '@/server/services/donor-registration';
import { clearExpiredFailureLocks } from '@/server/services/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 정리 배치 (외부 스케줄러 → 토네이도).
 *
 * AWS EventBridge Scheduler 등에서 **1분 간격**으로 호출한다.
 *   GET /api/cron/cleanup
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하는 일
 *  1) expireStalePinSessions          — PIN 을 입력하지 않아 TTL 이 지난 후원을 자동 취소한다.
 *                                       (결제사 콜백이 오지 않은 PENDING_PIN 건의 보정 경로이기도 하다)
 *  2) expireStaleConfirmations        — 구 확인 링크(CONFIRM_LINK) 만료 건을 자동 취소한다.
 *  3) purgeExpiredIdempotencyKeys     — 만료된 멱등키를 지운다.
 *  4) purgeExpiredResetTokens         — 만료된 비밀번호 재설정 토큰을 지운다.
 *  5) recoverStalePinCompletions      — PIN 콜백을 COMPLETED 로 선점한 직후 크래시해 결제 실행까지
 *                                       이어지지 못한 건(PENDING_PIN 고착)을 복구한다.
 *  6) recoverStaleConfirmedDonations  — 확인 링크를 소비한 직후 크래시해 결제 실행까지 이어지지
 *                                       못한 건(PENDING_CONFIRM 고착)을 복구한다.
 *  7) retryAllPendingRefundRecoveries — PG 취소 API 오류로 재시도 대기(PENDING_RECOVERY) 에 머문
 *                                       환불을 다시 시도한다.
 *  8) reconcileStuckPendingPayments   — 집계 예약 이후 크래시해 PENDING_PAYMENT 에 멈춘 후원을
 *                                       재시도한다.
 *  9) releaseStaleIdempotencyKeys     — 선점만 하고 끝내지 못한 멱등키를 풀어 준다. 이게 없으면
 *                                       강제 종료 한 번에 그 문자가 7일간 재전송조차 막힌다.
 * 10) recoverStuckMoMessages          — 처리 중 중단돼 PENDING 으로 남은 수신 문자를 재처리 대상으로
 *                                       표시한다(사업자 재전송이 DUPLICATE 로 반려되는 것을 푼다).
 * 11) redispatchMissedBroadcasts      — 결제는 끝났는데 송출이 시작되지 않은 건을 다시 송출한다.
 * 12) retryFailedYouTubeDeliveries    — 일시적 사유로 실패한 유튜브 채팅 전송을 다시 시도한다.
 * 12-1) retryFailedMtMessages         — 발송 실패한 안내 문자를 다시 보낸다(최대 3회·지수 백오프).
 *                                       1회용 링크·인증번호가 든 문자는 대상에서 제외한다.
 * 13) clearExpiredFailureLocks        — 잠금 시간이 지난 후원자의 실패 카운터를 초기화한다.
 * 14) purgeOldWebhookLogs            — 보존 기간이 지난 웹훅 원문 로그를 지운다.
 *
 * 원칙
 *  - 인증은 fail-closed. 비밀이 없으면 로컬에서만 통과한다.
 *  - 각 작업은 서로 독립이다. 하나가 실패해도 나머지는 계속 수행하고, 결과를 각각 돌려준다.
 *  - 출금을 일으키는 일은 하지 않는다. 만료 취소는 결제 이전 단계의 상태 전이일 뿐이다.
 *  - 겹쳐 도는 것을 막기 위해 짧은 실행 잠금을 잡는다. (setStatus 는 원자적 선점이 아니라
 *    동시에 두 번 돌면 같은 건에 상태 로그가 두 줄 남을 수 있다)
 */

/** 잠금 유지 시간. 배치 1회는 수백 ms 안에 끝나지만 DB 지연을 감안해 넉넉히 잡는다. */
const LOCK_TTL_SEC = 55;
const LOCK_KEY = 'cron:cleanup:lock';

function authorize(req: Request): { ok: boolean; reason?: string } {
  const expected = env.cron.secret;
  if (!expected) {
    // 비밀 미설정: 로컬 개발에서만 열어 둔다. 운영/스테이징에서는 어떤 호출도 받지 않는다.
    return isLocal ? { ok: true } : { ok: false, reason: 'CRON_SECRET 미설정' };
  }
  const header = req.headers.get('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!matched) return { ok: false, reason: 'Authorization: Bearer 헤더 없음' };
  return safeEqual(expected, matched[1]!.trim()) ? { ok: true } : { ok: false, reason: '비밀 불일치' };
}

interface StepResult {
  ok: boolean;
  count: number;
  error?: string;
}

/** 한 단계 실행. 실패해도 예외를 밖으로 내보내지 않는다(다음 단계를 막지 않기 위함). */
async function step(name: string, fn: () => Promise<number>): Promise<StepResult> {
  const started = Date.now();
  try {
    const count = await fn();
    if (count > 0) logger.info(`정리 배치: ${name}`, { count, latencyMs: Date.now() - started });
    return { ok: true, count };
  } catch (e) {
    logger.error(`정리 배치 실패: ${name}`, { message: (e as Error).message });
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    logger.warn('정리 배치 호출 거절', { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }

  const locked = await kv.setnx(LOCK_KEY, String(Date.now()), LOCK_TTL_SEC).catch(() => true);
  if (!locked) {
    return NextResponse.json({ ok: true, skipped: true, message: '이전 실행이 아직 진행 중입니다.' });
  }

  const started = Date.now();
  try {
    const pinSessions = await step('만료 PIN 인증 취소', () => expireStalePinSessions());
    const confirmations = await step('만료 확인 링크 취소', () => expireStaleConfirmations());
    const idempotencyKeys = await step('만료 멱등키 삭제', () => purgeExpiredIdempotencyKeys());
    const resetTokens = await step('만료 재설정 토큰 삭제', () => purgeExpiredResetTokens());
    const pinCompletions = await step('PIN 완료 후 결제 미실행 복구', () => recoverStalePinCompletions());
    const confirmedPayments = await step('확인 링크 소비 후 결제 미실행 복구', () => recoverStaleConfirmedDonations());
    const refundRecoveries = await step('환불 취소 재시도', () => retryAllPendingRefundRecoveries());
    const stuckPayments = await step('PENDING_PAYMENT 고착 건 재시도', () => reconcileStuckPendingPayments());
    const staleIdempotency = await step('중단된 멱등키 해제', () => releaseStaleIdempotencyKeys());
    const stuckMoMessages = await step('중단된 수신 문자 복구', () => recoverStuckMoMessages());
    const missedBroadcasts = await step('송출 누락 건 재송출', () => redispatchMissedBroadcasts());
    const youtubeRetries = await step('유튜브 전송 재시도', () => retryFailedYouTubeDeliveries());
    const mtRetries = await step('실패 MT 재발송', () => retryFailedMtMessages());
    const failureLocks = await step('만료된 실패 잠금 해제', () => clearExpiredFailureLocks());
    const webhookLogs = await step('오래된 웹훅 로그 정리', () => purgeOldWebhookLogs());
    const billKeyRevokes = await step('사업자 빌키 해지 재시도', () => retryFailedBillKeyRevocations());
    /**
     * EMMA 발송 큐 적체 감시.
     *
     * 다른 단계와 달리 **무언가를 고치지 않고 세기만 한다.** 큐에 쌓인 문자를 우리가 대신
     * 보낼 수는 없기 때문이다(발송은 EMMA 데몬의 몫). 대신 조용히 지나가지 않도록
     * ERROR 로그를 남기고 건수를 응답에 실어 관리자 화면·헬스체크가 보게 한다.
     */
    const mtQueueStuck = await step('EMMA 발송 큐 적체 확인', () => checkEmmaMtQueueBacklog(env.emma.enabled));

    const steps = {
      pinSessions,
      confirmations,
      idempotencyKeys,
      resetTokens,
      pinCompletions,
      confirmedPayments,
      refundRecoveries,
      stuckPayments,
      staleIdempotency,
      stuckMoMessages,
      missedBroadcasts,
      youtubeRetries,
      mtRetries,
      failureLocks,
      webhookLogs,
      billKeyRevokes,
      mtQueueStuck,
    };
    const allOk = Object.values(steps).every((s) => s.ok);
    return NextResponse.json({
      ok: allOk,
      at: new Date().toISOString(),
      latencyMs: Date.now() - started,
      steps,
    });
  } finally {
    await kv.del(LOCK_KEY).catch(() => undefined);
  }
}
