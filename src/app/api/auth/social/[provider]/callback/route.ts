import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { authReturnPath } from '@/lib/auth-return-path';
import { createSession } from '@/server/auth';
import { SOCIAL_PROVIDERS, getSocialAdapter, type SocialProvider } from '@/server/adapters/social';
import { findSocialDonor, validSocialState, socialPendingCookie, SOCIAL_PENDING_COOKIE } from '@/server/services/social-login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  if (!SOCIAL_PROVIDERS.includes(raw as SocialProvider)) return NextResponse.redirect(new URL('/login?error=social_unknown', req.url), 303);
  const provider = raw as SocialProvider;
  const jar = await cookies();
  const expected = jar.get(`tornado_social_state_${provider}`)?.value;
  const next = authReturnPath(jar.get(`tornado_social_next_${provider}`)?.value);
  jar.delete(`tornado_social_state_${provider}`);
  jar.delete(`tornado_social_next_${provider}`);
  jar.delete(SOCIAL_PENDING_COOKIE);
  const params = new URL(req.url).searchParams;
  const creator = /^\/c\/(TOR-[A-Z0-9]{2,10})(?:\/|$)/.exec(next);
  const back = creator ? `/c/${creator[1]}/login` : '/login';
  const fail = () => NextResponse.redirect(new URL(`${back}?error=social_error&next=${encodeURIComponent(next)}`, req.url), 303);
  const code = params.get('code');
  if (!validSocialState(expected, params.get('state')) || !code || code.length > 2048 || params.has('error')) return fail();
  try {
    const adapter = getSocialAdapter(provider);
    const profile = await adapter.getProfile(await adapter.exchangeCode(code, expected!));
    const user = await findSocialDonor(profile);
    if (user) {
      await createSession(user.id);
      return NextResponse.redirect(new URL(next, req.url), 303);
    }
    jar.set(SOCIAL_PENDING_COOKIE, socialPendingCookie(profile, next), { httpOnly: true, sameSite: 'lax', secure: env.baseUrl.startsWith('https'), path: '/', maxAge: 600 });
    return NextResponse.redirect(new URL('/social-signup', req.url), 303);
  } catch { return fail(); }
}
