/**
 * MO 서브번호 발급 · 회수.
 *
 * 번호 체계는 `1688-□□□□-XXXX` 다. 앞 8자리는 인포뱅크와 계약한 대표번호로 고정이고,
 * **뒤 4자리는 인포뱅크 승인 없이 토네이도가 직접 부여한다.** 그래서 크리에이터 승인 시점에
 * 즉시 발급해 바로 후원을 받게 할 수 있다(관리자 수동 배정을 기다릴 필요가 없다).
 *
 * 채번 규칙 세 가지
 * -----------------
 * 1. **순차가 아니라 난수(CSPRNG)로 뽑는다.**
 *    0001, 0002 … 로 나가면 내 번호에서 ±1 을 해 보는 것만으로 남의 후원 번호를 알아낼 수 있다.
 *
 * 2. **오입력이 몰리는 번호는 제외한다.** (0000, 1234, 1111 …)
 *    장난·오타 문자가 특정 크리에이터에게 실제 결제로 이어지는 것을 막는다.
 *
 * 3. **회수한 번호는 냉각기간이 지나기 전에는 다시 쓰지 않는다.**
 *    이게 가장 중요하다. 크리에이터 A 가 그만두고 번호가 회수된 뒤 곧바로 B 에게 재배정되면,
 *    A 를 후원하던 사람이 예전 번호로 문자를 보내는 순간 **B 에게 실제 돈이 결제된다.**
 *    후원자도 A 도 B 도 알아챌 방법이 없다. 4자리면 여유가 있으므로 넉넉히 잠가 둔다.
 */

import crypto from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { composeMoNumber, digitsOnly, isUsableSubCode, SUB_CODE_LENGTH } from '@/server/emma';

/**
 * 회수한 번호를 다시 쓰기까지의 냉각기간(일).
 * 기본 180일. 서브번호가 부족해지기 전까지는 길게 잡는 편이 안전하다.
 */
const REUSE_COOLDOWN_DAYS = Number(process.env.MO_SUBCODE_COOLDOWN_DAYS ?? 180);

/** 난수 채번 시도 횟수. 이보다 많이 충돌하면 번호 고갈로 보고 사람을 부른다. */
const MAX_PICK_ATTEMPTS = 40;

export class MoNumberExhaustedError extends Error {
  constructor(baseNumber: string) {
    super(
      `대표번호 ${baseNumber} 에서 배정 가능한 서브번호를 찾지 못했습니다. ` +
        '번호가 거의 소진되었거나 냉각기간에 묶여 있습니다. 대표번호 추가 계약을 검토해 주세요.',
    );
    this.name = 'MoNumberExhaustedError';
  }
}

export class MoBaseNumberNotConfiguredError extends Error {
  constructor() {
    super('EMMA_MO_BASE_NUMBER 가 설정되지 않았습니다. 계약한 대표번호를 지정해야 서브번호를 발급할 수 있습니다.');
    this.name = 'MoBaseNumberNotConfiguredError';
  }
}

/** 설정된 대표번호(숫자만). 없으면 예외. */
export function requireBaseNumber(): string {
  const base = digitsOnly(env.emma.baseNumber);
  if (!base) throw new MoBaseNumberNotConfiguredError();
  return base;
}

/** CSPRNG 로 4자리 서브번호 후보를 뽑는다. */
function pickSubCode(): string {
  return String(crypto.randomInt(0, 10 ** SUB_CODE_LENGTH)).padStart(SUB_CODE_LENGTH, '0');
}

/**
 * 지금 쓸 수 없는 서브번호 집합.
 *  - 이미 등록된 번호 전부 (상태 무관: 회수된 번호도 냉각기간 동안은 막는다)
 *  - 냉각기간이 지난 회수 번호는 다시 열어 준다.
 */
async function loadBlockedSubCodes(baseNumber: string, tx: Prisma.TransactionClient | typeof prisma) {
  const rows = await tx.creatorMoNumber.findMany({
    where: { baseNumber, keyword: null, subCode: { not: null } },
    select: { subCode: true, status: true, releasedAt: true },
  });

  const cooldownMs = REUSE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const blocked = new Set<string>();

  for (const row of rows) {
    if (!row.subCode) continue;
    // 회수·사용중지 상태이고 냉각기간이 끝났으면 다시 쓸 수 있다.
    const releasable =
      (row.status === 'RECLAIMED' || row.status === 'DISABLED') &&
      row.releasedAt != null &&
      now - row.releasedAt.getTime() >= cooldownMs;
    if (!releasable) blocked.add(row.subCode);
  }
  return blocked;
}

export interface IssuedMoNumber {
  id: string;
  phoneNumber: string;
  baseNumber: string;
  subCode: string;
  /** 기존에 배정돼 있던 번호를 그대로 돌려준 경우 true (새로 발급하지 않음) */
  reused: boolean;
}

/**
 * 크리에이터에게 MO 번호를 발급한다.
 *
 * - 이미 배정된 번호가 있으면 **새로 발급하지 않고 그것을 돌려준다.** (중복 발급 방지)
 * - 크리에이터 상태가 APPROVED 가 아니면 발급하지 않는다.
 *
 * 동시 호출 안전성
 *   `creator_mo_number_base_sub_uniq` 부분 유니크 인덱스가 최종 방어선이다. 후보를 뽑아
 *   INSERT 하다 충돌하면 다음 후보로 넘어간다(낙관적 채번). 미리 조회한 목록만 믿으면
 *   동시에 승인된 두 크리에이터가 같은 번호를 받을 수 있다.
 */
export async function issueMoNumberForCreator(creatorId: string): Promise<IssuedMoNumber> {
  const baseNumber = requireBaseNumber();

  const existing = await prisma.creatorMoNumber.findFirst({
    where: { creatorId, status: 'ASSIGNED' },
    select: { id: true, phoneNumber: true, baseNumber: true, subCode: true },
  });
  if (existing) {
    return {
      id: existing.id,
      phoneNumber: existing.phoneNumber,
      baseNumber: existing.baseNumber ?? baseNumber,
      subCode: existing.subCode ?? '',
      reused: true,
    };
  }

  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { id: true, status: true, displayName: true },
  });
  if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');
  if (creator.status !== 'APPROVED') {
    throw new Error('승인된 크리에이터에게만 번호를 발급할 수 있습니다.');
  }

  const blocked = await loadBlockedSubCodes(baseNumber, prisma);

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt += 1) {
    const subCode = pickSubCode();
    if (!isUsableSubCode(subCode)) continue;
    if (blocked.has(subCode)) continue;

    const phoneNumber = composeMoNumber(baseNumber, subCode);
    try {
      const created = await prisma.creatorMoNumber.create({
        data: {
          id: newId(),
          phoneNumber,
          keyword: null,
          baseNumber,
          subCode,
          mode: 'DEDICATED',
          status: 'ASSIGNED',
          creatorId,
          assignedAt: new Date(),
          releasedAt: null,
          memo: '크리에이터 승인 시 자동 발급',
        },
        select: { id: true },
      });
      logger.info('MO 서브번호 발급', { creatorId, phoneNumber, subCode });
      return { id: created.id, phoneNumber, baseNumber, subCode, reused: false };
    } catch (e) {
      // 유니크 충돌이면 다음 후보로. 그 외 오류는 그대로 올린다.
      if (isUniqueViolation(e)) {
        blocked.add(subCode);
        continue;
      }
      throw e;
    }
  }

  throw new MoNumberExhaustedError(baseNumber);
}

/**
 * 크리에이터의 번호를 회수한다.
 * 배정을 풀고 회수 시각을 남긴다. 이 시각으로부터 냉각기간이 지나야 다른 사람에게 갈 수 있다.
 */
export async function reclaimMoNumberForCreator(creatorId: string, reason?: string): Promise<number> {
  const now = new Date();
  const r = await prisma.creatorMoNumber.updateMany({
    where: { creatorId, status: 'ASSIGNED' },
    data: {
      status: 'RECLAIMED',
      creatorId: null,
      releasedAt: now,
      memo: reason ?? '크리에이터 상태 변경으로 회수',
    },
  });
  if (r.count > 0) logger.info('MO 서브번호 회수', { creatorId, count: r.count, reason });
  return r.count;
}

/** 대표번호 사용 현황. 관리자 화면에서 소진도를 보여 줄 때 쓴다. */
export async function getMoNumberCapacity(baseNumber = digitsOnly(env.emma.baseNumber)) {
  if (!baseNumber) return { baseNumber: '', total: 10 ** SUB_CODE_LENGTH, assigned: 0, blocked: 0, available: 0 };
  const total = 10 ** SUB_CODE_LENGTH;
  const assigned = await prisma.creatorMoNumber.count({
    where: { baseNumber, keyword: null, status: 'ASSIGNED' },
  });
  const blocked = (await loadBlockedSubCodes(baseNumber, prisma)).size;
  // 예약 번호는 애초에 후보에서 빠진다.
  return { baseNumber, total, assigned, blocked, available: total - blocked };
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  // Prisma P2002 / PostgreSQL 23505
  return code === 'P2002' || code === '23505';
}
