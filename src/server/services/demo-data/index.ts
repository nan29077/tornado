/**
 * 테스트용 더미 데이터 스위치 (2026-11-17) — 배포 전 정리 대상.
 *
 *   DEMO_DATA=true   더미 채널·크리에이터·라이브·상품을 보여 준다 (첫 접속 때 DB 에 demo- 행을 넣는다)
 *   DEMO_DATA=clean  다음 접속 때 demo- 행을 모두 지운다 (주문 기록이 남은 크리에이터는 정지 처리)
 *   그 외 / 미설정   아무것도 하지 않는다
 *
 * 운영(APP_ENV=prod)에서는 true 를 무시한다(clean 은 동작한다 — 실수로 들어간 더미를 지울 수 있게).
 */
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { demoProductId } from './catalog';
import { cleanDemoData, seedDemoData } from './seed';

export type DemoDataMode = 'on' | 'clean' | 'off';

export function demoDataMode(): DemoDataMode {
  const raw = (process.env.DEMO_DATA ?? '').trim().toLowerCase();
  if (raw === 'clean') return 'clean';
  if ((raw === 'true' || raw === '1' || raw === 'on') && env.appEnv !== 'prod') return 'on';
  return 'off';
}

export function isDemoDataEnabled(): boolean {
  return demoDataMode() === 'on';
}

let job: Promise<void> | null = null;
/** 마지막으로 더미를 넣은 날(KST). 날이 바뀌면 오늘 · 이번 주 팬투표 집계를 새로 채우려고 다시 넣는다. */
let jobDay = '';
/** (7차 점검) 더미가 아직 DB 에 있는지 마지막으로 확인한 시각 */
let verifiedAt = 0;
let verifying: Promise<void> | null = null;
const VERIFY_INTERVAL_MS = 10_000;

function kstDay(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 프로세스당 하루 한 번 넣거나 지운다. 실패해도 화면은 계속 그린다(더미만 빠진다). */
export function ensureDemoData(): Promise<void> {
  const mode = demoDataMode();
  if (mode === 'off') return Promise.resolve();
  const today = kstDay();
  if (job && mode === 'on' && jobDay !== today) job = null;
  /**
   * (7차 점검, 2026-11-19) 서버가 켜진 채 DB 를 초기화하면(도구_DB초기화 · 시뮬레이션 재시드) 더미가 지워져도
   * "오늘 이미 넣었다" 로 기억해 다시 넣지 않았다. 10초에 한 번만 더미 상품 1건이 남아 있는지 확인하고, 없으면 다시 넣는다.
   */
  if (job && mode === 'on' && !verifying && Date.now() - verifiedAt > VERIFY_INTERVAL_MS) {
    verifiedAt = Date.now();
    const current = job;
    verifying = (async () => {
      try {
        await current;
        const exists = await prisma.product.findUnique({ where: { id: demoProductId(1) }, select: { id: true } });
        if (!exists && job === current) job = null;
      } catch {
        // 확인이 실패하면 다음 확인 때 다시 본다
      } finally {
        verifying = null;
      }
    })();
  }
  if (!job) {
    jobDay = today;
    job = (async () => {
      try {
        if (mode === 'on') {
          const r = await seedDemoData(prisma);
          logger.info('demo-data: 더미 데이터 준비 완료', r);
        } else {
          const r = await cleanDemoData(prisma);
          logger.info('demo-data: 더미 데이터 정리 완료', { ...r });
        }
      } catch (e) {
        job = null; // 다음 접속 때 다시 시도
        logger.warn('demo-data: 더미 데이터 처리 실패', { mode, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }
  return job;
}

export * from './catalog';
