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
import { composeMoNumber, digitsOnly, formatMoNumber, isUsableSubCode, SUB_CODE_LENGTH } from '@/server/emma';

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
 * 서브번호 채번에 필요한 현재 상태.
 *
 *  - blocked  : 지금 쓸 수 없는 번호 (이미 배정됐거나, 회수됐지만 냉각기간이 남은 번호)
 *  - reusable : 냉각기간이 지나 **다시 배정해도 되는** 회수 번호 → 서브번호 → 기존 행 id
 *
 * reusable 을 따로 돌려주는 이유(E-4)
 * -----------------------------------
 * 회수 이력이 있는 번호는 행이 그대로 남아 있다. 냉각기간이 지났다고 해서 같은 번호로
 * `create` 를 하면 `creator_mo_number_base_sub_uniq` 유니크 제약에 걸려 **영원히 실패한다.**
 * 그러면 회수된 번호는 냉각기간이 아무리 지나도 재사용되지 않고, 대표번호가 서서히 말라붙는다.
 * 재배정은 새 행 생성이 아니라 **기존 행 갱신**으로 해야 한다.
 */
async function loadSubCodeState(baseNumber: string, tx: Prisma.TransactionClient | typeof prisma) {
  const rows = await tx.creatorMoNumber.findMany({
    where: { baseNumber, keyword: null, subCode: { not: null } },
    select: { id: true, subCode: true, status: true, releasedAt: true },
  });

  const cooldownMs = REUSE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const blocked = new Set<string>();
  const reusable = new Map<string, string>();

  for (const row of rows) {
    if (!row.subCode) continue;
    // 회수·사용중지 상태이고 냉각기간이 끝났으면 다시 쓸 수 있다.
    const releasable =
      (row.status === 'RECLAIMED' || row.status === 'DISABLED') &&
      row.releasedAt != null &&
      now - row.releasedAt.getTime() >= cooldownMs;
    if (releasable) reusable.set(row.subCode, row.id);
    else blocked.add(row.subCode);
  }
  return { blocked, reusable };
}

export interface IssuedMoNumber {
  id: string;
  phoneNumber: string;
  baseNumber: string;
  subCode: string;
  /** 기존에 배정돼 있던 번호를 그대로 돌려준 경우 true (새로 발급하지 않음) */
  reused: boolean;
  /**
   * 구 체계 번호를 회수하고 새로 발급했을 때, 회수한 옛 번호.
   * 관리자에게 "무엇이 무엇으로 바뀌었는지" 를 알려 주고 감사로그에 남기기 위해 돌려준다.
   */
  replaced?: string;
}

/**
 * 지금 대표번호 체계에 속한 번호인가.
 *
 * 판정 기준은 **현재 설정된 대표번호로 시작하는가** 하나다. 구 050 안심번호·1588 번호는 물론,
 * 인포뱅크 계약이 확정되어 대표번호가 교체되면 옛 대표번호로 발급된 번호도 여기서 걸린다.
 * (그래서 대표번호 교체는 `.env` 값 변경 + 일괄 재발급 한 번으로 끝난다)
 */
function isCurrentScheme(phoneNumber: string, baseNumber: string): boolean {
  return digitsOnly(phoneNumber).startsWith(baseNumber);
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
/**
 * 대표번호 안에서 쓸 수 있는 서브번호를 뽑아 크리에이터에게 붙인다.
 *
 * 발급·재발급이 같은 채번 규칙(난수·예약번호 제외·냉각기간)을 쓰도록 한 곳에 모아 둔다.
 * 두 경로가 갈라지면 재발급 쪽만 순번 채번이 되는 식의 사고가 난다.
 */
async function allocateSubCode(creatorId: string, baseNumber: string, memo: string): Promise<IssuedMoNumber> {
  const { blocked, reusable } = await loadSubCodeState(baseNumber, prisma);

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt += 1) {
    const subCode = pickSubCode();
    if (!isUsableSubCode(subCode)) continue;
    if (blocked.has(subCode)) continue;

    const phoneNumber = composeMoNumber(baseNumber, subCode);

    /**
     * 냉각기간이 지난 회수 번호는 행이 이미 있다. create 하면 유니크 제약에 걸리므로
     * 기존 행을 되살려 배정한다(E-4).
     *
     * updateMany 로 상태 조건을 함께 걸어 **다른 실행이 먼저 가져갔으면 0행**이 되게 한다.
     * (동시에 두 크리에이터가 같은 번호를 받는 것을 막는 낙관적 잠금)
     */
    const reuseId = reusable.get(subCode);
    if (reuseId) {
      const claimed = await prisma.creatorMoNumber.updateMany({
        where: { id: reuseId, creatorId: null, status: { in: ['RECLAIMED', 'DISABLED'] } },
        data: {
          phoneNumber,
          keyword: null,
          mode: 'DEDICATED',
          status: 'ASSIGNED',
          creatorId,
          assignedAt: new Date(),
          releasedAt: null,
          memo,
        },
      });
      if (claimed.count === 0) {
        // 다른 실행이 먼저 선점했다. 다음 후보로 넘어간다.
        reusable.delete(subCode);
        blocked.add(subCode);
        continue;
      }
      logger.info('MO 서브번호 재배정(냉각기간 경과)', { creatorId, phoneNumber, subCode });
      return { id: reuseId, phoneNumber, baseNumber, subCode, reused: false };
    }

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
          memo,
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
 * 크리에이터에게 MO 번호를 발급한다.
 *
 * - 이미 배정된 번호가 **현재 대표번호 체계면** 새로 발급하지 않고 그것을 돌려준다. (중복 발급 방지)
 * - 배정된 번호가 **구 체계면**(0505·1588, 또는 교체 전 대표번호) 회수하고 새로 발급한다.
 *   이 검사가 없으면 옛 번호를 이미 받아 둔 크리에이터는 몇 번을 다시 승인해도 영영 구 번호를 유지한다.
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

  if (existing && isCurrentScheme(existing.phoneNumber, baseNumber)) {
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

  // 구 체계 번호가 붙어 있으면 먼저 떼어 낸다. 새 번호를 붙인 뒤에 떼면 그 사이에 들어온
  // 문자가 어느 쪽으로 갈지 모호해지고, 한 크리에이터에게 번호 두 개가 붙은 상태가 남는다.
  if (existing) {
    await retireLegacyMoNumberRow(existing.id, '구 번호 체계 — 재발급으로 사용중지');
    logger.info('구 체계 MO 번호 사용중지', { creatorId, phoneNumber: existing.phoneNumber });
  }

  const issued = await allocateSubCode(
    creatorId,
    baseNumber,
    existing ? '구 번호 체계 재발급' : '크리에이터 승인 시 자동 발급',
  );
  return existing ? { ...issued, replaced: existing.phoneNumber } : issued;
}

/**
 * 관리자가 특정 크리에이터의 번호를 강제로 다시 발급한다.
 *
 * 번호 유출·오배정 신고처럼 "지금 쓰는 번호를 버려야 하는" 상황에 쓴다.
 * 옛 번호는 회수 처리되어 냉각기간 동안 아무에게도 가지 않는다.
 */
export async function reissueMoNumberForCreator(creatorId: string, reason: string): Promise<IssuedMoNumber> {
  const baseNumber = requireBaseNumber();

  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { id: true, status: true },
  });
  if (!creator) throw new Error('크리에이터를 찾을 수 없습니다.');
  if (creator.status !== 'APPROVED') {
    throw new Error('승인된 크리에이터에게만 번호를 발급할 수 있습니다.');
  }

  const existing = await prisma.creatorMoNumber.findFirst({
    where: { creatorId, status: 'ASSIGNED' },
    select: { id: true, phoneNumber: true },
  });
  if (existing) await releaseMoNumberRow(existing.id, reason);

  const issued = await allocateSubCode(creatorId, baseNumber, reason);
  return existing ? { ...issued, replaced: existing.phoneNumber } : issued;
}

export interface LegacyReissueResult {
  baseNumber: string;
  /** 새 번호를 받은 건 */
  reissued: Array<{ creatorId: string; displayName: string; from: string; to: string }>;
  /**
   * 새 번호를 주지 않고 내리기만 한 건.
   * reason 으로 이유를 구분한다. 두 경우를 뭉뚱그리면 보고서가 사실과 달라진다.
   *  - NOT_APPROVED : 승인 상태가 아닌 채널
   *  - ORPHAN_ROW   : 배정 상태가 아닌 채 붙어 있던 잔재 행
   */
  reclaimedOnly: Array<{
    creatorId: string;
    displayName: string;
    from: string;
    reason: 'NOT_APPROVED' | 'ORPHAN_ROW';
  }>;
  /** 실패한 건 (번호 소진 등) */
  failed: Array<{ creatorId: string; displayName: string; from: string; message: string }>;
  /**
   * 배정되지 않은 채 재고에 남아 있던 구 체계 번호. 사용중지로 내렸다.
   *
   * 배정된 번호만 정리하면 0505 가 재고 목록·MO 시뮬레이터 선택지에 계속 남는다.
   * 관리자는 그 번호를 다시 배정할 수 있고, 배정해도 문자는 오지 않는다.
   */
  retiredStock: Array<{ phoneNumber: string; previousStatus: string }>;
}

/**
 * 현재 대표번호 체계에 속하지 않는 배정 번호를 **전부** 새 번호로 바꾼다.
 *
 * 두 경우에 쓴다.
 *  1) 구 050·1588 번호를 쓰던 크리에이터를 1688 체계로 옮길 때 (1회성 정리)
 *  2) 인포뱅크 계약으로 대표번호가 확정·교체됐을 때 (`.env` 의 EMMA_MO_BASE_NUMBER 교체 후 실행)
 *
 * 한 건이 실패해도 나머지는 계속 진행하고, 결과를 건별로 돌려준다.
 * 전체를 트랜잭션으로 묶지 않는 이유는 수백 건 중 하나가 실패했다고 이미 잘 바뀐 것까지
 * 되돌리면 크리에이터마다 번호가 왔다 갔다 하기 때문이다.
 */
export async function reissueLegacyMoNumbers(): Promise<LegacyReissueResult> {
  const baseNumber = requireBaseNumber();

  /**
   * 크리에이터에게 **붙어 있는** 번호를 모두 본다. 상태로 거르지 않는다.
   *
   * 예전에는 `status='ASSIGNED'` 인 행만 봤다. 정상 경로는 배정을 풀 때 creatorId 도
   * 함께 비우므로 대개 맞지만, 그렇지 않은 행이 하나라도 생기면
   * (수동 SQL, 옛 시드, 중간에 끊긴 작업) 이 정리에서 **통째로 빠진다.**
   * 그런 행은 크리에이터 설정 화면에는 그대로 보이므로 "고쳤다는데 화면엔 그대로"가 된다.
   * 붙어 있는 것은 상태와 무관하게 전부 훑는 편이 안전하다.
   */
  const assigned = await prisma.creatorMoNumber.findMany({
    where: { creatorId: { not: null } },
    select: {
      id: true,
      phoneNumber: true,
      status: true,
      creatorId: true,
      creator: { select: { status: true, displayName: true } },
    },
  });

  const legacy = assigned.filter((row) => !isCurrentScheme(row.phoneNumber, baseNumber));
  const result: LegacyReissueResult = { baseNumber, reissued: [], reclaimedOnly: [], failed: [], retiredStock: [] };

  for (const row of legacy) {
    const creatorId = row.creatorId;
    if (!creatorId) continue;
    const displayName = row.creator?.displayName ?? creatorId;

    /**
     * 배정 상태가 아닌데 크리에이터가 붙어 있는 행은 떼어 내기만 한다.
     * 이미 다른 번호가 정상 배정돼 있을 수 있어, 새 번호를 또 주면 한 채널에 번호가
     * 둘이 된다. 잘못된 잔재를 지우는 것이 목적이다.
     */
    if (row.status !== 'ASSIGNED') {
      await retireLegacyMoNumberRow(row.id, '구 번호 체계 정리 — 배정 상태가 아닌 잔재 행 정리');
      result.reclaimedOnly.push({ creatorId, displayName, from: row.phoneNumber, reason: 'ORPHAN_ROW' });
      continue;
    }

    // 승인 상태가 아닌 채널에 번호가 붙어 있으면 새 번호를 주지 않고 회수만 한다.
    // (정지된 채널로 후원 문자가 계속 들어오는 것을 막는 것이 우선이다)
    if (row.creator?.status !== 'APPROVED') {
      await retireLegacyMoNumberRow(row.id, '구 번호 체계 정리 — 미승인 채널이라 번호만 내림');
      result.reclaimedOnly.push({ creatorId, displayName, from: row.phoneNumber, reason: 'NOT_APPROVED' });
      continue;
    }

    try {
      /**
       * **새 번호를 먼저 발급하고, 성공한 뒤에 옛 번호를 회수한다.**
       *
       * 회수를 먼저 하면 발급이 실패했을 때(번호 소진·일시적 DB 오류) 그 크리에이터는
       * 배정 번호가 하나도 없는 상태로 남는다. 회수된 번호는 냉각기간 때문에 즉시 되돌려
       * 줄 수도 없어서, 관리자가 알아채기 전까지 후원 문자가 전부 UNKNOWN_ROUTE 가 된다.
       *
       * 순서를 뒤집으면 최악의 경우가 "옛 번호가 남아 있다"(발급 실패) 또는
       * "두 번호가 동시에 살아 있다"(회수 실패)가 된다. 둘 다 후원은 계속 접수되고,
       * 라우팅은 phone_number 완전일치(routeCreator)라 번호가 둘이어도 서로 충돌하지 않는다.
       * (base_number+sub_code 유니크는 상태와 무관하므로 새 번호 발급 자체는 막히지 않는다)
       *
       * 단건 경로(issueMoNumberForCreator)는 반대 순서를 쓴다. 그쪽은 호출자가 결과를 즉시
       * 확인하므로 실패가 드러나고, 번호가 둘이면 화면에 어느 것을 보여 줄지 모호해지는 쪽이
       * 더 문제다. 수백 건을 한 번에 훑는 이 경로는 실패가 목록 속에 묻히므로 판단이 다르다.
       */
      const issued = await allocateSubCode(creatorId, baseNumber, '구 번호 체계 일괄 재발급');
      try {
        await retireLegacyMoNumberRow(row.id, '구 번호 체계 — 일괄 재발급으로 사용중지');
      } catch (e) {
        // 새 번호는 이미 살아 있다. 옛 번호가 함께 남아도 후원 접수에는 지장이 없으므로
        // 실패로 처리하지 않고, 관리자가 정리할 수 있도록 경고만 남긴다.
        logger.error('구 번호 회수 실패 — 옛 번호가 배정된 채로 남았습니다. 수동 회수가 필요합니다.', {
          creatorId,
          from: row.phoneNumber,
          to: issued.phoneNumber,
          message: (e as Error).message,
        });
      }
      result.reissued.push({ creatorId, displayName, from: row.phoneNumber, to: issued.phoneNumber });
    } catch (e) {
      result.failed.push({ creatorId, displayName, from: row.phoneNumber, message: (e as Error).message });
      logger.warn('구 번호 일괄 재발급 실패 — 옛 번호를 그대로 유지합니다.', {
        creatorId,
        from: row.phoneNumber,
        message: (e as Error).message,
      });
    }
  }

  /**
   * 배정되지 않은 구 체계 재고 정리.
   *
   * 크리에이터에게 붙어 있지 않아도 목록과 시뮬레이터 선택지에는 그대로 나온다.
   * 지우지 않고 DISABLED 로 내리는 이유: 과거 수신 이력(mo_inbound_message)이 이 번호를
   * 참조하고, 어떤 번호가 언제 쓰였는지는 분쟁 대응에 필요하다.
   */
  const stock = await prisma.creatorMoNumber.findMany({
    where: { status: { not: 'DISABLED' }, creatorId: null },
    select: { id: true, phoneNumber: true, status: true },
  });
  // (이미 DISABLED 인 구 번호는 화면에서 "사용중지"로 표시되고 배정할 수도 없으므로 그대로 둔다.
  //  과거 수신 이력이 이 행을 참조하므로 지우지도 않는다.)
  for (const row of stock) {
    if (isCurrentScheme(row.phoneNumber, baseNumber)) continue;
    await prisma.creatorMoNumber.update({
      where: { id: row.id },
      data: {
        status: 'DISABLED',
        creatorId: null,
        releasedAt: new Date(),
        memo: '구 번호 체계 — 재고에서 사용중지',
      },
    });
    result.retiredStock.push({ phoneNumber: row.phoneNumber, previousStatus: row.status });
  }

  logger.info('구 번호 일괄 재발급 완료', {
    baseNumber,
    reissued: result.reissued.length,
    reclaimedOnly: result.reclaimedOnly.length,
    failed: result.failed.length,
    retiredStock: result.retiredStock.length,
  });
  return result;
}

/** 재발급 결과를 관리자 화면에 보여 줄 한 문장으로 만든다. */
export function describeLegacyReissue(r: LegacyReissueResult): string {
  const touched =
    r.reissued.length + r.reclaimedOnly.length + r.failed.length + r.retiredStock.length;
  if (touched === 0) {
    return `구 체계 번호가 없습니다. 배정된 번호와 재고가 모두 ${formatMoNumber(r.baseNumber)} 체계입니다.`;
  }
  const parts = [`${r.reissued.length}건을 ${formatMoNumber(r.baseNumber)} 체계로 재발급했습니다.`];
  if (r.reclaimedOnly.length > 0) parts.push(`미승인 채널 ${r.reclaimedOnly.length}건은 회수만 했습니다.`);
  if (r.retiredStock.length > 0) parts.push(`재고에 남아 있던 구 번호 ${r.retiredStock.length}건은 사용중지했습니다.`);
  if (r.failed.length > 0) parts.push(`${r.failed.length}건은 실패했습니다 (${r.failed[0].message}).`);
  return parts.join(' ');
}

/**
 * 번호 한 행의 배정을 푼다.
 * 회수 시각(releasedAt)을 남겨야 냉각기간이 걸리므로, 배정 해제는 반드시 이 경로로만 한다.
 */
async function releaseMoNumberRow(id: string, memo: string): Promise<void> {
  await prisma.creatorMoNumber.update({
    where: { id },
    data: { status: 'RECLAIMED', creatorId: null, releasedAt: new Date(), memo },
  });
}

/**
 * 구 체계 번호를 **재고에서 완전히 내린다.**
 *
 * 왜 회수(RECLAIMED)로는 부족한가
 * --------------------------------
 * 회수만 하면 그 번호는 배정만 풀린 채 재고 목록에 그대로 남는다.
 *  - 관리자 MO 번호 화면과 MO 시뮬레이터 선택지에 0505 가 계속 보인다
 *    ("번호를 바꿨다는데 왜 아직 보이냐"의 실제 원인 중 하나다)
 *  - 회수 상태는 관리자가 다시 배정할 수 있다. 배정해도 그 번호로는 문자가 오지 않으므로
 *    후원이 통째로 끊긴 채널이 만들어진다.
 *
 * 지우지 않고 사용중지로 내리는 이유는 과거 수신 이력(mo_inbound_message)이 이 번호를
 * 참조하고, 어떤 번호가 언제 쓰였는지가 분쟁 대응에 필요하기 때문이다.
 */
async function retireLegacyMoNumberRow(id: string, memo: string): Promise<void> {
  await prisma.creatorMoNumber.update({
    where: { id },
    data: { status: 'DISABLED', creatorId: null, releasedAt: new Date(), memo },
  });
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

/**
 * 대표번호 사용 현황. 관리자 화면에서 소진도를 보여 줄 때 쓴다.
 *
 * available 계산에 대하여(E-4)
 * ----------------------------
 * 예전에는 `total - blocked` 였다. 두 가지가 빠져 있었다.
 *  1) **예약(오입력 다발) 번호**(0000·1234·1111 …)는 애초에 채번 후보에서 빠지는데도 여유로 셌다.
 *  2) 냉각기간이 지난 회수 번호는 blocked 에서 빠지므로 여유로 잡히는데, 실제로는 재배정
 *     경로가 없어 쓸 수 없었다. 지금은 재배정이 되므로 여유로 세는 것이 맞다.
 * 그래서 "실제로 뽑힐 수 있는 후보"를 그대로 세는 방식으로 바꾼다.
 */
export async function getMoNumberCapacity(baseNumber = digitsOnly(env.emma.baseNumber)) {
  const total = 10 ** SUB_CODE_LENGTH;
  /** 오입력이 몰려 채번에서 제외한 번호 수. 대표번호와 무관하게 고정이다. */
  const reserved = countReservedSubCodes();
  if (!baseNumber) {
    return { baseNumber: '', total, assigned: 0, blocked: 0, reserved, available: total - reserved };
  }
  const assigned = await prisma.creatorMoNumber.count({
    where: { baseNumber, keyword: null, status: 'ASSIGNED' },
  });
  const { blocked } = await loadSubCodeState(baseNumber, prisma);
  // 예약 번호와 사용 중인 번호가 겹칠 수 있으므로 빼기가 아니라 실제 후보를 센다.
  let available = 0;
  for (let n = 0; n < total; n += 1) {
    const code = String(n).padStart(SUB_CODE_LENGTH, '0');
    if (!isUsableSubCode(code)) continue;
    if (blocked.has(code)) continue;
    available += 1;
  }
  return { baseNumber, total, assigned, blocked: blocked.size, reserved, available };
}

/** 채번에서 제외되는 번호(오입력 다발) 개수. */
function countReservedSubCodes(): number {
  const total = 10 ** SUB_CODE_LENGTH;
  let count = 0;
  for (let n = 0; n < total; n += 1) {
    if (!isUsableSubCode(String(n).padStart(SUB_CODE_LENGTH, '0'))) count += 1;
  }
  return count;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  // Prisma P2002 / PostgreSQL 23505
  return code === 'P2002' || code === '23505';
}
