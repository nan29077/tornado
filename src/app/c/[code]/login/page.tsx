import Link from 'next/link';
import { HeartHandshake } from 'lucide-react';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { SocialAuthButtons } from '@/components/public/social-auth';
import { DonorTestLogin } from '@/components/public/donor-test-login';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { authReturnPath } from '@/lib/auth-return-path';
import { isLocal } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: '후원자 로그인 | 도네이도', robots: { index: false, follow: false } };

export default async function DonorLoginPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ next?: string; error?: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const sp = await searchParams;
  const next = authReturnPath(sp.next, `/c/${creator.code}`);
  return <CreatorDonateShell creator={creator} activeMenu="login">
    <div className="mx-auto max-w-md py-9 sm:py-12">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-100 text-brand-800"><HeartHandshake size={24} strokeWidth={1.7} /></span>
      <h1 className="mt-5 text-2xl font-extrabold text-ink-900">반가워요, 후원자님</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-600">{creator.displayName}님에게 보낸 응원과 답글을 한곳에서 확인하세요. 로그인해도 자동으로 결제되지 않습니다.</p>
      <div className="mt-7 rounded-3xl border border-warm-300 bg-white p-5 shadow-card sm:p-7">
        {sp.error ? <p role="alert" className="mb-4 rounded-xl bg-warm-100 p-3 text-sm text-ink-800">{sp.error === 'social_not_ready' ? '간편 로그인 연동을 준비 중입니다. 이메일 또는 아래 테스트 로그인을 이용해 주세요.' : '로그인을 완료하지 못했습니다. 다시 시도해 주세요.'}</p> : null}
        <SocialAuthButtons mode="login" nextPath={next} />
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="mt-5 block rounded-xl border border-ink-200 px-4 py-3 text-center text-sm font-bold text-ink-800">이메일로 로그인</Link>
        <p className="mt-4 text-center text-xs leading-relaxed text-ink-500">처음 이용하시나요? 간편 로그인 후 후원자 계정을 만들 수 있어요.<br />기존 이메일 계정과는 자동으로 합쳐지지 않습니다.</p>
      </div>
      {isLocal ? <DonorTestLogin nextPath={next} /> : null}
      <Link href={`/c/${creator.code}`} className="mt-6 block text-center text-sm font-semibold text-ink-600">로그인 없이 후원 페이지 보기</Link>
    </div>
  </CreatorDonateShell>;
}
