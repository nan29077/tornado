import { BookOpen, MessageSquare, CreditCard, ShieldCheck, Smartphone, CircleAlert } from 'lucide-react';
import { CreatorDonateShell } from '@/components/public/creator-donate-shell';
import { Notice } from '@/components/ui';
import { loadCreatorDonateProfile } from '@/server/services/creator-donate-profile';

export const dynamic = 'force-dynamic';
export const metadata = { title: '이용방법 | 도네이도', robots: { index: false, follow: false } };

/** 후원 페이지 안의 이용방법. 공용 /how-it-works 로 나가지 않는다. */
export default async function CreatorHowItWorksPage({ params }: { params: Promise<{ code: string }> }) {
  const creator = await loadCreatorDonateProfile((await params).code);

  const steps = [
    {
      no: '1',
      icon: <CreditCard size={17} strokeWidth={1.7} />,
      title: '계좌를 1회 등록합니다',
      body: '첫 문자를 보내면 오는 안내 링크에서 본인 명의 계좌를 등록합니다. 계좌번호 원문은 저장하지 않고 은행명과 끝 4자리만 보관합니다.',
    },
    {
      no: '2',
      icon: <MessageSquare size={17} strokeWidth={1.7} />,
      title: '응원 문자를 보냅니다',
      body: `${creator.displayName} 님의 전용 후원 번호로 메시지를 보내면 결제 PIN 입력 문자가 도착합니다. 이 단계까지는 출금되지 않습니다.`,
    },
    {
      no: '3',
      icon: <Smartphone size={17} strokeWidth={1.7} />,
      title: 'PIN 을 입력하면 결제됩니다',
      body: '문자로 받은 링크에서 결제 PIN 을 입력하면 등록한 계좌에서 후원금이 출금됩니다. 유효시간 안에 입력하지 않으면 자동 취소됩니다.',
    },
    {
      no: '4',
      icon: <ShieldCheck size={17} strokeWidth={1.7} />,
      title: '방송에 표시됩니다',
      body: '결제가 완료된 후원만 유튜브 라이브 채팅과 방송 오버레이, 음성 안내로 전달됩니다. 결제되지 않은 메시지는 표시되지 않습니다.',
    },
  ];

  return (
    <CreatorDonateShell creator={creator} activeMenu="how-it-works">
      <section className="py-7 sm:py-9">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-brand-700">
          <BookOpen size={19} strokeWidth={1.8} />
          처음이신가요
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">문자후원 이용방법</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">
          문자 한 통이면 {creator.displayName} 님의 방송 화면에 내 메시지가 표시됩니다. 처음 한 번만 계좌를
          등록하면 그다음부터는 문자와 PIN 입력만으로 끝납니다.
        </p>
      </section>

      <div className="mb-5">
        <Notice tone="warning" title="처음 보내는 문자는 후원되지 않습니다">
          최초 문자는 계좌 등록 안내만 발송됩니다. 안내 문자의 링크에서 계좌 등록과 이용 동의를 마친 뒤 다시
          문자를 보내주세요.
        </Notice>
      </div>

      <ol className="space-y-2.5">
        {steps.map((s) => (
          <li key={s.no} className="flex gap-3 rounded-[1.5rem] border border-warm-300/70 bg-white p-4 shadow-card">
            <span className="relative mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
              {s.icon}
              <span className="absolute -top-1.5 -left-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[10px] font-black text-brand-400">
                {s.no}
              </span>
            </span>
            <div>
              <p className="text-[13.5px] font-bold text-ink-900">{s.title}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <section className="mt-6 rounded-[2rem] border border-warm-300/70 bg-gradient-to-br from-white to-warm-100 p-6 shadow-card">
        <p className="flex items-center gap-1.5 text-[14px] font-black tracking-[-0.02em] text-ink-900">
          <CircleAlert size={16} strokeWidth={1.7} className="text-warning-500" />
          꼭 알아두세요
        </p>
        <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-ink-500">
          <li>만 19세 미만은 이용할 수 없습니다.</li>
          <li>결제되지 않은 메시지는 방송에 표시되지 않습니다.</li>
          <li>후원 문자에 전화번호·계좌번호 같은 개인정보를 적지 마세요. 자동으로 가려지지만 남기지 않는 편이 안전합니다.</li>
          <li>유튜브 공식 슈퍼챗이 아닌 외부 후원 서비스입니다.</li>
        </ul>
      </section>
    </CreatorDonateShell>
  );
}
