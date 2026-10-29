import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-29 4차 점검 P2-6 — MO 웹훅은 예상하지 못한 처리 오류에 5xx 로 응답한다.
 * (200 으로 응답하면 MTONET 이 재전송하지 않아 그 문자는 다시 처리되지 않는다)
 *
 * 후원 흐름(handleMoInbound)은 대체해 응답 코드만 본다. 재전송된 ERROR 행을 다시 처리하는
 * 중복 방지 경로는 round3-payments.test.ts(PAY-I)가 실제 흐름으로 검증한다.
 */
const handleMoInbound = vi.fn();
vi.mock('@/server/services/donation-flow', () => ({ handleMoInbound: (...a: unknown[]) => handleMoInbound(...a) }));

import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { mockMoAdapter } from '@/server/adapters/mo';
import { POST } from '@/app/api/webhooks/mo/route';
import { resetDb } from './helpers';

const emma = env.emma as { enabled: boolean };
let prevEmma = false;

beforeEach(async () => {
  await resetDb();
  prevEmma = emma.enabled;
  emma.enabled = false; // 테스트 환경은 EMMA 폴링을 켜 둔다. 웹훅 경로를 보려고 잠시 끈다.
  vi.spyOn(mockMoAdapter, 'verify').mockReturnValue({ ok: true });
  handleMoInbound.mockReset();
});

afterEach(() => {
  emma.enabled = prevEmma;
  vi.restoreAllMocks();
});

function moRequest(extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify({ messageId: 'MO-1', to: '168812341001', from: '01012345678', text: '안녕하세요' });
  return new Request('http://localhost:3025/api/webhooks/mo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body,
  });
}

describe('P2-6 MO 웹훅 응답 코드', () => {
  it('처리 중 예외 → 500 (사업자 재전송 유도), 수신 로그에도 500 으로 남는다', async () => {
    handleMoInbound.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(moRequest());
    expect(res.status).toBe(500);
    const log = await prisma.webhookLog.findFirstOrThrow({ where: { source: 'MO' } });
    expect(log.statusCode).toBe(500);
  });

  it('직전 처리 미완료(retryLater) → 503', async () => {
    handleMoInbound.mockResolvedValueOnce({ result: 'DUPLICATE', retryLater: true, message: '잠시 후' });
    const res = await POST(moRequest());
    expect(res.status).toBe(503);
  });

  it('정상·중복 처리 → 200', async () => {
    handleMoInbound.mockResolvedValueOnce({ result: 'DUPLICATE', message: '이미 처리된 문자입니다.' });
    const res = await POST(moRequest());
    expect(res.status).toBe(200);
  });

  it('payload 형식 오류 → 400 (재전송해도 결과가 같다)', async () => {
    const req = new Request('http://localhost:3025/api/webhooks/mo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: '168812341001' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(handleMoInbound).not.toHaveBeenCalled();
  });

  it('P2-5 헤더 로그에서 x-api-key·cookie 값을 가린다', async () => {
    handleMoInbound.mockResolvedValueOnce({ result: 'DUPLICATE', message: 'ok' });
    await POST(moRequest({ 'x-api-key': 'mtonet-live-api-key-123456', cookie: 'sid=secretcookie' }));
    const log = await prisma.webhookLog.findFirstOrThrow({ where: { source: 'MO' } });
    const headers = log.headersMask as Record<string, string>;
    expect(headers['x-api-key']).not.toContain('live-api-key');
    expect(headers.cookie).not.toContain('secretcookie');
  });
});
