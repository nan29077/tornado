import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { expireStalePinSessions, recoverStalePinCompletions } from '@/server/services/pin-authorization';
import { expireStaleConfirmations, recoverStaleConfirmedDonations } from '@/server/services/donation-confirm';
import { purgeExpiredIdempotencyKeys } from '@/server/services/idempotency';
import { purgeExpiredResetTokens } from '@/server/services/password-reset';
import { retryAllPendingRefundRecoveries } from '@/server/services/refund';
import { reconcileStuckPendingPayments } from '@/server/services/donation-flow';

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

    const steps = {
      pinSessions,
      confirmations,
      idempotencyKeys,
      resetTokens,
      pinCompletions,
      confirmedPayments,
      refundRecoveries,
      stuckPayments,
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
