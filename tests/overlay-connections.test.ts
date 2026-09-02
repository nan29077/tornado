import { describe, expect, it } from 'vitest';
import {
  countOverlayConnections,
  registerOverlayConnection,
} from '@/server/services/overlay-connections';

describe('오버레이 연결 상태 분리', () => {
  it('후원과 게임 방송 연결을 각각 세고 전체 수도 유지한다', () => {
    const creatorId = `connection-${Date.now()}`;
    const offDonation = registerOverlayConnection(creatorId, () => undefined, 'broadcast', 'donation');
    const offGame = registerOverlayConnection(creatorId, () => undefined, 'broadcast', 'game');
    const offPreview = registerOverlayConnection(creatorId, () => undefined, 'preview', 'game');

    expect(countOverlayConnections(creatorId, 'broadcast')).toBe(2);
    expect(countOverlayConnections(creatorId, 'broadcast', 'donation')).toBe(1);
    expect(countOverlayConnections(creatorId, 'broadcast', 'game')).toBe(1);
    expect(countOverlayConnections(creatorId, 'preview', 'game')).toBe(1);

    offDonation();
    offGame();
    offPreview();
    expect(countOverlayConnections(creatorId, 'broadcast')).toBe(0);
  });
});
