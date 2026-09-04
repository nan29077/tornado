/**
 * MO 번호 정리 실행기 — **화면이 보고 있는 데이터베이스**를 고른다.
 *
 * 왜 이 파일이 따로 필요한가
 * --------------------------
 * 이 프로젝트에는 데이터베이스가 둘 있다.
 *
 *   1_미리보기실행.bat  →  `.pglite` 폴더의 내장 DB (PGlite, 포트 5433)
 *   그 밖의 CLI 도구     →  `.env` 의 DATABASE_URL (보통 PostgreSQL 5432)
 *
 * 예전 `도구_MO번호정리.bat` 은 `npm run mo:reissue` 를 그대로 불러 **.env 쪽 DB** 만
 * 정리했다. 실제로 크리에이터가 보는 화면은 미리보기 DB 라서, 도구는
 * "구 체계 번호가 없습니다" 라고 답하는데 화면에는 0505 가 그대로 남아 있었다.
 * 사람이 잘못한 게 아니라 서로 다른 DB 를 본 것이다.
 *
 * 이 실행기는 `.pglite` 폴더가 있으면 그 DB 를 열어 정리하고, 없으면 `.env` 의 DB 를
 * 정리한다. 즉 **화면에 보이는 번호가 실제로 바뀐다.**
 *
 * 사용법
 *   node tools/mo-reissue.mjs --dry-run   무엇이 바뀌는지만 출력
 *   node tools/mo-reissue.mjs             실제로 정리
 */
import 'dotenv/config';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readLock } from './process-guard.mjs';

const require = createRequire(import.meta.url);
const DATA_DIR = path.resolve(process.cwd(), '.pglite');
const APP_PORT = Number(process.env.PORT ?? 3025);
const args = process.argv.slice(2);

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
      const { port } = server.address();
      server.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

/** 그 프로세스가 아직 살아 있는지 확인한다. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 권한이 없을 뿐 살아 있다
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(700);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

function run(script, scriptArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], { stdio: 'inherit', shell: false, env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const tsxCli = localScript('tsx/dist/cli.mjs', 'tsx/dist/cli.mjs');
const target = path.join('scripts', 'reissue-legacy-mo.ts');

let socketServer;
let database;

try {
  if (fs.existsSync(DATA_DIR)) {
    /**
     * 미리보기 서버가 켜져 있으면 같은 데이터 폴더를 두 프로세스가 동시에 열게 된다.
     * PGlite 는 그 상황을 막아 주지 않으므로 **데이터가 깨질 수 있다.** 반드시 먼저 막는다.
     */
    /**
     * 포트만 보지 않고 실행 잠금 파일도 함께 본다.
     * 포트 검사는 "이 컴퓨터에서 그 포트가 열려 있나"만 알 수 있어, 서버가 다른 주소에
     * 떠 있거나 검사하는 쪽이 다른 환경이면 놓친다. 잠금 파일에는 실제 프로세스 번호가
     * 들어 있어 더 정확하다. 둘 중 하나라도 걸리면 막는다.
     */
    const lock = readLock();
    const lockAlive = lock ? isAlive(lock.pid) : false;
    if (lockAlive || (await portInUse(APP_PORT))) {
      console.error('');
      console.error('[중단] 미리보기 서버가 실행 중입니다.');
      if (lockAlive) console.error(`       (실행 중인 프로세스 번호: ${lock.pid})`);
      console.error('');
      console.error('       미리보기 데이터베이스는 한 번에 한 프로그램만 열 수 있습니다.');
      console.error('       3_서버종료.bat 으로 서버를 끈 뒤 다시 실행해 주세요.');
      console.error('       (정리가 끝나면 1_미리보기실행.bat 으로 다시 켜시면 됩니다)');
      console.error('');
      process.exit(1);
    }

    console.log('[대상] 미리보기 내장 데이터베이스 (.pglite) — 화면에 보이는 데이터입니다.');
    const port = await freePort();
    database = await PGlite.create({ dataDir: DATA_DIR });
    socketServer = new PGLiteSocketServer({ db: database, port, host: '127.0.0.1', maxConnections: 10 });
    await socketServer.start();

    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.exitCode = await run(tsxCli, [target, ...args], {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DIRECT_DATABASE_URL: databaseUrl,
      PGLITE: '1',
      PGLITE_PORT: String(port),
      DB_POOL_MAX: '1',
      ALLOW_INMEMORY_FALLBACK: 'true',
    });
  } else {
    console.log('[대상] .env 의 DATABASE_URL (PostgreSQL)');
    console.log('       미리보기 폴더(.pglite)가 없어 이쪽을 정리합니다.');
    process.exitCode = await run(tsxCli, [target, ...args], process.env);
  }
} catch (e) {
  console.error(`[실패] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await socketServer?.stop().catch(() => undefined);
  await database?.close().catch(() => undefined);
}
