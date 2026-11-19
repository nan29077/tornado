import { prisma } from '@/server/db';
import type { SessionUser } from '@/server/auth';
import { mediaUrlVariants } from '@/server/uploads';
import { getSubscriptionStatus } from '@/server/services/talk/talk';

/**
 * 팬챗 첨부 파일(사진 · 음성 · 영상)을 이 사람이 볼 수 있는가 (7차 점검 P2-2, 2026-11-19).
 *
 * 예전에는 주소만 알면 로그인 없이 누구나 열 수 있었다. 주소는 추측할 수 없는 32자리지만,
 * 유료 구독자가 주소를 퍼뜨리면 비구독자도 그대로 봤다.
 *
 * 규칙
 *  - 팬챗 메시지에 붙은 파일: 최고관리자(신고 검토) · 그 팬챗방 크리에이터 · 지금 구독 중인 팬만.
 *    팬은 공개 시각이 지난 메시지만, 나에게만 보낸 답장(DIRECT)은 받은 팬만, 지운 메시지는 볼 수 없다.
 *  - 아직 어느 메시지에도 붙지 않은 음성 · 영상(크리에이터가 올리고 보내기 전 미리 듣기): 크리에이터 · 관리자만.
 *  - 아직 어느 메시지에도 붙지 않은 사진: 일반 업로드 이미지(상품 · 배너 · 프로필 등)이므로 공개.
 */
export type TalkMediaDecision = 'PUBLIC' | 'ALLOW_PRIVATE' | 'DENY';

const AV_EXT = new Set(['mp3', 'm4a', 'ogg', 'wav', 'webm', 'mp4', 'mov']);

export function isAudioVideoName(name: string): boolean {
  return AV_EXT.has(name.split('.').pop()?.toLowerCase() ?? '');
}

export async function decideTalkMediaAccess(name: string, user: SessionUser | null, now: Date = new Date()): Promise<TalkMediaDecision> {
  const av = isAudioVideoName(name);
  const urls = mediaUrlVariants(name);
  const msgs = await prisma.talkMessage.findMany({
    where: av ? { mediaUrl: { in: urls } } : { imageUrl: { in: urls } },
    select: { creatorId: true, kind: true, fanUserId: true, deletedAt: true, createdAt: true },
    take: 20,
  });

  if (msgs.length === 0) {
    if (!av) return 'PUBLIC';
    if (user && (user.role === 'ADMIN' || user.creatorId)) return 'ALLOW_PRIVATE';
    return 'DENY';
  }

  if (!user) return 'DENY';
  if (user.role === 'ADMIN') return 'ALLOW_PRIVATE';
  if (user.creatorId && msgs.some((m) => m.creatorId === user.creatorId)) return 'ALLOW_PRIVATE';

  const visible = msgs.filter((m) => !m.deletedAt && m.createdAt <= now && (m.kind === 'BROADCAST' || (m.kind === 'DIRECT' && m.fanUserId === user.id)));
  for (const creatorId of new Set(visible.map((m) => m.creatorId))) {
    const status = await getSubscriptionStatus(user.id, creatorId, now);
    if (status.active) return 'ALLOW_PRIVATE';
  }
  return 'DENY';
}
