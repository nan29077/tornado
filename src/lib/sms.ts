/**
 * 문자 길이 계산.
 *
 * 문자는 글자 수가 아니라 **바이트**로 SMS(단문)/LMS(장문)가 갈리고, 건당 요금이 3~4배 차이난다.
 * 관리자 화면과 크리에이터 스튜디오가 같은 기준으로 세야 "관리자 화면에서는 단문인데
 * 스튜디오에서는 장문" 같은 어긋남이 생기지 않으므로 한 곳에 둔다.
 */

/** SMS 단문 한계(바이트). 이 값을 넘으면 LMS 로 나간다. */
export const SMS_BYTE_LIMIT = 90;

/**
 * EUC-KR 기준 문자 바이트 수. 국내 문자 사업자가 SMS/LMS 를 가르는 기준이다.
 * ASCII 는 1바이트, 그 밖(한글·전각기호·이모지)은 2바이트로 센다.
 */
export function smsByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    bytes += ch.charCodeAt(0) < 128 ? 1 : 2;
  }
  return bytes;
}

/** 바이트 수 기준 발송 구분. */
export function smsKind(bytes: number): 'SMS' | 'LMS' {
  return bytes > SMS_BYTE_LIMIT ? 'LMS' : 'SMS';
}
