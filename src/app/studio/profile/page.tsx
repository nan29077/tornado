import { notFound } from 'next/navigation';
import { Badge, Card, CardTitle, DataRow, EmptyState, Field, Input, Notice, SectionTitle, Table, Td, Th } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm } from '@/components/studio/action-form';
import { ImageUploadField } from '@/components/studio/image-upload-field';
import { updateCreatorProfileAction } from '@/app/actions/studio';
import { requireCreator } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import { creatorStatusLabel } from '@/lib/labels';
import { ProfileAvatar } from '@/components/profile/generated-avatar';

export const dynamic = 'force-dynamic';

export default async function StudioSettingsProfilePage() {
  const { creatorId, email, avatarIndex } = await requireCreator();

  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    include: { codes: { orderBy: { issuedAt: 'desc' }, take: 10 } },
  });

  if (!creator) notFound();

  const status = creatorStatusLabel[creator.status];

  return (
    <>
      {/* 좌측 메뉴 이름("프로필 설정")과 제목이 달라 다른 화면으로 넘어온 줄 알기 쉬웠다. 맞춘다. */}
      <PageHeader
        title="프로필 설정"
        description="채널 프로필과 계정 정보를 관리합니다. 후원샵 꾸미기는 후원 설정 > 후원페이지 탭에 있습니다."
      />

      <div className="space-y-5">
        <section>
          <SectionTitle title="채널 상태" />
          <Card>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <CardTitle>{creator.displayName}</CardTitle>
              <Badge tone={status.tone}>{status.text}</Badge>
            </div>
            <DataRow label="로그인 계정" value={email ?? '-'} />
            <DataRow label="크리에이터 코드" value={<span className="font-mono">{creator.code}</span>} />
            <DataRow label="승인 시각" value={formatKst(creator.approvedAt)} />
            <DataRow label="가입 시각" value={formatKst(creator.createdAt)} />
            {creator.suspendedAt ? <DataRow label="정지 시각" value={formatKst(creator.suspendedAt)} /> : null}
          </Card>
        </section>

        <section>
          <SectionTitle title="프로필 수정" description="후원샵과 후원 알림에 표시되는 정보입니다. 크리에이터 소개는 후원 설정 > 후원페이지 탭에서 수정합니다." />
          <Card>
            <div className="mb-5 flex items-center gap-3 rounded-2xl border border-brand-100 bg-brand-50/60 p-4">
              <ProfileAvatar
                seed={creator.code}
                avatarIndex={avatarIndex}
                name={creator.displayName}
                imageUrl={creator.avatarUrl}
                className="h-16 w-16"
              />
              <div>
                <p className="text-[14px] font-extrabold text-ink-900">현재 프로필 캐릭터</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
                  기본 캐릭터는 계정별로 50종 중 하나가 자동 배정되며 모든 화면에 동일하게 표시됩니다.
                </p>
              </div>
            </div>
            <ActionForm action={updateCreatorProfileAction} submitLabel="프로필 저장">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="표시명" hint="1~30자" required>
                  <Input name="displayName" maxLength={30} defaultValue={creator.displayName} />
                </Field>
                <Field label="채널명" hint="50자 이내. 비워두면 표시하지 않습니다.">
                  <Input name="channelName" maxLength={50} defaultValue={creator.channelName ?? ''} />
                </Field>
              </div>
              <ImageUploadField
                name="avatarUrl"
                label="아바타(프로필 캐릭터)"
                aspect="square"
                defaultValue={creator.avatarUrl ?? ''}
                hint="파일을 올리거나 이미지 URL 을 입력하세요. 비워두면 자동 배정된 캐릭터가 표시됩니다."
              />
            </ActionForm>
          </Card>
        </section>

        <section>
          <SectionTitle title="코드 이력" description="코드 발급과 회수는 통합 관리자가 처리합니다." />
          {creator.codes.length === 0 ? (
            <EmptyState title="코드 이력이 없습니다" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>코드</Th>
                  <Th>상태</Th>
                  <Th>발급일</Th>
                  <Th>회수일</Th>
                </tr>
              </thead>
              <tbody>
                {creator.codes.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-mono font-semibold text-ink-900">{c.code}</Td>
                    <Td>
                      <Badge tone={c.active ? 'success' : 'neutral'}>{c.active ? '사용 중' : '회수됨'}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(c.issuedAt, false)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatKst(c.revokedAt, false)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <Notice tone="neutral">
          표시명과 소개는 후원샵에 그대로 노출됩니다. 개인 연락처나 계좌번호 등 개인정보는 입력하지 마세요.
          채널 상태 변경(승인·정지)과 크리에이터 코드 변경은 통합 관리자를 통해서만 가능합니다.
        </Notice>
      </div>
    </>
  );
}
