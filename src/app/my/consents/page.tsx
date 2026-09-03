import Link from 'next/link';
import {FileText, Check, X, ChevronLeft } from 'lucide-react';
import { Card, CardTitle, Badge, EmptyState, Notice, LinkButton } from '@/components/ui';
import { MarketingConsentForm } from '@/components/my/marketing-consent-form';
import { requireDonorContext } from '@/components/my/donor';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import type { ConsentType } from '@/generated/prisma/enums';

export const dynamic = 'force-dynamic';

const CONSENT_LABEL: Record<ConsentType, string> = {
  TERMS_SERVICE: '서비스 이용약관',
  PRIVACY: '개인정보 수집 및 이용',
  E_FINANCE: '전자금융거래 이용약관',
  WITHDRAWAL_AGREE: '출금이체 동의',
  AGE_CONFIRM: '만 19세 이상 확인',
  MARKETING: '마케팅 정보 수신 (선택)',
};

const CONSENT_LINK: Partial<Record<ConsentType, string>> = {
  TERMS_SERVICE: '/terms',
  PRIVACY: '/privacy',
  E_FINANCE: '/terms/e-finance',
};

export default async function MyConsentsPage() {
  const { user, donorId } = await requireDonorContext('/my/consents');

  const donor = donorId
    ? await prisma.donorProfile.findUnique({ where: { id: donorId }, select: { phoneHash: true } })
    : null;

  /**
   * 번호로 조회할 때는 **계정이 붙지 않은 기록만** 가져온다.
   *
   * 예전에는 `phoneHash` 만 맞으면 다른 계정(userId)으로 기록된 동의 이력까지 끌어왔다.
   * 통신사 번호 재배정이나 연결 해제 후 다른 사람이 같은 번호를 인증하면, 그 사람 화면에
   * 이전 이용자의 동의 이력이 그대로 보였다.
   * (문자만으로 동의한 이력은 userId 가 없으므로 이 조건으로도 정상적으로 표시된다)
   */
  const or: Array<{ userId: string } | { phoneHash: string; userId: null }> = [{ userId: user.id }];
  if (donor?.phoneHash) or.push({ phoneHash: donor.phoneHash, userId: null });

  const records = await prisma.consentRecord.findMany({
    where: { OR: or },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      type: true,
      agreed: true,
      createdAt: true,
      terms: { select: { title: true, version: true, effectiveFrom: true, required: true } },
    },
  });

  // 최신 마케팅 동의 상태 (이력 중 가장 최근 레코드 기준)
  const latestMarketing = records.find((r) => r.type === 'MARKETING');
  const marketingAgreed = latestMarketing?.agreed ?? false;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/my/account"
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-400 transition-colors hover:text-ink-900"
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
          내 정보로 돌아가기
        </Link>
        <h2 className="mt-1 text-[18px] font-black tracking-[-0.025em] text-ink-900">동의 이력</h2>
      </div>
      <Notice tone="brand">
        계좌 등록과 이용 동의 시점에 동의한 약관의 버전과 일시입니다. 약관이 변경되면 새 버전으로 다시 동의를 받습니다.
      </Notice>

      <MarketingConsentForm agreed={marketingAgreed} />

      {records.length === 0 ? (
        <EmptyState
          title="동의 이력이 없습니다"
          description="문자후원 계좌 등록 과정에서 약관에 동의하면 이곳에 기록이 표시됩니다."
        />
      ) : (
        <div className="space-y-2.5">
          {records.map((r) => {
            const href = CONSENT_LINK[r.type];
            return (
              <Card key={r.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
                      <FileText size={17} strokeWidth={1.7} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-[14px] font-bold text-ink-900">{CONSENT_LABEL[r.type]}</p>
                        <Badge tone={r.terms.required ? 'brand' : 'neutral'}>
                          {r.terms.required ? '필수' : '선택'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[12.5px] text-ink-500">{r.terms.title}</p>
                      <p className="mt-1 text-[12px] text-ink-400">
                        버전 {r.terms.version} · 시행일 {formatKst(r.terms.effectiveFrom, false)}
                      </p>
                      <p className="mt-0.5 text-[12px] tabular-nums text-ink-400">
                        동의 일시 {formatKst(r.createdAt)}
                      </p>
                      {href ? (
                        <LinkButton href={href} variant="secondary" size="sm" className="mt-2">
                          약관 전문 보기
                        </LinkButton>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0">
                    {r.agreed ? (
                      <Badge tone="success">
                        <Check size={13} strokeWidth={2} />
                        <span className="ml-1">동의</span>
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        <X size={13} strokeWidth={2} />
                        <span className="ml-1">미동의</span>
                      </Badge>
                    )}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardTitle>동의를 철회하고 싶다면</CardTitle>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          출금이체 동의는 등록 계좌 관리에서 해지할 수 있고, 마케팅 수신 동의는 이 페이지 상단에서 바로 철회할 수
          있습니다. 그 밖의 동의 철회나 개인정보 삭제 요청은 고객센터로 접수해 주세요.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <LinkButton href="/my/account" variant="secondary" size="md" className="w-full">
            등록 계좌 관리
          </LinkButton>
          <LinkButton href="/support" variant="secondary" size="md" className="w-full">
            고객센터 문의
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
