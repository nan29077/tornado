import Link from 'next/link';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { AdminField, AdminInput, AdminSelect, FilterBar, Pager } from '@/components/admin/controls';
import { ActionButton, SelectActionForm } from '@/components/admin/action-form';
import { PAGE_SIZE, parsePage, clampPageOrRedirect } from '@/components/admin/constants';
import { issueTemporaryPasswordAction, updateUserStatus } from '@/app/actions/admin/accounts';
import { issueCreatorMoNumberAction } from '@/app/actions/admin/transactions';
import { TempPasswordButton } from '@/components/admin/temp-password-button';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { formatMoNumber } from '@/server/emma';
import type { Prisma } from '@/generated/prisma/client';
import type { UserRole, UserStatus } from '@/generated/prisma/enums';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { userStatusLabel, adminPermissionLabel, creatorStatusLabel } from '@/lib/labels';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

/**
 * 회원 관리.
 *
 * 이 화면은 회원 계정을 다루는 곳이지만, **크리에이터에게 MO 번호를 부여하는 자리**이기도 하다.
 * 예전에는 번호 부여가 MO 번호 화면에만 있었고, 거기서는
 *   ① 번호를 직접 만들어 재고에 넣고 → ② 200행짜리 목록에서 그 번호를 찾아 → ③ 이름을 타이핑해 배정
 * 하는 세 단계를 거쳐야 했다. 담당자는 "어떤 번호를 만들어야 하는지"까지 알아야 했다.
 * 서브번호 4자리는 도네이도가 정하는 값이므로 사람이 고를 이유가 없다.
 * 여기서는 회원 목록의 그 줄에서 [번호 부여] 한 번으로 끝난다.
 */

const roleLabel: Record<UserRole, string> = { DONOR: '후원자', CREATOR: '크리에이터', ADMIN: '관리자' };

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; role?: string; status?: string; page?: string; mo?: string }>;
}) {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/users');

  const sp = await searchParams;
  const now = new Date();
  const page = parsePage(sp.page);
  const q = (sp.q ?? '').trim();
  const role = sp.role && sp.role in roleLabel ? (sp.role as UserRole) : undefined;
  const status = sp.status && sp.status in userStatusLabel ? (sp.status as UserStatus) : undefined;
  /** 'none' = 번호가 없는 크리에이터만. 번호 부여 대상을 한 번에 뽑기 위한 필터. */
  const moFilter = sp.mo === 'none' ? 'none' : undefined;

  const where: Prisma.UserWhereInput = {
    // 소프트 삭제(탈퇴 처리)된 계정은 목록·통계에서 제외한다.
    // 예전에는 필터도 표시도 없어 삭제된 계정이 "활성"처럼 보이고 상태 변경 버튼까지 열려 있었다.
    deletedAt: null,
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    /**
     * 번호 미부여 필터.
     * 승인된 크리에이터인데 ASSIGNED 번호가 하나도 없는 계정만 남긴다.
     * (미승인 채널은 애초에 번호를 줄 수 없으므로 대상이 아니다)
     */
    ...(moFilter === 'none'
      ? {
          creatorProfile: {
            is: { status: 'APPROVED', moRoutes: { none: { status: 'ASSIGNED' } } },
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
            // 크리에이터는 코드·활동명으로 찾는 일이 더 많다. 예전에는 이메일/이름만 검색돼서
            // 코드(TOR-8K2M)를 알고 있어도 이 화면에서는 찾을 수 없었다.
            { creatorProfile: { is: { code: { contains: q.toUpperCase() } } } },
            { creatorProfile: { is: { displayName: { contains: q, mode: 'insensitive' as const } } } },
          ],
        }
      : {}),
  };

  const [total, users, byStatus, moPendingCount, resetRequests] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      // 보조 정렬키가 없으면 같은 초에 만들어진 행들의 순서가 페이지마다 달라져
      // 목록에서 중복·누락이 생긴다(시드·일괄 생성에서 실제로 발생한다).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, email: true, name: true, role: true, status: true, avatarIndex: true,
        phoneMasked: true, lastLoginAt: true, createdAt: true,
        creatorProfile: {
          select: {
            id: true, displayName: true, code: true, avatarUrl: true, status: true,
            // 배정된 번호만 본다. 회수·중지된 행까지 가져오면 이미 끊긴 번호가 화면에 남는다.
            moRoutes: {
              where: { status: 'ASSIGNED' },
              orderBy: [{ assignedAt: 'asc' }],
              select: { phoneNumber: true, keyword: true },
            },
          },
        },
        donorProfile: { select: { id: true } },
        adminProfile: { select: { permission: true } },
      },
    }),
    // 타일도 화면의 필터를 따라야 한다. 예전에는 where 없이 전체를 세어,
    // "정지" 필터를 걸었는데 타일에는 전체 회원 수가 그대로 남아 두 숫자가 서로 어긋났다.
    prisma.user.groupBy({ by: ['status'], where, _count: { _all: true } }),
    // 번호가 없는 승인 크리에이터 수. 필터와 무관한 전체 기준이다(라벨로 명시).
    prisma.creatorProfile.count({
      where: { status: 'APPROVED', moRoutes: { none: { status: 'ASSIGNED' } } },
    }),
    // 이메일 발송 연동 전이라 재설정 링크 원문은 서버 로그에만 남는다.
    // 여기서는 "요청이 실제로 접수됐는지" 만 확인할 수 있게 최근 요청을 보여 준다.
    prisma.passwordResetToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, createdAt: true, expiresAt: true, usedAt: true, user: { select: { email: true } } },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 필터를 바꿔 결과가 줄었을 때 URL 의 옛 page 번호 때문에 빈 목록이 뜨는 것을 막는다.
  const params = { q, role: role ?? '', status: status ?? '', mo: moFilter ?? '' };
  clampPageOrRedirect('/admin/users', params, page, lastPage, total);
  const count = (s: UserStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="회원 관리"
        description="이메일·이름·크리에이터 코드로 검색하고, 계정 상태 변경과 크리에이터 MO 번호 부여를 한 자리에서 처리합니다. 상태 변경 시 활성 세션이 즉시 만료됩니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <StatTile
          label="전체 회원"
          value={formatNumber(byStatus.reduce((a, b) => a + b._count._all, 0))}
          sub="현재 조건 기준"
        />
        <StatTile label="활성" value={formatNumber(count('ACTIVE'))} tone="success" />
        <StatTile label="정지" value={formatNumber(count('SUSPENDED'))} tone="warning" />
        <StatTile label="탈퇴" value={formatNumber(count('WITHDRAWN'))} />
        <StatTile
          label="번호 미부여 크리에이터"
          value={formatNumber(moPendingCount)}
          sub="승인됐지만 MO 번호가 없음 · 전체 기준"
          tone={moPendingCount > 0 ? 'danger' : 'success'}
        />
      </div>

      {moPendingCount > 0 && moFilter !== 'none' ? (
        <div className="mb-4">
          <Notice tone="danger" title={`MO 번호가 없는 승인 크리에이터가 ${formatNumber(moPendingCount)}명 있습니다`}>
            이 크리에이터들은 승인은 됐지만 <strong>문자후원을 한 통도 받을 수 없습니다.</strong> 아래 목록의
            [번호 부여] 버튼으로 즉시 발급할 수 있습니다.{' '}
            <Link href="/admin/users?mo=none" className="font-bold text-brand-700 underline">
              번호 미부여 크리에이터만 보기
            </Link>
          </Notice>
        </div>
      ) : null}

      <FilterBar action="/admin/users" resetHref="/admin/users">
        <AdminField label="검색 (이메일/이름/코드)" className="w-60">
          <AdminInput name="q" defaultValue={q} placeholder="example@tornado.kr 또는 TOR-8K2M" />
        </AdminField>
        <AdminField label="회원 유형" className="w-36">
          <AdminSelect name="role" defaultValue={role ?? ''}>
            <option value="">전체</option>
            {(Object.keys(roleLabel) as UserRole[]).map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="상태" className="w-36">
          <AdminSelect name="status" defaultValue={status ?? ''}>
            <option value="">전체</option>
            {(Object.keys(userStatusLabel) as UserStatus[]).map((s) => (
              <option key={s} value={s}>
                {userStatusLabel[s].text}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="MO 번호" className="w-40">
          <AdminSelect name="mo" defaultValue={moFilter ?? ''}>
            <option value="">전체</option>
            <option value="none">번호 미부여 크리에이터</option>
          </AdminSelect>
        </AdminField>
      </FilterBar>

      <Notice tone="neutral" title="개인정보 표시 원칙">
        전화번호는 마스킹된 값만 표시합니다. 원문 전화번호·계좌번호는 관리자 화면에서도 조회할 수 없습니다.
      </Notice>

      <div className="mt-4">
        {users.length === 0 ? (
          <EmptyState
            title="조건에 맞는 회원이 없습니다"
            description={moFilter === 'none' ? '번호가 없는 승인 크리에이터가 없습니다.' : '검색어나 필터를 조정해 보세요.'}
          />
        ) : (
          <>
            <Table className="min-w-[1180px]">
              <thead>
                <tr>
                  <Th>이메일</Th>
                  <Th>이름</Th>
                  <Th>유형</Th>
                  <Th>연락처</Th>
                  <Th>MO 번호</Th>
                  <Th>상태</Th>
                  <Th>최근 로그인</Th>
                  <Th>상태 변경</Th>
                  <Th>비밀번호</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const creator = u.creatorProfile;
                  const assigned = creator?.moRoutes ?? [];
                  return (
                    <tr key={u.id}>
                      <Td className="max-w-[200px] break-all">{u.email ?? '-'}</Td>
                      <Td>
                        <div className="flex min-w-[150px] items-center gap-2.5">
                          <ProfileAvatar
                            seed={creator?.code ?? u.id}
                            avatarIndex={u.avatarIndex}
                            imageUrl={creator?.avatarUrl}
                            name={u.name}
                            className="h-9 w-9"
                          />
                          <div className="min-w-0">
                            <span className="block truncate font-semibold text-ink-900">{u.name ?? '-'}</span>
                            {creator ? (
                              <Link
                                href={`/admin/creators/${creator.id}`}
                                className="mt-0.5 block text-[11px] font-semibold text-brand-700"
                              >
                                {creator.displayName} ({creator.code})
                              </Link>
                            ) : null}
                            {u.donorProfile ? (
                              <Link
                                href={`/admin/donors/${u.donorProfile.id}`}
                                className="mt-0.5 block text-[11px] font-semibold text-brand-700"
                              >
                                후원자 상세
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={u.role === 'ADMIN' ? 'brand' : 'neutral'}>{roleLabel[u.role]}</Badge>
                        {u.adminProfile ? (
                          <span className="mt-0.5 block text-[11px] text-ink-400">
                            {adminPermissionLabel[u.adminProfile.permission]}
                          </span>
                        ) : null}
                      </Td>
                      <Td>{u.phoneMasked ?? '-'}</Td>

                      {/*
                        MO 번호 칸.
                        크리에이터가 아닌 계정에는 아무것도 그리지 않는다(빈 칸이 곧 "해당 없음"이다).
                        승인 전에는 번호를 줄 수 없으므로 버튼 대신 이유를 보여 준다.
                      */}
                      <Td>
                        {!creator ? (
                          <span className="text-[12px] text-ink-300">-</span>
                        ) : assigned.length > 0 ? (
                          <>
                            {assigned.map((m) => (
                              <span
                                key={`${m.phoneNumber}-${m.keyword ?? ''}`}
                                className="block font-mono text-[12.5px] font-semibold text-ink-900"
                              >
                                {formatMoNumber(m.phoneNumber)}
                                {m.keyword ? ` (${m.keyword})` : ''}
                              </span>
                            ))}
                          </>
                        ) : creator.status !== 'APPROVED' ? (
                          <div className="flex flex-col gap-1">
                            <Badge tone={creatorStatusLabel[creator.status].tone}>
                              {creatorStatusLabel[creator.status].text}
                            </Badge>
                            <span className="text-[11px] leading-tight text-ink-400">승인 후 부여 가능</span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone="warning">미부여</Badge>
                            <ActionButton
                              action={issueCreatorMoNumberAction}
                              values={{ creatorId: creator.id }}
                              label="번호 부여"
                              variant="primary"
                              confirm={`${creator.displayName} 님에게 대표번호 + 서브번호 4자리를 자동 발급합니다. 발급 즉시 문자후원을 받을 수 있습니다.`}
                            />
                          </div>
                        )}
                      </Td>

                      <Td>
                        <Badge tone={userStatusLabel[u.status].tone}>{userStatusLabel[u.status].text}</Badge>
                        <span className="mt-0.5 block text-[11px] text-ink-400">
                          가입 {formatKst(u.createdAt, false)}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">{formatKst(u.lastLoginAt, false)}</Td>
                      <Td>
                        <SelectActionForm
                          ariaLabel={`${u.email ?? u.id} 계정 상태 변경`}
                          action={updateUserStatus}
                          values={{ userId: u.id }}
                          name="status"
                          defaultValue={u.status}
                          options={[
                            { value: 'ACTIVE', label: '활성' },
                            { value: 'SUSPENDED', label: '정지' },
                            { value: 'WITHDRAWN', label: '탈퇴' },
                          ]}
                          confirm={`${u.email ?? u.id} 회원의 상태를 변경합니다. 계속할까요?`}
                        />
                      </Td>
                      <Td>
                        <TempPasswordButton
                          action={issueTemporaryPasswordAction}
                          userId={u.id}
                          label={u.email ?? u.id}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager basePath="/admin/users" params={params} page={page} lastPage={lastPage} total={total} />
          </>
        )}
      </div>

      <div className="mt-4">
        <SectionTitle
          title="최근 비밀번호 재설정 요청"
          description="사용자가 로그인 화면에서 직접 요청한 건입니다. 최근 10건."
        />
        <Notice tone="warning" title="재설정 링크 원문은 관리자도 볼 수 없습니다">
          링크 토큰은 해시로만 저장됩니다. 이메일 발송 연동 전까지는 링크 원문이 서버 로그에만 남으므로,
          사용자에게 직접 안내해야 할 때는 본인 확인 후 회원 목록의 [임시 비밀번호] 버튼을 사용해 주세요.
        </Notice>
        <div className="mt-3">
          {resetRequests.length === 0 ? (
            <EmptyState title="접수된 재설정 요청이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>이메일</Th>
                  <Th>요청 시각</Th>
                  <Th>만료 시각</Th>
                  <Th>상태</Th>
                </tr>
              </thead>
              <tbody>
                {resetRequests.map((r) => {
                  const expired = r.expiresAt.getTime() < now.getTime();
                  return (
                    <tr key={r.id}>
                      <Td className="max-w-[220px] break-all">{r.user.email ?? '-'}</Td>
                      <Td className="whitespace-nowrap">{formatKst(r.createdAt)}</Td>
                      <Td className="whitespace-nowrap">{formatKst(r.expiresAt)}</Td>
                      <Td>
                        {r.usedAt ? (
                          <Badge tone="success">사용됨</Badge>
                        ) : expired ? (
                          <Badge tone="neutral">만료</Badge>
                        ) : (
                          <Badge tone="brand">대기 중</Badge>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </>
  );
}
