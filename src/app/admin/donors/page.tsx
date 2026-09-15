import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, PAID_DONATION_STATUSES, clampPageOrRedirect } from '@/components/admin/constants';
import { bankLabel } from '@/components/admin/mask';
import {
  unlockDonor,
  setDonorBlock,
  updateDonorLimitsByAdmin,
  findDonorByPhoneAction,
} from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { Prisma } from '@/generated/prisma/client';
import { donorOnboardingStatusLabel } from '@/lib/labels';
import { maskPhone } from '@/lib/crypto';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

type StateFilter = '' | 'LOCKED' | 'BLOCKED' | 'REGISTERED' | 'UNREGISTERED';

export default async function AdminDonorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string; page?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/donors');

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const state = (['LOCKED', 'BLOCKED', 'REGISTERED', 'UNREGISTERED'].includes(sp.state ?? '')
    ? sp.state
    : '') as StateFilter;

  const now = new Date();
  /**
   * **주소창에 평문 전화번호를 남기지 않는다 (A-9).**
   *
   * 목록 필터는 GET 폼이라 입력값이 그대로 `?q=` 에 실리고, 웹서버 접근로그·브라우저
   * 방문기록·Referer 헤더에 전체 번호가 남는다. 화면은 마스킹해 두고 주소창으로 새면
   * 마스킹이 무의미하다.
   *
   * 그래서 전체 번호가 GET 으로 들어오면 **조회하지 않고 곧바로 마스킹 형태로 주소를 바꾼다.**
   * 전체 번호로 한 명을 찾는 일은 아래 POST 폼(`findDonorByPhoneAction`)이 맡는다.
   * `q` 에는 `010-****-5432` 같은 마스킹 값만 남으므로, 뒤 4자리 부분 검색은 그대로 동작한다.
   */
  const digits = q.replace(/[^0-9]/g, '');
  if (/^01[0-9]{8,9}$/.test(digits)) {
    redirect(`/admin/donors?${new URLSearchParams({ q: maskPhone(digits), ...(state ? { state } : {}) }).toString()}`);
  }

  const where: Prisma.DonorProfileWhereInput = {
    // 번호 재사용으로 분리된(은퇴) 프로필은 기본 목록에서 감춘다.
    retiredAt: null,
    ...(q ? { phoneMasked: { contains: q } } : {}),
    ...(state === 'LOCKED' ? { lockedUntil: { gt: now } } : {}),
    ...(state === 'BLOCKED' ? { blockedAt: { not: null } } : {}),
    ...(state === 'REGISTERED' ? { registeredAt: { not: null } } : {}),
    ...(state === 'UNREGISTERED' ? { registeredAt: null } : {}),
  };

  const [total, donors, lockedCount, blockedCount, registeredCount] = await Promise.all([
    prisma.donorProfile.count({ where }),
    prisma.donorProfile.findMany({
      where,
      // 보조 정렬키로 페이지 간 중복·누락을 막는다.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, phoneMasked: true, displayName: true, createdAt: true, registeredAt: true,
        onboardingStatus: true, registrationLinkSentAt: true,
        failCount: true, lockedUntil: true, blockedAt: true, blockedReason: true,
        dailyLimit: true, monthlyLimit: true,
        paymentTokens: {
          where: { status: 'ACTIVE' },
          select: { bankName: true, accountTail4: true, registeredAt: true },
          take: 1,
          orderBy: { registeredAt: 'desc' },
        },
      },
    }),
    prisma.donorProfile.count({ where: { lockedUntil: { gt: now } } }),
    prisma.donorProfile.count({ where: { blockedAt: { not: null } } }),
    prisma.donorProfile.count({ where: { registeredAt: { not: null } } }),
  ]);

  const donorIds = donors.map((d) => d.id);
  const totals = donorIds.length
    ? await prisma.donation.groupBy({
        by: ['donorId'],
        where: { donorId: { in: donorIds }, status: { in: PAID_DONATION_STATUSES } },
        _sum: { amount: true },
        _count: { _all: true },
      })
    : [];
  const totalMap = new Map(totals.map((t) => [t.donorId ?? '', t]));

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  clampPageOrRedirect('/admin/donors', { q, state }, page, lastPage, total);

  return (
    <>
      <PageHeader
        title="후원자 관리"
        description="문자만으로 생성된 후원자를 포함합니다. 전화번호는 마스킹, 계좌는 은행명과 끝 4자리만 표시합니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="전체 후원자" value={formatNumber(total)} sub="현재 조건 기준" />
        <StatTile label="계좌 등록 완료" value={formatNumber(registeredCount)} tone="success" />
        <StatTile label="결제 실패 잠금" value={formatNumber(lockedCount)} tone={lockedCount > 0 ? 'warning' : 'neutral'} />
        <StatTile label="이용 제한" value={formatNumber(blockedCount)} tone={blockedCount > 0 ? 'danger' : 'neutral'} />
      </div>

      {/*
        전체 번호 조회는 POST 로만 받는다. 주소창·접근로그에 평문 번호를 남기지 않기 위함이다.
        찾으면 후원자 상세로 바로 이동한다.
      */}
      <div className="mb-3 max-w-md">
        <ActionForm
          action={findDonorByPhoneAction}
          submitLabel="번호로 찾기"
          variant="secondary"
          compact
        >
          <AdminField
            label="전화번호로 정확히 찾기"
            hint="전체 번호는 주소창에 남지 않습니다. 찾으면 해당 후원자 상세로 이동합니다."
            className="w-60"
          >
            <AdminInput name="phone" inputMode="tel" placeholder="010-9876-5432" autoComplete="off" />
          </AdminField>
        </ActionForm>
      </div>

      <FilterBar action="/admin/donors" resetHref="/admin/donors">
        <AdminField label="마스킹 번호 검색" className="w-60">
          <AdminInput name="q" defaultValue={q} placeholder="010-****-5432" />
        </AdminField>
        <AdminField label="상태" className="w-44">
          <AdminSelect name="state" defaultValue={state}>
            <option value="">전체</option>
            <option value="REGISTERED">계좌 등록 완료</option>
            <option value="UNREGISTERED">계좌 미등록</option>
            <option value="LOCKED">결제 실패 잠금</option>
            <option value="BLOCKED">이용 제한</option>
          </AdminSelect>
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="잠금과 이용 제한은 다릅니다">
        결제 실패 잠금은 연속 실패로 자동 설정되며 관리자 해제 전까지 후원이 접수되지 않습니다. 이용 제한은 운영 판단에
        따른 수동 차단입니다.
      </Notice>

      <div className="mt-4">
        {donors.length === 0 ? (
          <EmptyState title="조건에 맞는 후원자가 없습니다" />
        ) : (
          <>
            <Table className="min-w-[1100px]">
              <thead>
                <tr>
                  <Th>연락처</Th>
                  <Th>등록일</Th>
                  <Th>계좌 등록</Th>
                  <Th className="text-right">누적 후원</Th>
                  <Th className="text-right">실패</Th>
                  <Th>잠금·제한</Th>
                  <Th>개인 한도</Th>
                  <Th>처리</Th>
                </tr>
              </thead>
              <tbody>
                {donors.map((d) => {
                  const agg = totalMap.get(d.id);
                  const token = d.paymentTokens[0];
                  const locked = d.lockedUntil != null && d.lockedUntil > now;
                  return (
                    <tr key={d.id}>
                      <Td>
                        <Link href={`/admin/donors/${d.id}`} className="font-semibold text-brand-700">
                          {d.phoneMasked}
                        </Link>
                        {d.displayName ? (
                          <span className="mt-0.5 block text-[11px] text-ink-400">{d.displayName}</span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">{formatKst(d.createdAt, false)}</Td>
                      <Td>
                        {token ? (
                          <>
                            <Badge tone={donorOnboardingStatusLabel[d.onboardingStatus].tone}>
                              {donorOnboardingStatusLabel[d.onboardingStatus].text}
                            </Badge>
                            <span className="mt-0.5 block text-[11px] text-ink-500">
                              {bankLabel(token.bankName, token.accountTail4)}
                            </span>
                          </>
                        ) : (
                          <>
                            <Badge tone={donorOnboardingStatusLabel[d.onboardingStatus].tone}>
                              {donorOnboardingStatusLabel[d.onboardingStatus].text}
                            </Badge>
                            {d.registrationLinkSentAt ? (
                              <span className="mt-0.5 block text-[11px] text-ink-400">
                                {formatKst(d.registrationLinkSentAt, false)}
                              </span>
                            ) : null}
                          </>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {formatWon(agg?._sum.amount ?? 0n)}
                        <span className="mt-0.5 block text-[11px] text-ink-400">{formatNumber(agg?._count._all ?? 0)}건</span>
                      </Td>
                      <Td className="text-right tabular-nums">{formatNumber(d.failCount)}</Td>
                      <Td>
                        {locked ? <Badge tone="warning">잠금 {formatKst(d.lockedUntil, false)}</Badge> : null}
                        {d.blockedAt ? (
                          <>
                            <Badge tone="danger">이용 제한</Badge>
                            <span className="mt-0.5 block max-w-[160px] text-[11px] break-words text-ink-400">
                              {d.blockedReason ?? '-'}
                            </span>
                          </>
                        ) : null}
                        {!locked && !d.blockedAt ? <Badge tone="success">정상</Badge> : null}
                      </Td>
                      <Td className="text-[12px]">
                        <details>
                          <summary className="cursor-pointer text-brand-700">
                            {d.dailyLimit != null || d.monthlyLimit != null ? '개별 설정됨' : '정책 기본값'}
                          </summary>
                          <div className="mt-2 w-52">
                            <ActionForm action={updateDonorLimitsByAdmin} submitLabel="한도 저장" variant="secondary" compact>
                              <input type="hidden" name="donorId" value={d.id} />
                              <AdminField label="일 한도 (비우면 정책값)">
                                <AdminInput
                                  name="dailyLimit"
                                  inputMode="numeric"
                                  defaultValue={d.dailyLimit != null ? d.dailyLimit.toString() : ''}
                                />
                              </AdminField>
                              <AdminField label="월 한도 (비우면 정책값)">
                                <AdminInput
                                  name="monthlyLimit"
                                  inputMode="numeric"
                                  defaultValue={d.monthlyLimit != null ? d.monthlyLimit.toString() : ''}
                                />
                              </AdminField>
                            </ActionForm>
                          </div>
                        </details>
                      </Td>
                      <Td>
                        <div className="flex flex-col gap-1.5">
                          <ActionButton
                            action={unlockDonor}
                            values={{ donorId: d.id }}
                            label="잠금 해제"
                            disabled={!locked && d.failCount === 0}
                            confirm="결제 실패 잠금을 해제하고 실패 횟수를 0으로 되돌립니다."
                          />
                          {d.blockedAt ? (
                            <ActionButton
                              action={setDonorBlock}
                              values={{ donorId: d.id, next: 'UNBLOCK' }}
                              label="제한 해제"
                              confirm="이 후원자의 이용 제한을 해제합니다."
                            />
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-[12px] text-danger-600">이용 제한</summary>
                              <div className="mt-1.5 w-48">
                                <ActionForm
                                  action={setDonorBlock}
                                  submitLabel="제한 적용"
                                  variant="danger"
                                  compact
                                  confirm="이 후원자의 이용을 제한합니다. 이후 문자후원이 접수되지 않습니다."
                                >
                                  <input type="hidden" name="donorId" value={d.id} />
                                  <input type="hidden" name="next" value="BLOCK" />
                                  <AdminField label="제한 사유">
                                    <AdminInput name="reason" placeholder="예: 반복 분쟁 신고" />
                                  </AdminField>
                                </ActionForm>
                              </div>
                            </details>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              basePath="/admin/donors"
              params={{ q, state }}
              page={page}
              lastPage={lastPage}
              total={total}
            />
          </>
        )}
      </div>
    </>
  );
}
