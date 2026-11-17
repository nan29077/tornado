import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoRail } from '@/components/public/auto-rail';
import { MoreButton } from '@/components/home-fan/fan-home';

/**
 * 구독자 전용 탭 자동 흐름 선반 · 섹션별 [더보기] (2026-11-17)
 */
describe('자동 흐름 선반', () => {
  it('처음(서버) 화면에는 카드가 한 번만 그려지고 복제본이 없다 — 넘칠 때만 브라우저에서 붙는다', () => {
    const html = renderToStaticMarkup(
      <AutoRail>
        <article>카드A</article>
        <article>카드B</article>
      </AutoRail>,
    );
    expect(html.match(/카드A/g)).toHaveLength(1);
    expect(html).not.toContain('data-auto-rail-clone');
    expect(html).toContain('data-auto-rail="off"');
  });
});

describe('섹션별 더보기', () => {
  it('더보기 버튼은 지정한 전체 보기 주소로 가고, 읽기 쉬운 이름을 갖는다', () => {
    const html = renderToStaticMarkup(<MoreButton href="/explore/products" title="크리에이터 샵 인기 상품" />);
    expect(html).toContain('href="/explore/products"');
    expect(html).toContain('aria-label="크리에이터 샵 인기 상품 더보기"');
    expect(html).toContain('더보기');
  });

  it('구독자 전용 탭의 각 슬라이드 섹션에 전체 보기 주소가 연결돼 있다', () => {
    const src = readFileSync('src/components/home-fan/fan-home.tsx', 'utf8');
    for (const s of ['live', 'creators', 'channels', 'products', 'trending']) {
      expect(src).toContain(`/explore/${s}`);
    }
    // 가로 선반은 자동 흐름 선반으로 (카테고리 칩 줄만 일반 선반)
    expect(src.match(/<AutoRail/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
