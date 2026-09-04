import type { Metadata } from 'next';
import {
  MessageSquare, CreditCard, ShieldCheck, BellRing, Ban, Gauge,
  Undo2, ScrollText, CircleAlert, Landmark, Clock, Smartphone,
} from 'lucide-react';
import { PublicShell } from '@/components/layout/public-shell';
import { PageHeader } from '@/components/public/page-header';
import { Card, CardTitle, SectionTitle, Notice, LinkButton, DataRow } from '@/components/ui';
import { formatWon, formatNumber } from '@/lib/money';
import { resolvePolicy } from '@/server/services/limits';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '문자후원 이용방법 | 도네이도',
  description: '문자 한 통으로 크리에이터를 후원하는 방법과 계좌 등록, 결제, 방송 노출 절차를 안내합니다.',
};

export default async function HowItWorksPage() {
  const policy = await resolvePolicy();

  return (
    <PublicShell aside={<HowAside />}>
      <PageHeader
        eyebrow="이용방법"
        title="문자 한 통으로 후원하는 전체 과정"
        description="최초 1회 계좌 등록만 마치면, 그 다음부터는 문자를 보내는 것만으로 후원이 접수됩니다. 아래 순서를 그대로 따라 주세요."
      />

      <Notice tone="warning" title="시작하기 전에 꼭 확인해 주세요">
        <ul className="list-disc space-y-1 pl-4">
          <li>최초로 보내는 문자는 후원 처리되지 않습니다. 계좌 등록 안내만 발송됩니다.</li>
          <li>등록을 마친 뒤 문자를 보내면 등록한 계좌에서 후원금이 출금됩니다.</li>
          <li>결제되지 않은 메시지는 방송 화면과 채팅에 표시되지 않습니다.</li>
        </ul>
      </Notice>

      {/* 단계 안내 */}
      <section className="mt-8">
        <SectionTitle title="후원 절차" description="처음 한 번만 등록하면 이후에는 2단계부터 건너뜁니다." />
        <div className="space-y-2.5">
          <Step
            no={1}
            icon={<MessageSquare size={18} strokeWidth={1.7} />}
            title="크리에이터 후원 번호로 문자 보내기"
            body="방송 화면이나 크리에이터 후원 페이지에 안내된 번호로 응원 메시지를 보냅니다. 대표번호를 쓰는 크리에이터는 메시지 맨 앞에 안내된 키워드를 붙여야 후원 대상이 구분됩니다."
            note="이 최초 문자는 후원으로 접수되지 않으며, 결제도 발생하지 않습니다."
            noteTone="warning"
          />
          <Step
            no={2}
            icon={<CreditCard size={18} strokeWidth={1.7} />}
            title="안내 문자의 링크에서 계좌 등록"
            body="문자로 받은 1회용 보안 링크를 열어 본인 명의 계좌를 등록하고 이용 동의를 진행합니다. 등록 화면에서 후원 대상, 문자 1건당 후원금, 이용 한도, 취소·환불 조건을 모두 확인할 수 있습니다."
            note="계좌번호 원문은 도네이도에 저장하지 않습니다. 은행명과 계좌 끝 4자리만 보관합니다."
          />
          <Step
            no={3}
            icon={<ShieldCheck size={18} strokeWidth={1.7} />}
            title="문자를 보내고 PIN 인증으로 결제"
            body="등록을 마친 뒤 다시 문자를 보내면 결제 PIN 입력 링크가 도착합니다. 결제사 화면에서 PIN 을 입력하는 순간 등록한 계좌에서 후원금이 출금됩니다."
            note="PIN 을 입력하지 않은 요청은 일정 시간이 지나면 자동으로 만료되고 결제되지 않습니다."
          />
          <Step
            no={4}
            icon={<BellRing size={18} strokeWidth={1.7} />}
            title="방송에 후원 메시지 노출"
            body="결제가 완료된 후원만 유튜브 라이브 채팅, 방송 오버레이, 음성 안내(TTS)로 전달됩니다. 전송 결과는 마이페이지에서 확인할 수 있습니다."
            note="금칙어가 포함된 메시지는 일부 문구가 가려지거나 노출이 차단될 수 있습니다."
          />
        </div>
      </section>

      {/* 출금 안내 */}
      <section className="mt-8">
        <SectionTitle title="언제 돈이 빠져나가나요" description="출금 시점을 정확히 알고 이용하세요." />
        <Card>
          <div className="space-y-3">
            <Line
              icon={<Ban size={17} strokeWidth={1.7} />}
              tone="warning"
              title="최초 문자 — 출금 없음"
              body="계좌 등록 전에 보낸 문자는 후원으로 처리되지 않으며 요금이 청구되지 않습니다. (이동통신사 문자 발송 요금은 별도)"
            />
            <Line
              icon={<Landmark size={17} strokeWidth={1.7} />}
              tone="danger"
              title="등록 후 문자 — PIN 입력 시 출금"
              body="계좌 등록을 마친 뒤 보내는 문자는 결제 PIN 인증을 거쳐 등록한 계좌에서 후원금이 출금됩니다."
            />
            <Line
              icon={<Clock size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="PIN 을 입력하지 않은 요청 — 자동 만료"
              body="결제 PIN 을 입력하지 않으면 요청은 만료되고 출금되지 않습니다. 만료된 요청은 방송에도 표시되지 않습니다."
            />
          </div>
        </Card>
      </section>

      {/* 한도 */}
      <section className="mt-8">
        <SectionTitle
          title="이용 한도"
          description="과도한 후원을 막기 위한 기본 한도입니다. 마이페이지에서 더 낮게 설정할 수 있습니다."
        />
        <Card>
          <DataRow label="문자 1건당 기본 후원금" value={formatWon(policy.defaultAmount)} />
          <DataRow label="1건 허용 범위" value={`${formatWon(policy.minAmount)} ~ ${formatWon(policy.maxAmount)}`} />
          <DataRow label="1일 최대" value={formatWon(policy.donorDailyLimit)} />
          <DataRow label="1개월 최대" value={formatWon(policy.donorMonthlyLimit)} />
          <DataRow label="크리에이터 1명당 1일 최대" value={formatWon(policy.perCreatorDailyLimit)} />
          <DataRow
            label="연속 후원 제한"
            value={`${formatNumber(policy.velocityWindowSec)}초 내 ${formatNumber(policy.velocityMaxCount)}건`}
          />
          <DataRow
            label="연속 후원 시 대기"
            value={`${formatNumber(policy.cooldownAfterCount)}건 이후 ${formatNumber(policy.cooldownSec)}초 대기`}
          />
          <DataRow label="신규 후원자 첫날 한도" value={formatWon(policy.newDonorFirstDayLimit)} />
          <DataRow label="결제 실패 누적" value={`${formatNumber(policy.failureLockThreshold)}회 시 자동 잠금`} />
        </Card>
        <p className="mt-2 flex gap-2 text-[12px] leading-relaxed text-ink-400">
          <Gauge size={15} strokeWidth={1.7} className="mt-0.5 shrink-0" />
          <span>
            한도를 넘는 문자는 후원으로 접수되지 않고 안내 문자가 발송됩니다. 이미 지난 결제는 한도 변경의 영향을 받지
            않습니다.
          </span>
        </p>
      </section>

      {/* 취소/환불 */}
      <section className="mt-8">
        <SectionTitle title="취소 및 환불" />
        <Card>
          <div className="space-y-3">
            <Line
              icon={<Undo2 size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="환불 요청 방법"
              body="마이페이지 후원 내역에서 결제 완료 건의 환불을 요청하거나, 고객센터로 거래번호와 함께 접수해 주세요."
            />
            <Line
              icon={<CircleAlert size={17} strokeWidth={1.7} />}
              tone="warning"
              title="환불이 제한되는 경우"
              body="이미 크리에이터에게 정산이 완료된 건, 부정 이용이 확인된 건, 본인 확인이 어려운 건은 환불이 제한될 수 있습니다."
            />
            <Line
              icon={<ScrollText size={17} strokeWidth={1.7} />}
              tone="neutral"
              title="처리 절차"
              body="환불 요청 접수 후 관리자 검토를 거쳐 승인되면 결제 취소가 진행되고, 결과는 문자와 마이페이지로 안내됩니다."
            />
          </div>
        </Card>
      </section>

      {/* 미성년자 */}
      <section className="mt-8">
        <SectionTitle title="미성년자 이용 제한" />
        <Notice tone="danger" title="만 19세 미만은 이용할 수 없습니다">
          도네이도 문자후원은 만 19세 이상만 이용할 수 있습니다. 계좌 등록 시 연령 확인에 동의해야 하며, 명의자 동의
          없이 이루어진 후원은 확인 즉시 이용이 정지되고 환불 절차가 진행됩니다. 가족 명의 휴대전화나 계좌를 무단으로
          사용하지 마세요.
        </Notice>
      </section>

      {/* 문자 요금 */}
      <section className="mt-8">
        <Card>
          <div className="flex gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Smartphone size={17} strokeWidth={1.7} />
            </span>
            <div>
              <CardTitle>문자 발송 요금 안내</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
                후원금과 별개로 이동통신사의 문자 발송 요금이 발생할 수 있습니다. 요금 정책은 가입한 통신 요금제를
                확인해 주세요.
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section className="mt-8">
        <Card className="bg-ink-900 text-white">
          <p className="text-[15px] font-extrabold leading-snug">후원할 크리에이터의 코드를 알고 계신가요?</p>
          <p className="mt-1.5 text-[13px] leading-relaxed opacity-90">
            방송 화면에 안내된 코드를 입력하면 후원 번호와 안내를 바로 확인할 수 있습니다.
          </p>
          <LinkButton href="/" variant="secondary" size="lg" className="mt-4">
            크리에이터 코드 입력하기
          </LinkButton>
        </Card>
      </section>
    </PublicShell>
  );
}

function Step({
  no, icon, title, body, note, noteTone = 'neutral',
}: {
  no: number;
  icon: React.ReactNode;
  title: string;
  body: string;
  note?: string;
  noteTone?: 'neutral' | 'warning';
}) {
  return (
    <Card className="flex gap-3">
      <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        {icon}
        <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[11px] font-bold text-white">
          {no}
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-[14.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-500">{body}</p>
        {note ? (
          <p
            className={
              noteTone === 'warning'
                ? 'mt-2 rounded-lg bg-warning-50 px-3 py-2 text-[12.5px] leading-relaxed font-semibold text-ink-900'
                : 'mt-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] leading-relaxed text-ink-700'
            }
          >
            {note}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function Line({
  icon, title, body, tone,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  tone: 'neutral' | 'warning' | 'danger';
}) {
  const badge =
    tone === 'danger' ? 'bg-danger-50 text-danger-600'
    : tone === 'warning' ? 'bg-warning-50 text-warning-600'
    : 'bg-ink-50 text-brand-700';
  return (
    <div className="flex gap-3">
      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${badge}`}>{icon}</span>
      <div>
        <p className="text-[13.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </div>
  );
}

function HowAside() {
  return (
    <div className="sticky top-24 space-y-3">
      <Card>
        <CardTitle>한눈에 보기</CardTitle>
        <ol className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-500">
          <li>1. 후원 번호로 문자 발송</li>
          <li>2. 안내 링크에서 계좌 등록</li>
          <li>3. 문자 재발송 후 결제 확인</li>
          <li>4. 방송에 후원 메시지 노출</li>
        </ol>
      </Card>
      <Card>
        <CardTitle>도움이 더 필요하신가요</CardTitle>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          자주 묻는 질문에서 답을 찾지 못했다면 고객센터로 문의해 주세요.
        </p>
        <div className="mt-3 space-y-2">
          <LinkButton href="/faq" variant="secondary" size="md" className="w-full">
            자주 묻는 질문
          </LinkButton>
          <LinkButton href="/support" variant="secondary" size="md" className="w-full">
            고객센터 문의
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
