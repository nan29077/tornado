import type { Metadata } from 'next';
import {
  AlertTriangle,
  Ban,
  CircleX,
  Clock,
  Hourglass,
  MessageSquare,
  Phone,
  Wallet,
} from 'lucide-react';
import { Card, CardTitle, DataRow, Notice } from '@/components/ui';
import { prisma } from '@/server/db';
import { resolveSecureLink } from '@/server/services/secure-link';
import { loadRegistrationContext } from '@/server/services/donor-registration';
import { loadConfirmContext } from '@/server/services/donation-confirm';
import { resolvePolicy } from '@/server/services/limits';
import { formatWon } from '@/lib/money';
import { computeFees } from '@/server/services/settlement';
import { LinkShell } from './link-shell';
import { RegisterForm, type TermsItem } from './register-form';
import { defaultDonorName } from '@/lib/donor-name';
import { ConfirmPanel } from './confirm-panel';

/**
 * MT 문자로 발송된 1회용 보안링크 진입점.
 *  - REGISTER_ACCOUNT : 최초 계좌 등록 + 이용 동의
 *  - CONFIRM_PAYMENT  : 문자후원 결제 확인
 * 검색엔진 색인을 막고, 항상 서버에서 새로 검증한다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '도네이도 후원 확인',
  robots: { index: false, follow: false },
};

export default async function SecureLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await resolveSecureLink(token);

  if (!res.ok) {
    return (
      <LinkShell>
        <InvalidLink reason={res.reason} />
      </LinkShell>
    );
  }

  const purpose = res.link!.purpose;

  if (purpose === 'REGISTER_ACCOUNT') {
    return (
      <LinkShell>
        <RegisterScreen token={token} />
      </LinkShell>
    );
  }

  if (purpose === 'CONFIRM_PAYMENT') {
    return (
      <LinkShell>
        <ConfirmScreen token={token} />
      </LinkShell>
    );
  }

  return (
    <LinkShell>
      <Card>
        <CardTitle>지원하지 않는 링크입니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
          이 링크의 용도는 현재 화면에서 처리할 수 없습니다. 고객센터로 문의해 주세요.
        </p>
      </Card>
    </LinkShell>
  );
}

// --------------------------------------------------------------- 링크 오류 화면

function InvalidLink({ reason }: { reason: 'NOT_FOUND' | 'EXPIRED' | 'USED' }) {
  if (reason === 'EXPIRED') {
    return (
      <Card>
        <div className="flex items-center gap-2 text-warning-600">
          <Hourglass size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">확인 시간이 지났습니다</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
          확인 시간이 지나 후원이 자동 취소되었습니다. 결제는 진행되지 않았습니다.
        </p>
        <div className="mt-3">
          <Notice tone="neutral">
            다시 후원하시려면 크리에이터 번호로 문자를 새로 보내주세요. 새 확인 링크가 발송됩니다.
          </Notice>
        </div>
      </Card>
    );
  }

  if (reason === 'USED') {
    return (
      <Card>
        <div className="flex items-center gap-2 text-ink-500">
          <Clock size={20} strokeWidth={1.7} />
          <p className="text-[16px] font-extrabold text-ink-900">이미 처리된 링크입니다</p>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
          이 링크는 1회만 사용할 수 있으며 이미 사용되었습니다. 처리 결과는 문자로 안내되었습니다.
        </p>
        <div className="mt-3">
          <Notice tone="neutral">
            같은 링크를 다시 열어도 중복 결제는 발생하지 않습니다. 결과가 확인되지 않으면 고객센터로 문의해 주세요.
          </Notice>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-2 text-danger-600">
        <CircleX size={20} strokeWidth={1.7} />
        <p className="text-[16px] font-extrabold text-ink-900">유효하지 않은 링크입니다</p>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
        주소가 잘못되었거나 더 이상 사용할 수 없는 링크입니다. 결제는 진행되지 않았습니다.
      </p>
      <div className="mt-3">
        <Notice tone="warning" title="주의">
          도네이도는 문자로 발송한 링크 외에 다른 경로로 계좌 정보를 요구하지 않습니다.
        </Notice>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- 계좌 등록 화면

async function RegisterScreen({ token }: { token: string }) {
  const loaded = await loadRegistrationContext(token);
  if (!loaded.ok) {
    return (
      <Card>
        <CardTitle>등록을 진행할 수 없습니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
      </Card>
    );
  }
  const ctx = loaded.ctx;

  // 시행일이 도래한 정책·약관만 노출한다.
  const nowForPolicy = new Date();
  const [moNumber, feePolicy, policy, termsRows] = await Promise.all([
    ctx.creatorId
      ? prisma.creatorMoNumber.findFirst({ where: { creatorId: ctx.creatorId, status: 'ASSIGNED' } })
      : Promise.resolve(null),
    prisma.feePolicy.findFirst({
      where: {
        scope: 'GLOBAL',
        active: true,
        effectiveFrom: { lte: nowForPolicy },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: nowForPolicy } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    }),
    resolvePolicy(ctx.creatorId, ctx.donorId, nowForPolicy),
    prisma.termsVersion.findMany({
      // TermsVersion 은 종료일이 없다(신 버전 등록 시 구 버전 active=false 처리).
      where: { active: true, effectiveFrom: { lte: nowForPolicy } },
      orderBy: [{ required: 'desc' }, { effectiveFrom: 'desc' }],
    }),
  ]);

  const amount = ctx.donationAmount;
  // 실제 정산과 같은 계산식을 쓴다. 화면에서 따로 계산하면 부가세 처리가 어긋난다.
  const fees = computeFees(amount, {
    pgFeeRate: feePolicy ? feePolicy.pgFeeRate.toString() : '0.018',
    pgFixedFee: feePolicy?.pgFixedFee ?? 0n,
    platformFeeRate: feePolicy ? feePolicy.platformFeeRate.toString() : '0.15',
    vatIncluded: feePolicy ? feePolicy.vatIncluded : true,
  });
  const pgFixed = feePolicy?.pgFixedFee ?? 0n;
  const pct = (rate: string) => `${(Number(rate) * 100).toFixed(1)}%`;

  // 동일 유형의 약관이 여러 버전 활성화된 경우 최신(effectiveFrom 최신) 1건만 노출한다.
  const seenTypes = new Set<string>();
  const terms: TermsItem[] = [];
  for (const t of termsRows) {
    if (seenTypes.has(t.type)) continue;
    seenTypes.add(t.type);
    terms.push({
      id: t.id,
      type: t.type,
      title: t.title,
      content: t.content,
      required: t.required,
      version: t.version,
    });
  }

  return (
    <div className="space-y-3">
      <Card>
        <p className="text-[12px] font-semibold text-brand-700">최초 1회 계좌 등록</p>
        <h1 className="mt-1 text-[20px] font-extrabold leading-snug tracking-tight text-ink-900">
          {ctx.creatorName ?? '크리에이터'} 후원을 위한
          <br />
          계좌 등록과 이용 동의
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          보내주신 최초 문자는 후원 처리되지 않았습니다. 아래 내용을 확인하고 등록을 완료해 주세요.
        </p>
        <div className="mt-3">
          <DataRow label="후원 대상" value={ctx.creatorName ?? '-'} />
          <DataRow
            label="후원 번호"
            value={
              moNumber ? (
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={14} strokeWidth={1.7} className="text-brand-700" />
                  {moNumber.phoneNumber}
                  {moNumber.keyword ? <span className="text-ink-400">({moNumber.keyword} 로 시작)</span> : null}
                </span>
              ) : (
                '배정 준비 중'
              )
            }
          />
          <DataRow label="신청 번호" value={ctx.phoneMasked} />
        </div>
      </Card>

      <Notice tone="danger" title="문자를 보내면 계좌에서 출금이 요청됩니다">
        등록을 마친 뒤 위 후원 번호로 문자를 보내면, 문자 1건마다 등록한 계좌에서 {formatWon(amount)}의 출금이
        요청됩니다. 실수로 반복 발송하면 발송한 건수만큼 출금이 요청되니 주의해 주세요.
      </Notice>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Wallet size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>후원금과 수수료</CardTitle>
        </div>
        <DataRow label="문자 1건당 후원금" value={formatWon(amount)} />
        <DataRow label="후원자 출금 금액" value={`${formatWon(amount)} (수수료 별도 부담 없음)`} />
        <DataRow
          label="결제 수수료"
          value={`${pct(fees.pgFeeRate)}${pgFixed > 0n ? ` + ${formatWon(pgFixed)}` : ''} (${formatWon(fees.pgFeeSupply)})`}
        />
        <DataRow label="플랫폼 수수료" value={`${pct(fees.platformFeeRate)} (${formatWon(fees.platformFeeSupply)})`} />
        {fees.vat > 0n ? <DataRow label="수수료 부가세 (10%)" value={formatWon(fees.vat)} /> : null}
        <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
          수수료{fees.vat > 0n ? '와 그 부가세는' : '는'} 크리에이터 정산금에서 차감되며, 후원자는 문자 1건당
          후원금만 출금됩니다. 문자 발송 요금은 통신사 정책에 따라 별도로 부과될 수 있습니다.
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <MessageSquare size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>이용 한도</CardTitle>
        </div>
        <DataRow label="1일 최대" value={formatWon(policy.donorDailyLimit)} />
        <DataRow label="1개월 최대" value={formatWon(policy.donorMonthlyLimit)} />
        <DataRow label="크리에이터별 1일 최대" value={formatWon(policy.perCreatorDailyLimit)} />
        <DataRow label="신규 후원자 첫날 최대" value={formatWon(policy.newDonorFirstDayLimit)} />
        <DataRow
          label="연속 후원 제한"
          value={`${policy.velocityWindowSec}초 내 ${policy.velocityMaxCount}건`}
        />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
          한도를 초과하면 결제가 진행되지 않고 문자로 안내됩니다. 한도는 마이페이지에서 더 낮게 설정할 수 있습니다.
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-warning-50 text-warning-600">
            <AlertTriangle size={17} strokeWidth={1.7} />
          </span>
          <CardTitle>취소·환불과 이용 제한</CardTitle>
        </div>
        <ul className="space-y-2 text-[13px] leading-relaxed text-ink-700">
          <li>결제 완료 후 방송에 노출되기 전까지는 고객센터를 통해 취소를 요청할 수 있습니다.</li>
          <li>이미 방송에 노출된 후원은 원칙적으로 취소가 어려우며, 오류·중복 결제 등은 확인 후 환불 처리됩니다.</li>
          <li>환불은 출금된 계좌로 처리되며, 처리까지 영업일 기준 시간이 소요될 수 있습니다.</li>
          <li>결제 실패가 반복되면 이용이 일시 잠금되며, 관리자 확인 후 해제됩니다.</li>
          <li className="flex gap-2">
            <Ban size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-danger-600" />
            <span>만 19세 미만은 이용할 수 없습니다. 본인 명의 계좌로만 등록해 주세요.</span>
          </li>
        </ul>
      </Card>

      <RegisterForm token={token} terms={terms} defaultName={defaultDonorName(ctx.phoneMasked)} />
    </div>
  );
}

// ------------------------------------------------------------- 결제 확인 화면

async function ConfirmScreen({ token }: { token: string }) {
  const loaded = await loadConfirmContext(token);
  if (!loaded.ok) {
    return (
      <Card>
        <CardTitle>확인을 진행할 수 없습니다</CardTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
      </Card>
    );
  }
  const ctx = loaded.ctx;

  return (
    <ConfirmPanel
      token={token}
      creatorName={ctx.creatorName}
      amountText={formatWon(ctx.amount)}
      buttonText={`${formatWon(ctx.amount)} 후원하기`}
      message={ctx.message}
      expiresAtIso={ctx.expiresAt.toISOString()}
      donorId={ctx.donorId ?? undefined}
      donorNickname={ctx.donorNickname ?? undefined}
      donorSnsPlatform={ctx.donorSnsPlatform ?? undefined}
    />
  );
}
