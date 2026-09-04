/**
 * MO 수신번호 자동 점검 — 미리보기 서버가 뜰 때마다 한 번 돈다.
 *
 * 왜 자동으로 도는가
 * ------------------
 * 대표번호 체계가 바뀌면(0505·1588 → 1688, 또는 인포뱅크 계약 대표번호 확정) 이미
 * 배정돼 있던 번호는 **저절로 따라오지 않는다.** 그 번호로 문자를 보내도 어디에도
 * 닿지 않는데, 화면에는 멀쩡히 배정된 것처럼 보인다. 관리자가 정리 도구를 기억해
 * 실행해야만 고쳐지는 구조였고, 실제로 그래서 오래 방치됐다.
 *
 * 서버가 뜰 때 한 번 훑어 바로잡으면 사람이 기억할 일이 없어진다. 바꿀 것이 없으면
 * 아무 말도 하지 않고, 바꿨을 때만 무엇을 바꿨는지 알린다.
 *
 * 안전장치
 *  - 대표번호(EMMA_MO_BASE_NUMBER)가 없으면 아무것도 하지 않는다.
 *    (설정 전에 멋대로 번호를 바꾸면 더 위험하다)
 *  - 실패해도 서버 기동을 막지 않는다. 번호 정리는 기동 조건이 아니다.
 */
import 'dotenv/config';
import { prisma } from '../src/server/db';
import { formatMoNumber } from '../src/server/emma';
import { reissueLegacyMoNumbers } from '../src/server/services/mo-number-issue';

async function main() {
  const base = (process.env.EMMA_MO_BASE_NUMBER ?? '').replace(/\D/g, '');
  if (!base) return; // 대표번호 미설정 — 판단 기준이 없으므로 손대지 않는다.

  const result = await reissueLegacyMoNumbers();
  const touched =
    result.reissued.length + result.reclaimedOnly.length + result.retiredStock.length + result.failed.length;
  if (touched === 0) return; // 정상. 조용히 지나간다.

  console.log('');
  console.log(`[번호정리] 구 체계 MO 번호를 ${formatMoNumber(result.baseNumber)} 체계로 정리했습니다.`);
  for (const r of result.reissued) {
    console.log(`           ${r.displayName}: ${formatMoNumber(r.from)} -> ${formatMoNumber(r.to)}`);
  }
  for (const r of result.reclaimedOnly) {
    const why = r.reason === 'NOT_APPROVED' ? '승인 상태가 아님' : '배정 상태가 아닌 잔재 행';
    console.log(`           ${r.displayName}: ${formatMoNumber(r.from)} 내림 (${why})`);
  }
  if (result.retiredStock.length > 0) {
    console.log(`           재고에 남아 있던 구 번호 ${result.retiredStock.length}건을 사용중지했습니다.`);
  }
  for (const r of result.failed) {
    console.log(`           [실패] ${r.displayName}: ${formatMoNumber(r.from)} — ${r.message}`);
  }
  if (result.reissued.length > 0) {
    console.log('           바뀐 번호를 크리에이터에게 안내해 주세요.');
  }
  console.log('');
}

main()
  .catch((e) => {
    // 기동을 막지 않는다. 정리는 언제든 도구_MO번호정리.bat 으로 다시 할 수 있다.
    console.log(`[번호정리] 건너뜀 — ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => prisma.$disconnect());
