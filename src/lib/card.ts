/**
 * 카드 입력값 정규화 헬퍼.
 *
 * `'use server'` 파일은 **모든 export 가 async 함수여야 한다.** 순수 함수를 그 안에 두면
 * "Server Actions must be async functions" 로 빌드가 깨지므로 별도 모듈로 분리한다.
 *
 * 이 파일은 값을 변환만 하고 저장·전송하지 않는다. 카드번호를 다루는 호출부는
 * PCI-DSS 주의사항(로그·DB 미저장)을 지켜야 한다.
 */

/**
 * 유효기간 입력을 코엠 규격(YYMM)으로 맞춘다.
 *
 * 사람은 보통 MM/YY 로 적고(카드 표면 표기), 코엠 규격은 YYMM 이라 뒤집어야 한다.
 * 앞 두 자리가 01~12 면 MM/YY 로 보고 뒤집고, 아니면 이미 YYMM 인 것으로 본다.
 *
 * @returns YYMM 4자리. 해석할 수 없으면 null.
 */
export function toCardYm(expiry: string): string | null {
  const digits = expiry.replace(/\D/g, '');
  if (digits.length !== 4) return null;

  const first = Number(digits.slice(0, 2));
  const second = Number(digits.slice(2, 4));

  // MM/YY → YYMM 으로 뒤집는다.
  if (first >= 1 && first <= 12) return `${digits.slice(2, 4)}${digits.slice(0, 2)}`;
  // 이미 YYMM 이다. 뒤 두 자리가 월이어야 한다.
  if (second >= 1 && second <= 12) return digits;

  return null;
}
