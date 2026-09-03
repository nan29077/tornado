import { LifeBuoy, ShieldCheck } from 'lucide-react';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { SupportForm } from '@/components/public/support-form';
import { Notice } from '@/components/ui';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';

export const dynamic = 'force-dynamic';
export const metadata = { title: '문의하기 | 도네이도', robots: { index: false, follow: false } };

/**
 * 후원 페이지 안의 문의 화면.
 *
 * 예전에는 후원 페이지에서 [신고·문의하기]를 누르면 공용 `/support` 로 나갔다. 그 순간
 * 후원자는 보던 크리에이터를 잃고 도네이도 메인 구조로 튕겨 나갔다.
 * 같은 폼(SupportForm)을 이 셸 안에서 그대로 쓴다 — 접수 경로는 하나로 유지하고
 * 화면만 후원 페이지 안에 둔다.
 */
export default async function CreatorSupportPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ tx?: string }>;
}) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const tx = (await searchParams).tx?.trim();

  return (
    <CreatorDonateShell creator={creator} activeMenu="support">
      <section className="py-7 sm:py-9">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-brand-700">
          <LifeBuoy size={19} strokeWidth={1.8} />
          고객센터
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">문의하기</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">
          {creator.displayName} 님에게 보낸 후원과 관련해 결제 오류, 원치 않는 노출, 부적절한 후원 유도가 있었다면
          알려 주세요. <span className="font-bold text-ink-900">거래번호</span>를 함께 적어 주시면 훨씬 빠르게
          확인할 수 있습니다.
        </p>
      </section>

      <div className="mb-4">
        <Notice tone="neutral">
          <span className="flex items-start gap-2">
            <ShieldCheck size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-brand-700" />
            문의 내용은 도네이도 운영팀만 확인합니다. 크리에이터에게 전달되지 않습니다.
          </span>
        </Notice>
      </div>

      <SupportForm defaultTransactionNo={tx || undefined} />
    </CreatorDonateShell>
  );
}
