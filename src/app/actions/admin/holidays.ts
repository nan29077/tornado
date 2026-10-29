'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { isValidDateKey, formatDateKeyKo } from '@/lib/business-day';
import type { AdminActionState } from '@/components/admin/state';
import type { SessionUser } from '@/server/auth';
import { run, text, optText, bool, enumValue, requiredId, assertFinanceAdmin } from './shared';

/**
 * 공휴일(public_holiday) 관리 액션.
 *
 * 이 표가 틀리면 전체 정산일 계산이 통째로 어긋나므로(settlement-schedule.ts 참고),
 * 고객지원(SUPPORT)·읽기전용(READ_ONLY) 권한에서는 어떤 변경도 허용하지 않는다.
 *
 * 2026-10-29 (4차 점검): 공휴일은 정산 보류·지급일을 바꾸므로 **돈이 움직이는 작업**으로 본다.
 * 운영(OPERATION) 도 막고 최고관리자·재무(FINANCE)만 등록·수정·삭제할 수 있다(assertFinanceAdmin 과 같은 집합).
 */

const HOLIDAY_KINDS = ['STATUTORY', 'SUBSTITUTE', 'TEMPORARY', 'BANK_ONLY'] as const;

function assertHolidayAdmin(admin: SessionUser): void {
  assertFinanceAdmin(admin, '공휴일 등록·수정·삭제(정산일 계산에 직접 영향)');
}

export async function createHolidayAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertHolidayAdmin(admin);

    const date = text(fd, 'date');
    if (!isValidDateKey(date)) {
      throw new Error('날짜가 올바르지 않습니다. 달력에 실제로 있는 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.');
    }
    const name = text(fd, 'name');
    if (name.length < 1) throw new Error('공휴일 명칭을 입력해 주세요.');
    const kind = enumValue(fd, 'kind', HOLIDAY_KINDS, '공휴일 종류');
    const memo = optText(fd, 'memo');

    const existing = await prisma.publicHoliday.findUnique({ where: { date }, select: { name: true } });
    if (existing) {
      throw new Error(`${date} 는 이미 "${existing.name}"(으)로 등록되어 있습니다. 등록된 항목을 수정해 주세요.`);
    }

    const created = await prisma.publicHoliday.create({
      data: { id: newId(), date, name, kind, memo },
    });
    await writeAudit({
      adminUserId: admin.id,
      action: 'HOLIDAY_CREATE',
      targetType: 'PublicHoliday',
      targetId: created.id,
      after: { date, name, kind, memo },
    });
    revalidatePath('/admin/holidays');
    return `${formatDateKeyKo(date)} "${name}" 을(를) 공휴일로 등록했습니다.`;
  });
}

export async function updateHolidayAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertHolidayAdmin(admin);

    const id = requiredId(fd, 'id', '공휴일');
    const name = text(fd, 'name');
    if (name.length < 1) throw new Error('공휴일 명칭을 입력해 주세요.');
    const kind = enumValue(fd, 'kind', HOLIDAY_KINDS, '공휴일 종류');
    const active = bool(fd, 'active');
    const memo = optText(fd, 'memo');

    const before = await prisma.publicHoliday.findUnique({ where: { id } });
    if (!before) throw new Error('공휴일을 찾을 수 없습니다.');

    await prisma.publicHoliday.update({ where: { id }, data: { name, kind, active, memo } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'HOLIDAY_UPDATE',
      targetType: 'PublicHoliday',
      targetId: id,
      before: { name: before.name, kind: before.kind, active: before.active, memo: before.memo },
      after: { name, kind, active, memo },
    });
    revalidatePath('/admin/holidays');
    return `${formatDateKeyKo(before.date)} "${name}" 정보를 수정했습니다.`;
  });
}

export async function deleteHolidayAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertHolidayAdmin(admin);

    const id = requiredId(fd, 'id', '공휴일');
    const before = await prisma.publicHoliday.findUnique({ where: { id } });
    if (!before) throw new Error('공휴일을 찾을 수 없습니다.');

    await prisma.publicHoliday.delete({ where: { id } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'HOLIDAY_DELETE',
      targetType: 'PublicHoliday',
      targetId: id,
      before: { date: before.date, name: before.name, kind: before.kind, active: before.active },
    });
    revalidatePath('/admin/holidays');
    return `${formatDateKeyKo(before.date)} "${before.name}" 공휴일을 삭제했습니다.`;
  });
}
