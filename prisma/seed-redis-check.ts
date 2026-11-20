/**
 * 시드 전용: Redis 가 꺼져 있으면 이번 시드는 내장 메모리 저장소로 실행한다 (2026-11-20).
 *
 * .env 에 REDIS_URL 이 있는데 Redis 가 떠 있지 않으면, 앱 코드는 "Redis 장애" 로 보고 속도 제한을
 * 보수적으로 차단한다(limits.ts L-1, 운영 안전장치). 그래서 셸에서 `npm run db:seed` 를 실행하면
 * 샘플 후원이 전부(또는 첫 건만 빼고) "한도차단" 으로 만들어져 정산 · 캘린더 화면이 비었다.
 * 미리보기 실행기(tools/preview.mjs)가 하는 것과 같은 확인을 시드에서도 한다.
 *
 * 앱 설정(src/lib/env)은 처음 불러올 때 값이 고정되므로, 다른 모듈보다 먼저(dotenv 바로 다음) 불러와야 한다.
 * 그래서 비동기 연결 대신 짧은 자식 프로세스로 **동기** 확인한다. 운영 환경에서는 시드 자체가 실행되지 않는다.
 */
import { spawnSync } from 'node:child_process';

const redisUrl = (process.env.REDIS_URL ?? '').trim();
if (redisUrl) {
  let host = '127.0.0.1';
  let port = 6379;
  try {
    const u = new URL(redisUrl);
    host = u.hostname || host;
    port = Number(u.port) || port;
  } catch {
    // 형식이 이상하면 기본 주소로 확인한다
  }
  const probe =
    "const s=require('net').connect({host:process.argv[1],port:Number(process.argv[2])});" +
    's.setTimeout(800);' +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});" +
    "s.on('error',()=>process.exit(1));";
  const r = spawnSync(process.execPath, ['-e', probe, host, String(port)], { timeout: 3000, stdio: 'ignore' });
  if (r.status !== 0) {
    console.log(`[seed] Redis(${host}:${port}) 가 꺼져 있어 이번 시드는 내장 메모리 저장소로 실행합니다.`);
    process.env.REDIS_URL = '';
  }
}

export {};
