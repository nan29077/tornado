/**
 * 구 체계 MO 수신번호 일괄 정리 (CLI).
 *
 * 관리자 화면(`/admin/mo-numbers` > 구 번호 정리)과 같은 일을 명령줄에서 한다.
 * 화면에 들어가기 전에 무엇이 바뀌는지 먼저 확인하고 싶을 때, 또는 배포 직후
 * 한 번에 정리하고 싶을 때 쓴다.
 *
 * 사용법
 *   npm run mo:reissue -- --dry-run   (무엇이 바뀌는지만 출력, 변경 없음)
 *   npm run mo:reissue                (실제로 재발급)
 *
 * 대표번호가 바뀌었을 때(인포뱅크 계약 확정)도 같은 명령을 쓴다.
 *   1) .env 의 EMMA_MO_BASE_NUMBER 를 계약 대표번호로 교체
 *   2) npm run mo:reissue -- --dry-run 으로 대상 확인
 *   3) npm run mo:reissue
 *   4) 바뀐 번호를 크리에이터에게 안내 (방송 화면 문구 교체 필요)
 */
import 'dotenv/config';
import { prisma } from '../src/server/db';
import { formatMoNumber, digitsOnly } from '../src/server/emma';
import { reissueLegacyMoNumbers, requireBaseNumber } from '../src/server/services/mo-number-issue';

const dryRun = process.argv.includes('--dry-run');

/**
 * 지금 어느 데이터베이스에 붙어 있는지 사람이 읽을 수 있게 만든다.
 *
 * **이 한 줄이 없어서 크게 헤맸다.**
 * 미리보기(1_미리보기실행.bat)는 `.pglite` 폴더의 내장 DB(5433)를 쓰고,
 * 이 도구는 `.env` 의 DATABASE_URL(보통 PostgreSQL 5432)에 붙는다.
 * 서로 다른 DB 라서 화면에는 0505 가 그대로 보이는데 도구는
 * "구 체계 번호가 없습니다" 라고 답하는 일이 실제로 있었다.
 * 무엇을 보고 있는지 먼저 밝히면 그런 오해가 생기지 않는다.
 */
function describeDatabase(): string {
  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) return '(DATABASE_URL 없음)';
  try {
    const u = new URL(raw);
    const where = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
    if (process.env.PGLITE === '1' || u.port === '5433') {
      return `${where}  ← 미리보기 내장 DB (.pglite)`;
    }
    return `${where}  ← PostgreSQL`;
  } catch {
    return '(DATABASE_URL 형식을 알 수 없음)';
  }
}

async function main() {
  const baseNumber = requireBaseNumber();
  console.log(`데이터베이스: ${describeDatabase()}`);
  console.log(`대표번호: ${formatMoNumber(baseNumber)}  (EMMA_MO_BASE_NUMBER)`);
  console.log(dryRun ? '모드: 미리보기 (변경 없음)\n' : '모드: 실제 재발급\n');

  // 상태로 거르지 않는다. 크리에이터에게 붙어 있는 것은 전부 본다.
  // (배정 상태가 아닌 채 붙어 있는 잔재 행도 화면에는 그대로 보이기 때문)
  const assigned = await prisma.creatorMoNumber.findMany({
    where: { creatorId: { not: null } },
    select: { phoneNumber: true, status: true, creator: { select: { displayName: true, status: true } } },
    orderBy: { phoneNumber: 'asc' },
  });

  /**
   * 재고(크리에이터에게 붙지 않은 번호)도 함께 본다.
   * 0505 가 보인다는 신고의 상당수는 배정된 번호가 아니라 **재고에 남은 구 번호**다.
   * 관리자 화면과 MO 시뮬레이터 선택지에 그대로 나오기 때문이다.
   */
  const stock = await prisma.creatorMoNumber.findMany({
    where: { creatorId: null },
    select: { phoneNumber: true, status: true },
    orderBy: { phoneNumber: 'asc' },
  });
  const legacyStock = stock.filter((r) => !digitsOnly(r.phoneNumber).startsWith(baseNumber));
  const legacy = assigned.filter((r) => !digitsOnly(r.phoneNumber).startsWith(baseNumber));

  /**
   * 현재 배정 상태를 항상 출력한다.
   *
   * 예전에는 "바꿀 게 없다" 한 줄만 찍고 끝냈는데, 그러면 **정말 다 1688 인지**
   * 아니면 **배정된 번호가 하나도 없는 건지** 구분이 되지 않았다.
   * 번호가 잘못 보인다는 신고를 받았을 때 가장 먼저 봐야 하는 것이 이 목록이다.
   */
  console.log(`배정된 번호 ${assigned.length}건:`);
  if (assigned.length === 0) {
    console.log('  (없음) — 승인된 크리에이터에게 배정된 MO 번호가 하나도 없습니다.');
  } else {
    for (const r of assigned) {
      const ok = digitsOnly(r.phoneNumber).startsWith(baseNumber) ? '' : '   <-- 구 체계';
      const state = r.status === 'ASSIGNED' ? '' : `  [${r.status}]`;
      console.log(
        `  - ${(r.creator?.displayName ?? '(이름 없음)').padEnd(16)} ${formatMoNumber(r.phoneNumber)}${state}${ok}`,
      );
    }
  }
  console.log('');

  /**
   * 사용중지(DISABLED)된 구 번호는 **이미 정리가 끝난 것**이다.
   * 배정할 수 없고 화면에도 사용중지로 표시된다. 과거 수신 이력이 참조하므로 남겨 둘 뿐이다.
   * 이것까지 "구 체계"로 세면 정리가 끝난 뒤에도 할 일이 남은 것처럼 보인다.
   */
  const pendingStock = legacyStock.filter((r) => r.status !== 'DISABLED');
  console.log(`재고(미배정) ${stock.length}건 · 그중 정리가 필요한 구 체계 ${pendingStock.length}건:`);
  if (stock.length === 0) {
    console.log('  (없음)');
  } else {
    for (const r of stock) {
      const current = digitsOnly(r.phoneNumber).startsWith(baseNumber);
      const mark = current ? '' : r.status === 'DISABLED' ? '   (구 체계 — 정리 완료)' : '   <-- 구 체계';
      console.log(`  - ${formatMoNumber(r.phoneNumber).padEnd(16)} ${r.status}${mark}`);
    }
  }
  console.log('');

  if (legacy.length === 0 && pendingStock.length === 0) {
    console.log('구 체계 번호가 없습니다. 배정된 번호와 재고가 모두 현재 대표번호 체계입니다.');
    return;
  }

  console.log(`구 체계 번호 ${legacy.length}건:`);
  for (const r of legacy) {
    const note = r.creator?.status === 'APPROVED' ? '' : `  (${r.creator?.status} — 회수만 함)`;
    console.log(`  - ${r.creator?.displayName ?? '(이름 없음)'}: ${formatMoNumber(r.phoneNumber)}${note}`);
  }

  if (dryRun) {
    console.log('\n미리보기라 아무것도 바꾸지 않았습니다. 실행하려면 --dry-run 없이 다시 실행하세요.');
    return;
  }

  console.log('\n재발급 중...');
  const result = await reissueLegacyMoNumbers();

  for (const r of result.reissued) {
    console.log(`  [완료] ${r.displayName}: ${formatMoNumber(r.from)} -> ${formatMoNumber(r.to)}`);
  }
  for (const r of result.reclaimedOnly) {
    const why =
      r.reason === 'NOT_APPROVED'
        ? '승인 상태가 아니라 새 번호를 주지 않음'
        : '배정 상태가 아닌 잔재 행이라 내리기만 함';
    console.log(`  [내림] ${r.displayName}: ${formatMoNumber(r.from)} (${why})`);
  }
  for (const r of result.failed) {
    console.log(`  [실패] ${r.displayName}: ${formatMoNumber(r.from)} — ${r.message}`);
  }
  for (const r of result.retiredStock) {
    console.log(`  [재고정리] ${formatMoNumber(r.phoneNumber)} (${r.previousStatus}) -> 사용중지`);
  }

  console.log(
    `\n재발급 ${result.reissued.length}건 · 내림 ${result.reclaimedOnly.length}건 · ` +
      `재고정리 ${result.retiredStock.length}건 · 실패 ${result.failed.length}건`,
  );
  if (result.reissued.length > 0) {
    console.log('바뀐 번호를 크리에이터에게 안내해 주세요. 방송 화면의 후원 번호 문구를 교체해야 합니다.');
  }
  if (result.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`[실패] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
