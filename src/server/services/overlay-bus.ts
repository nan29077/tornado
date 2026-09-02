import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * 오버레이 실시간 이벤트 버스 (SSE 백엔드).
 *
 * - 단일 인스턴스: 인메모리 EventEmitter
 * - 다중 인스턴스(AWS ECS/EKS 등): Redis Pub/Sub 로 브로드캐스트
 *
 * 결제 성공 이벤트만 이 버스에 올린다. 결제 실패 건은 절대 올리지 않는다.
 */

/**
 * 표시 설정은 페이로드에 함께 실어 보낸다.
 * OBS 브라우저 소스와 스튜디오 미리보기는 한 번 열면 방송이 끝날 때까지 그대로 떠 있으므로,
 * 페이지를 열 때 읽은 값만 쓰면 테마·위치를 바꿔 저장해도 새로 고침하기 전까지 반영되지 않는다.
 * 이벤트마다 현재 설정을 실어 보내면 브라우저 소스를 다시 로드하지 않아도 즉시 적용된다.
 */
export interface OverlayEventPayload {
  eventId: string;
  creatorId: string;
  donationId: string | null;
  donorName: string;
  amount: string;
  message: string;
  sticker: string;
  /// 금액 구간에서 고른 파티클 효과 (NONE | HEART | STAR | FIREWORK | CONFETTI | COIN)
  effect: string;
  /// 후원자명 + 메시지 배너를 띄울지 여부
  banner: boolean;
  /// 적용된 금액 구간 이름. 구간을 쓰지 않으면 빈 문자열.
  tierLabel: string;
  tts: {
    enabled: boolean;
    text: string;
    voice: string;
    speed: number;
    pitch: number;
    volume: number;
  } | null;
  /// 음성 합성 위치. browser = 오버레이 브라우저(Web Speech API), server = 서버 합성 mp3
  ttsMode: 'browser' | 'server';
  /// 효과음 재생 여부와 음량(0~100). 오버레이가 Web Audio 로 직접 합성한다.
  soundEnabled: boolean;
  soundVolume: number;
  durationMs: number;
  /// 알림 배너 테마 (TORNADO | MINIMAL | NEON)
  theme: string;
  /// 알림 배너 표시 위치 (TOP_LEFT ... BOTTOM_RIGHT)
  position: string;
  /// 메시지 최대 표시 글자 수
  maxMessageLen: number;
  /// 배치 미세 조정(캔버스 대비 백분율 이동 + 크기 배율 %). 이벤트마다 실어 보내므로
  /// 스튜디오에서 저장하면 브라우저 소스를 다시 로드하지 않아도 다음 알림부터 적용된다.
  offsetX: number;
  offsetY: number;
  scalePct: number;
  /// 오버레이 표시 스위치. false 면 방송 화면(브라우저 소스)에서는 재생하지 않는다.
  enabled: boolean;
  occurredAt: string;
  isTest: boolean;
}

const CHANNEL = 'tornado:overlay';

const globalForBus = globalThis as unknown as {
  overlayEmitter?: EventEmitter;
  overlayPub?: Redis;
  overlaySub?: Redis;
  overlayRecentLocalEventIds?: Set<string>;
  overlayTtsGrants?: Map<string, OverlayTtsGrant>;
};

/**
 * 서버 TTS 합성 허가.
 *
 * 오버레이가 서버 합성 mp3 를 받아 갈 때, 예전에는 읽을 문장을 쿼리로 직접 보냈다.
 * 그러면 오버레이 토큰(OBS 브라우저 소스 URL 에 늘 노출되는 값)을 아는 사람이
 * 아무 문장이나 무제한으로 유료 합성시킬 수 있고, 후원 메시지에 적용한 금칙어도
 * 이 경로에서는 아무 의미가 없었다.
 *
 * 그래서 "무엇을 읽어도 되는지" 를 서버가 정한다.
 * 실제로 발행된 이벤트의 문장만 기억해 두고, 합성 요청은 eventId 로만 받는다.
 */
export interface OverlayTtsGrant {
  creatorId: string;
  text: string;
  voice: string;
  speed: number;
  pitch: number;
  volume: number;
  expiresAt: number;
}

/** 이벤트가 화면에 뜨고 재생될 때까지 필요한 시간. 넉넉히 잡아도 5분이면 충분하다. */
const TTS_GRANT_TTL_MS = 5 * 60 * 1000;
const TTS_GRANT_MAX = 500;

const ttsGrants = globalForBus.overlayTtsGrants ?? new Map<string, OverlayTtsGrant>();
globalForBus.overlayTtsGrants = ttsGrants;

/**
 * 발행된 이벤트의 TTS 문장을 기억한다.
 * 발행한 인스턴스와 Redis 로 이벤트를 넘겨받은 인스턴스 양쪽에서 부른다.
 * 어느 인스턴스로 합성 요청이 들어와도 답할 수 있어야 하기 때문이다.
 */
function rememberTtsGrant(payload: OverlayEventPayload) {
  const tts = payload.tts;
  if (!tts?.enabled || !tts.text) return;

  const now = Date.now();
  for (const [id, grant] of ttsGrants) {
    if (grant.expiresAt <= now) ttsGrants.delete(id);
  }
  while (ttsGrants.size >= TTS_GRANT_MAX) {
    const oldest = ttsGrants.keys().next().value;
    if (!oldest) break;
    ttsGrants.delete(oldest);
  }

  ttsGrants.set(payload.eventId, {
    creatorId: payload.creatorId,
    text: tts.text,
    voice: tts.voice,
    speed: tts.speed,
    pitch: tts.pitch,
    volume: tts.volume,
    expiresAt: now + TTS_GRANT_TTL_MS,
  });
}

/**
 * 합성해도 되는 문장을 돌려준다. 모르는 이벤트거나 만료됐으면 null.
 * 재생 재시도를 위해 한 번 쓰고 지우지는 않는다 (TTL 과 호출 빈도 제한으로 충분하다).
 */
export function findOverlayTtsGrant(eventId: string, creatorId: string): OverlayTtsGrant | null {
  const grant = ttsGrants.get(eventId);
  if (!grant) return null;
  if (grant.creatorId !== creatorId) return null;
  if (grant.expiresAt <= Date.now()) {
    ttsGrants.delete(eventId);
    return null;
  }
  return grant;
}

const emitter =
  globalForBus.overlayEmitter ??
  (() => {
    const e = new EventEmitter();
    e.setMaxListeners(0);
    return e;
  })();
globalForBus.overlayEmitter = emitter;

/**
 * 이 프로세스가 직접 발행한 이벤트 ID 기록.
 * Redis Pub/Sub 로 자기 자신에게 되돌아온 메시지를 중복 재생하지 않기 위해 사용한다.
 * Redis 구독 핸들러는 최초 모듈 인스턴스의 클로저에 남으므로, 개발 서버(HMR)에서 모듈이
 * 다시 로드돼도 같은 집합을 보도록 globalThis 에 보관한다.
 */
const recentLocalEventIds = globalForBus.overlayRecentLocalEventIds ?? new Set<string>();
globalForBus.overlayRecentLocalEventIds = recentLocalEventIds;
const RECENT_LOCAL_MAX = 1000;

function ensureRedis() {
  if (!env.redisUrl) return;
  if (globalForBus.overlayPub && globalForBus.overlaySub) return;
  try {
    // redis.ts 와 동일한 안전 설정:
    //  - enableOfflineQueue: false  → 연결 끊김 중 쌓인 명령을 flush 할 때 EPIPE 가 프로세스 예외로 터지는 것을 방지
    //  - retryStrategy 5회 제한     → 무한 재접속 루프 차단 (Redis 미실행 환경에서 수천 번 재시도하며 EPIPE 생성)
    const retryStrategy = (times: number) => (times > 5 ? null : Math.min(times * 300, 2000));
    const pub = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy });
    const sub = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy });
    pub.on('error', (e: Error) => logger.warn('overlay pub error', { message: e.message }));
    sub.on('error', (e: Error) => logger.warn('overlay sub error', { message: e.message }));
    sub.subscribe(CHANNEL).catch((e: Error) => logger.warn('overlay subscribe 실패', { message: e.message }));
    sub.on('message', (_ch: string, raw: string) => {
      try {
        const payload = JSON.parse(raw) as OverlayEventPayload;
        // 이 프로세스에서 이미 로컬로 전달한 이벤트가 Redis 를 거쳐 되돌아온 경우 중복 재생을 막는다.
        if (recentLocalEventIds.has(payload.eventId)) return;
        // 이 인스턴스로 합성 요청이 들어올 수 있으므로 재생 여부와 무관하게 문장은 기억해 둔다.
        rememberTtsGrant(payload);
        emitter.emit(payload.creatorId, payload);
      } catch {
        /* ignore */
      }
    });
    globalForBus.overlayPub = pub;
    globalForBus.overlaySub = sub;
  } catch (e) {
    logger.warn('Overlay Redis 연결 실패. 인메모리 버스만 사용합니다.', { message: (e as Error).message });
  }
}

ensureRedis();


export function publishOverlayEvent(payload: OverlayEventPayload) {
  // 항상 로컬 구독자(같은 프로세스의 SSE 연결)에게 즉시 전달한다.
  // 기존에는 REDIS_URL 이 설정돼 있으면 Redis 로만 발행했는데, Redis 서버가 내려가 있으면
  // publish 실패가 조용히 무시되어 오버레이가 아무 이벤트도 받지 못했다.
  // 로컬 전달을 기본으로 하고, Redis 는 다중 인스턴스 브로드캐스트 용도로만 추가 발행한다.
  recentLocalEventIds.add(payload.eventId);
  if (recentLocalEventIds.size > RECENT_LOCAL_MAX) {
    const oldest = recentLocalEventIds.values().next().value;
    if (oldest) recentLocalEventIds.delete(oldest);
  }
  rememberTtsGrant(payload);
  emitter.emit(payload.creatorId, payload);

  // 다른 인스턴스로의 전파 실패는 조용히 넘기면 안 된다.
  // OBS 쪽 SSE 연결은 끊기지 않고 살아 있으므로 재연결도, 누락분 재전송도 일어나지 않는다.
  // 그러면 그 후원 알림은 그 화면에 영영 뜨지 않는데 결제·정산은 정상이라 아무도 눈치채지 못한다.
  // 최소한 흔적은 남겨서 사후에 추적할 수 있게 한다.
  //
  // 다만 심각도는 나눈다.
  // Redis 가 아예 연결되지 않은 상태(로컬 개발처럼 Redis 를 안 띄운 경우)는
  // 이미 'redis error' 로 따로 찍히고 있고, 단일 인스턴스에서는 인메모리 전달만으로 충분하다.
  // 이 경우까지 error 로 남기면 후원 한 건마다 빨간 줄이 쌓여 진짜 오류가 묻힌다.
  // 연결은 살아 있는데 발행만 실패한 경우가 진짜 위험한 상황이다.
  globalForBus.overlayPub?.publish(CHANNEL, JSON.stringify(payload)).catch((e: Error) => {
    const connected = globalForBus.overlayPub?.status === 'ready';
    const log = connected ? logger.error : logger.warn;
    log('오버레이 이벤트 Redis 전파 실패. 다른 인스턴스의 오버레이는 이 알림을 받지 못한다.', {
      eventId: payload.eventId,
      creatorId: payload.creatorId,
      donationId: payload.donationId,
      redisStatus: globalForBus.overlayPub?.status ?? 'none',
      message: e.message,
    });
  });
}

export function subscribeOverlay(creatorId: string, handler: (p: OverlayEventPayload) => void): () => void {
  emitter.on(creatorId, handler);
  return () => emitter.off(creatorId, handler);
}
