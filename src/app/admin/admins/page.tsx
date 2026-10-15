import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionButton, SelectActionForm } from '@/components/admin/action-form';
import { AdminInviteForm } from '@/components/admin/admin-invite-form';
import {
  createAdminInviteAction,
  revokeAdminInviteAction,
  updateAdminPermission,
  revokeAdmin,
} from '@/app/actions/admin/accounts';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import type { AdminPermission } from '@/generated/prisma/enums';
import { userStatusLabel } from '@/lib/labels';
import { requireAdminPage } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';

const PERMISSIONS: Array<{ value: AdminPermission; label: string; description: string }> = [
  { value: 'SUPER_ADMIN', label: '최고 관리자', description: '모든 기능 + 관리자 권한 변경' },
  { value: 'OPERATION', label: '운영', description: '회원·크리에이터·문자·방송 운영 (정산·환불 등 돈이 움직이는 작업 제외)' },
  { value: 'FINANCE', label: '재무', description: '정산·수수료·환불 처리' },
  { value: 'SUPPORT', label: '고객지원', description: '조회 및 일반 운영 (환불·정산 승인 제외)' },
  { value: 'READ_ONLY', label: '읽기 전용', description: '조회만 가능. 모든 변경 차단' },
];

const permissionLabel = Object.fromEntries(PERMISSIONS.map((p) => [p.value, p.label])) as Record<AdminPermission, string>;

export default async function AdminAdminsPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/admins');

  const now = new Date();
  const [me, admins, auditCounts, invites] = await Promise.all([
    getSessionUser(),
    prisma.adminProfile.findMany({
      // 자격이 회수된 계정은 목록 아래쪽으로 내린다.
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, userId: true, permission: true, memo: true, createdAt: true, revokedAt: true,
        user: { select: { email: true, name: true, status: true, lastLoginAt: true } },
        _count: { select: { auditLogs: true } },
      },
    }),
    prisma.adminAuditLog.count(),
    // [SEC-A] 최근 초대 내역(대기·수락·회수·만료). 토큰 원문은 저장하지 않으므로 링크는 다시 보여 줄 수 없다.
    prisma.adminInvite.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, email: true, permission: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true,
        invitedBy: { select: { email: true } },
      },
    }),
  ]);

  const superCount = admins.filter((a) => a.permission === 'SUPER_ADMIN' && !a.revokedAt).length;
  const isSuper = me?.adminPermission === 'SUPER_ADMIN';

  return (
    <>
      <PageHeader
        title="관리자 권한"
        description="권한 변경은 최고 관리자만 수행할 수 있으며, 본인 권한은 변경할 수 없습니다."
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="관리자 수" value={formatNumber(admins.length)} />
        <StatTile label="최고 관리자" value={formatNumber(superCount)} tone={superCount <= 1 ? 'warning' : 'brand'} />
        <StatTile
          label="읽기 전용"
          value={formatNumber(admins.filter((a) => a.permission === 'READ_ONLY' && !a.revokedAt).length)}
        />
        <StatTile label="누적 감사로그" value={formatNumber(auditCounts)} />
      </div>

      {!isSuper ? (
        <Notice tone="warning" title="권한 변경 권한이 없습니다">
          현재 계정의 권한은 {permissionLabel[(me?.adminPermission ?? 'READ_ONLY') as AdminPermission] ?? '미지정'} 입니다.
          권한 변경은 최고 관리자(SUPER_ADMIN)만 수행할 수 있습니다.
        </Notice>
      ) : (
        <Notice tone="neutral" title="권한 설계">
          마지막 최고 관리자는 강등할 수 없습니다. 읽기 전용 계정은 모든 서버 액션에서 변경이 차단되며, 정산·환불·수수료
          같이 돈이 움직이는 작업은 최고 관리자와 재무 권한만 수행할 수 있습니다(운영·고객지원 불가).
        </Notice>
      )}

      <div className="mt-4 grid grid-cols-1 gap-2.5 lg:grid-cols-5">
        {PERMISSIONS.map((p) => (
          <div key={p.value} className="rounded-xl border border-ink-100 bg-white px-3 py-2.5">
            <p className="text-[12px] font-bold text-ink-900">{p.label}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-400">{p.description}</p>
          </div>
        ))}
      </div>

      {isSuper ? (
        <div className="mt-5">
          <SectionTitle
            title="관리자 초대"
            description="이메일로 1회용 초대 링크(72시간)를 만듭니다. 초대받은 분이 그 이메일 계정으로 로그인한 상태에서 링크를 열어 수락해야 관리자가 됩니다. 크리에이터 계정은 겸직할 수 없습니다."
          />
          <Card>
            <AdminInviteForm
              action={createAdminInviteAction}
              permissions={PERMISSIONS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </Card>

          <div className="mt-4">
            <SectionTitle
              title="초대 내역"
              description="링크 원문은 저장하지 않아 다시 볼 수 없습니다. 링크를 잃어버렸으면 같은 이메일로 다시 초대해 주세요(이전 링크는 자동 회수)."
            />
            {invites.length === 0 ? (
              <EmptyState title="초대 내역이 없습니다" />
            ) : (
              <Table className="min-w-[760px]">
                <thead>
                  <tr>
                    <Th>이메일</Th>
                    <Th>권한</Th>
                    <Th>상태</Th>
                    <Th>초대한 사람</Th>
                    <Th>만료</Th>
                    <Th>관리</Th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => {
                    const status = inv.acceptedAt
                      ? { tone: 'success' as const, text: '수락됨' }
                      : inv.revokedAt
                        ? { tone: 'neutral' as const, text: '회수됨' }
                        : inv.expiresAt <= now
                          ? { tone: 'neutral' as const, text: '만료됨' }
                          : { tone: 'warning' as const, text: '수락 대기' };
                    const pending = !inv.acceptedAt && !inv.revokedAt && inv.expiresAt > now;
                    return (
                      <tr key={inv.id}>
                        <Td className="break-all">{inv.email}</Td>
                        <Td>{permissionLabel[inv.permission]}</Td>
                        <Td>
                          <Badge tone={status.tone}>{status.text}</Badge>
                        </Td>
                        <Td className="break-all">{inv.invitedBy.email ?? '-'}</Td>
                        <Td className="whitespace-nowrap">{formatKst(inv.expiresAt, false)}</Td>
                        <Td>
                          {pending ? (
                            <ActionButton
                              action={revokeAdminInviteAction}
                              values={{ inviteId: inv.id }}
                              label="초대 회수"
                              variant="danger"
                              confirm={`${inv.email} 초대 링크를 회수합니다. 이미 전달한 링크로는 더 이상 수락할 수 없습니다.`}
                            />
                          ) : (
                            <span className="text-[11px] text-ink-400">-</span>
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
      ) : null}

      <div className="mt-5">
        <SectionTitle title="관리자 목록" />
        {admins.length === 0 ? (
          <EmptyState title="등록된 관리자가 없습니다" />
        ) : (
          <Table className="min-w-[900px]">
            <thead>
              <tr>
                <Th>이메일</Th>
                <Th>이름</Th>
                <Th>계정 상태</Th>
                <Th>권한</Th>
                <Th>최근 로그인</Th>
                <Th className="text-right">감사로그</Th>
                <Th>권한 변경</Th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => {
                const isMe = a.userId === me?.id;
                const revoked = a.revokedAt != null;
                return (
                  <tr key={a.id}>
                    <Td className="break-all">
                      {a.user.email ?? '-'}
                      {isMe ? <Badge tone="brand" className="ml-1.5">본인</Badge> : null}
                      {revoked ? <Badge tone="danger" className="ml-1.5">자격 회수</Badge> : null}
                    </Td>
                    <Td>{a.user.name ?? '-'}</Td>
                    <Td>
                      <Badge tone={userStatusLabel[a.user.status].tone}>{userStatusLabel[a.user.status].text}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={revoked ? 'neutral' : a.permission === 'SUPER_ADMIN' ? 'brand' : 'neutral'}>
                        {revoked ? '권한 없음' : permissionLabel[a.permission]}
                      </Badge>
                      {revoked ? (
                        <span className="mt-0.5 block text-[11px] text-ink-400">
                          {formatKst(a.revokedAt, false)} 회수 · 감사로그 보존을 위해 목록에는 남습니다
                        </span>
                      ) : null}
                      {a.memo ? <span className="mt-0.5 block text-[11px] text-ink-400">{a.memo}</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap">{formatKst(a.user.lastLoginAt, false)}</Td>
                    <Td className="text-right tabular-nums">{formatNumber(a._count.auditLogs)}</Td>
                    <Td>
                      {revoked ? (
                        <span className="text-[11px] leading-relaxed text-ink-400">
                          다시 부여하려면 위 [관리자 초대]에서 같은 이메일로 초대해 주세요.
                        </span>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <SelectActionForm
                        ariaLabel="관리자 권한 등급 변경"
                            action={updateAdminPermission}
                            values={{ profileId: a.id }}
                            name="permission"
                            defaultValue={a.permission}
                            options={PERMISSIONS.map((p) => ({ value: p.value, label: p.label }))}
                            disabled={isMe || !isSuper}
                            hint={isMe ? '본인 권한은 변경할 수 없습니다.' : !isSuper ? '최고 관리자만 변경할 수 있습니다.' : undefined}
                            confirm={`${a.user.email ?? a.id} 의 권한을 변경합니다.`}
                          />
                          {/*
                            READ_ONLY 로 낮추는 것만으로는 후원자 연락처·결제 이력 열람이 그대로 남는다.
                            떠난 사람의 계정을 실제로 막으려면 자격 자체를 거둘 수단이 있어야 한다.
                          */}
                          <ActionButton
                            action={revokeAdmin}
                            values={{ profileId: a.id }}
                            label="관리자 자격 회수"
                            variant="danger"
                            disabled={isMe || !isSuper}
                            confirm={`${a.user.email ?? a.id} 의 관리자 자격을 회수합니다. 관리자 콘솔에 더 이상 접근할 수 없고 열려 있는 세션도 즉시 끊깁니다. 감사로그는 그대로 남습니다. 진행할까요?`}
                          />
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
