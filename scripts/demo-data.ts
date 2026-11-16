/**
 * 테스트용 더미 데이터 넣기 · 정리 (2026-11-17)
 *
 *   npx tsx scripts/demo-data.ts seed    더미 넣기 (여러 번 실행해도 중복 없음)
 *   npx tsx scripts/demo-data.ts clean   demo- 로 시작하는 행 모두 정리
 *
 * .env 의 DATABASE_URL 에 연결한다. 미리보기(내장 DB)에서는 .env 의 DEMO_DATA 값으로 켜고 끈다
 *   DEMO_DATA=true  → 다음 접속 때 자동으로 넣는다
 *   DEMO_DATA=clean → 다음 접속 때 자동으로 정리한다
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { cleanDemoData, seedDemoData } from '../src/server/services/demo-data/seed';

const cmd = (process.argv[2] ?? '').toLowerCase();
const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
const isProd = appEnv === 'prod' || appEnv === 'production' || process.env.NODE_ENV === 'production';

async function main() {
  if (cmd !== 'seed' && cmd !== 'clean') {
    console.log('사용법: npx tsx scripts/demo-data.ts seed | clean');
    process.exit(1);
  }
  if (cmd === 'seed' && isProd) {
    console.log('[demo-data] 운영 환경에서는 더미 데이터를 넣지 않습니다.');
    process.exit(0);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    if (cmd === 'seed') {
      const r = await seedDemoData(prisma);
      console.log(`[demo-data] 더미 크리에이터 ${r.creators}명 · 상품 ${r.products}개를 넣었습니다.`);
    } else {
      const r = await cleanDemoData(prisma);
      console.log(`[demo-data] 정리 완료 — 상품 ${r.products}개 · 크리에이터 ${r.creators}명 삭제${r.creatorsSuspended ? `, 주문 기록이 남은 ${r.creatorsSuspended}명은 정지 처리` : ''}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[demo-data] 실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
