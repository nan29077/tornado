/**
 * E2E 전체 실행기.
 *
 *   npm run dev            (다른 터미널에서 먼저 실행)
 *   npm run test:e2e       (이 스크립트)
 *
 * 스크립트마다 DB 를 초기화·재시드해서 실행 순서에 따라 결과가 달라지지 않게 한다.
 * 재시드를 건너뛰려면: npm run test:e2e -- --no-reseed
 * 일부만 돌리려면:     npm run test:e2e -- round10 studio
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, assertServerUp } from './_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCRIPTS = [
  ['round5', '스튜디오 셸·내비게이션'],
  ['round6', '후원샵 · PC PIN 후원 전 구간'],
  ['round7', '문의 채널 · 관리자 문의 · 보안'],
  ['round8', '정산 탭 · 원천징수 · 금칙어'],
  ['round9', '민감자료 권한 · 지급대행 · 관리자 권한'],
  ['round10', '알림 · 정산주기 · 공휴일 · 오버레이'],
  ['gap', '기기별 안내 · 모의 고지 · 공개 페이지'],
  ['studio', '유튜브 · 오버레이 · 스트림 · 설정'],
  ['admin', '관리자 전 화면 스모크 · 한도 정책'],
  // (2026-11-19 7차 점검) 새 기능 시뮬레이션도 전체 실행에 포함한다
  ['engage', '팬투표 · 팬챗 · 1:1 채팅'],
  // fan 은 engage 가 열어 둔 팬챗방 · 구독을 이어서 쓴다 → 재시드하지 않는다
  ['fan', '팬챗 버블형 · 팬투표 고도화', { keepData: true }],
  ['video-sticker', '영상 상품 · 유튜브 API 관리'],
  ['overlay-ladder', '금액별 후원 연출 단계'],
  ['donor-experience', '후원자 화면 · 답글 · 반응형'],
];

const argv = process.argv.slice(2);
const reseed = !argv.includes('--no-reseed');
const only = argv.filter((a) => !a.startsWith('--'));
const targets = only.length ? SCRIPTS.filter(([key]) => only.includes(key)) : SCRIPTS;

if (!targets.length) {
  console.error(`실행할 스크립트가 없습니다. 사용 가능: ${SCRIPTS.map(([k]) => k).join(', ')}`);
  process.exit(2);
}

await assertServerUp();
console.log(`대상 서버: ${BASE}`);
console.log(`실행 대상 ${targets.length}종${reseed ? ' (스크립트마다 DB 재시드)' : ' (재시드 없음)'}\n`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args) => spawnSync(cmd, args, { cwd: path.join(HERE, '..'), stdio: 'inherit', shell: process.platform === 'win32' });

const summary = [];
for (const [key, title, opts = {}] of targets) {
  if (reseed && !opts.keepData) {
    console.log(`\n[${key}] DB 초기화·재시드`);
    const reset = run(npmCmd, ['run', 'db:reset']);
    const seed = run(npmCmd, ['run', 'db:seed']);
    if (reset.status !== 0 || seed.status !== 0) {
      console.error(`[${key}] 재시드 실패 — 건너뜁니다.`);
      summary.push({ key, title, status: 'SKIP' });
      continue;
    }
  }
  if (reseed && !opts.keepData) {
    // 서버는 켜진 채 DB 만 초기화했다. 더미 데이터(DEMO_DATA=true)를 다시 채우도록 메인 화면을 두 번 연다
    // (서버는 10초에 한 번 더미가 남아 있는지 확인한다 → 확인 간격이 지난 뒤 요청이 알아채고, 그다음 요청이 다시 넣는다)
    for (const wait of [11_000, 2_000, 0]) {
      await fetch(`${BASE}/vote`).then((r) => r.text()).catch(() => '');
      if (wait) await new Promise((res) => setTimeout(res, wait));
    }
  }
  console.log(`\n════════ ${key} — ${title} ════════`);
  const res = run(process.execPath, [path.join(HERE, `${key}-e2e.mjs`)]);
  summary.push({ key, title, status: res.status === 0 ? 'PASS' : 'FAIL' });
}

console.log('\n════════════════ 전체 결과 ════════════════');
for (const s of summary) console.log(`${s.status.padEnd(4)} | ${s.key.padEnd(8)} | ${s.title}`);
const failed = summary.filter((s) => s.status !== 'PASS');
console.log(`\n${summary.length}종 중 ${summary.length - failed.length}종 통과, ${failed.length}종 실패`);
process.exit(failed.length ? 1 : 0);
