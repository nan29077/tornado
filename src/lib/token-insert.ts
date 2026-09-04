/**
 * 문자 본문에 "자동으로 채워지는 항목"을 커서 자리에 끼워 넣는 계산.
 *
 * 왜 따로 빼는가
 * --------------
 * 크리에이터가 `{후원자}` 같은 항목을 손으로 치면 `{후원자 }`(공백) `[후원자]`(대괄호)
 * `{후원인}`(오타)처럼 조금만 어긋나도 값으로 바뀌지 않고 그 글자가 그대로 문자에 나간다.
 * 그래서 버튼으로 넣게 만들었는데, "어디에 넣을지 / 길이가 넘치면 어떻게 할지" 는
 * 화면을 띄우지 않고도 확인할 수 있어야 하는 규칙이라 순수 함수로 분리한다.
 */

export interface TokenInsertResult {
  /** 넣은 뒤의 본문. 길이 제한을 넘으면 원문 그대로다. */
  body: string;
  /** 넣은 뒤 커서를 둘 위치. 항목 바로 뒤다. */
  caret: number;
  /** 길이 제한에 걸려 넣지 못했으면 true */
  full: boolean;
}

/**
 * @param body      현재 본문
 * @param start     선택 시작 위치(커서 위치)
 * @param end       선택 끝 위치. start 와 다르면 그 구간을 항목으로 바꾼다.
 * @param token     넣을 항목 (예: `{후원자}`)
 * @param maxLength 본문 최대 글자 수
 */
export function insertToken(
  body: string,
  start: number,
  end: number,
  token: string,
  maxLength: number,
): TokenInsertResult {
  // 커서 값이 뒤집혀 오거나 범위를 벗어나도 안전하게 잘라 쓴다.
  const lo = Math.max(0, Math.min(body.length, Math.min(start, end)));
  const hi = Math.max(0, Math.min(body.length, Math.max(start, end)));

  const next = body.slice(0, lo) + token + body.slice(hi);

  // textarea 의 maxLength 는 손으로 칠 때만 막아 준다. 버튼 삽입은 여기서 직접 막는다.
  if (next.length > maxLength) {
    return { body, caret: hi, full: true };
  }

  return { body: next, caret: lo + token.length, full: false };
}
