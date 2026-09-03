import { env } from '@/lib/env';
import type { AdapterInfo, ProviderResult } from '../types';

/**
 * 유튜브 어댑터.
 *
 * 원칙
 *  - API Key 만으로 채팅 작성 기능을 구현하지 않는다. 채팅 등록은 OAuth 2.0 권한이 필요하다.
 *  - 필요한 스코프: https://www.googleapis.com/auth/youtube.force-ssl
 *  - 할당량: 기본 일일 10,000 units. liveChatMessages.insert 는 비용이 큰 편이므로
 *    실측 후 증설 신청 전까지 큐 + 상한으로 방어한다.
 *  - 외부 결제이므로 Super Chat 으로 표시하거나 오인시키지 않는다.
 */

export interface YouTubeTokens {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresAt: Date;
}

export interface YouTubeChannel {
  channelId: string;
  title: string;
  thumbnailUrl?: string;
}

export interface YouTubeActiveBroadcast {
  broadcastId: string;
  liveChatId: string | null;
  title: string;
  lifeCycleStatus: string;
  chatEnabled: boolean;
  startedAt?: Date;
}

export interface YouTubeAdapter {
  info(): AdapterInfo;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<ProviderResult<YouTubeTokens>>;
  refresh(refreshToken: string): Promise<ProviderResult<YouTubeTokens>>;
  getChannel(accessToken: string): Promise<ProviderResult<YouTubeChannel>>;
  findActiveBroadcast(accessToken: string): Promise<ProviderResult<YouTubeActiveBroadcast | null>>;
  insertChatMessage(
    accessToken: string,
    liveChatId: string,
    text: string,
  ): Promise<ProviderResult<{ messageId: string; quotaUnits: number }>>;
  revoke(refreshToken: string): Promise<ProviderResult<{ revokedAt: Date }>>;
}

const mockState = {
  live: true,
  broadcastId: 'MOCK-BROADCAST-0001',
  liveChatId: 'MOCK-LIVECHAT-0001',
  chatEnabled: true,
  messages: [] as Array<{ id: string; text: string; at: Date }>,
  /**
   * 실패 주입 스위치.
   *
   * mock 이 항상 성공만 돌려주면 "갱신 실패 → 재연결 안내", "전송 실패 → 재시도",
   * "할당량 초과" 같은 경로를 한 번도 검증할 수 없다. 테스트와 로컬 점검에서
   * 실제 장애 모양을 재현할 수 있게 열어 둔다. (운영에서는 mock 자체가 기동 차단된다)
   */
  failures: {
    refresh: false,
    lookup: false,
    insert: false,
  },
};

export function mockYouTubeState() {
  return mockState;
}

export function setMockLive(live: boolean) {
  mockState.live = live;
}

export function setMockChatEnabled(enabled: boolean) {
  mockState.chatEnabled = enabled;
}

/** 테스트/로컬 점검용 실패 주입. 지정하지 않은 항목은 그대로 둔다. */
export function setMockYouTubeFailure(next: Partial<typeof mockState.failures>) {
  Object.assign(mockState.failures, next);
}

export function resetMockYouTube() {
  mockState.live = true;
  mockState.chatEnabled = true;
  mockState.messages = [];
  mockState.failures = { refresh: false, lookup: false, insert: false };
}

export const mockYouTubeAdapter: YouTubeAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  getAuthUrl(state) {
    return `/mock/youtube/consent?state=${encodeURIComponent(state)}`;
  },
  async exchangeCode() {
    return {
      ok: true,
      data: {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    };
  },
  async refresh() {
    if (mockState.failures.refresh) {
      return { ok: false, code: 'invalid_grant', message: '사용자가 접근 권한을 취소했습니다. (mock)' };
    }
    return {
      ok: true,
      data: {
        accessToken: `mock-access-token-${Date.now()}`,
        refreshToken: 'mock-refresh-token',
        scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    };
  },
  async getChannel() {
    return {
      ok: true,
      data: { channelId: 'UCmockchannel0001', title: '도네이도 테스트 채널' },
    };
  },
  async findActiveBroadcast() {
    if (mockState.failures.lookup) {
      return { ok: false, code: 'backendError', message: '라이브 방송 조회 실패 (mock)' };
    }
    if (!mockState.live) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        broadcastId: mockState.broadcastId,
        liveChatId: mockState.liveChatId,
        title: '테스트 라이브 방송',
        lifeCycleStatus: 'live',
        chatEnabled: mockState.chatEnabled,
        startedAt: new Date(Date.now() - 600_000),
      },
    };
  },
  async insertChatMessage(_token, _chatId, text) {
    if (mockState.failures.insert) {
      return { ok: false, code: 'backendError', message: '채팅 전송 실패 (mock)' };
    }
    // providerMessageId 의 MOCKMSG- 접두사가 "이 기록은 실제 전송이 아니다"는 표식이다.
    // 실연동으로 전환한 뒤 과거 기록을 가려낼 때 이 접두사로 구분한다.
    const id = `MOCKMSG-${Date.now()}`;
    mockState.messages.push({ id, text, at: new Date() });
    if (mockState.messages.length > 200) mockState.messages.shift();
    return { ok: true, data: { messageId: id, quotaUnits: env.youtube.insertQuotaCost } };
  },
  async revoke() {
    return { ok: true, data: { revokedAt: new Date() } };
  },
};

export function getYouTubeAdapter(): YouTubeAdapter {
  switch (env.youtube.provider) {
    case 'mock':
      return mockYouTubeAdapter;
    case 'google':
      throw new Error(
        'Google 실연동 어댑터는 OAuth 클라이언트 승인 및 동의화면 검증 완료 후 구현합니다. 현재는 mock 만 사용 가능합니다.',
      );
    default:
      throw new Error(`YOUTUBE_PROVIDER=${env.youtube.provider} 어댑터가 구현되지 않았습니다.`);
  }
}

/**
 * 유튜브 채팅 메시지 포맷.
 * - 이모지를 사용하지 않는다.
 * - Super Chat 으로 오인되지 않도록 "도네이도 후원" 을 명시한다.
 */
export function formatChatMessage(input: {
  donorName: string;
  amount: bigint;
  message: string;
  maxLength?: number;
  /** 크리에이터가 금액 표시를 끈 경우. 오버레이와 같은 규칙을 적용한다. */
  hideAmount?: boolean;
}): string {
  const amountText = input.amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const head = input.hideAmount
    ? `[도네이도 후원] ${input.donorName}: `
    : `[도네이도 후원 ${amountText}원] ${input.donorName}: `;
  const limit = input.maxLength ?? 200;
  // 길이 계산과 자르기는 **코드포인트 기준**으로 한다.
  // String#slice 는 UTF-16 코드유닛 단위라 이모지 같은 서로게이트 페어 한가운데를 자르면
  // 깨진 문자가 그대로 채팅에 올라간다.
  const headChars = [...head];
  const bodyChars = [...input.message];
  const room = Math.max(0, limit - headChars.length);
  const body =
    bodyChars.length > room
      ? `${bodyChars.slice(0, Math.max(0, room - 3)).join('')}...`
      : input.message;
  return `${head}${body}`;
}
