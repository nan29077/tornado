import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UserPlus } from '@/components/brand/icons';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { SocialAuthButtons } from '@/components/public/social-auth';
import { SignupForm } from '@/components/public/signup-form';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { authReturnPath } from '@/lib/auth-return-path';
import { getSessionUser } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: '회원가입 | 도네이도 샵', robots: { index: false, follow: false } };

/**
 * 도네이도 샵 안의 회원가입 (2026-11-17).
 * 메인 회원가입과 **같은 계정**을 만든다. 가입하면 이 샵으로 돌아오고, 다른 크리에이터의 샵도 추가 가입 없이 이용한다.
 * 처음 가입한 샵의 크리에이터는 "유입 크리에이터"로만 기록된다(기존 팬 귀속 규칙).
 */
export default async function ShopSignupPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const sp = await searchParams;
  const next = authReturnPath(sp.next, `/c/${creator.code}`);
  const user = await getSessionUser().catch(() => null);
  if (user) redirect(next);

  return (
    <CreatorDonateShell creator={creator} activeMenu="login">
      <div className="mx-auto max-w-md py-9 sm:py-12">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-100 text-brand-800">
          <UserPlus size={24} strokeWidth={1.7} />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold text-ink-900">도네이도 회원가입</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">
          한 번 가입하면 {creator.displayName}님 샵은 물론 모든 크리에이터의 도네이도 샵에서 후원·구독·구매를 이용할 수 있어요.
        </p>
        <div className="mt-7 rounded-3xl border border-warm-300 bg-white p-5 shadow-card sm:p-7">
          <SignupForm nextPath={next} />
          <div className="mt-5">
            <SocialAuthButtons mode="signup" nextPath={next} />
          </div>
          <p className="mt-4 text-center text-[13px] text-ink-500">
            이미 회원이신가요{' '}
            <Link href={`/c/${creator.code}/login?next=${encodeURIComponent(next)}`} className="font-semibold text-brand-700">
              로그인
            </Link>
          </p>
        </div>
        <Link href={`/c/${creator.code}`} className="mt-6 block text-center text-sm font-semibold text-ink-600">
          가입 없이 샵 둘러보기
        </Link>
      </div>
    </CreatorDonateShell>
  );
}
