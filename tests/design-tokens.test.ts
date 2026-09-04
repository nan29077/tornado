import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 디자인 토큰(색) 사용 검사.
 *
 * 왜 필요한가
 * -----------
 * Tailwind 는 정의되지 않은 색 클래스를 **오류 없이 조용히 무시한다.** `text-ink-600` 처럼
 * 팔레트에 없는 계단을 쓰면 빌드도 통과하고 화면도 뜨지만, 그 자리 글자는 아무 색도 받지
 * 못한 채 부모 색을 그대로 물려받는다. 그래서
 *   - 회색이어야 할 본문이 새까맣게 나오고
 *   - hover 색이 아예 바뀌지 않고
 *   - 주황색이어야 할 경고 문구가 회색으로 나온다.
 * 눈으로만 보면 "좀 이상한데" 하고 넘어가기 쉬워 실제로 37곳이 이 상태로 쌓여 있었다.
 *
 * 검사 범위
 * ---------
 * 프로젝트 고유 색 계열(brand·ink·accent·success·warning·danger·warm)만 본다.
 * Tailwind 기본 팔레트(red-500 등)는 @theme 가 지우지 않으므로 그대로 쓸 수 있다.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS = path.join(SRC, 'app', 'globals.css');

/** 클래스 앞에 붙을 수 있는 유틸리티 이름들 */
const PREFIX =
  'text|bg|border|ring|from|to|via|fill|stroke|outline|decoration|accent|caret|divide|placeholder|shadow';

function readPalette(): Map<string, Set<string>> {
  const css = readFileSync(CSS, 'utf8');
  const palette = new Map<string, Set<string>>();
  for (const m of css.matchAll(/--color-([a-z]+)-(\d+)\s*:/g)) {
    const [, family, shade] = m;
    if (!palette.has(family)) palette.set(family, new Set());
    palette.get(family)!.add(shade);
  }
  return palette;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // 자동 생성 코드(Prisma 클라이언트)는 화면이 아니므로 제외한다.
    if (name === 'generated' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}

/** 흰 배경 위 대비비를 계산한다 (WCAG 2.1). */
function contrastOnWhite(hex: string): number {
  const v = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels.map(lin);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05);
}

function colorValue(family: string, shade: string): string {
  const css = readFileSync(CSS, 'utf8');
  const m = css.match(new RegExp(`--color-${family}-${shade}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--color-${family}-${shade} 를 찾을 수 없습니다`);
  return m[1];
}

/**
 * 상태 색은 역할이 둘이다.
 *  - 500 : 배지·버튼 **바탕**색. 흰 글자를 얹는다.
 *  - 600 : 흰 배경 위 **글자**색.
 * 500 을 글자에 쓰면 대비가 모자라 정작 가장 잘 읽혀야 할 오류·경고 문구가 흐려진다.
 */
describe('디자인 토큰 — 글자색 대비', () => {
  it('문구용 색(600)은 흰 배경에서 본문 기준(4.5:1)을 넘는다', () => {
    for (const family of ['danger', 'warning', 'success']) {
      const ratio = contrastOnWhite(colorValue(family, '600'));
      expect(ratio, `${family}-600 대비 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('먹색 본문 색도 기준을 넘는다', () => {
    for (const shade of ['600', '700', '800', '900']) {
      const ratio = contrastOnWhite(colorValue('ink', shade));
      expect(ratio, `ink-${shade} 대비 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('상태 색 500 을 글자색으로 쓰지 않는다', () => {
    // 500 은 바탕용이다. bg-/border- 로는 계속 쓰고, text- 로만 쓰지 않는다.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/text-(danger|warning|success)-500(?![\d/])/g)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${m[0]}`);
          }
        });
    }
    expect(
      offenders,
      `상태 색 500 은 배지 바탕용입니다. 흰 배경 위 글자로 쓰면 대비가 모자랍니다.\n` +
        `글자에는 600 을 쓰세요.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('디자인 토큰 — 정의되지 않은 색 클래스', () => {
  const palette = readPalette();

  it('팔레트에 기본 계열이 모두 있다', () => {
    for (const family of ['brand', 'ink', 'accent', 'success', 'warning', 'danger', 'warm']) {
      expect(palette.has(family), `${family} 계열이 globals.css 에 없습니다`).toBe(true);
    }
  });

  it('먹색(ink) 계단이 비어 있지 않다', () => {
    // 본문 글자 색이 이 계단 위에서 움직인다. 하나만 비어도 그 자리 글자가 색을 잃는다.
    const ink = palette.get('ink')!;
    for (const shade of ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']) {
      expect(ink.has(shade), `--color-ink-${shade} 이 없습니다`).toBe(true);
    }
  });

  it('화면 코드가 팔레트에 없는 색을 쓰지 않는다', () => {
    const families = [...palette.keys()].join('|');
    const pattern = new RegExp(`(?<![\\w-])(?:${PREFIX})-(${families})-(\\d+)`, 'g');

    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(pattern)) {
          const [token, family, shade] = m;
          if (!palette.get(family)!.has(shade)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${token}`);
          }
        }
      });
    }

    expect(
      offenders,
      `globals.css 의 @theme 에 없는 색입니다. 그 자리 글자는 색을 받지 못하고 부모 색을 물려받습니다.\n` +
        `팔레트에 계단을 추가하거나 정의된 색으로 바꿔 주세요.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
