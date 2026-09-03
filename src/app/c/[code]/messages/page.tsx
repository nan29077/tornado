import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MessageCircleHeart } from 'lucide-react';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { DonationReply } from '@/components/public/donation-reply';
import { Badge, LinkButton } from '@/components/ui';
import { getSessionUser } from '@/server/auth';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';
import { listMyCreatorMessages } from '@/server/services/donation-replies';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { donationStatusLabel } from '@/lib/labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: '내 문자후원 내역 | 도네이도', robots: { index: false, follow: false } };

export default async function CreatorMessagesPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ page?: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);
  const path = `/c/${creator.code}/messages`;
  const user = await getSessionUser();
  if (!user) redirect(`/c/${creator.code}/login?next=${encodeURIComponent(path)}`);
  const data = await listMyCreatorMessages(user.id, creator.id, Number((await searchParams).page ?? 1));
  return <CreatorDonateShell creator={creator} activeMenu="messages">
    <section className="py-7 sm:py-9">
      <p className="mb-3 flex items-center gap-2 text-sm font-bold text-brand-700"><MessageCircleHeart size={19} />나의 응원 기록</p>
      <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">내 문자후원 내역</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-600">{creator.displayName}님에게 보낸 문자와 크리에이터의 답글을 확인하세요. 이 화면은 나에게만 보입니다.</p>
      <div className="mt-4 flex flex-wrap gap-2"><LinkButton href={`/c/${creator.code}`} variant="secondary" size="sm">후원 페이지로</LinkButton><LinkButton href={`/c/${creator.code}/account`} variant="secondary" size="sm">내 정보</LinkButton></div>
    </section>
    {!data.connected ? <div className="rounded-3xl border border-warm-300 bg-white p-6">
      <h2 className="font-bold text-ink-900">휴대폰 번호를 연결해 주세요</h2>
      <p className="my-3 text-sm leading-relaxed text-ink-600">카카오·네이버 로그인만으로 문자 발신번호가 연결되지는 않습니다. 본인 휴대폰을 인증하면 해당 번호로 보낸 후원 내역을 안전하게 확인할 수 있습니다.</p>
      <LinkButton href={`/c/${creator.code}/account`} size="md">휴대폰 번호 연결하기</LinkButton>
    </div> : data.rows.length === 0 ? <p className="rounded-3xl border border-dashed border-warm-300 bg-white p-8 text-center text-sm text-ink-600">아직 이 크리에이터에게 보낸 문자후원이 없습니다.</p> : <>
      <p className="mb-3 text-sm font-semibold text-ink-500">총 {data.total}건 · 결제 상태는 각 내역을 확인하세요</p>
      <ul className="space-y-4">{data.rows.map((d) => <li key={d.id} className="rounded-3xl border border-warm-300/70 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-ink-500">{formatKst(d.receivedAt)}</span><Badge tone={donationStatusLabel[d.status].tone}>{donationStatusLabel[d.status].text}</Badge></div>
        <p className="mt-3 text-lg font-extrabold text-ink-900">{formatWon(d.amount)}{d.isTest ? <span className="ml-2 text-xs font-semibold text-ink-500">테스트 · 실제 결제 아님</span> : null}</p>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-800">{d.message || '(메시지 없음)'}</p>
        {d.reply ? <DonationReply {...d.reply} name={creator.displayName} /> : <p className="mt-4 border-t border-warm-200 pt-3 text-xs text-ink-500">크리에이터가 답글을 남기면 이곳에 표시됩니다.</p>}
      </li>)}</ul>
      <nav aria-label="후원 내역 페이지" className="mt-6 flex items-center justify-center gap-5 text-sm font-bold">
        {data.page > 1 ? <Link href={`${path}?page=${data.page - 1}`}>이전</Link> : null}<span>{data.page} / {data.pages}</span>{data.page < data.pages ? <Link href={`${path}?page=${data.page + 1}`}>다음</Link> : null}
      </nav>
    </>}
  </CreatorDonateShell>;
}
