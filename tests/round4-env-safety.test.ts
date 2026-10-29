import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-29 4차 점검 — 환경 점검·IP 판정 회귀 테스트 (SEC-1, P2-12, P2-13).
 *
 * env 는 모듈 로드 시점에 값을 읽으므로, 환경을 바꿔 보는 테스트는 resetModules 후 다시 import 한다.
 */

const KEYS = [
  'APP_ENV',
  'NODE_ENV',
  'TORNADO_LOCAL_PREVIEW',
  'APP_BASE_URL',
  'MO_WEBHOOK_SECRET',
  'CRON_SECRET',
  'PAYMENT_PIN_CALLBACK_SECRET',
  'TRUST_CF_HEADER',
  'TRUST_REAL_IP_HEADER',
  'ALLOW_DEV_LOGIN_ON_TUNNEL',
  'EMMA_ENABLED',
] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function loadEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  setEnv(values);
  vi.resetModules();
  return import('@/lib/env');
}

afterEach(() => {
  setEnv(saved);
  vi.resetModules();
});

describe('SEC-1 APP_ENV=local 은 내 컴퓨터에서 도는 실행에서만 허용된다', () => {
  it('프로덕션 빌드 + local + 미리보기 표시 없음 → 기동 중단', async () => {
    const m = await loadEnv({ APP_ENV: 'local', NODE_ENV: 'production', TORNADO_LOCAL_PREVIEW: undefined, APP_BASE_URL: 'http://localhost:3025' });
    expect(m.localModeProblems().join('\n')).toContain('프로덕션 빌드');
    expect(() => m.assertBootSafety()).toThrow(/프로덕션 빌드/);
  });

  it('로컬 미리보기 실행기(TORNADO_LOCAL_PREVIEW=1)는 그대로 뜬다', async () => {
    const m = await loadEnv({ APP_ENV: 'local', NODE_ENV: 'production', TORNADO_LOCAL_PREVIEW: '1', APP_BASE_URL: 'http://localhost:3025' });
    expect(m.localModeProblems()).toEqual([]);
    expect(() => m.assertBootSafety()).not.toThrow();
  });

  it('개발 서버(NODE_ENV=development)도 그대로 뜬다', async () => {
    const m = await loadEnv({ APP_ENV: 'local', NODE_ENV: 'development', TORNADO_LOCAL_PREVIEW: undefined, APP_BASE_URL: 'http://127.0.0.1:3025' });
    expect(m.localModeProblems()).toEqual([]);
  });

  it('local 인데 APP_BASE_URL 이 공개 도메인이면 기동 중단', async () => {
    const m = await loadEnv({ APP_ENV: 'local', NODE_ENV: 'development', APP_BASE_URL: 'https://donaido.example.com' });
    expect(m.localModeProblems().join('\n')).toContain('공개 주소');
  });

  it('APP_ENV 를 비우면 프로덕션 빌드는 prod 로 판정된다(.env.example 기본값)', async () => {
    const m = await loadEnv({ APP_ENV: '', NODE_ENV: 'production' });
    expect(m.env.appEnv).toBe('prod');
    expect(m.isLocal).toBe(false);
  });

  it('루프백·사설망 판정', async () => {
    const m = await loadEnv({});
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '10.1.2.3', '172.16.0.1', '192.168.0.10', '::ffff:127.0.0.1', 'fd12:3456::1']) {
      expect(m.isLoopbackOrPrivateHost(h), h).toBe(true);
    }
    for (const h of ['abc.trycloudflare.com', '8.8.8.8', '172.32.0.1', '203.0.113.7', '', '2001:db8::1']) {
      expect(m.isLoopbackOrPrivateHost(h), h).toBe(false);
    }
  });
});

describe('SEC-1 개발 전용 기능은 직접 접속한 요청에만 열린다', () => {
  const req = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  it('localhost 직접 접속은 허용, 터널(cloudflared) 경유는 차단', async () => {
    const { isDirectLocalRequest, isDevFeatureAllowedFor } = await import('@/server/request-ip');
    expect(isDirectLocalRequest(req({ host: 'localhost:3025', 'x-forwarded-for': '::1' }))).toBe(true);
    expect(isDirectLocalRequest(req({ host: '192.168.0.10:3025', 'x-forwarded-for': '192.168.0.22' }))).toBe(true);
    // cloudflared 는 Host 를 localhost 로 바꿔 보내더라도 CF 헤더와 실제 공인 IP 를 붙인다.
    expect(
      isDirectLocalRequest(req({ host: 'localhost:3025', 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7' })),
    ).toBe(false);
    expect(isDirectLocalRequest(req({ host: 'localhost:3025', 'x-forwarded-for': '203.0.113.7' }))).toBe(false);
    expect(isDirectLocalRequest(req({ host: 'abc.trycloudflare.com', 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isDirectLocalRequest(req({ host: 'localhost:3025', 'x-forwarded-host': 'abc.trycloudflare.com' }))).toBe(false);
    expect(isDirectLocalRequest(req({}))).toBe(false);
    // 테스트 환경은 APP_ENV=local 이다.
    expect(isDevFeatureAllowedFor(req({ host: 'localhost:3025', 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });

  it('ALLOW_DEV_LOGIN_ON_TUNNEL=1 이면 터널 요청에도 연다(명시적 opt-in)', async () => {
    const { isDevFeatureAllowedFor } = await import('@/server/request-ip');
    const tunnel = req({ host: 'localhost:3025', 'x-forwarded-for': '203.0.113.7', 'cf-ray': 'x' });
    expect(isDevFeatureAllowedFor(tunnel)).toBe(false);
    process.env.ALLOW_DEV_LOGIN_ON_TUNNEL = '1';
    expect(isDevFeatureAllowedFor(tunnel)).toBe(true);
  });

  it('staging/prod 에서는 직접 접속이어도 열지 않는다', async () => {
    await loadEnv({ APP_ENV: 'staging', NODE_ENV: 'production', ALLOW_DEV_LOGIN_ON_TUNNEL: '1' });
    const { isDevFeatureAllowedFor } = await import('@/server/request-ip');
    expect(isDevFeatureAllowedFor(req({ host: 'localhost:3025', 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('개발 아웃박스는 터널 요청에 404 를 돌려준다', async () => {
    const { GET } = await import('@/app/api/dev/outbox/route');
    const tunnel = new Request('http://localhost:3025/api/dev/outbox', {
      headers: { host: 'localhost:3025', 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7' },
    });
    expect((await GET(tunnel)).status).toBe(404);
    const local = new Request('http://localhost:3025/api/dev/outbox', {
      headers: { host: 'localhost:3025', 'x-forwarded-for': '127.0.0.1' },
    });
    expect((await GET(local)).status).toBe(200);
  });
});

describe('P2-13 운영 공유 비밀 강도 점검', () => {
  it('dev-only·예시 값·32자 미만을 거절한다', async () => {
    const { weakSecretReason } = await loadEnv({});
    expect(weakSecretReason('dev-only-mo-webhook-secret')).toMatch(/dev-only/);
    expect(weakSecretReason('ZGV2LW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcy0hIQ==')).toMatch(/예시/);
    expect(weakSecretReason('short-secret')).toMatch(/32자/);
    expect(weakSecretReason('a'.repeat(64))).toBeNull();
  });

  it('prod 에서 MO_WEBHOOK_SECRET 이 .env.example 값이면 점검에 걸린다', async () => {
    const m = await loadEnv({
      APP_ENV: 'prod',
      EMMA_ENABLED: 'false',
      MO_WEBHOOK_SECRET: 'dev-only-mo-webhook-secret',
      CRON_SECRET: 'too-short',
      PAYMENT_PIN_CALLBACK_SECRET: 'b'.repeat(40),
    });
    const problems = m.assertProductionSafety().join('\n');
    expect(problems).toContain('MO_WEBHOOK_SECRET 가 약합니다');
    expect(problems).toContain('CRON_SECRET 가 약합니다');
    expect(problems).not.toContain('PAYMENT_PIN_CALLBACK_SECRET 가 약합니다');
  });
});

describe('P2-12 클라이언트 IP 판정과 속도 제한', () => {
  const req = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  it('XFF 가 없을 때 CF-Connecting-IP / X-Real-IP 는 플래그를 켠 경우에만 믿는다', async () => {
    const { clientIpFrom } = await import('@/server/rate-limit');
    const h = req({ 'cf-connecting-ip': '198.51.100.1', 'x-real-ip': '198.51.100.2' });
    setEnv({ TRUST_CF_HEADER: undefined, TRUST_REAL_IP_HEADER: undefined });
    expect(clientIpFrom(h)).toBeNull();
    setEnv({ TRUST_REAL_IP_HEADER: 'true' });
    expect(clientIpFrom(h)).toBe('198.51.100.2');
    setEnv({ TRUST_CF_HEADER: 'true' });
    expect(clientIpFrom(h)).toBe('198.51.100.1');
    // XFF 가 있으면 기존 규칙(신뢰 프록시 단수)을 그대로 따른다.
    expect(clientIpFrom(req({ 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '198.51.100.1' }))).toBe('203.0.113.9');
  });

  it('로컬에서는 IP 를 모르면 통과, staging 에서는 공용 noip 버킷으로 제한한다', async () => {
    const local = await import('@/server/rate-limit');
    expect((await local.consumeRateLimit('r4-noip-local', null, 1, 60)).ok).toBe(true);
    expect((await local.consumeRateLimit('r4-noip-local', null, 1, 60)).ok).toBe(true);

    await loadEnv({ APP_ENV: 'staging', NODE_ENV: 'production' });
    const staging = await import('@/server/rate-limit');
    // 공용 버킷은 개별 상한의 UNKNOWN_CLIENT_MULTIPLIER 배(2 x 20 = 40)까지 허용한다.
    const cap = 2 * staging.UNKNOWN_CLIENT_MULTIPLIER;
    for (let i = 1; i <= cap; i++) {
      const keyArg = i % 3 === 0 ? '' : i % 2 === 0 ? undefined : null;
      expect((await staging.consumeRateLimit('r4-noip', keyArg, 2, 60)).ok).toBe(true);
    }
    const over = await staging.consumeRateLimit('r4-noip', null, 2, 60);
    expect(over.ok).toBe(false);
    expect(over.count).toBe(cap + 1);
  });
});
