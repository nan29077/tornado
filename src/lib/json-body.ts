/**
 * JSON 요청 본문을 "객체"로만 받아들이는 도우미.
 *
 * `req.json()` 은 본문이 `null` · `123` · `"문자열"` · `[]` 여도 성공한다.
 * 그대로 `body.action` 을 읽으면
 *   - `null`  → TypeError → 500 (원인이 로그에만 남고 화면에는 서버 오류로 보인다)
 *   - 문자열·숫자 → 조용히 `undefined` → 엉뚱한 분기
 * 가 된다. 객체가 아닌 본문은 빈 객체로 떨어뜨려 "알 수 없는 요청"(400) 경로를 타게 한다.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  return isRecord(body) ? body : {};
}

/** 문자열 배열만 남긴다. 객체·숫자가 섞여 들어와도 뒤 단계에서 터지지 않게 한다. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
