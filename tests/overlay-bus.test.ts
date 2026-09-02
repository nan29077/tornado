import { describe, expect, it } from 'vitest';
import { publishOverlayEvent, subscribeOverlay, type OverlayEventPayload } from '@/server/services/overlay-bus';

/**
 * 오버레이 이벤트 버스 회귀 테스트.
 *
 * 이 프로젝트에서 "오버레이 미리보기에 이벤트가 안 뜬다" 버그가 여러 번 반복됐다.
 * 실제 원인은 대부분 Redis 연동 쪽(재접속 폭주, 전파 실패 로깅 등)이었지만, 그때마다
 * 정작 "Redis 가 없는 로컬 미리보기에서도 구독자에게 즉시 전달되는가"라는 핵심 계약은
 * 테스트로 고정돼 있지 않았다. 테스트 환경은 REDIS_URL='' (tests/setup.ts) 이므로
 * 이 파일은 정확히 그 시나리오 — 로컬 미리보기와 같은 인메모리 전용 경로 — 를 검증한다.
 */

function samplePayload(overrides: Partial<OverlayEventPayload> = {}): OverlayEventPayload {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    creatorId: 'creator-x',
    donationId: null,
    donorName: '테스트 후원자',
    amount: '3000',
    message: '안녕하세요',
    sticker: 'DEFAULT',
    effect: 'DEFAULT',
    banner: true,
    tierLabel: '',
    tts: null,
    ttsMode: 'browser',
    soundEnabled: true,
    soundVolume: 80,
    durationMs: 7000,
    theme: 'TORNADO',
    position: 'BOTTOM_CENTER',
    maxMessageLen: 80,
    offsetX: 0,
    offsetY: 0,
    scalePct: 100,
    enabled: true,
    occurredAt: new Date().toISOString(),
    isTest: true,
    ...overrides,
  };
}

describe('오버레이 이벤트 버스 (Redis 없는 인메모리 경로)', () => {
  it('발행하면 같은 creatorId 구독자에게 즉시 전달된다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const received: OverlayEventPayload[] = [];
    const unsubscribe = subscribeOverlay(creatorId, (p) => received.push(p));

    try {
      const payload = samplePayload({ creatorId });
      publishOverlayEvent(payload);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(payload);
    } finally {
      unsubscribe();
    }
  });

  it('다른 creatorId 로 발행한 이벤트는 받지 않는다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const otherId = `creator-other-${Date.now()}`;
    const received: OverlayEventPayload[] = [];
    const unsubscribe = subscribeOverlay(creatorId, (p) => received.push(p));

    try {
      publishOverlayEvent(samplePayload({ creatorId: otherId }));
      expect(received).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('구독 해제 후에는 더 이상 전달되지 않는다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const received: OverlayEventPayload[] = [];
    const unsubscribe = subscribeOverlay(creatorId, (p) => received.push(p));
    unsubscribe();

    publishOverlayEvent(samplePayload({ creatorId }));
    expect(received).toHaveLength(0);
  });

  it('여러 구독자(예: PC·모바일 미리보기 틀)가 모두 같은 이벤트를 받는다', () => {
    const creatorId = `creator-${Date.now()}-${Math.random()}`;
    const a: OverlayEventPayload[] = [];
    const b: OverlayEventPayload[] = [];
    const offA = subscribeOverlay(creatorId, (p) => a.push(p));
    const offB = subscribeOverlay(creatorId, (p) => b.push(p));

    try {
      const payload = samplePayload({ creatorId });
      publishOverlayEvent(payload);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    } finally {
      offA();
      offB();
    }
  });
});
