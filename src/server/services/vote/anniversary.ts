/**
 * 크리에이터 기념일 (2026-11-18) — 생일 · 데뷔일 등. 팬투표 캘린더와 "오늘 생일" 표시에 쓴다.
 */
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { toKst } from '@/lib/datetime';

export const ANNIVERSARY_KIND_LABEL: Record<string, string> = { BIRTHDAY: '생일', DEBUT: '데뷔일', CUSTOM: '기념일' };

export async function saveAnniversary(creatorId: string, input: { kind: string; month: number; day: number; year?: number | null; title?: string | null }) {
  const kind = ['BIRTHDAY', 'DEBUT', 'CUSTOM'].includes(input.kind) ? input.kind : null;
  if (!kind) throw new Error('기념일 종류를 골라 주세요.');
  const m = Math.trunc(input.month);
  const d = Math.trunc(input.day);
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (!maxDay || d < 1 || d > maxDay) throw new Error('날짜를 확인해 주세요.');
  const year = input.year && input.year >= 1900 && input.year <= 2100 ? Math.trunc(input.year) : null;
  const title = (input.title ?? '').trim().slice(0, 30) || ANNIVERSARY_KIND_LABEL[kind];
  const count = await prisma.creatorAnniversary.count({ where: { creatorId } });
  if (count >= 10) throw new Error('기념일은 10개까지 등록할 수 있어요.');
  await prisma.creatorAnniversary.upsert({
    where: { creatorId_kind_month_day: { creatorId, kind, month: m, day: d } },
    create: { id: newId(), creatorId, kind, month: m, day: d, year, title },
    update: { year, title },
  });
}

export async function deleteAnniversary(creatorId: string, id: string) {
  await prisma.creatorAnniversary.deleteMany({ where: { id, creatorId } });
}

export async function listCreatorAnniversaries(creatorId: string) {
  return prisma.creatorAnniversary.findMany({ where: { creatorId }, orderBy: [{ month: 'asc' }, { day: 'asc' }] });
}

/** 한 달 캘린더 (승인된 크리에이터만) */
export async function monthAnniversaries(month: number) {
  const rows = await prisma.creatorAnniversary.findMany({ where: { month }, orderBy: [{ day: 'asc' }, { kind: 'asc' }], take: 500 });
  const creators = await prisma.creatorProfile.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.creatorId))] }, status: 'APPROVED' },
    select: { id: true, code: true, displayName: true, avatarUrl: true, user: { select: { avatarIndex: true } } },
  });
  return rows.filter((r) => creators.some((c) => c.id === r.creatorId)).map((r) => ({ ...r, creator: creators.find((c) => c.id === r.creatorId)! }));
}

/** 오늘(KST) 기념일 */
export async function todayAnniversaries(now: Date = new Date()) {
  const k = toKst(now);
  const list = await monthAnniversaries(k.getUTCMonth() + 1);
  return list.filter((r) => r.day === k.getUTCDate());
}
