'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { revokeYouTubeConnection } from '@/server/services/youtube-connection';
import type { AdminActionState } from '@/components/admin/state';
import { run, requiredId, bool, enumValue, int, money } from './shared';

/**
 * 유튜브 연동 운영 액션.
 * 토큰 원문은 어떤 경로로도 화면에 반환하지 않는다.
 */

export async function disconnectYouTube(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const before = await prisma.youTubeConnection.findUnique({
      where: { creatorId },
      select: { id: true, status: true, channelTitle: true, expiresAt: true, refreshTokenEnc: true },
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
    revalidatePath('/admin/youtube');
    revalidatePath(`/admin/creators/${creatorId}`);
    return providerRevoked
      ? '유튜브 연결을 해제하고 구글 권한 회수와 토큰 폐기를 완료했습니다. 크리에이터가 다시 연결해야 합니다.'
      : '유튜브 연결을 해제하고 저장된 토큰을 폐기했습니다. 구글 쪽 권한 회수는 실패했으니 필요하면 크리에이터가 구글 보안 설정에서 직접 해제해야 합니다.';
  });
}

// =========================================================== TTS 설정 (관리자 전담)

/**
 * 크리에이터별 TTS 설정 변경.
 *
 * TTS 는 외부 음성 합성 서비스와의 연동이 필요해 크리에이터가 직접 다루지 않는다.
 * 통합 관리자가 연동을 담당하고, 크리에이터별 읽기 옵션도 이 화면에서 조정한다.
 */
export async function updateCreatorTtsSetting(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { id: true, displayName: true },
    });
    if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');

    const voice = enumValue(
      fd,
      'voice',
      ['ko-KR-Standard-A', 'ko-KR-Standard-B', 'ko-KR-Standard-C', 'ko-KR-Standard-D'] as const,
      '음성',
    );
    const speed = int(fd, 'speedPercent', { min: 50, max: 200, label: '속도(%)' }) / 100;
    const volume = int(fd, 'volumePercent', { min: 0, max: 100, label: '볼륨(%)' }) / 100;
    const maxChars = int(fd, 'maxChars', { min: 10, max: 200, label: '최대 글자 수' });
    const minAmount = money(fd, 'minAmount', '최소 후원금');
    if (minAmount > 1_000_000n) throw new Error('최소 후원금은 1,000,000원 이하로 입력해 주세요.');

    const before = await prisma.ttsSetting.findUnique({ where: { creatorId } });
    const data = {
      enabled: bool(fd, 'enabled'),
      readAmount: bool(fd, 'readAmount'),
      readName: bool(fd, 'readName'),
      voice,
      speed,
      volume,
      minAmount,
      maxChars,
    };

    await prisma.ttsSetting.upsert({
      where: { creatorId },
      create: { id: newId(), creatorId, ...data },
      update: data,
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'TTS_SETTING_UPDATE',
      targetType: 'TtsSetting',
      targetId: creatorId,
      before: before
        ? { enabled: before.enabled, voice: before.voice, speed: before.speed, volume: before.volume }
        : null,
      after: { enabled: data.enabled, voice: data.voice, speed: data.speed, volume: data.volume },
    });

    revalidatePath('/admin/tts');
    return `${creator.displayName} 의 TTS 설정을 저장했습니다.`;
  });
}
