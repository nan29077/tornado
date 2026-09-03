import 'dotenv/config';

// 테스트는 항상 mock 어댑터와 로컬 암호화를 사용한다.
process.env.PAYMENT_PROVIDER = 'mock';
process.env.MO_PROVIDER = 'mock';
process.env.MT_PROVIDER = 'mock';
process.env.YOUTUBE_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.CRYPTO_PROVIDER = 'local';
process.env.SAFE_MODE = 'true';
process.env.ALLOW_DIRECT_TRIGGER = 'true'; // DIRECT_TRIGGER 경로도 테스트한다
process.env.ALLOW_INMEMORY_FALLBACK = 'true';
// 테스트에서는 Redis 대신 인메모리 스토어를 사용해 상태를 격리한다.
process.env.REDIS_URL = '';
process.env.MO_ALLOWED_IPS = '';

/**
 * EMMA(인포뱅크 에이전트) 연동 테스트 설정.
 *
 * env 는 모듈 로드 시 한 번만 읽히므로 여기서 미리 지정한다. 켜 두어도 다른 테스트에 영향이 없다.
 * EMMA_ENABLED 는 운영 기동 점검과 폴링 배치·MT 어댑터에서만 참조하고, MT_PROVIDER 는
 * 위에서 mock 으로 고정해 두었기 때문에 기존 문자 발송 검증(아웃박스)은 그대로 동작한다.
 */
process.env.EMMA_ENABLED = 'true';
process.env.EMMA_MO_BASE_NUMBER = '16881234';
process.env.EMMA_DB_URL = ''; // 테스트는 앱과 같은 DB(PGlite)를 쓴다
process.env.EMMA_ID = ''; // 이중화 미사용 → em_smt_tran.emma_id 는 공백이어야 한다

// 내장 DB(PGlite)는 단일 세션 위에 여러 연결을 다중화(multiplex)한다.
// 연결 풀이 2개 이상이면 동시 요청의 트랜잭션·prepared statement 가 서로 섞여
// "방금 만든 행을 찾을 수 없음", "bind message supplies N parameters" 같은 오류가 난다.
// PGlite 를 대상으로 할 때는 연결을 1개로 고정해 실제 PostgreSQL 과 같은 결과를 보장한다.
const pglitePort = process.env.PGLITE_PORT ?? '5433';
const isPglite = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${pglitePort}/`);
if (isPglite) process.env.DB_POOL_MAX = '1';

// 테스트가 끝난 뒤 개발 DB 에 테스트 잔여 데이터를 남기지 않는다.
import { afterAll } from 'vitest';

afterAll(async () => {
  const { resetDb } = await import('./helpers');
  const { prisma } = await import('@/server/db');
  await resetDb();
  await prisma.$disconnect();
});
