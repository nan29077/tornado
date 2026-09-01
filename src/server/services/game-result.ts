import { randomInt } from 'node:crypto';

/**
 * 게임 결과 계산 (순수 로직).
 *
 * DB · 네트워크에 의존하지 않는다. 그래야 추첨 로직만 따로 테스트할 수 있다.
 * 실시간 추첨은 조작 시비가 반드시 따라오므로 두 가지를 지킨다.
 *  - 무작위는 CSPRNG(node:crypto randomInt)만 쓴다. Math.random 을 쓰지 않는다.
 *  - 결과는 서버가 확정하고, 화면은 그 결과를 재생하기만 한다.
 */

export interface ParticipantRow {
  displayName: string;
  entry: string | null;
  donorId: string | null;
  createdAt: Date;
}

export interface WinnerSeed {
  rank: number;
  name: string;
  prize: string;
  donorId: string | null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : [];
}

/** 편향 없는 무작위 섞기 (Fisher-Yates + CSPRNG) */
export function shuffle<T>(input: T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}



export function computeRoulette(items: string[]) {
  const index = randomInt(items.length);
  return { winnerIndex: index, winner: items[index] };
}

/**
 * 사다리 가로줄을 만든다.
 * 같은 행에서 이웃한 가로줄이 겹치지 않도록 한 칸씩 띄운다.
 */
function buildRungs(cols: number) {
  const rows = Math.max(8, cols * 3);
  const rungs: { row: number; col: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const used = new Set<number>();
    for (const col of shuffle(Array.from({ length: cols - 1 }, (_, i) => i))) {
      if (used.has(col) || used.has(col - 1) || used.has(col + 1)) continue;
      if (randomInt(2) === 0) {
        rungs.push({ row, col });
        used.add(col);
      }
    }
  }
  return { rungs, rows };
}

export function computeLadder(items: string[], destinationsInput: string[], selectedIndex?: number) {
  const cols = items.length;
  // 도착 항목 수를 출발 수에 맞춘다. 모자라면 빈칸으로 채운다.
  const destinations = [...destinationsInput];
  while (destinations.length < cols) destinations.push('');
  destinations.length = cols;

  const shuffled = shuffle(destinations);
  const { rungs, rows } = buildRungs(cols);

  const order = items.map((_, startCol) => {
    let col = startCol;
    for (let row = 0; row < rows; row++) {
      if (rungs.some((r) => r.row === row && r.col === col)) col = Math.min(col + 1, cols - 1);
      else if (rungs.some((r) => r.row === row && r.col === col - 1)) col = Math.max(col - 1, 0);
    }
    return shuffled[col] ?? '';
  });

  return {
    rungs,
    rows,
    cols,
    starts: items,
    destinations: shuffled,
    order,
    activeIndex: typeof selectedIndex === 'number' ? selectedIndex : null,
  };
}

export function computeEntryResult(
  type: string,
  config: Record<string, unknown>,
  participants: ParticipantRow[],
): Record<string, unknown> {
  switch (type) {
    case 'RANKING': {
      const rankCount = Math.min(Number(config.rankCount) || 1, participants.length);
      const prizes = asStringArray(config.prizes);
      const picked = shuffle(participants).slice(0, Math.max(1, rankCount));
      return {
        ranks: picked.map((p, i) => ({
          rank: i + 1,
          name: p.displayName,
          prize: prizes[i] ?? '',
          donorId: p.donorId,
        })),
      };
    }
    case 'VOTE': {
      const choices = asStringArray(config.choices);
      const counts = choices.map(() => 0);
      for (const p of participants) {
        const idx = Number(p.entry);
        if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
      }
      const total = counts.reduce((a, b) => a + b, 0);
      let topIndex = 0;
      counts.forEach((c, i) => {
        if (c > counts[topIndex]) topIndex = i;
      });
      return {
        choices,
        counts,
        total,
        topIndex: total > 0 ? topIndex : -1,
        topLabel: total > 0 ? choices[topIndex] : '',
      };
    }
    case 'QUIZ': {
      const choices = asStringArray(config.choices);
      const answerIndex = Number(config.answerIndex) || 0;
      const counts = choices.map(() => 0);
      const correct: ParticipantRow[] = [];
      for (const p of participants) {
        const idx = Number(p.entry);
        if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
        if (idx === answerIndex) correct.push(p);
      }
      // 정답자가 여러 명이면 추첨으로 1명을 고른다. 정답자 전원도 함께 보여 준다.
      const picked = correct.length > 0 ? shuffle(correct).slice(0, 1) : [];
      return {
        choices,
        counts,
        answerIndex,
        answerLabel: choices[answerIndex] ?? '',
        correctCount: correct.length,
        correctNames: correct.slice(0, 30).map((p) => p.displayName),
        ranks: picked.map((p, i) => ({
          rank: i + 1,
          name: p.displayName,
          prize: String(config.prize ?? ''),
          donorId: p.donorId,
        })),
      };
    }
    case 'KEYWORD': {
      const keyword = String(config.keyword ?? '').trim().toLowerCase();
      const winnerCount = Math.max(1, Number(config.winnerCount) || 1);
      // 선착순이므로 섞지 않는다. 들어온 순서 그대로 자른다.
      const matched = participants.filter((p) => (p.entry ?? '') === keyword).slice(0, winnerCount);
      return {
        keyword: String(config.keyword ?? ''),
        totalCorrect: participants.filter((p) => (p.entry ?? '') === keyword).length,
        ranks: matched.map((p, i) => ({
          rank: i + 1,
          name: p.displayName,
          prize: String(config.prize ?? ''),
          donorId: p.donorId,
        })),
      };
    }
    case 'NUMBER_GUESS': {
      const answer = Number(config.answer) || 0;
      const exact = config.mode === 'exact';
      const winnerCount = Math.max(1, Number(config.winnerCount) || 1);
      const rows = participants
        .map((p) => ({ p, value: Number(p.entry) }))
        .filter((x) => Number.isFinite(x.value));

      const picked = exact
        ? rows.filter((x) => x.value === answer).slice(0, winnerCount)
        : rows
            .map((x) => ({ ...x, diff: Math.abs(x.value - answer) }))
            .sort((a, b) => a.diff - b.diff || a.p.createdAt.getTime() - b.p.createdAt.getTime())
            .slice(0, winnerCount);

      return {
        answer,
        mode: exact ? 'exact' : 'closest',
        entryCount: rows.length,
        ranks: picked.map((x, i) => ({
          rank: i + 1,
          name: x.p.displayName,
          prize: String(config.prize ?? ''),
          detail: String(x.value),
          donorId: x.p.donorId,
        })),
      };
    }
    default:
      return { ranks: [] };
  }
}

/** 결과에서 당첨자 목록을 뽑아낸다. 당첨자 개념이 없는 게임은 빈 배열. */
export function winnersOf(type: string, result: Record<string, unknown>, config: Record<string, unknown>): WinnerSeed[] {
  if (type === 'ROULETTE') {
    const winner = String(result.winner ?? '');
    return winner ? [{ rank: 1, name: winner, prize: String(config.prize ?? ''), donorId: null }] : [];
  }
  if (type === 'LADDER') {
    const starts = asStringArray(result.starts);
    const order = asStringArray(result.order);
    return starts.map((name, i) => ({ rank: i + 1, name, prize: order[i] ?? '', donorId: null }));
  }
  if (type === 'VOTE' || type === 'GOAL_GAUGE') return [];

  const ranks = Array.isArray(result.ranks) ? (result.ranks as Record<string, unknown>[]) : [];
  return ranks.map((r, i) => ({
    rank: Number(r.rank) || i + 1,
    name: String(r.name ?? ''),
    prize: String(r.prize ?? ''),
    donorId: (r.donorId as string) ?? null,
  }));
}
