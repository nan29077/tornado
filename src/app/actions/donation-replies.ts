'use server';

import { revalidatePath } from 'next/cache';
import { requireCreator } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { donationReplySchema, saveDonationReply } from '@/server/services/donation-replies';
import type { StudioActionState } from './studio';

export async function replyToDonationAction(_prev: StudioActionState, data: FormData): Promise<StudioActionState> {
  const user = await requireCreator();
  const parsed = donationReplySchema.safeParse(data.get('body'));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message };
  const id = String(data.get('donationId') ?? '');
  if (!id || id.length > 100) return { ok: false, message: '후원 내역을 확인해 주세요.' };
  if (!(await consumeRateLimit('donation-reply', user.id, 20, 60, { failClosed: true })).ok) return { ok: false, message: '잠시 후 다시 작성해 주세요.' };
  try {
    const code = await saveDonationReply(user.id, id, parsed.data);
    revalidatePath(`/studio/donations/${id}`);
    revalidatePath(`/c/${code}/messages`);
    revalidatePath('/my');
    return { ok: true, message: '답글을 저장했습니다. 후원자의 내 문자후원 내역에 표시됩니다.' };
  } catch {
    return { ok: false, message: '답글을 저장하지 못했습니다. 후원 내역과 작성 권한을 확인해 주세요.' };
  }
}
