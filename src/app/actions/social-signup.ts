'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSession } from '@/server/auth';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { readSocialPending, registerSocialDonor, SOCIAL_PENDING_COOKIE } from '@/server/services/social-login';
import { attributeFanByCreatorCode } from '@/server/services/creator-fans';

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

  // 크리에이터 후원 페이지에서 시작한 가입이면 그 크리에이터의 팬으로 귀속한다.
  const fromCreator = /^\/c\/(TOR-[A-Z0-9]{2,10})(?:\/|$)/.exec(pending.next);
  if (fromCreator) await attributeFanByCreatorCode(userId, fromCreator[1]);

  redirect(pending.next);
}
