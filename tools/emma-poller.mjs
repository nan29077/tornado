/**
 * EMMA MO 수신 폴러 (상주 프로세스).
 *
 * 왜 필요한가
 * -----------
 * `/api/cron/emma-mo` 는 "누군가 주기적으로 불러 주는" 것을 전제로 만들어져 있다. 그런데
 * 저장소 어디에도 부르는 쪽이 없었다. 초인종만 달고 누르는 사람이 없는 상태라, EMMA 를 켜도
 * **문자가 한 통도 처리되지 않는다.** 게다가 화면에 오류도 뜨지 않는다(조용한 실패).
 *
 * 이 스크립트가 그 역할을 한다. 개발 PC 와 단일 서버 배포에서 쓴다.
 * AWS 처럼 스케줄러가 따로 있는 환경에서는 EventBridge 로 같은 주소를 부르면 되고, 그때는
 * 이 프로세스를 띄우지 않는다(둘 다 띄워도 잠금 때문에 사고가 나지는 않는다).
 *
 * 사용법
 *   node tools/emma-poller.mjs
 *   npm run emma:poll
 *
 * 환경변수
 *   APP_BASE_URL          호출할 앱 주소 (기본 http://127.0.0.1:3025)
 *   CRON_SECRET           인증 비밀. 운영에서는 필수 — 없으면 앱이 401 로 거절한다
 *   EMMA_POLL_INTERVAL_MS 폴링 주기 (기본 10000 = 10초)
 *
 * 설계 메모
 *  - **겹쳐 돌지 않는다.** 이전 호출이 끝난 뒤에 다음 대기를 시작한다(setInterval 이 아니라
 *    끝나고 재예약). 응답이 느릴 때 요청이 쌓이는 것을 막는다. 앱 쪽에도 잠금이 있지만
 *    여기서 먼저 막는 편이 낫다.
 *  - **실패해도 죽지 않는다.** 앱 재시작·DB 순단으로 한 번 실패했다고 폴러가 종료되면
 *    사람이 다시 띄울 때까지 수신이 멈춘다. 연속 실패 시 간격을 늘려 로그만 남기고 계속 돈다.
 *  - **조용히 돈다.** 정상 폴링은 로그를 남기지 않는다. 처리 건수가 있거나 실패했을 때만 찍는다.
 *    10초마다 찍으면 하루 8,640줄이 쌓여 정작 중요한 로그가 묻힌다.
 */

const BASE = (process.env.APP_BASE_URL || 'http://127.0.0.1:3025').replace(/\/+$/, '');
const SECRET = process.env.CRON_SECRET || '';
const INTERVAL_MS = Math.max(1000, Number(process.env.EMMA_POLL_INTERVAL_MS || 10_000));
const URL_PATH = '/api/cron/emma-mo';

/** 연속 실패 시 대기 시간을 늘리는 상한(밀리초). 5분마다 한 번은 반드시 다시 시도한다. */
const MAX_BACKOFF_MS = 5 * 60_000;

let consecutiveFailures = 0;
let stopping = false;

function ts() {
  return new Date().toISOString();
}

function backoffMs() {
  if (consecutiveFailures === 0) return INTERVAL_MS;
  // 2배씩 늘리되 상한을 둔다.
  const grown = INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 10);
  return Math.min(grown, MAX_BACKOFF_MS);
}

async function pollOnce() {
  const headers = SECRET ? { authorization: `Bearer ${SECRET}` } : {};
  const controller = new AbortController();
  // 폴링 한 번이 주기보다 오래 걸리면 다음 차례를 계속 밀어낸다. 넉넉히 잡되 상한을 둔다.
  const timer = setTimeout(() => controller.abort(), Math.max(30_000, INTERVAL_MS * 3));

  try {
    const res = await fetch(`${BASE}${URL_PATH}`, { headers, signal: controller.signal });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      consecutiveFailures += 1;
      const hint =
        res.status === 401
          ? ' — CRON_SECRET 이 앱 설정과 다릅니다(또는 비어 있습니다).'
          : '';
      console.error(`[${ts()}] EMMA 폴링 실패 HTTP ${res.status}${hint} ${JSON.stringify(body)}`);
      return;
    }

    consecutiveFailures = 0;

    // 정상이면 조용히 지나간다. 무언가 일어났을 때만 남긴다.
    if (body.skipped) return;
    if ((body.handed ?? 0) > 0 || (body.failed ?? 0) > 0 || (body.abandoned ?? 0) > 0 || (body.deferred ?? 0) > 0) {
      console.log(
        `[${ts()}] EMMA 폴링 처리 ${body.handed ?? 0}건` +
          ` (건너뜀 ${body.skipped ?? 0} · 보류 ${body.deferred ?? 0} · 실패 ${body.failed ?? 0} · 포기 ${body.abandoned ?? 0})`,
      );
    }
  } catch (e) {
    consecutiveFailures += 1;
    const reason = e?.name === 'AbortError' ? '응답 시간 초과' : e?.message || String(e);
    console.error(`[${ts()}] EMMA 폴링 오류: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

async function loop() {
  console.log(`[${ts()}] EMMA MO 폴러 시작 — ${BASE}${URL_PATH}, ${INTERVAL_MS / 1000}초 주기`);
  if (!SECRET) {
    console.warn(
      `[${ts()}] CRON_SECRET 이 비어 있습니다. 로컬(APP_ENV=local)에서만 동작하고 운영에서는 전건 401 로 거절됩니다.`,
    );
  }

  while (!stopping) {
    await pollOnce();
    if (stopping) break;
    const wait = backoffMs();
    if (wait !== INTERVAL_MS) {
      console.warn(`[${ts()}] 연속 실패 ${consecutiveFailures}회 — ${wait / 1000}초 뒤 재시도합니다.`);
    }
    await new Promise((r) => setTimeout(r, wait));
  }

  console.log(`[${ts()}] EMMA MO 폴러 종료`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
  });
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
