'use server';

import { headers } from 'next/headers';
import { prisma } from '@/server/db';
import { loadConfirmContext, confirmDonation } from '@/server/services/donation-confirm';
import { clientIpFrom, consumeIpRateLimit } from '@/server/rate-limit';
import { checkDonorName } from '@/lib/donor-name';
import { validateDonorName } from '@/server/services/donor-name';

/**
 * 문자후원 결제 확인 서버 액션.
 * - 보안링크는 1회용이므로 서버에서 중복 클릭이 방어된다.
 * - 결제가 실패하면 실패로 그대로 안내한다. 실패 건은 방송에 노출되지 않는다.
 */

export interface ConfirmActionResult {
  ok: boolean;
  message: string;
  /** 대외 노출용 거래번호 (성공 시에만) */
  transactionNo?: string;
}

export async function confirmDonationAction(token: string): Promise<ConfirmActionResult> {
  const h = await headers();
  const ip = clientIpFrom((name) => h.get(name)) ?? undefined;
  const userAgent = h.get('user-agent') ?? undefined;

  const loaded = await loadConfirmContext(String(token ?? ''));
  if (!loaded.ok) {
    return { ok: false, message: loaded.reason };
  }
  const donationId = loaded.ctx.donationId;

  try {
    const outcome = await confirmDonation(token, ip, userAgent);
    if (!outcome.ok) {
      return { ok: false, message: outcome.message || '결제가 완료되지 않았습니다.' };
    }
    const donation = await prisma.donation.findUnique({
      where: { id: donationId },
      select: { transactionNo: true },
    });
    return {
      ok: true,
      message: outcome.message || '후원이 완료되었습니다.',
      transactionNo: donation?.transactionNo,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message || '결제 처리 중 오류가 발생했습니다.' };
  }
}

export interface NicknameUpdateResult {
  ok: boolean;
  message?: string;
}

/**
 * 확인 화면에서 후원자 닉네임·SNS 플랫폼을 저장/수정한다.
 * 닉네임이 비어 있으면 아무것도 하지 않는다(기존 값 유지).
 *
 * 소유권 검증
 *  - **`donorId` 를 인자로 받지 않는다.** 서버 액션은 액션 ID 만 알면 누구나 호출할 수 있어서,
 *    예전 구현은 임의의 donorId 로 남의 방송 표시 닉네임을 바꿀 수 있었다(그 값은 오버레이와
 *    TTS 로 방송에 그대로 나간다). 방어는 ULID 추측 난이도뿐이었다.
 *  - 대신 이 화면이 이미 들고 있는 **보안링크 토큰**으로 대상을 정한다. 토큰이 가리키는
 *    후원 건의 후원자만 수정된다. (토큰은 여기서 소비하지 않는다 — 결제 확인 때 1회 소비된다)
 *  - 무제한 시도를 막기 위해 IP 단위 속도 제한도 함께 건다.
 */
export async function updateDonorNicknameAction(
  token: string,
  nickname: string,
  snsPlatform?: string,
): Promise<NicknameUpdateResult> {
  const trimmed = nickname.trim();
  if (!trimmed) return { ok: true }; // 빈 값 = 변경 없음

  const clientCheck = checkDonorName(trimmed);
  if (!clientCheck.ok) return { ok: false, message: clientCheck.message };

  const limited = await consumeIpRateLimit('donor-nickname', 20, 600);
  if (!limited.ok) return { ok: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };

  const loaded = await loadConfirmContext(String(token ?? ''));
  if (!loaded.ok) return { ok: false, message: loaded.reason };
  const donorId = loaded.ctx.donorId;
  if (!donorId) return { ok: false, message: '후원자 정보를 찾을 수 없습니다.' };

  try {
    const serverCheck = await validateDonorName(trimmed);
    if (!serverCheck.ok) return { ok: false, message: serverCheck.message ?? '닉네임을 다시 입력해 주세요.' };

    await prisma.donorProfile.update({
      where: { id: donorId },
      data: {
        displayName: serverCheck.value,
        snsPlatform: snsPlatform?.trim() || null,
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message || '닉네임 저장에 실패했습니다.' };
  }
}
