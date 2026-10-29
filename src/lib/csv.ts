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

/**
 * SET-1 (2026-10-29): 식별번호 열(은행코드·계좌번호·주민등록번호·사업자번호·크리에이터 코드 등).
 *
 * csvCell 은 순수 숫자를 그대로 내보낸다. 금액 열에는 그게 맞지만(엑셀이 숫자로 합계를 낸다),
 * 식별번호를 엑셀로 열면 숫자로 바뀌어 **앞자리 0 이 사라지고**(은행코드 004 -> 4) 12자리가 넘으면
 * 지수 표기(9.00101E+12)가 되어 원래 값을 되살릴 수 없다. 저장하는 순간 파일 자체가 망가진다.
 *
 * 숫자·하이픈으로만 된 값은 `="004"` 수식-문자열 형태로 내보낸다. 엑셀은 이것을 문자열 상수
 * "004" 를 돌려주는 수식으로 읽어 0 을 지키고 지수 표기도 하지 않는다.
 *  - 수식 주입 방지와 충돌하지 않는다: 이 형태는 **숫자·하이픈만** 있는 값에만 쓰므로 수식 안에
 *    공격자가 넣을 수 있는 문자가 없다. 그 밖의 값은 csvCell 로 넘겨 기존 방어(`'` 접두)를 그대로 쓴다.
 *  - 빈 값은 빈 칸으로 둔다.
 *
 * **기계가 읽는 파일(은행 대량이체 업로드)에는 쓰지 않는다.** 은행·지급대행 시스템은 `="004"` 를
 * 그대로 문자열로 읽어 거부하거나 잘못 이체한다. 그 파일은 csvCell(원문 숫자)로 두고,
 * 엑셀로 열어 저장하지 말라고 화면에서 안내한다 (api/admin/settlements/payout 참고).
 */
const IDENTIFIER = /^[0-9][0-9-]*$/;

export function csvTextCell(v: string): string {
  const cleaned = v.replace(CONTROL_CHARS, '').trim();
  if (cleaned === '') return '';
  if (!IDENTIFIER.test(cleaned)) return csvCell(cleaned);
  // CSV 이스케이프 후: "=""004"""  ->  엑셀이 읽는 값: ="004"
  return `"=""${cleaned}"""`;
}

/** 열 종류. 'text' 는 식별번호(csvTextCell), 'auto' 는 기본(csvCell, 금액·일반 텍스트). */
export type CsvColumnKind = 'auto' | 'text';

/** 열 종류 배열에 맞춰 한 행을 만든다. kinds 가 짧으면 나머지는 'auto' 다. */
export function csvRow(values: string[], kinds: readonly CsvColumnKind[] = []): string {
  return values.map((v, i) => (kinds[i] === 'text' ? csvTextCell(v) : csvCell(v))).join(',');
}
