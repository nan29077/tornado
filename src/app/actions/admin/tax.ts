'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { kstMonthRange } from '@/lib/datetime';
import { TAX_TYPES, taxTypeLabel, normalizeTaxType } from '@/lib/labels';
import { maskBusinessNo } from '@/lib/crypto';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, enumValue, requiredId, assertFinanceAdmin } from './shared';

/**
 * 세무 관리 액션 (`/admin/tax`).
 *
 * 여기서는 **세무 정보(누구에게 어떻게 지급하는가)만** 바꾼다.
 * 이미 지급된 건의 금액·세액은 절대 고치지 않는다. 정산 원장은 append-only 이고,
 * 지급이 끝난 뒤 세액을 소급해 바꾸면 이미 나간 돈과 신고 자료가 어긋난다.
 * 잘못 징수한 건은 정산 화면의 **조정 분개**로 바로잡는다.
 */

/** 사업자등록번호 표기 통일. 숫자 10자리만 통과시킨다. */
function normalizeBusinessNo(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return null;
  if (digits.length !== 10) {
    throw new Error('사업자등록번호는 숫자 10자리로 입력해 주세요. (예: 123-45-67890)');
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * 크리에이터 한 명의 세무 정보 저장.
 *
 * 과세유형을 바꾸면 **다음 지급부터** 원천징수 여부가 달라진다.
 * 이미 지급된 건에는 소급되지 않는다(화면에도 그렇게 안내한다).
 */
export async function updateCreatorTaxProfile(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    // 사업자번호·세금계산서 이메일은 세무 자료다. 재무/운영 권한에서만 손댈 수 있다.
    assertFinanceAdmin(admin, '크리에이터 세무 정보 변경');

    const creatorId = requiredId(fd, 'creatorId', '크리에이터');
    const taxType = enumValue(fd, 'taxType', TAX_TYPES, '과세유형');
    const businessNo = normalizeBusinessNo(optText(fd, 'businessNo'));
    const businessName = optText(fd, 'businessName');
    const taxInvoiceEmail = optText(fd, 'taxInvoiceEmail');
    const taxMemo = optText(fd, 'taxMemo');

    if (taxInvoiceEmail && !EMAIL_RE.test(taxInvoiceEmail)) {
      throw new Error('세금계산서 이메일 형식이 올바르지 않습니다.');
    }
    // 사업자로 지정하면 원천징수를 하지 않는다. 근거(사업자번호) 없이 그 상태로 두면
    // 원천징수의무 불이행이 되므로, 번호 없이 사업자로 바꾸는 것을 막는다.
    if (taxType !== 'INDIVIDUAL' && !businessNo) {
      throw new Error(
        `${taxTypeLabel[taxType].text}로 지정하려면 사업자등록번호가 필요합니다. ` +
          '번호 없이 사업자로 두면 원천징수를 하지 않은 채 지급되어 도네이도가 가산세를 부담합니다.',
      );
    }

    const before = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { displayName: true, taxType: true, businessNo: true, businessName: true, taxInvoiceEmail: true },
    });
    if (!before) throw new Error('크리에이터를 찾을 수 없습니다.');

    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: { taxType, businessNo, businessName, taxInvoiceEmail, taxMemo, taxUpdatedAt: new Date() },
    });

    /**
     * 감사로그에는 **마스킹된 사업자번호만** 남긴다.
     *
     * 감사로그는 삭제되지 않고 오래 남으며 여러 등급의 관리자가 함께 본다.
     * 사업자번호 원문을 그대로 적으면 세무 담당이 아닌 계정도 전수로 수집할 수 있다.
     * 변경 여부를 추적하는 데는 마스킹 값과 "바뀌었다" 표시만으로 충분하다.
     * (원문은 `creator_profile` 본체에 남아 있고, 세무 화면에서만 권한으로 열람한다)
     */
    await writeAudit({
      adminUserId: admin.id,
      action: 'CREATOR_TAX_PROFILE_UPDATE',
      targetType: 'CreatorProfile',
      targetId: creatorId,
      before: {
        taxType: before.taxType,
        businessNo: maskBusinessNo(before.businessNo),
        businessName: before.businessName,
        taxInvoiceEmail: before.taxInvoiceEmail,
      },
      after: {
        taxType,
        businessNo: maskBusinessNo(businessNo),
        businessNoChanged: (before.businessNo ?? null) !== (businessNo ?? null),
        businessName,
        taxInvoiceEmail,
      },
    });

    revalidatePath('/admin/tax');
    revalidatePath(`/admin/creators/${creatorId}`);

    const changed = normalizeTaxType(before.taxType) !== taxType;
    return changed
      ? `${before.displayName} 의 과세유형을 ${taxTypeLabel[taxType].text}(으)로 변경했습니다. ` +
          `${taxTypeLabel[taxType].withholding ? '다음 지급부터 3.3% 를 원천징수합니다.' : '다음 지급부터 원천징수하지 않습니다.'} ` +
          '이미 지급된 건에는 적용되지 않습니다.'
      : `${before.displayName} 의 세무 정보를 저장했습니다.`;
  });
}

/**
 * 해당 월 지급분의 **원천징수 신고 완료** 표시.
 *
 * 국세청 신고 자체는 홈택스에서 한다. 여기서는 "무엇을 이미 신고했는지" 를 기록해
 * 다음 달에 같은 건을 두 번 신고하거나 빠뜨리는 일을 막는다.
 * 이미 표시된 건은 건드리지 않으므로 여러 번 눌러도 안전하다.
 */
export async function markWithholdingFiled(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '원천징수 신고 완료 처리');

    const ym = text(fd, 'month');
    const { key, start, end } = kstMonthRange(ym);

    const target = await prisma.settlementRequest.findMany({
      where: { status: 'PAID', paidAt: { gte: start, lt: end }, withholdingFiledAt: null },
      select: { id: true },
    });
    if (target.length === 0) {
      throw new Error(`${key} 지급분 중 신고 대기 중인 건이 없습니다. (이미 모두 완료 표시되어 있습니다)`);
    }

    const filedAt = new Date();
    await prisma.settlementRequest.updateMany({
      where: { id: { in: target.map((t) => t.id) } },
      data: { withholdingFiledAt: filedAt },
    });

    await writeAudit({
      adminUserId: admin.id,
      action: 'WITHHOLDING_MARK_FILED',
      targetType: 'SettlementRequest',
      targetId: key,
      after: { month: key, rows: target.length, filedAt: filedAt.toISOString() },
    });

    revalidatePath('/admin/tax');
    return `${key} 지급분 ${target.length}건을 원천징수 신고 완료로 표시했습니다.`;
  });
}
