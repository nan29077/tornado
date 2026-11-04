import Image from 'next/image';
import Link from 'next/link';
import {
  MessageSquare, ShieldCheck, Radio, Wallet, Sparkles, ArrowRight,
  CreditCard, BellRing, ListChecks, PlayCircle, MonitorPlay, Volume2,
} from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { MascotAccent } from '@/components/brand/mascot-decorations';
import { CreatorCodeForm } from '@/components/creator-code-form';
import { HeroSlider } from '@/components/public/hero-slider';
import { BannerStrip } from '@/components/public/banner-strip';
import { Card, CardTitle, SectionTitle, LinkButton, Notice } from '@/components/ui';
import { prisma } from '@/server/db';
import { siteImageUrl } from '@/lib/site-images';
import { getSiteImageSelection } from '@/server/services/site-images';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // 공개 메인은 DB가 재기동되는 짧은 순간에도 전체 화면이 무너지지 않게 한다.
  // FAQ만 비워서 렌더링하고, 서버 상태는 /api/health에서 별도로 확인한다.
  const [banner, faqs] = await Promise.all([getSiteImageSelection('banner'), prisma.contentPost.findMany({
    where: { type: 'FAQ', published: true },
    orderBy: { sortOrder: 'asc' },
    take: 5,
  }).catch(() => [])]);

  return (
    <PublicShell aside={<HomeAside />}>
      <HeroSlider bannerImage={siteImageUrl('banner', banner)} />

      {/* 관리자 등록 배너 (HOME_TOP) */}
      <BannerStrip position="HOME_TOP" className="mt-4" />

      {/* 3. 크리에이터 코드 입력 */}
      <section className="mt-4">
        <Card className="border border-brand-100">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
              <Sparkles size={17} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>크리에이터 찾기</CardTitle>
              <p className="text-[12px] text-ink-400">코드 · 유튜브 채널명 · 닉네임으로 검색하세요.</p>
            </div>
          </div>
          <CreatorCodeForm />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-400">
            승인된 크리에이터만 검색됩니다. 크리에이터 코드뿐 아니라 유튜브 채널명이나 닉네임으로도 후원 페이지에
            접근할 수 있습니다.
          </p>
        </Card>
      </section>

      {/* 4. 문자 한 통으로 후원하는 방법 */}
      <section className="mt-8">
        <SectionTitle title="문자 한 통으로 후원하는 방법" description="처음 한 번만 등록하면, 그 다음부터는 문자만 보내면 됩니다." />
        <div className="space-y-2.5">
          <StepCard
            no={1}
            icon={<MessageSquare size={18} strokeWidth={1.7} />}
            title="크리에이터 번호로 문자 보내기"
            body="방송 화면에 안내된 후원 번호로 응원 메시지를 보냅니다."
          />
          <StepCard
            no={2}
            icon={<CreditCard size={18} strokeWidth={1.7} />}
            title="최초 1회 계좌 등록"
            body="최초 문자는 후원 처리되지 않습니다. 안내 문자의 링크에서 계좌 등록과 이용 동의를 완료하세요."
          />
          <StepCard
            no={3}
            icon={<ShieldCheck size={18} strokeWidth={1.7} />}
            title="문자 후원 PIN 인증"
            body="등록 후 문자를 보내면 결제 PIN 입력 링크가 발송됩니다. PIN 을 입력하면 등록한 계좌에서 후원금이 출금됩니다."
          />
          <StepCard
            no={4}
            icon={<BellRing size={18} strokeWidth={1.7} />}
            title="방송에 바로 표시"
            body="결제가 완료된 후원만 유튜브 채팅과 방송 오버레이, 음성 안내로 표시됩니다."
          />
        </div>

        <div className="mt-3">
          <Notice tone="warning" title="꼭 확인해 주세요">
            문자를 보낸 뒤 결제 PIN 을 입력하면 등록한 계좌에서 후원금이 출금됩니다. 결제되지 않은 메시지는 방송에
            표시되지 않으며, 최초 문자는 후원 처리되지 않습니다.
          </Notice>
        </div>
      </section>

      {/* 5. 최초 계좌 등록 안내 */}
      <section className="mt-8">
        <SectionTitle title="최초 계좌 등록 안내" description="등록 화면에서 아래 내용을 모두 확인하실 수 있습니다." />
        <Card>
          <ul className="space-y-2 text-[13.5px] leading-relaxed text-ink-700">
            {[
              '후원 대상 크리에이터와 후원 번호',
              '문자 1건당 후원금과 수수료 안내',
              '일일·월간 이용 한도',
              '취소 및 환불 조건',
              '반복 발송 시 주의사항',
              '만 19세 미만 이용 제한',
              '개인정보 수집·이용 및 전자금융거래 동의',
              '출금이체 동의 (마케팅 동의는 선택)',
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <ListChecks size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-700" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section id="creator-promo" className="mt-8" aria-labelledby="creator-promo-title">
        <Card padded={false} className="overflow-hidden">
          <div className="px-5 py-4 sm:px-6">
            <h2 id="creator-promo-title" className="text-[19px] font-black tracking-[-0.025em] text-ink-900">
              팬의 문자, 내 방송의 후원으로
            </h2>
          </div>
          <video
            controls
            playsInline
            preload="none"
            width={1280}
            height={720}
            poster="/videos/donaido-creator-promo-poster.webp"
            aria-labelledby="creator-promo-title"
            className="block aspect-video h-auto w-full bg-ink-900"
          >
            <source src="/videos/donaido-creator-promo.mp4" type="video/mp4" />
            <a href="/videos/donaido-creator-promo.mp4">홍보 영상 다운로드</a>
          </video>
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-[13px] leading-relaxed text-ink-600">
              유튜브를 연동하면 팬이 문자로 보낸 응원 메시지가 PIN 결제 완료 후 실시간 채팅에 표시돼요. OBS · PRISM 오버레이에도 후원 알림을 띄울 수 있어요.
            </p>
            <LinkButton href="/creator-apply" className="shrink-0">
              크리에이터 가입 신청
              <ArrowRight size={16} strokeWidth={1.8} />
            </LinkButton>
          </div>
        </Card>
      </section>

      {/* 6. 방송 연동 소개 */}
      <section className="mt-8">
        <SectionTitle title="유튜브·OBS·PRISM 연동" description="결제가 완료된 후원만 방송에 노출됩니다." />
        <Card padded={false} className="overflow-hidden">
          <Image
            src="/assets/tornado-hero-studio-v2.png"
            alt="라이브 방송을 진행하는 크리에이터 스튜디오"
            width={1536}
            height={1024}
            className="h-[230px] w-full object-cover object-center sm:h-[270px]"
          />
          <div className="space-y-2.5 p-5">
            <FeatureLine icon={<PlayCircle size={17} strokeWidth={1.7} />} title="유튜브 라이브 채팅 등록" body="후원 메시지가 라이브 채팅에 자동으로 올라갑니다. 유튜브 공식 슈퍼챗이 아닌 외부 후원으로 표시됩니다." />
            <FeatureLine icon={<MonitorPlay size={17} strokeWidth={1.7} />} title="OBS · PRISM 오버레이" body="브라우저 소스 주소 하나만 추가하면 회오리 애니메이션과 후원 알림이 표시됩니다." />
            <FeatureLine icon={<Volume2 size={17} strokeWidth={1.7} />} title="TTS 음성 안내" body="후원 메시지를 음성으로 읽어줍니다. 음성·속도·볼륨·최소 후원금을 설정할 수 있습니다." />
            <FeatureLine icon={<Radio size={17} strokeWidth={1.7} />} title="도네이도 자체 방송" body="RTMPS 송출과 자체 플레이어에서도 동일한 후원 효과를 확인할 수 있습니다. (준비 중)" />
          </div>
        </Card>
      </section>

      {/* 7. 크리에이터 기능 */}
      <section className="mt-8">
        <SectionTitle title="크리에이터를 위한 기능" />
        <div className="grid grid-cols-2 gap-2.5">
          {[
            { icon: <MessageSquare size={17} strokeWidth={1.7} />, title: '전용 후원 번호', body: '크리에이터마다 고유 번호 또는 코드를 배정합니다.' },
            { icon: <BellRing size={17} strokeWidth={1.7} />, title: '실시간 후원 알림', body: '오버레이·TTS·감사 스티커를 자유롭게 설정합니다.' },
            { icon: <Wallet size={17} strokeWidth={1.7} />, title: '정산 관리', body: '후원금, 수수료, 정산 가능 금액을 한눈에 확인합니다.' },
            { icon: <ShieldCheck size={17} strokeWidth={1.7} />, title: '금칙어·차단', body: '부적절한 메시지와 후원자를 즉시 차단합니다.' },
          ].map((f) => (
            <Card key={f.title} className="h-full">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-700">{f.icon}</span>
              <p className="mt-2.5 text-[14px] font-bold text-ink-900">{f.title}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">{f.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* 8. 후원자 보호 */}
      <section className="mt-8">
        <SectionTitle title="후원자 보호와 이용 한도" description="과도한 후원을 막기 위한 안전장치가 기본으로 적용됩니다." />
        <Card padded={false} className="overflow-hidden">
          <Image src="/assets/tornado-hero-viewer-v2.png" alt="안전하게 문자 후원을 보내는 시청자" width={1536} height={1024} className="h-[210px] w-full object-cover object-center sm:h-[250px]" />
          <div className="grid grid-cols-2 gap-3 p-5 text-[13px]">
            <Guard label="문자 1건당" value="1,000~50,000원" note="크리에이터 설정" />
            <Guard label="후원자별 1일 최대" value="100,000원" note="한도 조정 가능" />
            <Guard label="1분 내 최대" value="3건" />
            <Guard label="연속 후원 시" value="자동 대기" />
            <Guard label="결제 실패 3회" value="자동 잠금" />
            <Guard label="만 19세 미만" value="이용 제한" />
          </div>
        </Card>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
          한도는 마이페이지에서 더 낮게 설정할 수 있고, 크리에이터별 후원 차단도 가능합니다.
        </p>
      </section>

      {/* 9. 크리에이터 가입 신청 */}
      <section className="mt-8">
        <Card className="creator-cta relative overflow-hidden text-white">
          <span className="absolute -right-6 -top-7 h-24 w-24 rounded-full border border-white/15" aria-hidden />
          <span className="absolute right-5 top-5 h-10 w-10 rounded-full border border-white/10" aria-hidden />
          <MascotAccent seed="크리에이터 시작" className="absolute -bottom-4 right-1 h-28 w-28 opacity-90 sm:right-5 sm:h-32 sm:w-32" />
          <p className="relative text-[13px] font-bold text-white/85">크리에이터라면</p>
          <p className="relative max-w-[70%] mt-1 text-[21px] font-black leading-snug tracking-[-0.025em] text-white">
            문자 후원을 방송에
            <br />
            바로 연결해 보세요.
          </p>
          {/*
            버튼이 마스코트를 가려서 배경을 85% 로 낮춰 비쳐 보이게 한다.
            글자색은 brand-700 -> brand-800 으로 한 단계 진하게 내렸다.
            흰 배경을 낮추면 어두운 카드 바탕이 비쳐 올라와 밝기가 떨어지는데,
            글자색을 그대로 두면 대비가 4.6:1 에서 3.9:1 로 내려가 읽기 어려워진다.
            한 단계 내리면 5.1:1 이 되어 지금보다 오히려 또렷하다.
          */}
          <LinkButton
            href="/creator-apply"
            variant="secondary"
            size="lg"
            className="relative mt-5 border-white/45 bg-white/85 text-brand-800 hover:bg-white/95"
          >
            크리에이터로 시작하기
            <ArrowRight size={16} strokeWidth={1.8} />
          </LinkButton>
        </Card>
      </section>

      {/* 관리자 등록 배너 (HOME_MIDDLE) */}
      <BannerStrip position="HOME_MIDDLE" className="mt-8" />

      {/* 10. FAQ */}
      <section className="mt-8">
        <SectionTitle
          title="자주 묻는 질문"
          action={
            <Link href="/faq" className="text-[13px] font-semibold text-brand-700">
              전체 보기
            </Link>
          }
        />
        <div className="space-y-2">
          {faqs.map((f) => (
            <details key={f.id} className="card group p-4">
              <summary className="cursor-pointer list-none text-[14px] font-bold text-ink-900">{f.title}</summary>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-500">{f.body}</p>
            </details>
          ))}
          {faqs.length === 0 ? <p className="text-[13px] text-ink-400">등록된 FAQ가 없습니다.</p> : null}
        </div>
      </section>

      {/* 11. 고객센터 */}
      <section className="mt-8">
        <Card>
          <CardTitle>고객센터</CardTitle>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
            후원 취소·환불, 계좌 등록 문제, 방송 연동 문의는 고객센터로 접수해 주세요.
          </p>
          <LinkButton href="/support" variant="secondary" size="md" className="mt-3">
            문의하기
          </LinkButton>
        </Card>
      </section>
    </PublicShell>
  );
}

function StepCard({ no, icon, title, body }: { no: number; icon: React.ReactNode; title: string; body: string }) {
  return (
    <Card className="flex gap-3">
      <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        {icon}
        <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[11px] font-bold text-white">
          {no}
        </span>
      </span>
      <div>
        <p className="text-[14.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </Card>
  );
}

function FeatureLine({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">{icon}</span>
      <div>
        <p className="text-[13.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </div>
  );
}

function Guard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-ink-50 px-3 py-2.5">
      <p className="text-[11.5px] text-ink-400">{label}</p>
      <p className="mt-0.5 text-[14px] font-extrabold text-ink-900">{value}</p>
      {/* 값만으로는 오해할 수 있는 항목에만 붙인다 (예: 금액은 크리에이터가 정한다) */}
      {note ? <p className="mt-0.5 text-[11px] text-ink-400">{note}</p> : null}
    </div>
  );
}

function HomeAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>도네이도는</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          문자 한 통으로 크리에이터를 응원하는 후원 플랫폼입니다. 결제가 완료된 후원만 방송에 표시되며, 모든 거래는
          거래번호로 추적됩니다.
        </p>
      </Card>
      <Card>
        <CardTitle>라이브 후원 예시</CardTitle>
        <div className="mt-3 space-y-2">
          {[
            { name: '홍*동', amount: '3,000원', msg: '오늘 방송 재미있어요!' },
            { name: '김*수', amount: '3,000원', msg: '항상 응원합니다' },
            { name: '이*리', amount: '5,000원', msg: '감기 조심하세요' },
          ].map((d) => (
            <div key={d.name} className="rounded-xl border border-ink-100 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-bold text-ink-900">{d.name}</span>
                <span className="text-[12.5px] font-extrabold text-brand-700">{d.amount}</span>
              </div>
              <p className="mt-1 text-[12px] text-ink-500">{d.msg}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-ink-300">화면 이해를 돕기 위한 예시입니다.</p>
      </Card>
    </div>
  );
}
