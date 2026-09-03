import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Notice, SectionTitle, StatTile, Table, Td, Th } from '@/components/ui';
import { ActionButton, ActionForm, SelectActionForm } from '@/components/admin/action-form';
import { AdminInput, AdminSelect } from '@/components/admin/controls';
import { createAdminByEmail, updateAdminPermission, revokeAdmin } from '@/app/actions/admin/accounts';
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
  { value: 'OPERATION', label: '운영', description: '회원·크리에이터·문자·방송 운영' },
  { value: 'FINANCE', label: '재무', description: '정산·수수료·환불 처리' },
  { value: 'SUPPORT', label: '고객지원', description: '조회 및 일반 운영 (환불·정산 승인 제외)' },
  { value: 'READ_ONLY', label: '읽기 전용', description: '조회만 가능. 모든 변경 차단' },
];

const permissionLabel = Object.fromEntries(PERMISSIONS.map((p) => [p.value, p.label])) as Record<AdminPermission, string>;

export default async function AdminAdminsPage() {
  // 레이아웃 가드에만 기대지 않는다. 레이아웃과 페이지는 병렬로 렌더되므로
  // 이 호출이 없으면 권한 없는 요청에서도 아래 조회가 먼저 실행된다.
  await requireAdminPage('/admin/admins');

  const [me, admins, auditCounts] = await Promise.all([
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
          마지막 최고 관리자는 강등할 수 없습니다. 읽기 전용 계정은 모든 서버 액션에서 변경이 차단되며, 고객지원
          권한은 환불 승인과 정산 처리를 수행할 수 없습니다.
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
            title="관리자 추가"
            description="기존에 가입된 계정을 관리자로 승격합니다. 크리에이터 계정은 겸직할 수 없습니다."
          />
          <Card>
            <ActionForm
              action={createAdminByEmail}
              submitLabel="관리자로 등록"
              confirm="입력한 계정을 관리자로 등록합니다. 계속할까요?"
            >
              <div className="grid gap-2.5 sm:grid-cols-[1fr_200px]">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-ink-500">계정 이메일</span>
                  <AdminInput type="email" name="email" required placeholder="user@example.com" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-ink-500">부여할 권한</span>
                  <AdminSelect name="permission" defaultValue="READ_ONLY">
                    {PERMISSIONS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </AdminSelect>
                </label>
              </div>
            </ActionForm>
          </Card>
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
                          다시 부여하려면 위 [관리자 추가]에서 같은 이메일로 등록해 주세요.
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
