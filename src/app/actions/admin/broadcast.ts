'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { revokeYouTubeConnection } from '@/server/services/youtube-connection';
import { notifyUser } from '@/server/services/notifications';
import type { AdminActionState } from '@/components/admin/state';
import { run, requiredId, bool, int, money } from './shared';

/**
 * 유튜브 연동 운영 액션.
 * 토큰 원문은 어떤 경로로도 화면에 반환하지 않는다.
 */

export async function disconnectYouTube(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const before = await prisma.youTubeConnection.findUnique({
      where: { creatorId },
      select: {
        id: true, status: true, channelTitle: true, expiresAt: true, refreshTokenEnc: true,
        creator: { select: { userId: true } },
      },
    });
    if (!before) throw new Error('연결된 유튜브 채널이 없습니다.');
    if (before.status === 'REVOKED') throw new Error('이미 해제된 연결입니다.');

    // 구글 쪽 권한까지 회수하고 저장된 토큰 암호문을 폐기한다.
    // (회수 호출이 실패해도 우리 토큰 폐기는 반드시 수행한다)
    const { providerRevoked } = await revokeYouTubeConnection({
      connectionId: before.id,
      refreshTokenEnc: before.refreshTokenEnc,
      reason: '관리자에 의해 연결이 강제 해제되었습니다.',
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'YOUTUBE_DISCONNECT',
      targetType: 'YouTubeConnection',
      targetId: before.id,
      before: { status: before.status, channelTitle: before.channelTitle },
      after: { status: 'REVOKED', tokensPurged: true, providerRevoked },
    });

    /**
     * 크리에이터에게 알린다.
     *
     * 알리지 않으면 **다음 방송에서 채팅 전송이 실패하고 나서야** 연결이 끊긴 사실을 안다.
     * 방송 중에 알아차리면 손쓸 방법이 없다. (알림 실패가 해제를 되돌리지는 않는다)
     */
    await notifyUser({
      userId: before.creator.userId,
      title: '유튜브 채널 연결이 해제되었습니다',
      body: `관리자가 ${before.channelTitle ?? '연결된 채널'} 의 연결을 해제했습니다. 다시 연결하기 전까지 후원 메시지가 라이브 채팅으로 전송되지 않습니다.`,
      linkUrl: '/studio/youtube',
    }).catch(() => undefined);

    revalidatePath('/admin/youtube');
    revalidatePath(`/admin/creators/${creatorId}`);
    return providerRevoked
      ? '유튜브 연결을 해제하고 구글 권한 회수와 토큰 폐기를 완료했습니다. 크리에이터가 다시 연결해야 합니다.'
      : '유튜브 연결을 해제하고 저장된 토큰을 폐기했습니다. 구글 쪽 권한 회수는 실패했으니 필요하면 크리에이터가 구글 보안 설정에서 직접 해제해야 합니다.';
  });
}

// =========================================================== TTS 설정 (관리자 전담)

/**
 * 크리에이터별 TTS 읽기 옵션 변경.
 *
 * **소유권 경계**
 *  - 음성(`voice`)·속도(`speed`)·제공사(`provider`)·외부 인증 정보는 **크리에이터**가
 *    `/studio/overlay` 간편 설정에서 정한다. 이 액션은 그 값을 절대 건드리지 않는다.
 *  - 관리자는 운영 정책에 해당하는 읽기 옵션(사용 여부·최소 후원금·최대 글자 수·
 *    금액/이름 읽기·볼륨)만 조정한다.
 *
 * 예전에는 관리자 폼이 `voice` 를 Google 스타일 enum(`ko-KR-Standard-A~D`)으로 강제하고
 * `provider` 를 무시한 채 저장했다. 크리에이터가 고른 브라우저 음성이나 CLOVA 화자(`nara` 등)가
 * 어느 제공사에도 없는 값으로 덮어써져, 저장 버튼 한 번에 음성이 깨졌다.
 */
export async function updateCreatorTtsSetting(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, displayName: true },
    });
    if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');

    const volume = int(fd, 'volumePercent', { min: 0, max: 100, label: '볼륨(%)' }) / 100;
    const maxChars = int(fd, 'maxChars', { min: 10, max: 200, label: '최대 글자 수' });
    const minAmount = money(fd, 'minAmount', '최소 후원금');
    if (minAmount > 1_000_000n) throw new Error('최소 후원금은 1,000,000원 이하로 입력해 주세요.');

    const before = await prisma.ttsSetting.findUnique({ where: { creatorId } });
    const data = {
      enabled: bool(fd, 'enabled'),
      readAmount: bool(fd, 'readAmount'),
      readName: bool(fd, 'readName'),
      volume,
      minAmount,
      maxChars,
    };

    await prisma.ttsSetting.upsert({
      where: { creatorId },
      // 새로 만들 때도 voice/speed/provider 는 스키마 기본값에 맡긴다.
      // 크리에이터가 아직 고르지 않았을 뿐이지, 관리자가 정할 값이 아니다.
      create: { id: newId(), creatorId, ...data },
      update: data,
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'TTS_SETTING_UPDATE',
      targetType: 'TtsSetting',
      targetId: creatorId,
      before: before
        ? {
            enabled: before.enabled,
            volume: before.volume,
            minAmount: before.minAmount.toString(),
            maxChars: before.maxChars,
            readAmount: before.readAmount,
            readName: before.readName,
          }
        : null,
      after: {
        enabled: data.enabled,
        volume: data.volume,
        minAmount: data.minAmount.toString(),
        maxChars: data.maxChars,
        readAmount: data.readAmount,
        readName: data.readName,
      },
    });

    revalidatePath('/admin/tts');
    return `${creator.displayName} 의 TTS 읽기 옵션을 저장했습니다. 음성·속도·제공사는 크리에이터 설정을 그대로 유지합니다.`;
  });
}
