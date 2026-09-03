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
  const legacy = assigned.filter((r) => !digitsOnly(r.phoneNumber).startsWith(baseNumber));

  if (legacy.length === 0) {
    console.log('구 체계 번호가 없습니다. 배정된 번호가 모두 현재 대표번호 체계입니다.');
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

  console.log(
    `\n재발급 ${result.reissued.length}건 · 회수 ${result.reclaimedOnly.length}건 · 실패 ${result.failed.length}건`,
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
