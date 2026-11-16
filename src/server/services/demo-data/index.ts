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

/** 프로세스당 한 번만 넣거나 지운다. 실패해도 화면은 계속 그린다(더미만 빠진다). */
export function ensureDemoData(): Promise<void> {
  const mode = demoDataMode();
  if (mode === 'off') return Promise.resolve();
  if (!job) {
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
