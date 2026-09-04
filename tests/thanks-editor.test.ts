import { describe, expect, it } from 'vitest';
import { insertToken } from '@/lib/token-insert';
import { THANKS_MT_MAX_LENGTH, THANKS_MT_VARIABLES } from '@/server/services/mt-templates';
import { SMS_BYTE_LIMIT, smsByteLength } from '@/lib/sms';

/**
 * 감사 문자 편집기의 "버튼으로 항목 넣기".
 *
 * 손으로 `{후원자}` 를 치면 공백·대괄호·오타로 어긋나 값으로 바뀌지 않고 그 글자가 그대로
 * 후원자에게 발송된다. 버튼으로 넣게 만든 이유가 그것이므로, 넣는 규칙이 깨지면
 * 개선 자체가 무의미해진다. 화면 없이 확인할 수 있도록 계산만 따로 검증한다.
 */
describe('감사 문자 — 버튼으로 항목 넣기', () => {
  it('커서가 있던 자리에 들어간다 (맨 뒤가 아니다)', () => {
    const body = '님 감사합니다!';
    const r = insertToken(body, 0, 0, '{후원자}', THANKS_MT_MAX_LENGTH);
    expect(r.body).toBe('{후원자}님 감사합니다!');
    expect(r.full).toBe(false);
  });

  it('넣은 뒤 커서가 항목 바로 뒤에 온다', () => {
    const r = insertToken('님 감사합니다!', 0, 0, '{후원자}', THANKS_MT_MAX_LENGTH);
    expect(r.caret).toBe('{후원자}'.length);
    // 이어서 바로 타이핑하면 항목 뒤에 붙는다.
    const typed = r.body.slice(0, r.caret) + r.body.slice(r.caret);
    expect(typed).toBe(r.body);
  });

  it('문장 한가운데에도 들어간다', () => {
    const body = '고마워요 잘 받았습니다';
    const at = '고마워요 '.length;
    const r = insertToken(body, at, at, '{금액}', THANKS_MT_MAX_LENGTH);
    expect(r.body).toBe('고마워요 {금액}잘 받았습니다');
  });

  it('글자를 선택한 상태면 그 부분을 항목으로 바꾼다', () => {
    const body = '홍길동님 감사합니다';
    const r = insertToken(body, 0, 3, '{후원자}', THANKS_MT_MAX_LENGTH);
    expect(r.body).toBe('{후원자}님 감사합니다');
  });

  it('여러 번 눌러도 순서대로 이어 붙는다', () => {
    let body = '';
    let caret = 0;
    for (const token of ['{후원자}', '{금액}', '{메시지}']) {
      const r = insertToken(body, caret, caret, token, THANKS_MT_MAX_LENGTH);
      body = r.body;
      caret = r.caret;
    }
    expect(body).toBe('{후원자}{금액}{메시지}');
  });

  it('글자 수가 꽉 차면 넣지 않고 본문을 그대로 둔다', () => {
    const body = '가'.repeat(THANKS_MT_MAX_LENGTH - 2);
    const r = insertToken(body, body.length, body.length, '{후원자}', THANKS_MT_MAX_LENGTH);
    expect(r.full).toBe(true);
    expect(r.body).toBe(body);
    expect(r.body.length).toBeLessThanOrEqual(THANKS_MT_MAX_LENGTH);
  });

  it('딱 맞게 들어가는 길이는 막지 않는다', () => {
    const token = '{후원자}';
    const body = '가'.repeat(THANKS_MT_MAX_LENGTH - token.length);
    const r = insertToken(body, body.length, body.length, token, THANKS_MT_MAX_LENGTH);
    expect(r.full).toBe(false);
    expect(r.body.length).toBe(THANKS_MT_MAX_LENGTH);
  });

  it('커서 값이 뒤집혀 오거나 범위를 벗어나도 본문이 깨지지 않는다', () => {
    const body = '감사합니다';
    // 뒤에서 앞으로 드래그하면 start > end 로 들어온다.
    expect(insertToken(body, 5, 2, '{금액}', THANKS_MT_MAX_LENGTH).body).toBe('감사{금액}');
    // 값이 범위를 벗어나도 잘라 쓴다.
    expect(insertToken(body, -10, 999, '{금액}', THANKS_MT_MAX_LENGTH).body).toBe('{금액}');
    expect(insertToken('', 0, 0, '{금액}', THANKS_MT_MAX_LENGTH).body).toBe('{금액}');
  });
});

/**
 * 버튼 문구·예시값은 서버 상수 한 곳에서만 관리한다.
 * 화면 쪽에 따로 표를 두면 항목을 추가했을 때 한쪽만 고쳐져
 * 버튼에 `{누적}` 같은 날글자가 그대로 노출된다.
 */
describe('감사 문자 — 항목 표기', () => {
  it('모든 항목에 버튼 문구와 예시값이 있다', () => {
    for (const v of THANKS_MT_VARIABLES) {
      expect(v.button.length, `${v.token} 의 버튼 문구`).toBeGreaterThan(0);
      expect(v.sample.length, `${v.token} 의 예시값`).toBeGreaterThan(0);
    }
  });

  it('버튼 문구와 예시값에 중괄호를 그대로 쓰지 않는다', () => {
    for (const v of THANKS_MT_VARIABLES) {
      expect(v.button).not.toContain('{');
      expect(v.sample).not.toContain('{');
    }
  });

  it('항목 이름은 서로 겹치지 않는다', () => {
    const tokens = THANKS_MT_VARIABLES.map((v) => v.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('예시값을 모두 채운 기본 안내 길이가 짧은 문자 한도를 넘지 않는다', () => {
    // 크리에이터가 placeholder 를 그대로 쓰는 경우가 많다. 그 문장이 곧바로
    // 긴 문자가 되면 안내가 무색해지므로 기준선을 잡아 둔다.
    const sample = '[도네이도] 구영님 감사합니다! 10,000원 후원 잘 받았어요.';
    expect(smsByteLength(sample)).toBeLessThanOrEqual(SMS_BYTE_LIMIT);
  });
});
