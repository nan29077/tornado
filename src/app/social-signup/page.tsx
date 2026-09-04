import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { finishSocialSignup } from '@/app/actions/social-signup';
import { readSocialPending, SOCIAL_PENDING_COOKIE } from '@/server/services/social-login';
import { Logo } from '@/components/brand/logo';

export const dynamic = 'force-dynamic';
export const metadata = { title: '후원자 가입 | 도네이도', robots: { index: false, follow: false } };

export default async function SocialSignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const pending = readSocialPending((await cookies()).get(SOCIAL_PENDING_COOKIE)?.value);
  if (!pending) redirect('/login?error=social_error');
  const error = (await searchParams).error;
  return <main className="grid min-h-dvh place-items-center bg-warm-50 px-4 py-10"><section className="w-full max-w-md rounded-3xl border border-warm-300 bg-white p-7 shadow-card">
    <Logo compact /><h1 className="mt-6 text-2xl font-extrabold text-ink-900">후원자로 시작하기</h1>
    <p className="mt-3 text-sm leading-relaxed text-ink-600">{pending.name}님, 서비스 이용에 동의하면 나만의 캐릭터 프로필이 만들어집니다. 실제 후원에는 별도의 휴대폰 인증과 결제 등록이 필요합니다.</p>
    {error ? <p role="alert" className="mt-4 text-sm text-danger-600">{error === 'consent' ? '필수 약관에 동의해 주세요.' : '가입을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'}</p> : null}
    <form action={finishSocialSignup} className="mt-6 space-y-5">
      <div className="flex flex-wrap gap-4 text-sm font-bold text-brand-800"><Link href="/terms" target="_blank">이용약관 보기</Link><Link href="/privacy" target="_blank">개인정보 처리방침 보기</Link></div>
      <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-800"><input type="checkbox" name="agree" required className="mt-1 h-4 w-4 shrink-0" />[필수] 서비스 이용약관 및 개인정보 수집·이용에 동의합니다.</label>
      <button className="min-h-12 w-full rounded-xl bg-ink-900 px-4 text-sm font-bold text-white">동의하고 후원자 가입</button>
    </form>
  </section></main>;
}
