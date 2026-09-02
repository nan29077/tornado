/**
 * 안전한 테스트 실행기.
 *
 * 개발용 DATABASE_URL을 그대로 사용하면 테스트의 TRUNCATE가 미리보기/개발 데이터를 지울 수 있다.
 * 매 실행마다 메모리 PGlite를 띄우고 최신 마이그레이션을 적용한 뒤 Vitest를 실행한다.
 */
import 'dotenv/config';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const require = createRequire(import.meta.url);

function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      shell: false,
      env,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let socketServer;
let database;

try {
  const port = await freePort();
  database = await PGlite.create();
  socketServer = new PGLiteSocketServer({ database: undefined, db: database, port, host: '127.0.0.1', maxConnections: 30 });
  await socketServer.start();

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: databaseUrl,
    PGLITE: '1',
    PGLITE_PORT: String(port),
    DB_POOL_MAX: '1',
    DB_TRANSACTION_MAX_WAIT_MS: '10000',
    DB_TRANSACTION_TIMEOUT_MS: '20000',
    ALLOW_INMEMORY_FALLBACK: 'true',
  };

  const prismaCli = localScript('prisma/build/index.js', 'prisma/build/index.js');
  const migrated = await run(prismaCli, ['migrate', 'deploy'], env);
  if (migrated !== 0) process.exitCode = migrated;
  else {
    const vitestCli = localScript('vitest/vitest.mjs', 'vitest/vitest.mjs');
    const args = process.argv.slice(2);
    const vitestArgs = args.includes('--watch') ? args : ['run', ...args];
    process.exitCode = await run(vitestCli, vitestArgs, env);
  }
} catch (error) {
  console.error(`[테스트 준비 실패] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await socketServer?.stop().catch(() => undefined);
  await database?.close().catch(() => undefined);
}
