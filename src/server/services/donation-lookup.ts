import { prisma } from '@/server/db';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { donationStatusLabel } from '@/lib/labels';

/**
 * 비로그인 후원 내역 조회(문자 인증 후)의 조회 본체.
 *
 * 'use server' 파일에 두면 export 하는 순간 **인증 없이 부를 수 있는 서버 액션**이 되므로
 * 서비스 모듈로 분리했다(테스트에서도 직접 검증한다). 호출 전 번호 소유 확인은 액션이 한다.
 */

export interface LookupResult {
  phoneMasked: string;
  totalCount: number;
  totalAmount: string;
  registered: boolean;
  items: Array<{
    id: string;
    creatorName: string;
    creatorCode: string;
    amount: string;
    message: string;
    statusText: string;
    statusTone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
    receivedAt: string;
  }>;
}

export async function loadDonationLookupResult(ph: string, phoneMasked: string): Promise<LookupResult> {
  const donor = await prisma.donorProfile.findUnique({
    where: { phoneHash: ph },
    select: { id: true, registeredAt: true, userId: true, previousUserId: true, unlinkedAt: true, retiredAt: true },
  });

  if (!donor || donor.retiredAt) {
    return { phoneMasked, totalCount: 0, totalAmount: formatWon(0n), registered: false, items: [] };
  }

  /**
   * [SEC-F] 번호 재사용(통신사 재배정) 방어 — phone-link 의 `recycled` 판정과 같은 기준.
   *
   * 계정 연결이 끊긴 프로필(userId=null, previousUserId 있음 = 탈퇴·연결 해제)은 **이전 이용자의
   * 이력**을 담고 있다. 번호가 다른 사람에게 재배정됐다면, 그 번호로 인증번호만 받으면
   * 이전 사람의 후원 내역(크리에이터·금액·메시지)이 그대로 보였다.
   * 이런 프로필은 연결이 끊긴 시각(unlinkedAt) **이후** 이 번호로 들어온 후원만 보여 준다.
   * (끊긴 뒤의 후원은 그 시점 번호 소유자의 것이다. unlinkedAt 이 없으면 아무것도 보여 주지 않는다)
   */
  const detached = !donor.userId && Boolean(donor.previousUserId);
  if (detached && !donor.unlinkedAt) {
    return { phoneMasked, totalCount: 0, totalAmount: formatWon(0n), registered: false, items: [] };
  }
  const since = detached && donor.unlinkedAt ? { receivedAt: { gte: donor.unlinkedAt } } : {};

  const [donations, paid] = await Promise.all([
    prisma.donation.findMany({
      where: { donorId: donor.id, ...since },
      orderBy: { receivedAt: 'desc' },
      take: 30,
      select: {
        id: true,
        amount: true,
        message: true,
        status: true,
        receivedAt: true,
        creator: { select: { displayName: true, code: true } },
      },
    }),
    prisma.donation.aggregate({
      where: {
        donorId: donor.id,
        ...since,
        status: {
          in: ['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'],
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    phoneMasked,
    totalCount: paid._count._all,
    totalAmount: formatWon(paid._sum.amount ?? 0n),
    // 분리된 프로필의 등록 상태(결제수단)는 이전 이용자의 것이므로 표시하지 않는다.
    registered: detached ? false : Boolean(donor.registeredAt),
    items: donations.map((d) => {
      const label = donationStatusLabel[d.status];
      return {
        id: d.id,
        creatorName: d.creator.displayName,
        creatorCode: d.creator.code,
        amount: formatWon(d.amount),
        message: d.message || '(내용 없음)',
        statusText: label.text,
        statusTone: label.tone,
        receivedAt: formatKst(d.receivedAt, false),
      };
    }),
  };
}
