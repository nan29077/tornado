'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { env, isLocal } from '@/lib/env';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { getSessionUser } from '@/server/auth';
import { SUPPORT_CATEGORY_VALUES } from '@/components/public/support-options';
import { INQUIRY_GUEST_COOKIE, claimGuestInquiry } from '@/server/services/inquiry';
import { notifySuperAdmins } from '@/server/services/notifications';
import { cookies } from 'next/headers';
import { clientIpFrom } from '@/server/rate-limit';

/**
 * 고객센터 문의 접수 (/support 폼).
 *
 * 문의 채널은 SupportInquiry 하나로 일원화한다.
 * 예전에는 이 폼이 Report 로만 저장돼 (1) 답변 필드도 조회 화면도 없어 비회원 접수가 무응답으로 끝나고,
 * (2) 우측 하단 위젯 문의와 서로 다른 테이블에 쌓여 같은 사람의 이력을 못 보는 문제가 있었다.
 * 이제 모든 접수는 SupportInquiry 스레드가 되고, 위젯에서 그대로 답변을 확인할 수 있다.
 * '부적절한 이용 신고(ABUSE)'만 추가로 Report 를 만들어 신고 처리 큐에도 올린다.
 */

export interface SupportFormState {
  ok: boolean;
  message?: string;
  /** 접수번호 (SupportInquiry ID) */
  ticketId?: string;
  /** 거래번호 연결 결과 안내 */
  linkNote?: string;
}

// 'use server' 파일은 async 함수만 export 할 수 있으므로 상수는 내부에만 둔다.
const RATE_WINDOW_SEC = 600;
const RATE_MAX = 10;
/** [SEC-G] 거래번호 안내 문구. 존재·소유 여부와 무관하게 항상 같다(거래번호 탐색 방지). */
const SUPPORT_TRANSACTION_NOTE = (no: string) =>
  `거래번호 ${no} 를 문의에 함께 기록했습니다. 담당자가 해당 거래를 직접 확인한 뒤 답변드립니다.`;

const schema = z.object({
  category: z.string().refine((v) => SUPPORT_CATEGORY_VALUES.includes(v), '문의 유형을 선택해 주세요.'),
  content: z
    .string()
    .trim()
    .min(10, '문의 내용을 10자 이상 입력해 주세요.')
    .max(2000, '문의 내용은 2,000자를 넘을 수 없습니다.'),
  transactionNo: z.string().trim().max(64, '거래번호를 확인해 주세요.'),
});

export async function submitSupportRequest(
  _prev: SupportFormState,
  formData: FormData,
): Promise<SupportFormState> {
  const parsed = schema.safeParse({
    category: String(formData.get('category') ?? ''),
    content: String(formData.get('content') ?? ''),
    transactionNo: String(formData.get('transactionNo') ?? ''),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
  }

  const { category, content, transactionNo } = parsed.data;

  // 남용 방지: IP 단위 10분당 10건 (로그인 사용자는 계정 단위로도 함께 제한)
  const user = await getSessionUser().catch(() => null);
  const h = await headers();
  const ip = clientIpFrom((name) => h.get(name));
  /**
   * [RL-UNKNOWN] IP 를 알 수 없으면 예전에는 전원이 `support:rate:ip:unknown` 한 버킷을 공유해
   * 한 사람이 10건을 넣으면 모두의 문의 접수가 막혔다. 로그인 사용자는 계정 버킷만으로 세고,
   * 비로그인은 IP 버킷과 이름이 겹치지 않는 별도 `noip` 버킷을 쓴다.
   */
  const rateKeys: string[] = [];
  if (ip) rateKeys.push(`support:rate:ip:${ip}`);
  if (user) rateKeys.push(`support:rate:user:${user.id}`);
  if (!ip && !user) rateKeys.push('support:rate:noip');
  for (const key of rateKeys) {
    const tries = await kv.incr(key, RATE_WINDOW_SEC);
    if (tries > RATE_MAX) {
      return { ok: false, message: '문의를 너무 자주 접수하고 있습니다. 잠시 후 다시 시도해 주세요.' };
    }
  }

  let donationId: string | null = null;
  let creatorId: string | null = null;
  let linkNote: string | undefined;

  if (transactionNo) {
    /**
     * [SEC-G] 거래번호 존재 여부를 응답으로 구분하지 않고, **본인 소유 건만** 문의에 연결한다.
     *
     * 예전에는 비로그인 사용자도 거래번호를 넣으면 "연결되었습니다 / 찾지 못했습니다" 로 응답이 갈려
     * 거래번호를 대입해 존재 여부를 탐색할 수 있었고, 남의 후원 건을 자기 문의(그리고 ABUSE 신고)에
     * 연결해 관리자 화면에서 그 후원과 크리에이터가 문의자 것으로 보이게 만들 수 있었다.
     *
     * 이제는 로그인한 후원자(그 후원의 donor 계정) 또는 그 후원을 받은 크리에이터일 때만 연결한다.
     * 그 밖에는 거래번호를 문의에 **텍스트로만** 남기고(transactionNo) 담당자가 직접 확인한다.
     * 어느 경우든 화면 안내 문구는 같다.
     */
    if (user) {
      const donation = await prisma.donation.findUnique({
        where: { transactionNo },
        select: {
          id: true,
          creatorId: true,
          donor: { select: { userId: true } },
          creator: { select: { userId: true } },
        },
      });
      const owns = donation && (donation.donor?.userId === user.id || donation.creator.userId === user.id);
      if (donation && owns) {
        donationId = donation.id;
        creatorId = donation.creatorId;
      }
    }
    linkNote = SUPPORT_TRANSACTION_NOTE(transactionNo);
  }

  // 로그인 사용자는 후원자 프로필의 phoneHash 로 문의자를 식별한다 (원문은 저장하지 않음)
  let reporterHash: string | null = null;
  if (user) {
    const donor = await prisma.donorProfile.findUnique({
      where: { userId: user.id },
      select: { phoneHash: true },
    });
    reporterHash = donor?.phoneHash ?? null;
  }

  const jar = await cookies();
  const cookieToken = jar.get(INQUIRY_GUEST_COOKIE)?.value ?? null;

  try {
    // 게스트로 남긴 스레드가 있으면 먼저 계정으로 승계한다 (같은 사람 문의가 쪼개지지 않게).
    if (user && cookieToken) {
      await claimGuestInquiry(user.id, cookieToken).catch(() => null);
      jar.delete(INQUIRY_GUEST_COOKIE);
    }

    const now = new Date();
    let inquiry = user
      ? await prisma.supportInquiry.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
      : cookieToken
        ? await prisma.supportInquiry.findUnique({ where: { guestToken: cookieToken } })
        : null;

    let issuedGuestToken: string | null = null;

    if (inquiry) {
      await prisma.supportInquiry.update({
        where: { id: inquiry.id },
        data: {
          status: 'OPEN',
          category,
          source: 'FORM',
          lastMessageAt: now,
          ...(transactionNo ? { transactionNo } : {}),
          ...(donationId ? { donationId } : {}),
          ...(creatorId ? { creatorId } : {}),
        },
      });
    } else {
      const token = user ? null : newId();
      inquiry = await prisma.supportInquiry.create({
        data: {
          id: newId(),
          userId: user?.id ?? null,
          guestToken: token,
          category,
          source: 'FORM',
          status: 'OPEN',
          transactionNo: transactionNo || null,
          donationId,
          creatorId,
          lastMessageAt: now,
        },
      });
      issuedGuestToken = token;
    }

    await prisma.supportMessage.create({
      data: { id: newId(), inquiryId: inquiry.id, sender: 'USER', body: content },
    });

    if (issuedGuestToken) {
      // 비회원도 이 쿠키로 우측 하단 문의 창에서 답변을 확인할 수 있다.
      jar.set(INQUIRY_GUEST_COOKIE, issuedGuestToken, {
        httpOnly: true,
        sameSite: 'lax',
        // 세션 쿠키와 같은 기준으로 판단한다.
        secure: !isLocal && env.baseUrl.startsWith('https'),
        maxAge: 60 * 60 * 24 * 365,
        path: '/',
      });
    }

    // 접수 즉시 통합 관리자에게 알린다. 위젯 문의만 알림이 가고 고객센터 폼은 조용히 쌓이던 문제를 막는다.
    await notifySuperAdmins({
      title: '새 고객센터 문의가 접수되었습니다',
      body: `[${category}] ${content.slice(0, 80)}`,
      linkUrl: `/admin/inquiries/${inquiry.id}`,
    }).catch(() => undefined);

    // 신고 유형은 신고 처리 큐(Report)에도 올린다. 본문에 식별자를 섞지 않는다.
    if (category === 'ABUSE') {
      await prisma.report.create({
        data: {
          id: newId(),
          category,
          content,
          status: 'OPEN',
          donationId,
          creatorId,
          reporterHash,
          reporterUserId: user?.id ?? null,
        },
      });
    }

    return { ok: true, ticketId: inquiry.id, linkNote };
  } catch {
    return { ok: false, message: '문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
