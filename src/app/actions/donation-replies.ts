'use server';

import { revalidatePath } from 'next/cache';
import { requireCreator } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { donationReplySchema, replyNotifyTarget, saveDonationReply } from '@/server/services/donation-replies';
import { notifyUser } from '@/server/services/notifications';
import type { StudioActionState } from './studio';

export async function replyToDonationAction(_prev: StudioActionState, data: FormData): Promise<StudioActionState> {
  /**
   * [REPLY-AUTH] requireCreator 는 미로그인·미승인·정지 상태에서 예외를 던진다. 예전에는 잡지 않아
   * 화면이 오류 페이지로 넘어갔다(다른 스튜디오 액션은 메시지 상태로 돌려준다). 같은 방식으로 맞춘다.
   * 안내 문구는 requireCreator 가 만든 한국어 문구(정지·심사 대기 등)를 그대로 쓴다.
   */
  let user: Awaited<ReturnType<typeof requireCreator>>;
  try {
    user = await requireCreator();
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : '크리에이터 로그인이 필요합니다.' };
  }
  const parsed = donationReplySchema.safeParse(data.get('body'));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message };
  const id = String(data.get('donationId') ?? '');
  if (!id || id.length > 100) return { ok: false, message: '후원 내역을 확인해 주세요.' };
  if (!(await consumeRateLimit('donation-reply', user.id, 20, 60, { failClosed: true })).ok) return { ok: false, message: '잠시 후 다시 작성해 주세요.' };
  try {
    const code = await saveDonationReply(user.id, id, parsed.data);
    // 후원자에게 앱 알림 (처음 단 답글만, 실패해도 답글 저장은 그대로)
    const target = await replyNotifyTarget(id).catch(() => null);
    if (target) {
      await notifyUser({
        userId: target.userId,
        title: `${target.creatorName}님이 내 후원에 답글을 남겼어요`,
        body: parsed.data.slice(0, 120),
        linkUrl: `/c/${target.creatorCode}/messages`,
      }).catch(() => undefined);
    }
    revalidatePath(`/studio/donations/${id}`);
    revalidatePath(`/c/${code}/messages`);
    revalidatePath('/my');
    return { ok: true, message: '답글을 저장했습니다. 후원자의 내 후원 내역에 표시되고 알림이 갑니다.' };
  } catch {
    return { ok: false, message: '답글을 저장하지 못했습니다. 후원 내역과 작성 권한을 확인해 주세요.' };
  }
}
