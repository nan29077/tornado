import type { Metadata } from 'next';
import Link from 'next/link';
import { HeartHandshake, Sparkles } from '@/components/brand/icons';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { SignupForm } from '@/components/public/signup-form';
import { CreatorApplyForm } from '@/components/public/creator-apply-form';
import { Card, CardTitle, Notice, cx } from '@/components/ui';
import { SocialAuthButtons } from '@/components/public/social-auth';
import { getSessionUser } from '@/server/auth';
import { isServiceInMockMode } from '@/server/service-mode';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '회원가입 | 도네이도',
  description: '도네이도 회원 한 번 가입으로 모든 크리에이터의 도네이도 샵을 이용하세요. 크리에이터 가입도 여기서 신청합니다.',
};

/**
 * 회원가입 (2026-11-17).
 * - 일반회원: 이메일 / 카카오·네이버. 한 계정으로 모든 도네이도 샵을 이용한다.
 * - 크리에이터: 채널·구독자 수를 입력해 신청 → 최고관리자 승인 후 크리에이터 계정으로 전환.
 *   간편 가입 계정은 먼저 일반회원으로 가입한 뒤 마이페이지에서 전환 신청한다.
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const sp = await searchParams;
  const type = sp.type === 'creator' ? 'creator' : 'member';
  const user = await getSessionUser().catch(() => null);
  if (user) redirect(type === 'creator' && user.role === 'DONOR' ? '/my/creator' : user.role === 'ADMIN' ? '/admin' : user.role === 'CREATOR' ? '/studio' : '/my');

  return (
    <PublicShell aside={<SignupAside />}>
      <PageHeader
        eyebrow="회원가입"
        title={type === 'creator' ? '크리에이터 가입' : '도네이도 회원가입'}
        description={
          type === 'creator'
            ? '채널 정보를 입력해 신청하면 최고관리자 심사 후 크리에이터 계정으로 바뀝니다.'
            : '한 번 가입하면 모든 크리에이터의 도네이도 샵에서 후원·구독·구매를 이용할 수 있어요.'
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-ink-100 p-1" role="tablist" aria-label="가입 유형">
        <TypeTab href="/signup" active={type === 'member'} icon={<HeartHandshake size={16} strokeWidth={1.85} />} label="일반회원" />
        <TypeTab href="/signup?type=creator" active={type === 'creator'} icon={<Sparkles size={16} strokeWidth={1.85} />} label="크리에이터" />
      </div>

      {type === 'member' ? (
        <>
          <Card>
            <SignupForm />
            <div className="mt-5">
              <SocialAuthButtons mode="signup" />
            </div>
            <p className="mt-4 text-center text-[13px] text-ink-500">
              이미 계정이 있으신가요{' '}
              <Link href="/login" className="font-semibold text-brand-700">
                로그인
              </Link>
            </p>
          </Card>
          <div className="mt-4">
            <Notice tone="brand" title="문자후원은 가입 없이도 됩니다">
              문자후원은 문자 발송과 계좌 등록만으로 이용할 수 있습니다. 회원이 되면 후원·구독·주문 내역을 한곳에서 관리하고,
              도네이도 샵에서 영상 후원과 구매를 할 수 있어요.
            </Notice>
          </div>
        </>
      ) : (
        <>
          <Card className="mb-4">
            <CardTitle>카카오·네이버로 가입하시나요</CardTitle>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
              간편 가입은 먼저 일반회원으로 가입한 뒤, 마이페이지의 [크리에이터 전환]에서 같은 신청서를 제출하면 됩니다.
            </p>
            <div className="mt-3">
              <SocialAuthButtons mode="signup" nextPath="/my/creator" />
            </div>
          </Card>
          <CreatorApplyForm loggedIn={false} mockMode={isServiceInMockMode()} />
        </>
      )}
    </PublicShell>
  );
}

function TypeTab({ href, active, icon, label }: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={cx(
        'flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13.5px] font-bold transition-colors',
        active ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900',
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

function SignupAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>회원이 되면</CardTitle>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>모든 크리에이터의 도네이도 샵을 추가 가입 없이 이용</li>
          <li>영상 후원과 상품 구매</li>
          <li>구독한 크리에이터의 새 영상·방송 알림</li>
          <li>후원·주문·배송 내역 한곳에서 확인</li>
          <li>후원 한도와 크리에이터별 차단 설정</li>
        </ul>
      </Card>
      <Card>
        <CardTitle>크리에이터 심사 기준</CardTitle>
        <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-ink-500">
          <li>실제 운영 중인 채널인지 확인</li>
          <li>불법·성인·도박 콘텐츠 여부</li>
          <li>본인 확인 및 정산 정보 일치</li>
        </ul>
      </Card>
    </div>
  );
}
