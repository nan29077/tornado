/**
 * 방송 게임 카탈로그 (클라이언트 / 서버 공용).
 *
 * 규칙
 *  - 서버 전용 모듈(prisma, env 등)을 import 하지 않는다. 오버레이·참여 페이지도 이 파일을 읽는다.
 *  - 정답·확률처럼 시청자에게 노출되면 안 되는 값은 `SECRET_CONFIG_KEYS` 에 등록한다.
 *    공개 응답을 만들 때 서버가 이 목록을 기준으로 잘라낸다.
 *  - 금전 보상(크레딧·포인트·쿠폰)은 다루지 않는다. 보상은 크리에이터가 방송에서 직접 주는
 *    무형 보상(샤라웃 · 신청곡 · 굿즈 등)의 "이름"만 기록한다.
 */

export const GAME_TYPES = [
  'ROULETTE',
  'LADDER',
  'RANKING',
  'VOTE',
  'QUIZ',
  'KEYWORD',
  'NUMBER_GUESS',
  'GOAL_GAUGE',
] as const;

export type GameType = (typeof GAME_TYPES)[number];

export function isGameType(v: unknown): v is GameType {
  return typeof v === 'string' && (GAME_TYPES as readonly string[]).includes(v);
}

/** 회차 진행 상태 */
export const ROUND_STATUSES = ['OPEN', 'CLOSED', 'RESULT', 'ENDED'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/** 참여 방식 */
export const ENTRY_MODES = ['LINK', 'DONATION', 'BOTH'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

export const ENTRY_MODE_LABEL: Record<EntryMode, string> = {
  LINK: '링크·QR 참여',
  DONATION: '후원자 자동 참여',
  BOTH: '링크 + 후원 자동 참여',
};

export const ENTRY_MODE_HINT: Record<EntryMode, string> = {
  LINK: '시청자가 방송 화면의 QR 이나 링크로 직접 참여합니다. 후원하지 않아도 참여할 수 있습니다.',
  DONATION: '게임이 열려 있는 동안 후원한 분이 자동으로 참여자에 올라갑니다. 별도 입력이 없습니다.',
  BOTH: '링크로도 참여할 수 있고, 후원한 분은 자동으로 참여자에 올라갑니다. 무료 참여 경로가 함께 열려 있는 방식입니다.',
};

/** 게임 진행 방식 분류 */
export type GameCategory = 'item' | 'entry' | 'donation';

export interface GameTypeMeta {
  id: GameType;
  label: string;
  /** 목록에서 한 줄로 보여 주는 설명 */
  desc: string;
  /** lucide-react 아이콘 이름 (클라이언트에서 매핑) */
  icon: string;
  category: GameCategory;
  /** 크리에이터에게 보여 주는 진행 안내 */
  guide: string;
  /** 방송에서 어떻게 쓰면 좋은지 */
  tip: string;
}

export const GAME_TYPE_META: Record<GameType, GameTypeMeta> = {
  ROULETTE: {
    id: 'ROULETTE',
    label: '회오리 룰렛',
    desc: '항목을 넣고 돌려 하나를 뽑습니다',
    icon: 'Disc3',
    category: 'item',
    guide: '항목을 2개 이상 넣고 [돌리기]를 누르면 방송 화면에서 룰렛이 돌아가고 결과가 나옵니다. 시청자 참여가 필요 없어 혼자서도 바로 진행할 수 있습니다.',
    tip: '오늘의 컨텐츠 정하기, 벌칙 뽑기, 시청자 닉네임 추첨에 씁니다.',
  },
  LADDER: {
    id: 'LADDER',
    label: '사다리타기',
    desc: '출발 항목과 도착 보상을 사다리로 연결합니다',
    icon: 'Network',
    category: 'item',
    guide: '출발 항목(참여자·번호)과 도착 항목(보상)을 넣고 [돌리기]를 누르면 사다리 경로가 그려집니다. 번호를 골라 하나씩 추적할 수도 있습니다.',
    tip: '여러 명에게 각각 다른 보상을 나눌 때 좋습니다.',
  },
  RANKING: {
    id: 'RANKING',
    label: '순위 추첨',
    desc: '참여한 시청자 중 1등부터 순서대로 뽑습니다',
    icon: 'ListOrdered',
    category: 'entry',
    guide: '[참여 열기]로 시청자를 모으고 [결과 발표]를 누르면 1등부터 정해진 등수까지 순서대로 공개됩니다.',
    tip: '등수별로 보상을 다르게 걸면 끝까지 보게 됩니다.',
  },
  VOTE: {
    id: 'VOTE',
    label: '실시간 투표',
    desc: '시청자 의견을 실시간 막대로 보여 줍니다',
    icon: 'BarChart3',
    category: 'entry',
    guide: '주제와 선택지를 정하고 [참여 열기]를 누르면 방송 화면에 실시간 득표가 표시됩니다. 닉네임 없이 참여할 수 있습니다.',
    tip: '다음 곡, 다음 컨텐츠, 옷 고르기처럼 방송 흐름을 시청자와 함께 정할 때 씁니다.',
  },
  QUIZ: {
    id: 'QUIZ',
    label: '라이브 퀴즈',
    desc: '문제를 내고 정답자 중에서 뽑습니다',
    icon: 'HelpCircle',
    category: 'entry',
    guide: '문제와 선택지를 등록하고 [참여 열기] → [참여 마감] → [결과 발표] 순으로 진행합니다. 정답은 발표 전까지 방송 화면과 참여 페이지 어디에도 나가지 않습니다.',
    tip: '채널·방송 내용에 관한 문제를 내면 고정 시청자가 유리해 참여가 늘어납니다.',
  },
  KEYWORD: {
    id: 'KEYWORD',
    label: '선착순 키워드',
    desc: '정해진 단어를 먼저 친 순서대로 당첨',
    icon: 'Zap',
    category: 'entry',
    guide: '키워드를 정해 두고 방송에서 말로 알려 준 뒤 [참여 열기]를 누릅니다. 정확히 같은 단어를 먼저 입력한 순서대로 당첨자가 정해집니다.',
    tip: '가장 반응이 빠른 게임입니다. 키워드는 짧고 받아치기 쉬운 단어로 정하세요.',
  },
  NUMBER_GUESS: {
    id: 'NUMBER_GUESS',
    label: '숫자 맞히기',
    desc: '정답에 가장 가까운 시청자가 당첨',
    icon: 'Hash',
    category: 'entry',
    guide: '정답 숫자와 입력 범위를 정하고 [참여 열기]를 누릅니다. 정확히 맞힌 사람 또는 가장 가까운 사람이 당첨됩니다.',
    tip: '오늘 방송 시청자 수, 누적 후원 건수처럼 방송 중에 확인되는 숫자를 쓰면 재미가 큽니다.',
  },
  GOAL_GAUGE: {
    id: 'GOAL_GAUGE',
    label: '후원 목표 게이지',
    desc: '누적 후원액이 목표에 닿으면 공약 달성',
    icon: 'Target',
    category: 'donation',
    guide: '[시작]을 누른 뒤 들어온 후원 금액이 실시간으로 게이지에 쌓입니다. 시청자가 따로 참여할 것은 없습니다.',
    tip: '목표 금액과 공약(노래 한 곡, 게임 한 판 등)을 같이 적어 두면 목표 달성이 빨라집니다.',
  },
};

/** 게임 종류별 분류 */
export const ITEM_GAMES: GameType[] = ['ROULETTE', 'LADDER'];
export const ENTRY_GAMES: GameType[] = ['RANKING', 'VOTE', 'QUIZ', 'KEYWORD', 'NUMBER_GUESS'];
export const DONATION_GAMES: GameType[] = ['GOAL_GAUGE'];

export function usesItems(type: string): boolean {
  return (ITEM_GAMES as string[]).includes(type);
}
/** 시청자가 직접 참여하는 게임인가 */
export function usesEntries(type: string): boolean {
  return (ENTRY_GAMES as string[]).includes(type);
}
/** 후원 집계로 진행되는 게임인가 */
export function usesDonationTotal(type: string): boolean {
  return (DONATION_GAMES as string[]).includes(type);
}
/** 선택지를 고르는 게임인가 (실시간 집계 막대 표시) */
export function usesChoices(type: string): boolean {
  return type === 'VOTE' || type === 'QUIZ';
}
/** 참여자가 값을 직접 입력하는 게임인가 */
export function usesFreeEntry(type: string): boolean {
  return type === 'KEYWORD' || type === 'NUMBER_GUESS';
}
/** 참여할 때 닉네임이 필요한 게임인가 (투표는 익명) */
export function needsNickname(type: string): boolean {
  return usesEntries(type) && type !== 'VOTE';
}

/**
 * 시청자에게 절대 내려보내면 안 되는 config 키.
 * 공개 응답(오버레이 · 참여 페이지)을 만들 때 서버가 이 목록으로 잘라낸다.
 */
export const SECRET_CONFIG_KEYS: Record<string, string[]> = {
  QUIZ: ['answerIndex'],
  KEYWORD: ['keyword'],
  NUMBER_GUESS: ['answer'],
};

/** 타입별 config 기본값 */
export function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'LADDER':
      return { destinations: ['', ''] };
    case 'RANKING':
      return { rankCount: 3, prizes: ['', '', ''] };
    case 'VOTE':
      return { topic: '', choices: ['', ''] };
    case 'QUIZ':
      return { question: '', choices: ['', ''], answerIndex: 0, prize: '' };
    case 'KEYWORD':
      return { keyword: '', winnerCount: 1, prize: '' };
    case 'NUMBER_GUESS':
      return { answer: 50, min: 1, max: 100, mode: 'closest', winnerCount: 1, prize: '' };
    case 'GOAL_GAUGE':
      return { target: 100000, reward: '' };
    default:
      return { prize: '' };
  }
}

export const MAX_TITLE_LEN = 40;
export const MAX_ITEM_LEN = 24;
export const MAX_ITEMS = 24;
export const MAX_CHOICES = 6;
export const MAX_NICKNAME_LEN = 16;
export const MAX_KEYWORD_LEN = 20;
export const MAX_PRIZE_LEN = 30;

function cleanList(v: unknown, max = MAX_ITEMS): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? '').trim().slice(0, MAX_ITEM_LEN))
    .filter(Boolean)
    .slice(0, max);
}

/**
 * 생성 · 수정 공용 검증.
 * 통과하면 null, 실패하면 사람이 읽는 한국어 사유를 돌려준다.
 */
export function validateGameInput(
  type: string,
  title: string,
  items: string[],
  config: Record<string, unknown>,
): string | null {
  if (!isGameType(type)) return '알 수 없는 게임 종류입니다.';
  const name = title.trim();
  if (!name) return '게임 이름을 입력해 주세요.';
  if (name.length > MAX_TITLE_LEN) return `게임 이름은 ${MAX_TITLE_LEN}자 이내로 입력해 주세요.`;

  if (usesItems(type)) {
    if (cleanList(items).length < 2) return '항목을 2개 이상 입력해 주세요.';
  }
  if (type === 'LADDER') {
    const dest = cleanList(config.destinations);
    if (dest.length < 2) return '도착 항목(보상)을 2개 이상 입력해 주세요.';
  }
  if (type === 'VOTE') {
    if (!String(config.topic ?? '').trim()) return '투표 주제를 입력해 주세요.';
    if (cleanList(config.choices, MAX_CHOICES).length < 2) return '선택지를 2개 이상 입력해 주세요.';
  }
  if (type === 'QUIZ') {
    if (!String(config.question ?? '').trim()) return '문제를 입력해 주세요.';
    const choices = cleanList(config.choices, MAX_CHOICES);
    if (choices.length < 2) return '선택지를 2개 이상 입력해 주세요.';
    const idx = Number(config.answerIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) return '정답 선택지를 골라 주세요.';
  }
  if (type === 'KEYWORD') {
    const kw = String(config.keyword ?? '').trim();
    if (!kw) return '키워드를 입력해 주세요.';
    if (kw.length > MAX_KEYWORD_LEN) return `키워드는 ${MAX_KEYWORD_LEN}자 이내로 입력해 주세요.`;
  }
  if (type === 'NUMBER_GUESS') {
    const min = Number(config.min);
    const max = Number(config.max);
    const answer = Number(config.answer);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return '숫자 범위를 올바르게 입력해 주세요.';
    if (max - min > 1_000_000) return '숫자 범위가 너무 넓습니다. 100만 이내로 좁혀 주세요.';
    if (!Number.isFinite(answer) || answer < min || answer > max) return '정답은 입력 범위 안의 숫자여야 합니다.';
  }
  if (type === 'RANKING') {
    const n = Number(config.rankCount);
    if (!Number.isInteger(n) || n < 1 || n > 10) return '뽑을 인원은 1명에서 10명 사이로 정해 주세요.';
  }
  if (type === 'GOAL_GAUGE') {
    const target = Number(config.target);
    if (!Number.isFinite(target) || target < 1000) return '목표 금액은 1,000원 이상으로 정해 주세요.';
    if (target > 100_000_000) return '목표 금액이 너무 큽니다.';
  }
  return null;
}

/** 저장 전에 config 를 타입별로 정규화한다. 모르는 키는 버린다. */
export function normalizeConfig(type: string, input: Record<string, unknown>): Record<string, unknown> {
  const prize = String(input.prize ?? '').trim().slice(0, MAX_PRIZE_LEN);
  switch (type) {
    case 'ROULETTE':
      return { prize };
    case 'LADDER':
      return { destinations: cleanList(input.destinations) };
    case 'RANKING': {
      const rankCount = Math.min(10, Math.max(1, Number(input.rankCount) || 1));
      const prizes = Array.isArray(input.prizes)
        ? input.prizes.map((p) => String(p ?? '').trim().slice(0, MAX_PRIZE_LEN)).slice(0, rankCount)
        : [];
      while (prizes.length < rankCount) prizes.push('');
      return { rankCount, prizes };
    }
    case 'VOTE':
      return {
        topic: String(input.topic ?? '').trim().slice(0, MAX_TITLE_LEN),
        choices: cleanList(input.choices, MAX_CHOICES),
      };
    case 'QUIZ':
      return {
        question: String(input.question ?? '').trim().slice(0, 80),
        choices: cleanList(input.choices, MAX_CHOICES),
        answerIndex: Math.max(0, Number(input.answerIndex) || 0),
        prize,
      };
    case 'KEYWORD':
      return {
        keyword: String(input.keyword ?? '').trim().slice(0, MAX_KEYWORD_LEN),
        winnerCount: Math.min(20, Math.max(1, Number(input.winnerCount) || 1)),
        prize,
      };
    case 'NUMBER_GUESS':
      return {
        answer: Math.round(Number(input.answer) || 0),
        min: Math.round(Number(input.min) || 0),
        max: Math.round(Number(input.max) || 0),
        mode: input.mode === 'exact' ? 'exact' : 'closest',
        winnerCount: Math.min(20, Math.max(1, Number(input.winnerCount) || 1)),
        prize,
      };
    case 'GOAL_GAUGE':
      return {
        target: Math.round(Number(input.target) || 0),
        reward: String(input.reward ?? '').trim().slice(0, 60),
      };
    default:
      return {};
  }
}

/**
 * 키워드 정규화 — **저장 · 집계 · 판정 · 발표가 반드시 이 함수 하나를 쓴다.**
 *
 * 예전에는 저장 시에만 공백을 지우고(`replace(/\s+/g,'')`) 집계·발표는 공백을 남겨서,
 * 크리에이터가 키워드를 "해피 뉴이어" 처럼 띄어쓰기와 함께 저장하면
 *  - 참여자에게는 "정답" 으로 보이는데
 *  - 방송 화면의 정답자 수는 계속 0이고
 *  - [결과 발표]를 눌러도 **당첨자 없이** 발표되는
 * 사고가 났다. 규칙을 한 곳에만 둔다.
 */
export function normalizeKeyword(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, '').slice(0, MAX_KEYWORD_LEN);
}

/** 상태 라벨 (스튜디오 · 오버레이 공용) */
export const ROUND_STATUS_LABEL: Record<RoundStatus, string> = {
  OPEN: '진행 중',
  CLOSED: '마감 · 발표 대기',
  RESULT: '결과 발표됨',
  ENDED: '종료',
};
