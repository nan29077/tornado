import { env } from '@/lib/env';
import type { AdapterInfo } from '../types';

/**
 * 소셜 간편 로그인 어댑터 (카카오 / 네이버).
 *
 * 공식 OAuth 인가 코드 흐름. 키가 없으면 준비 중을 표시한다.
 * 토큰은 서버 메모리에서 프로필 조회에만 사용하며 저장·로그 출력하지 않는다.
 *
 * 실연동 시 필요한 것
 *  - 카카오: 카카오 디벨로퍼스 앱 생성, REST API 키, Redirect URI 등록, 동의항목 설정
 *  - 네이버: 네이버 개발자센터 앱 등록, Client ID/Secret, Callback URL 등록
 */

export type SocialProvider = 'kakao' | 'naver';

export const SOCIAL_PROVIDERS: SocialProvider[] = ['kakao', 'naver'];

export const SOCIAL_LABEL: Record<SocialProvider, string> = {
  kakao: '카카오',
  naver: '네이버',
};

export interface SocialProfile {
  provider: SocialProvider;
  /** 사업자 측 고유 사용자 식별자 */
  providerUserId: string;
  email?: string;
  name?: string;
}

export interface SocialTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface SocialAuthAdapter {
  info(): AdapterInfo;
  /** 동의 화면으로 보낼 URL */
  getAuthorizeUrl(state: string): string;
  /** 콜백 code -> 토큰 */
  exchangeCode(code: string, state: string): Promise<SocialTokens>;
  /** 토큰 -> 프로필 */
  getProfile(tokens: SocialTokens): Promise<SocialProfile>;
}

export interface SocialProviderStatus {
  provider: SocialProvider;
  label: string;
  /** 실제 연동 키가 모두 설정되어 사용 가능한 상태인지 */
  ready: boolean;
  /** 아직 없는 설정값 */
  missing: string[];
}

function configOf(provider: SocialProvider) {
  return provider === 'kakao' ? env.social.kakao : env.social.naver;
}

export function socialProviderStatus(provider: SocialProvider): SocialProviderStatus {
  const cfg = configOf(provider);
  const missing: string[] = [];
  if (!cfg.clientId) missing.push(provider === 'kakao' ? 'KAKAO_CLIENT_ID' : 'NAVER_CLIENT_ID');
  if (!cfg.clientSecret && provider === 'naver') missing.push('NAVER_CLIENT_SECRET');
  if (!cfg.redirectUri) missing.push(provider === 'kakao' ? 'KAKAO_REDIRECT_URI' : 'NAVER_REDIRECT_URI');

  return {
    provider,
    label: SOCIAL_LABEL[provider],
    ready: missing.length === 0,
    missing,
  };
}

export function allSocialProviderStatus(): SocialProviderStatus[] {
  return SOCIAL_PROVIDERS.map(socialProviderStatus);
}

export class SocialNotConfiguredError extends Error {
  constructor(public provider: SocialProvider, public missing: string[]) {
    super(`${SOCIAL_LABEL[provider]} 간편 로그인이 아직 연동되지 않았습니다.`);
    this.name = 'SocialNotConfiguredError';
  }
}

/**
 * 키가 없는 상태에서는 예외를 던져 임의로 로그인시키지 않는다.
 */
export function getSocialAdapter(provider: SocialProvider): SocialAuthAdapter {
  const status = socialProviderStatus(provider);
  if (!status.ready) {
    throw new SocialNotConfiguredError(provider, status.missing);
  }
  const cfg = configOf(provider);
  return {
    info: () => ({ provider, mode: 'live', missingCredentials: [] }),
    getAuthorizeUrl(state) {
      const url = new URL(provider === 'kakao' ? 'https://kauth.kakao.com/oauth/authorize' : 'https://nid.naver.com/oauth2.0/authorize');
      url.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, state }).toString();
      return url.toString();
    },
    async exchangeCode(code, state) {
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, code, state });
      if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
      const data = await socialJson(provider === 'kakao' ? 'https://kauth.kakao.com/oauth/token' : 'https://nid.naver.com/oauth2.0/token', { method: 'POST', body });
      if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('소셜 인증 토큰이 없습니다.');
      return { accessToken: data.access_token };
    },
    async getProfile(tokens) {
      const data = await socialJson(provider === 'kakao' ? 'https://kapi.kakao.com/v2/user/me' : 'https://openapi.naver.com/v1/nid/me', { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
      const profile = provider === 'naver' ? asRecord(data.response) : data;
      if (provider === 'naver' && data.resultcode !== '00') throw new Error('소셜 프로필 조회가 거절되었습니다.');
      const id = profile.id;
      if (!(typeof id === 'string' && id.length > 0 && id.length <= 200) && !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) throw new Error('소셜 사용자 식별자가 올바르지 않습니다.');
      const rawName = provider === 'kakao' ? asRecord(asRecord(data.kakao_account).profile).nickname : profile.nickname;
      return { provider, providerUserId: String(id), name: typeof rawName === 'string' ? rawName.slice(0, 40) : '후원자' };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function socialJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('소셜 인증 서버가 요청을 처리하지 못했습니다.');
  const data = asRecord(await response.json());
  if (data.error) throw new Error('소셜 인증이 거절되었습니다.');
  return data;
}
