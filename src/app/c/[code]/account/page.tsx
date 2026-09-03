import { redirect } from 'next/navigation';
import { UserRound } from 'lucide-react';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { SectionTitle, Notice } from '@/components/ui';
import { PhoneLinkForm } from '@/components/my/phone-link-form';
import { NicknameForm } from '@/components/my/nickname-form';
import { defaultDonorName } from '@/lib/donor-name';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';

export const dynamic = 'force-dynamic';
export const metadata = { title: '내 정보 | 도네이도', robots: { index: false, follow: false } };

/**
 * 후원 페이지 안의 내 정보(휴대폰 번호 · 방송 닉네임).
 *
 * 공용 `/my/account` 로 보내면 후원 페이지 밖으로 나간다. 후원자가 이 화면에서 실제로
 * 필요한 것은 두 가지뿐이라 — 번호 연결과 방송에 뜰 이름 — 그 둘만 여기에 둔다.
 * 폼 컴포넌트는 마이페이지와 **같은 것을 쓴다**(저장 규칙이 갈라지지 않게).
 */
export default async function CreatorAccountPage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const base = `/c/${creator.code}`;
  const path = `${base}/account`;

  const user = await getSessionUser();
  if (!user) redirect(`${base}/login?next=${encodeURIComponent(path)}`);

  const donor = await prisma.donorProfile.findUnique({
    where: { userId: user.id },
    select: { phoneMasked: true, displayName: true },
  });

  return (
    <CreatorDonateShell creator={creator} activeMenu="messages">
      <section className="py-7 sm:py-9">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-brand-700">
          <UserRound size={19} strokeWidth={1.8} />
          내 정보
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">번호와 방송 닉네임</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">
          문자후원은 휴대전화 번호를 기준으로 기록됩니다. 방송에 표시될 이름도 여기서 정할 수 있습니다.
        </p>
      </section>

      <div className="space-y-5">
        <section>
          <SectionTitle
            title="휴대폰 번호"
            description="문자후원의 후원자 식별 기준입니다. 번호를 연결해야 내 후원 내역이 보입니다."
          />
          <PhoneLinkForm linkedPhoneMasked={donor?.phoneMasked ?? null} />
        </section>

        <section>
          <SectionTitle
            title="방송 닉네임"
            description="크리에이터 화면과 방송 오버레이·유튜브 채팅에 표시되는 이름입니다."
          />
          <NicknameForm
            current={donor?.displayName ?? null}
            defaultName={defaultDonorName(donor?.phoneMasked ?? '')}
          />
        </section>

        <Notice tone="neutral">
          결제수단·한도·차단 같은 계정 전체 설정은 도네이도 마이페이지에서 관리합니다. 이 화면에서는 후원
          페이지에 필요한 두 가지만 다룹니다.
        </Notice>
      </div>
    </CreatorDonateShell>
  );
}
