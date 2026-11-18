/**
 * 팬챗·1:1 채팅 연락처 가림 (2026-11-17).
 * 전화번호 · 이메일 · 계좌번호 · 외부 메신저 아이디 · 링크를 가린다 (직거래·사기·스토킹 방지).
 * 순수 함수 — 화면과 서버 모두에서 쓴다.
 */

const MASK = '[가려짐]';

const PATTERNS: RegExp[] = [
  // 링크
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\bopen\.kakao\.com\S*/gi,
  // 이메일
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // 전화번호 (010-1234-5678, 01012345678, 02 123 4567 등)
  /(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g,
  // 계좌번호처럼 보이는 숫자 묶음 (123-456-789012)
  /(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?!\d)/g,
  // 외부 메신저 아이디 안내
  /(?:카톡|카카오톡|카카오|kakao|라인|line|텔레그램|텔레|telegram|인스타|insta(?:gram)?|디엠|dm)\s*(?:아이디|id)?\s*[:：=]?\s*@?[A-Za-z0-9._-]{3,}/gi,
];

export function maskContacts(input: string): { text: string; masked: boolean } {
  let text = input;
  let masked = false;
  for (const re of PATTERNS) {
    text = text.replace(re, () => {
      masked = true;
      return MASK;
    });
  }
  return { text, masked };
}

/** 크리에이터 메시지의 {닉네임} 을 받는 팬 이름으로 바꾼다 */
export function personalize(body: string, fanName: string | null | undefined): string {
  const name = (fanName ?? '').trim() || '팬';
  return body.replace(/\{닉네임\}/g, name);
}
