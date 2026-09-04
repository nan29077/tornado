/**
 * 미리보기(PGlite) 데이터베이스 준비.
 *
 * PGlite 는 PostgreSQL 을 WASM 으로 빌드한 임베디드 DB 로, Docker 나 별도 설치 없이
 * 실제 PostgreSQL 과 동일한 통신 규약(wire protocol)으로 동작한다.
 * 이 스크립트는 스키마가 비어 있을 때만 마이그레이션과 시드를 수행한다.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { SEED_VERSION, SEED_VERSION_KEY } from '../prisma/seed-version.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[중단] DATABASE_URL 이 없습니다.');
  process.exit(1);
}

const require = createRequire(import.meta.url);

/**
 * 셸과 npx 를 거치지 않고 로컬 실행 파일을 node 로 직접 실행한다.
 * (Windows 에서 경로에 공백이 있으면 셸이 명령을 잘라먹는 문제 회피)
 */
const runNode = (scriptPath, args) =>
  execFileSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit', shell: false });

/** 로컬 node_modules 안의 실행 스크립트 경로를 얻는다.
 *  패키지의 exports 제한을 우회하기 위해 실제 파일 경로를 우선 사용한다. */
function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

const prismaCli = localScript('prisma/build/index.js', 'prisma/build/index.js');
const tsxCli = localScript('tsx/dist/cli.mjs', 'tsx/dist/cli.mjs');

async function connectWithRetry(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      if (i === 0) console.log('[대기] 미리보기 데이터베이스가 준비될 때까지 기다립니다.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const client = await connectWithRetry();
if (!client) {
  console.error('[중단] 미리보기 데이터베이스에 연결하지 못했습니다.');
  process.exit(1);
}

const { rows } = await client.query(
  "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
);
let creators = 0;
let seedVersion = 0;
/** 데이터베이스에 실제로 적용된 마이그레이션 이름 */
let appliedMigrations = [];
if (rows[0].n > 0) {
  try {
    const r = await client.query('SELECT count(*)::int AS n FROM creator_profile');
    creators = r.rows[0].n;
  } catch {
    creators = 0;
  }
  try {
    const r = await client.query('SELECT value FROM system_setting WHERE key = $1', [SEED_VERSION_KEY]);
    seedVersion = Number(r.rows[0]?.value ?? 0) || 0;
  } catch {
    seedVersion = 0;
  }
  try {
    // 롤백되지 않고 실제로 적용된 마이그레이션만 센다.
    const r = await client.query(
      'SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL',
    );
    appliedMigrations = r.rows.map((row) => row.migration_name);
  } catch {
    // 표가 없으면(초기 상태) 검사할 것이 없다.
    appliedMigrations = [];
  }
}
await client.end();

/**
 * 다른 프로젝트의 데이터베이스를 물고 있는지 검사한다.
 *
 * 이 폴더를 복사해 다른 서비스를 만들면 코드는 갈라지지만 .pglite 는 .gitignore 대상이라
 * 그대로 남는다. 그러면 도메인 모델이 통째로 다른 데이터베이스에 붙은 채로 서버가 뜨고,
 * 화면은 멀쩡한데 로그인·시드만 조용히 실패한다(표가 아예 다르므로 조회 결과가 빈다).
 *
 * 데이터베이스에는 적용됐는데 이 프로젝트에는 없는 마이그레이션이 하나라도 있으면
 * 남의 데이터베이스로 본다. 이 상태는 migrate deploy 로 절대 맞춰지지 않는다.
 * (이미 적용 완료로 기록되어 있어 건너뛰기 때문)
 */
const migrationsDir = path.resolve(process.cwd(), 'prisma', 'migrations');
if (appliedMigrations.length > 0 && fs.existsSync(migrationsDir)) {
  const localMigrations = new Set(
    fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const foreign = appliedMigrations.filter((name) => !localMigrations.has(name)).sort();

  if (foreign.length > 0) {
    console.error('');
    console.error('[중단] 미리보기 데이터베이스가 이 프로젝트의 것이 아닙니다.');
    console.error('');
    console.error(`       데이터베이스에는 적용됐지만 이 프로젝트에 없는 마이그레이션이 ${foreign.length}개 있습니다.`);
    for (const name of foreign.slice(0, 10)) console.error(`         - ${name}`);
    if (foreign.length > 10) console.error(`         ... 외 ${foreign.length - 10}개`);
    console.error('');
    console.error('       이 폴더를 복사해 만든 다른 서비스가 같은 데이터베이스를 쓴 흔적입니다.');
    console.error('       이 상태로는 마이그레이션을 맞출 수 없어(이미 적용 완료로 기록되어 건너뜁니다)');
    console.error('       로그인과 시드 데이터가 조용히 실패합니다.');
    console.error('');
    console.error('       해결 방법');
    console.error('         1. 서버를 종료합니다. (3_서버종료.bat)');
    console.error('         2. .pglite 폴더 이름을 .pglite.backup-20260101 처럼 바꿉니다.');
    console.error('            (삭제가 아니라 이름 변경이므로 기존 데이터는 그대로 남습니다)');
    console.error('         3. 다시 실행하면 이 프로젝트 기준으로 새로 만들어집니다.');
    console.error('');
    process.exit(1);
  }
}

// 기존 미리보기 DB도 새 마이그레이션을 빠짐없이 적용한다.
// migrate deploy는 이미 적용된 항목을 건너뛰므로 기존 데이터는 유지된다.
console.log('[준비] 데이터베이스 마이그레이션을 확인합니다.');
runNode(prismaCli, ['migrate', 'deploy']);

if (rows[0].n === 0) {
  console.log('[준비] 처음 실행입니다.');
  console.log('[준비] 시드 데이터를 생성합니다.');
  runNode(tsxCli, ['prisma/seed.ts']);
} else if (creators === 0) {
  console.log('[준비] 시드 데이터가 없어 다시 생성합니다.');
  runNode(tsxCli, ['prisma/seed.ts']);
} else if (seedVersion < SEED_VERSION) {
  // 시드 내용이 추가된 경우(예: 후원자 테스트 계정).
  // 기존 데이터는 지우지 않고 부족한 것만 채운다 (시드는 전부 upsert).
  console.log(`[준비] 시드 데이터를 최신으로 보충합니다. (버전 ${seedVersion} → ${SEED_VERSION})`);
  runNode(tsxCli, ['prisma/seed.ts']);
} else {
  console.log(`[준비] 기존 미리보기 데이터를 사용합니다. (크리에이터 ${creators}명)`);
}

/**
 * MO 수신번호 점검.
 *
 * 대표번호 체계가 바뀌어도 이미 배정된 번호는 저절로 따라오지 않는다. 그 번호로는
 * 문자가 오지 않는데 화면에는 멀쩡히 배정된 것으로 보이므로, 서버가 뜰 때마다 한 번
 * 훑어 바로잡는다. 바꿀 것이 없으면 아무 말도 하지 않는다.
 *
 * 시드 뒤에 둔다. 시드가 번호를 새로 만들 수 있기 때문이다.
 */
try {
  runNode(tsxCli, ['scripts/mo-number-doctor.ts']);
} catch {
  // 번호 정리는 서버 기동 조건이 아니다. 실패해도 그대로 진행한다.
  console.log('[준비] MO 번호 점검을 건너뜁니다. (도구_MO번호정리.bat 으로 따로 실행할 수 있습니다)');
}
