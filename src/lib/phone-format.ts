/**
 * 전화번호 문자열 정규화 — **순수 함수만** 둔다 (2026-10-01 분리).
 *
 * 왜 따로 있나
 *   `@/lib/crypto` 는 `node:crypto` 와 `@/lib/env` 를 불러온다. 후원자 닉네임 규칙(`@/lib/donor-name`)이
 *   그 파일에서 이 두 함수만 가져다 쓰는 바람에, 닉네임 입력 화면(마이페이지 계정, 결제수단 등록·
 *   후원 확인 화면)의 **브라우저 번들에 env 검증이 실려** 브라우저에서 "PHONE_HASH_SECRET 가 설정되지
 *   않았습니다" 예외로 화면 전체가 오류 화면으로 바뀌었다. 클라이언트에서도 쓰는 함수는 여기 둔다.
 *   `@/lib/crypto` 는 이 파일을 re-export 해 기존 import 경로를 유지한다.
 */

export function normalizePhone(input: string): string {
  let v = (input || '').replace(/[^0-9+]/g, '');
  if (v.startsWith('+82')) v = '0' + v.slice(3);
  else if (v.startsWith('82') && v.length > 10) v = '0' + v.slice(2);
  return v.replace(/[^0-9]/g, '');
}

export function phoneTail4(value: string): string {
  const digits = (value || '').replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}
