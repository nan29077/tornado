import { describe, expect, it } from 'vitest';
import {
  computeEntryResult,
  computeLadder,
  computeRoulette,
  winnersOf,
  type ParticipantRow,
} from '@/server/services/game-result';

/**
 * 게임 결과 계산 회귀 테스트.
 *
 * 실시간 추첨은 조작 시비가 붙기 쉬운 기능이라, 결과 규칙이 바뀌면 바로 잡히도록
 * 순수 로직만 따로 검증한다. (DB 를 쓰지 않는다)
 */

function p(name: string, entry: string | null, seconds = 0): ParticipantRow {
  return { displayName: name, entry, donorId: null, createdAt: new Date(1700000000000 + seconds * 1000) };
}

describe('룰렛', () => {
  it('항상 항목 범위 안에서 뽑고, 특정 칸으로 쏠리지 않는다', () => {
    const items = ['A', 'B', 'C', 'D', 'E'];
    const hits = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const r = computeRoulette(items);
      expect(items[r.winnerIndex]).toBe(r.winner);
      hits.set(r.winner, (hits.get(r.winner) ?? 0) + 1);
    }
    // 균등하면 각 400회. 어느 칸도 200회 미만이거나 700회 초과이면 안 된다.
    for (const item of items) {
      const n = hits.get(item) ?? 0;
      expect(n).toBeGreaterThan(200);
      expect(n).toBeLessThan(700);
    }
  });
});

describe('사다리타기', () => {
  it('도착 항목이 중복 없이 하나씩 배정된다', () => {
    const starts = ['가', '나', '다', '라'];
    const dests = ['1등', '2등', '3등', '꽝'];
    for (let i = 0; i < 200; i++) {
      const r = computeLadder(starts, dests);
      expect(r.order).toHaveLength(starts.length);
      // 같은 보상이 두 사람에게 가면 안 된다
      expect(new Set(r.order).size).toBe(starts.length);
      expect([...r.order].sort()).toEqual([...dests].sort());
    }
  });

  it('도착 항목이 모자라면 빈칸으로 채워 길이를 맞춘다', () => {
    const r = computeLadder(['가', '나', '다'], ['1등']);
    expect(r.order).toHaveLength(3);
    expect(r.destinations).toHaveLength(3);
  });

  it('선택한 번호를 결과에 남긴다', () => {
    const r = computeLadder(['가', '나'], ['A', 'B'], 1);
    expect(r.activeIndex).toBe(1);
  });
});

describe('선착순 키워드', () => {
  const config = { keyword: '도네이도', winnerCount: 2, prize: '샤라웃' };
  const rows = [
    p('늦은사람', '도네이도', 30),
    p('오답', '토네이도', 1),
    p('일등', '도네이도', 2),
    p('이등', '도네이도', 5),
  ];

  it('정답자를 들어온 순서대로 자른다 (섞지 않는다)', () => {
    // 참여자는 서비스에서 createdAt 오름차순으로 넘어온다
    const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const r = computeEntryResult('KEYWORD', { ...config, keyword: '도네이도' }, ordered) as {
      ranks: { name: string }[];
      totalCorrect: number;
    };
    expect(r.totalCorrect).toBe(3);
    expect(r.ranks.map((x) => x.name)).toEqual(['일등', '이등']);
  });
});

describe('숫자 맞히기', () => {
  const rows = [p('멀리', '10', 1), p('가깝게', '48', 2), p('정확히', '50', 3), p('같은차이늦게', '52', 4)];

  it('가장 가까운 사람을 뽑는다', () => {
    const r = computeEntryResult(
      'NUMBER_GUESS',
      { answer: 50, mode: 'closest', winnerCount: 2, prize: '' },
      rows,
    ) as { ranks: { name: string; detail: string }[] };
    expect(r.ranks[0].name).toBe('정확히');
    // 48 과 52 는 차이가 같다. 먼저 낸 사람이 앞선다.
    expect(r.ranks[1].name).toBe('가깝게');
    expect(r.ranks[0].detail).toBe('50');
  });

  it('정확히 맞힌 사람만 뽑는 모드', () => {
    const r = computeEntryResult(
      'NUMBER_GUESS',
      { answer: 50, mode: 'exact', winnerCount: 3, prize: '' },
      rows,
    ) as { ranks: { name: string }[] };
    expect(r.ranks.map((x) => x.name)).toEqual(['정확히']);
  });
});

describe('라이브 퀴즈', () => {
  it('정답자 수를 세고 그중 한 명을 뽑는다', () => {
    const rows = [p('a', '0'), p('b', '1'), p('c', '1'), p('d', '2')];
    const r = computeEntryResult(
      'QUIZ',
      { choices: ['가', '나', '다'], answerIndex: 1, prize: '신청곡' },
      rows,
    ) as { correctCount: number; counts: number[]; ranks: { name: string; prize: string }[] };
    expect(r.correctCount).toBe(2);
    expect(r.counts).toEqual([1, 2, 1]);
    expect(r.ranks).toHaveLength(1);
    expect(['b', 'c']).toContain(r.ranks[0].name);
    expect(r.ranks[0].prize).toBe('신청곡');
  });

  it('정답자가 없으면 당첨자도 없다', () => {
    const rows = [p('a', '0'), p('b', '0')];
    const r = computeEntryResult('QUIZ', { choices: ['가', '나'], answerIndex: 1 }, rows) as {
      correctCount: number;
      ranks: unknown[];
    };
    expect(r.correctCount).toBe(0);
    expect(r.ranks).toHaveLength(0);
  });
});

describe('실시간 투표', () => {
  it('최다 득표 선택지를 고른다', () => {
    const rows = [p('a', '0'), p('b', '1'), p('c', '1'), p('d', '9')];
    const r = computeEntryResult('VOTE', { choices: ['가', '나'] }, rows) as {
      counts: number[];
      total: number;
      topIndex: number;
      topLabel: string;
    };
    // 범위를 벗어난 입력(9)은 집계에서 무시한다
    expect(r.counts).toEqual([1, 2]);
    expect(r.total).toBe(3);
    expect(r.topIndex).toBe(1);
    expect(r.topLabel).toBe('나');
  });

  it('아무도 투표하지 않으면 1위를 만들지 않는다', () => {
    const r = computeEntryResult('VOTE', { choices: ['가', '나'] }, []) as { topIndex: number };
    expect(r.topIndex).toBe(-1);
  });
});

describe('순위 추첨', () => {
  it('참여자보다 많이 뽑지 않고 같은 사람을 두 번 뽑지 않는다', () => {
    const rows = [p('a', null), p('b', null), p('c', null)];
    const r = computeEntryResult('RANKING', { rankCount: 5, prizes: ['1', '2', '3', '4', '5'] }, rows) as {
      ranks: { rank: number; name: string; prize: string }[];
    };
    expect(r.ranks).toHaveLength(3);
    expect(new Set(r.ranks.map((x) => x.name)).size).toBe(3);
    expect(r.ranks.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.ranks[0].prize).toBe('1');
  });
});

describe('당첨자 기록', () => {
  it('룰렛은 당첨 항목 한 건을 남긴다', () => {
    const seeds = winnersOf('ROULETTE', { winner: '치킨', winnerIndex: 0 }, { prize: '기프티콘' });
    expect(seeds).toEqual([{ rank: 1, name: '치킨', prize: '기프티콘', donorId: null }]);
  });

  it('사다리는 출발 항목마다 도착 보상을 남긴다', () => {
    const seeds = winnersOf('LADDER', { starts: ['가', '나'], order: ['A', 'B'] }, {});
    expect(seeds).toEqual([
      { rank: 1, name: '가', prize: 'A', donorId: null },
      { rank: 2, name: '나', prize: 'B', donorId: null },
    ]);
  });

  it('투표와 후원 목표는 당첨자 개념이 없다', () => {
    expect(winnersOf('VOTE', { counts: [1, 2] }, {})).toEqual([]);
    expect(winnersOf('GOAL_GAUGE', { achieved: true }, {})).toEqual([]);
  });
});
