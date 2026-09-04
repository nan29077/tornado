import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThanksMessageEditor } from '@/components/studio/thanks-message-editor';
import { THANKS_MT_MAX_LENGTH, THANKS_MT_VARIABLES } from '@/server/services/mt-templates';

/**
 * 감사 문자 편집기 화면 시뮬레이션.
 *
 * 이 화면의 요구사항은 "무엇이 계산되는가"가 아니라 **"크리에이터가 무엇을 읽는가"** 다.
 * 개발 용어가 되살아나거나 버튼이 사라지는 일은 로직 테스트로는 잡히지 않으므로,
 * 실제로 그려 본 결과에서 문구를 직접 확인한다.
 */

const VARIABLES = THANKS_MT_VARIABLES.map((v) => ({
  token: v.token,
  label: v.label,
  button: v.button,
  sample: v.sample,
}));

function render(body: string) {
  return renderToStaticMarkup(
    <ThanksMessageEditor
      defaultBody={body}
      variables={VARIABLES}
      maxLength={THANKS_MT_MAX_LENGTH}
      defaultPreview="[도네이도] 후원해 주셔서 감사합니다."
    />,
  );
}

describe('감사 문자 편집기 화면', () => {
  it('개발 용어("치환자", "바이트")가 화면에 보이지 않는다', () => {
    const html = render('{후원자}님 감사합니다!');
    expect(html).not.toContain('치환');
    // 정확한 바이트 수치는 막대에 마우스를 올렸을 때(title)만 나온다.
    const visible = html.replace(/title="[^"]*"/g, '');
    expect(visible).not.toContain('바이트');
  });

  it('SMS·LMS 대신 "짧은 문자 / 긴 문자" 로 표시한다', () => {
    const short = render('{후원자}님 감사합니다!');
    expect(short).toContain('짧은 문자');
    expect(short).not.toContain('SMS');
    expect(short).not.toContain('LMS');

    const long = render('가'.repeat(120));
    expect(long).toContain('긴 문자');
    expect(long).toContain('3~4배');
  });

  it('항목마다 눌러서 넣는 버튼이 있고 예시값이 함께 보인다', () => {
    const html = render('');
    for (const v of THANKS_MT_VARIABLES) {
      expect(html, `${v.token} 버튼`).toContain(v.button);
      expect(html, `${v.token} 예시값`).toContain(v.sample);
    }
    // 버튼은 폼을 제출하면 안 된다. 전부 type="button" 이어야 한다.
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(THANKS_MT_VARIABLES.length);
    for (const b of buttons) expect(b).toContain('type="button"');
  });

  it('본문을 비우면 기본 문구가 그대로 미리보기에 나온다', () => {
    const html = render('');
    expect(html).toContain('기본 문구');
    expect(html).toContain('[도네이도] 후원해 주셔서 감사합니다.');
  });

  it('미리보기에는 항목이 아니라 실제 값 예시가 채워진다', () => {
    const html = render('{후원자}님 {금액} 감사합니다');
    expect(html).toContain('구영님 10,000원 감사합니다');
    expect(html).not.toContain('{후원자}님 10,000원');
  });

  it('없는 항목을 쓰면 경고가 뜨고, 개발 용어를 쓰지 않는다', () => {
    const html = render('{후원인}님 감사합니다');
    expect(html).toContain('없는 항목입니다');
    expect(html).not.toContain('치환');
  });

  it('본문에 발신 표기가 없어도 미리보기에는 항상 [도네이도] 가 붙는다', () => {
    expect(render('감사합니다')).toContain('[도네이도] 감사합니다');
    // 이미 붙어 있으면 두 번 붙이지 않는다.
    const twice = render('[도네이도] 감사합니다');
    expect(twice).not.toContain('[도네이도] [도네이도]');
  });

  it('입력칸 name 이 서버가 읽는 이름과 같다', () => {
    // 이 이름이 어긋나면 저장은 성공했다고 나오면서 본문만 사라진다.
    expect(render('안녕')).toContain('name="thanksMtMessage"');
  });
});
