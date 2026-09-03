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

async function main() {
  const baseNumber = requireBaseNumber();
  console.log(`대표번호: ${formatMoNumber(baseNumber)}  (EMMA_MO_BASE_NUMBER)`);
  console.log(dryRun ? '모드: 미리보기 (변경 없음)\n' : '모드: 실제 재발급\n');

  const assigned = await prisma.creatorMoNumber.findMany({
    where: { status: 'ASSIGNED', creatorId: { not: null } },
    select: { phoneNumber: true, creator: { select: { displayName: true, status: true } } },
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
      console.log(`  - ${(r.creator?.displayName ?? '(이름 없음)').padEnd(16)} ${formatMoNumber(r.phoneNumber)}${ok}`);
    }
  }
  console.log('');

  console.log(`재고(미배정) ${stock.length}건 · 그중 구 체계 ${legacyStock.length}건:`);
  if (stock.length === 0) {
    console.log('  (없음)');
  } else {
    for (const r of stock) {
      const mark = digitsOnly(r.phoneNumber).startsWith(baseNumber) ? '' : '   <-- 구 체계';
      console.log(`  - ${formatMoNumber(r.phoneNumber).padEnd(16)} ${r.status}${mark}`);
    }
  }
  console.log('');

  if (legacy.length === 0 && legacyStock.length === 0) {
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
    console.log(`  [회수] ${r.displayName}: ${formatMoNumber(r.from)} (승인 상태가 아니라 새 번호를 주지 않음)`);
  }
  for (const r of result.failed) {
    console.log(`  [실패] ${r.displayName}: ${formatMoNumber(r.from)} — ${r.message}`);
  }
  for (const r of result.retiredStock) {
    console.log(`  [재고정리] ${formatMoNumber(r.phoneNumber)} (${r.previousStatus}) -> 사용중지`);
  }

  console.log(
    `\n재발급 ${result.reissued.length}건 · 회수 ${result.reclaimedOnly.length}건 · ` +
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
