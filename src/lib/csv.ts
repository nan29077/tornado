/**
 * CSV 셀 인코딩 (관리자 다운로드 공용).
 *
 * 예전에는 이체파일·원천징수·세무 자료 라우트가 같은 함수를 각자 복사해 썼고, 세 벌 모두
 * 다음 문제가 있었다 (SET-G / P2-1, 2026-10-15).
 *  - `-` 로 시작하는 값을 수식으로 보고 앞에 `'` 를 붙여, **음수 금액**(원장 분개 -12000)이
 *    문자열 `'-12000` 이 되었다. 엑셀 합계에서 빠지고 회계 프로그램 업로드가 깨진다.
 *  - `\r` 만 들어 있는 값은 따옴표로 감싸지 않아 행이 쪼개졌다.
 *  - 그 밖의 제어문자가 그대로 나가 일부 프로그램이 파일을 거부했다.
 *
 * 규칙
 *  - 순수 숫자(`-?\d+(\.\d+)?`)는 수식 방지 대상에서 뺀다. 숫자는 엑셀이 수식으로 실행하지 않는다.
 *  - 그 밖의 값이 `= + - @ \t \r` 로 시작하면 앞에 `'` 를 붙이고 따옴표로 감싼다(수식 주입 방지 유지).
 *  - `" , \r \n` 이 들어 있으면 따옴표로 감싸고 `"` 는 `""` 로 이스케이프한다.
 *  - 탭·줄바꿈을 뺀 제어문자는 지운다.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: string): string {
  const cleaned = v.replace(CONTROL_CHARS, '');
  const formula = !NUMERIC.test(cleaned) && FORMULA_START.test(cleaned);
  const safe = formula ? `'${cleaned}` : cleaned;
  const needsQuote = formula || /[",\r\n]/.test(safe);
  return needsQuote ? `"${safe.replace(/"/g, '""')}"` : safe;
}
