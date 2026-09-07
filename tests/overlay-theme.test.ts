import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { themeHasCard, themeOf } from '@/components/overlay/overlay-client';

/**
 * 후원 알림을 투네이션·트윕처럼 **배경 없는 큰 글씨**로 바꾼 작업의 재발 방지.
 *
 * 방송 화면에 상자를 깔면 그 안의 장면이 가려진다. 그래서 기본·미니멀·네온은 배경 판을
 * 없애고 글자만 얹는다. 상자를 원하는 크리에이터를 위해 예전 카드 디자인은 CARD 로 남겼다.
 */

const OVERLAY = 'src/components/overlay/overlay-client.tsx';
const SETTINGS = 'src/components/studio/overlay-quick-settings.tsx';
const EFFECTS = 'src/components/overlay/overlay-effects.tsx';
const read = (p: string) => readFileSync(p, 'utf8');

describe('테마 값', () => {
  it('네 가지를 알아본다', () => {
    expect(themeOf('TORNADO')).toBe('TORNADO');
    expect(themeOf('MINIMAL')).toBe('MINIMAL');
    expect(themeOf('NEON')).toBe('NEON');
    expect(themeOf('CARD')).toBe('CARD');
  });

  it('소문자로 저장돼 있어도 알아본다', () => {
    expect(themeOf('card')).toBe('CARD');
    expect(themeOf('neon')).toBe('NEON');
  });

  it('모르는 값·빈 값은 기본으로 떨어뜨린다', () => {
    // 방송 중에 화면이 통째로 비는 것보다 기본 디자인으로라도 나오는 편이 낫다.
    expect(themeOf('예전에쓰던값')).toBe('TORNADO');
    expect(themeOf('')).toBe('TORNADO');
    expect(themeOf(undefined)).toBe('TORNADO');
  });

  it('배경 판이 있는 테마는 CARD 뿐이다', () => {
    expect(themeHasCard('CARD')).toBe(true);
    expect(themeHasCard('TORNADO')).toBe(false);
    expect(themeHasCard('MINIMAL')).toBe(false);
    expect(themeHasCard('NEON')).toBe(false);
  });
});

describe('배경 없는 큰 글씨 알림', () => {
  const src = read(OVERLAY);

  it('글자에 테두리를 둘러 어떤 배경에서도 읽히게 한다', () => {
    // 배경 판을 없앤 대신 글자 자신이 테두리를 두른다. 이게 빠지면 밝은 장면에서
    // 흰 글자가 통째로 사라진다.
    expect(src).toContain('WebkitTextStrokeWidth');
    expect(src).toContain('WebkitTextStrokeColor');
    // 테두리를 글자 뒤에 그려야 획이 얇아지지 않는다.
    expect(src).toContain("paintOrder: 'stroke fill'");
  });

  it('방송 화면에서 읽히는 크기로 그린다', () => {
    // 1920 기준. 예전 16px 은 웹페이지 카드용 크기라 휴대폰 시청자가 읽을 수 없었다.
    expect(src).toContain('text-[64px]');
    expect(src).toContain('text-[46px]');
  });

  it('긴 메시지가 방송 화면을 덮지 않게 줄 수를 제한한다', () => {
    expect(src).toContain('line-clamp-3');
  });

  it('금액만 색을 달리해 강조한다', () => {
    expect(src).toContain('color: p.accent');
  });

  it('세 테마 모두 배경 색을 칠하지 않는다', () => {
    const block = src.slice(src.indexOf('const PLAIN_THEMES'), src.indexOf('const CARD_CLASSES'));
    expect(block).not.toContain('bg-');
    expect(block).not.toContain('background');
  });

  it('예전 카드 디자인은 그대로 남아 있다', () => {
    // 상자를 원하는 크리에이터를 위해 보존한다. 사라지면 되돌릴 수 없다.
    expect(src).toContain('const CARD_CLASSES');
    expect(src).toContain('bg-white/95');
  });
});

describe('캐릭터 스티커', () => {
  it('배경 없는 알림에서는 글자 옆에 작게 붙는다', () => {
    // 위에 크게 얹으면 세로로 길어져 방송 화면을 위아래로 가로지른다.
    const src = read(EFFECTS);
    expect(src).toContain("placement === 'side'");
    expect(src).toContain('w-[200px]');
    // 카드형에서 쓰던 크기는 그대로 남는다.
    expect(src).toContain('w-[260px]');
  });

  it('알림 화면이 옆 배치로 넘긴다', () => {
    expect(read(OVERLAY)).toContain('placement="side"');
  });
});

describe('스튜디오 설정 화면', () => {
  const src = read(SETTINGS);

  it('카드형을 고를 수 있다', () => {
    expect(src).toContain("value: 'CARD'");
    expect(src).toContain('카드형');
  });

  it('네 가지 테마가 모두 목록에 있다', () => {
    for (const v of ['TORNADO', 'MINIMAL', 'NEON', 'CARD']) {
      expect(src, `${v} 가 목록에 없습니다`).toContain(`value: '${v}'`);
    }
  });

  it('작은 미리보기도 실제와 같은 방식으로 그린다', () => {
    // 미리보기가 상자를 그리는데 실제는 안 그리면, 고른 것과 다른 것이 방송에 나간다.
    expect(src).toContain('OUTLINE_PREVIEW');
    expect(src).toContain("paintOrder: 'stroke fill'");
  });
});
