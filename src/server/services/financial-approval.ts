import { prisma } from '@/server/db';

/**
 * DIRECT_TRIGGER(MO 수신 즉시 결제) 는 ALLOW_DIRECT_TRIGGER 환경변수만으로 열어서는 안 된다.
 * 금융사 서면승인이 실제로 등록됐는지 DB 레코드로도 확인한다(M-3).
 *
 * 별도 테이블 대신 system_setting(키-값) 을 쓴다 — 이 한 건을 위해 스키마를 늘릴 필요가 없다.
 */
const WRITTEN_APPROVAL_KEY = 'financial_direct_trigger_written_approval';

interface WrittenApprovalValue {
  approved?: boolean;
  documentRef?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export async function hasDirectTriggerWrittenApproval(): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({ where: { key: WRITTEN_APPROVAL_KEY } });
  const value = row?.value as WrittenApprovalValue | null | undefined;
  return Boolean(value?.approved);
}

/** 금융사 서면승인 등록/해제. 관리자 화면·시드 스크립트에서만 호출한다. */
export async function setDirectTriggerWrittenApproval(
  input: { approved: boolean; documentRef?: string; approvedBy?: string },
): Promise<void> {
  const value: WrittenApprovalValue = {
    approved: input.approved,
    documentRef: input.documentRef,
    approvedBy: input.approvedBy,
    approvedAt: input.approved ? new Date().toISOString() : undefined,
  };
  await prisma.systemSetting.upsert({
    where: { key: WRITTEN_APPROVAL_KEY },
    create: { key: WRITTEN_APPROVAL_KEY, value: value as object, updatedBy: input.approvedBy ?? null },
    update: { value: value as object, updatedBy: input.approvedBy ?? null },
  });
}
