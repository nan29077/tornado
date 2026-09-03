import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { generateToken } from '@/lib/crypto';
import { authReturnPath } from '@/lib/auth-return-path';
import { SOCIAL_PROVIDERS, socialProviderStatus, getSocialAdapter, type SocialProvider } from '@/server/adapters/social';
import { consumeRateLimit, clientIpFromRequest } from '@/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const next = authReturnPath(new URL(req.url).searchParams.get('next'));
  const creator = /^\/c\/(TOR-[A-Z0-9]{2,10})(?:\/|$)/.exec(next);
  const back = creator ? `/c/${creator[1]}/login` : '/login';
  const error = (code: string) => NextResponse.redirect(new URL(`${back}?error=${code}&next=${encodeURIComponent(next)}`, req.url), 303);
  if (!SOCIAL_PROVIDERS.includes(raw as SocialProvider)) return error('social_unknown');
  const provider = raw as SocialProvider;
  if (!socialProviderStatus(provider).ready) return error('social_not_ready');
  if (!(await consumeRateLimit('social-start', clientIpFromRequest(req), 20, 60, { failClosed: true })).ok) return error('ratelimit');
  try {
    const state = generateToken(32);
    const res = NextResponse.redirect(getSocialAdapter(provider).getAuthorizeUrl(state), 303);
    const options = { httpOnly: true, sameSite: 'lax' as const, secure: env.baseUrl.startsWith('https'), path: '/', maxAge: 600 };
    res.cookies.set(`tornado_social_state_${provider}`, state, options);
    res.cookies.set(`tornado_social_next_${provider}`, next, options);
    return res;
  } catch { return error('social_error'); }
}
