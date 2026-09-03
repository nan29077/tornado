import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ jar: new Map<string, string>(), createSession: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (key: string) => mocks.jar.has(key) ? { value: mocks.jar.get(key)! } : undefined, set: (key: string, value: string) => mocks.jar.set(key, value), delete: (key: string) => mocks.jar.delete(key) }),
}));
vi.mock('@/server/auth', () => ({ createSession: mocks.createSession }));
import { GET } from '@/app/api/auth/social/[provider]/callback/route';
import { resetDb, seedBasics } from './helpers';
import { registerSocialDonor, readSocialPending, SOCIAL_PENDING_COOKIE } from '@/server/services/social-login';
import { env } from '@/lib/env';

const original = { ...env.social.kakao };
beforeEach(async () => {
  await resetDb();
  mocks.jar.clear();
  mocks.createSession.mockReset();
  Object.assign(env.social.kakao, { clientId: 'test', clientSecret: 'test', redirectUri: 'http://localhost:3025/api/auth/social/kakao/callback' });
});
afterEach(() => { vi.unstubAllGlobals(); Object.assign(env.social.kakao, original); });
const call = (query: string) => GET(new Request('http://localhost:3025/api/auth/social/kakao/callback?' + query), { params: Promise.resolve({ provider: 'kakao' }) });
function start() {
  mocks.jar.set('tornado_social_state_kakao', 'test-state');
  mocks.jar.set('tornado_social_next_kakao', '/c/TOR-8K2M/messages');
}
function providerReplies() {
  return vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'PRIVATE_TEST_TOKEN' })).mockResolvedValueOnce(Response.json({ id: 654321, kakao_account: { profile: { nickname: '응원후원자' } } }));
}
it('OAuth 콜백은 state 불일치 시 토큰 요청·로그인 없이 쿠키를 폐기한다', async () => {
  start();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const result = await call('state=attacker&code=test');
  expect(result.headers.get('location')).toContain('social_error');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.createSession).not.toHaveBeenCalled();
  expect(mocks.jar.has('tornado_social_state_kakao')).toBe(false);
});
it('기존 후원자는 세션을 생성하고 자신의 후원 내역으로 돌아간다', async () => {
  await seedBasics();
  const user = await registerSocialDonor({ provider: 'kakao', providerUserId: '654321', name: '응원후원자' }, true);
  start();
  vi.stubGlobal('fetch', providerReplies());
  const result = await call('state=test-state&code=test');
  expect(result.headers.get('location')).toBe('http://localhost:3025/c/TOR-8K2M/messages');
  expect(mocks.createSession).toHaveBeenCalledWith(user.id);
  expect(mocks.jar.has('tornado_social_state_kakao')).toBe(false);
  expect(mocks.jar.has(SOCIAL_PENDING_COOKIE)).toBe(false);
});
it('처음 온 소셜 사용자는 로그인하지 않고 약관 동의로 안내한다', async () => {
  start();
  vi.stubGlobal('fetch', providerReplies());
  const result = await call('state=test-state&code=test');
  expect(result.headers.get('location')).toBe('http://localhost:3025/social-signup');
  expect(mocks.createSession).not.toHaveBeenCalled();
  expect(readSocialPending(mocks.jar.get(SOCIAL_PENDING_COOKIE))?.next).toBe('/c/TOR-8K2M/messages');
  expect(mocks.jar.get(SOCIAL_PENDING_COOKIE)).not.toContain('PRIVATE_TEST_TOKEN');
});

