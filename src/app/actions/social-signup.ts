'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSession } from '@/server/auth';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { readSocialPending, registerSocialDonor, SOCIAL_PENDING_COOKIE } from '@/server/services/social-login';

export async function finishSocialSignup(data: FormData) {
  const jar = await cookies();
  const pending = readSocialPending(jar.get(SOCIAL_PENDING_COOKIE)?.value);
  if (!pending) redirect('/login?error=social_error');
  if (data.get('agree') !== 'on') redirect('/social-signup?error=consent');
  if (!(await consumeIpRateLimit('social-signup', 5, 60, { failClosed: true })).ok) redirect('/social-signup?error=retry');
  let userId: string;
  try { userId = (await registerSocialDonor(pending, true)).id; }
  catch { redirect('/social-signup?error=retry'); }
  jar.delete(SOCIAL_PENDING_COOKIE);
  await createSession(userId);
  redirect(pending.next);
}
