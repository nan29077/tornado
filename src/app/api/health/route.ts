import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { env, assertProductionSafety, bootWarnings } from '@/lib/env';
import { getSessionUser } from '@/server/auth';
import { readEmmaLastPollAt, readEmmaMtQueueHealth } from '@/server/emma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 시스템 상태 및 외부 연동 모드 점검 */
export async function GET() {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch (e) {
    checks.database = `error: ${(e as Error).message}`;
  }

  try {
    // ALB 헬스체크가 30초마다 여러 인스턴스에서 들어오므로 매 호출 쓰기를 피하고,
    // 연결 가능 여부만 확인하는 읽기 전용 점검으로 대체한다(값이 null 이어도 ok).
    await kv.get('health:ping');
    checks.cache = 'ok';
  } catch (e) {
    checks.cache = `error: ${(e as Error).message}`;
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');

  // 공개 응답은 최소 정보만 담는다.
  // 연동 사업자·안전모드·설정 경고는 내부 정찰에 그대로 쓰일 수 있어 관리자에게만 노출한다.
  const user = await getSessionUser().catch(() => null);
  if (user?.role !== 'ADMIN') {
    return NextResponse.json({ ok: healthy }, { status: healthy ? 200 : 503 });
  }

  // EMMA 폴링이 멈추면 문자가 들어와도 후원이 만들어지지 않는데 아무 오류도 나지 않는다(E-8).
  const lastPoll = env.emma.enabled ? await readEmmaLastPollAt().catch(() => null) : null;
  const emmaPollAt = lastPoll ? lastPoll.toISOString() : null;

  /**
   * 발송 큐 적체(H-2).
   *
   * 폴링 정지가 "문자가 들어와도 후원이 안 되는" 문제라면, 큐 적체는 "후원은 됐는데 문자가
   * 안 나가는" 문제다. 둘 다 화면에 오류가 뜨지 않아 헬스체크로 끌어올린다.
   */
  const emmaQueue = await readEmmaMtQueueHealth(env.emma.enabled).catch(() => null);

  return NextResponse.json(
    {
      ok: healthy,
      env: env.appEnv,
      safeMode: env.safety.safeMode,
      allowDirectTrigger: env.safety.allowDirectTrigger,
      providers: {
        payment: env.payment.provider,
        mo: env.mo.provider,
        mt: env.mt.provider,
        youtube: env.youtube.provider,
        tts: env.tts.provider,
      },
      checks,
      productionWarnings: assertProductionSafety(),
      // 기동을 막지는 않지만 특정 기능이 멈추는 설정(EMMA 장문 미지원, 헥토 PIN mock 등).
      configWarnings: bootWarnings(),
      emmaLastPollAt: emmaPollAt,
      emmaMtQueueStuck: emmaQueue?.stuck ?? 0,
      at: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
