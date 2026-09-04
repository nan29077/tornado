import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { digitsOnly, formatMoNumber } from '@/server/emma';
import { issueMoNumberForCreator, reissueLegacyMoNumbers } from '@/server/services/mo-number-issue';

/**
 * 구 체계(0505) MO 번호 소급 전환 시뮬레이션.
 *
 * 실제로 있었던 일
 * ----------------
 * 크리에이터 화면과 최고관리자 화면에 0505 번호가 계속 보였는데, 정리 도구는
 * "구 체계 번호가 없습니다" 라고 답했다. 원인은 도구와 화면이 **서로 다른
 * 데이터베이스**를 보고 있었던 것이지만, 그와 별개로 정리 로직 자체에도 빠지는
 * 경우가 있었다. 여기서는 그 로직이 **어떤 상태로 남아 있는 0505 든 빠짐없이**
 * 처리하는지 확인한다.
 *
 * 판정 기준은 하나다. 정리 후 테이블 어디에도 살아 있는 구 번호가 남지 않아야 한다.
 */

let fx: Fixture;
const BASE = '16881234';

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

async function makeCreator(name: string, status: 'APPROVED' | 'SUSPENDED' | 'PENDING' = 'APPROVED') {
  const user = await prisma.user.create({
    data: { id: newId(), email: `c-${newId()}@test.kr`, name, role: 'CREATOR' },
  });
  return prisma.creatorProfile.create({
    data: {
      id: newId(),
      userId: user.id,
      code: `TOR-${newId().slice(-5)}`,
      displayName: name,
      status,
      donationAmount: 3000n,
      paymentMode: 'CONFIRM_LINK',
    },
  });
}

/** 크리에이터에게 임의 상태의 번호 행을 붙인다. */
async function attachNumber(
  creatorId: string | null,
  phoneNumber: string,
  status: 'ASSIGNED' | 'RECLAIMED' | 'AVAILABLE' | 'RESERVED' | 'DISABLED',
) {
  return prisma.creatorMoNumber.create({
    data: {
      id: newId(),
      phoneNumber,
      mode: 'DEDICATED',
      status,
      creatorId,
      providerId: 'mtonet',
      assignedAt: creatorId ? new Date() : null,
    },
  });
}

/** 살아 있는(사용중지가 아닌) 구 체계 번호를 전부 찾는다. */
async function survivingLegacy() {
  const rows = await prisma.creatorMoNumber.findMany({
    select: { phoneNumber: true, status: true, creatorId: true },
  });
  return rows.filter(
    (r) => !digitsOnly(r.phoneNumber).startsWith(BASE) && r.status !== 'DISABLED',
  );
}

describe('0505 소급 전환 — 어떤 상태로 남아 있어도 빠지지 않는다', () => {
  it('배정된 0505 는 1688 로 재발급된다', async () => {
    const a = await makeCreator('가나다');
    await attachNumber(a.id, '05051001001', 'ASSIGNED');

    const result = await reissueLegacyMoNumbers();

    const changed = result.reissued.find((r) => r.creatorId === a.id);
    expect(changed, '재발급 목록에 없습니다').toBeDefined();
    expect(changed!.from).toBe('05051001001');
    expect(digitsOnly(changed!.to).startsWith(BASE)).toBe(true);
    expect(await survivingLegacy()).toEqual([]);
  });

  it('여러 크리에이터의 0505 를 한 번에 모두 바꾼다', async () => {
    const creators = [];
    for (let i = 0; i < 5; i += 1) {
      const c = await makeCreator(`크리에이터${i}`);
      await attachNumber(c.id, `0505100100${i}`, 'ASSIGNED');
      creators.push(c);
    }

    const result = await reissueLegacyMoNumbers();

    expect(result.reissued).toHaveLength(5);
    // 서로 다른 번호를 받아야 한다. 같은 번호를 두 명이 받으면 후원이 엉뚱한 곳으로 간다.
    const issued = result.reissued.map((r) => r.to);
    expect(new Set(issued).size).toBe(5);
    for (const n of issued) expect(digitsOnly(n).startsWith(BASE)).toBe(true);
    expect(await survivingLegacy()).toEqual([]);
  });

  it('배정 상태가 아닌 채 붙어 있는 0505 잔재도 떼어 낸다', async () => {
    // 정상 경로로는 잘 생기지 않지만, 수동 SQL·옛 시드·중간에 끊긴 작업으로 남을 수 있다.
    // 이 행은 크리에이터 설정 화면에 그대로 보이므로 "고쳤는데 화면엔 그대로"의 원인이 된다.
    const a = await makeCreator('잔재보유');
    await attachNumber(a.id, `${BASE}7777`, 'ASSIGNED'); // 정상 번호는 따로 있다
    await attachNumber(a.id, '05059000000', 'RECLAIMED'); // 그런데 옛 행이 붙어 있다

    await reissueLegacyMoNumbers();

    const mine = await prisma.creatorMoNumber.findMany({ where: { creatorId: a.id } });
    // 크리에이터 설정 화면은 상태를 가리지 않고 이 목록을 그대로 보여 준다.
    expect(mine.every((r) => digitsOnly(r.phoneNumber).startsWith(BASE))).toBe(true);
    expect(await survivingLegacy()).toEqual([]);
  });

  it('배정되지 않은 재고의 0505 는 사용중지된다', async () => {
    await attachNumber(null, '05051001002', 'AVAILABLE');
    await attachNumber(null, '05051001003', 'RESERVED');
    await attachNumber(null, '15881001', 'AVAILABLE'); // 더 옛날 체계도 함께

    const result = await reissueLegacyMoNumbers();

    expect(result.retiredStock).toHaveLength(3);
    const rows = await prisma.creatorMoNumber.findMany({
      where: { phoneNumber: { in: ['05051001002', '05051001003', '15881001'] } },
    });
    for (const r of rows) expect(r.status).toBe('DISABLED');
    // 사용중지된 번호는 관리자가 다시 배정할 수 없다 → 유령 번호가 되지 않는다.
    expect(await survivingLegacy()).toEqual([]);
  });

  it('승인 상태가 아닌 채널의 0505 는 새 번호를 주지 않고 회수만 한다', async () => {
    const s = await makeCreator('정지채널', 'SUSPENDED');
    await attachNumber(s.id, '05054004004', 'ASSIGNED');

    const result = await reissueLegacyMoNumbers();

    expect(result.reclaimedOnly.some((r) => r.creatorId === s.id)).toBe(true);
    expect(result.reissued.some((r) => r.creatorId === s.id)).toBe(false);
    const mine = await prisma.creatorMoNumber.findMany({ where: { creatorId: s.id } });
    expect(mine, '정지 채널에는 번호가 붙어 있으면 안 된다').toHaveLength(0);
    expect(await survivingLegacy()).toEqual([]);
  });

  it('섞여 있어도 전부 처리한다 (배정·잔재·재고·정지 동시)', async () => {
    const ok = await makeCreator('정상채널');
    await attachNumber(ok.id, '05051111111', 'ASSIGNED');
    const sus = await makeCreator('정지채널', 'SUSPENDED');
    await attachNumber(sus.id, '05052222222', 'ASSIGNED');
    const ghost = await makeCreator('잔재채널');
    await attachNumber(ghost.id, `${BASE}8080`, 'ASSIGNED');
    await attachNumber(ghost.id, '05053333333', 'RECLAIMED');
    await attachNumber(null, '05054444444', 'AVAILABLE');
    await attachNumber(null, '15889000', 'RESERVED');

    await reissueLegacyMoNumbers();

    const left = await survivingLegacy();
    expect(left, `아직 남은 구 번호: ${left.map((r) => formatMoNumber(r.phoneNumber)).join(', ')}`).toEqual([]);
  });

  it('두 번 돌려도 결과가 달라지지 않는다', async () => {
    const a = await makeCreator('반복실행');
    await attachNumber(a.id, '05055005005', 'ASSIGNED');

    const first = await reissueLegacyMoNumbers();
    const after = await prisma.creatorMoNumber.findMany({
      where: { creatorId: a.id, status: 'ASSIGNED' },
      select: { phoneNumber: true },
    });

    const second = await reissueLegacyMoNumbers();

    expect(first.reissued).toHaveLength(1);
    expect(second.reissued).toHaveLength(0);
    expect(second.reclaimedOnly).toHaveLength(0);
    expect(second.retiredStock).toHaveLength(0);
    const still = await prisma.creatorMoNumber.findMany({
      where: { creatorId: a.id, status: 'ASSIGNED' },
      select: { phoneNumber: true },
    });
    expect(still).toEqual(after); // 번호가 또 바뀌지 않는다
  });

  it('이미 1688 인 크리에이터의 번호는 건드리지 않는다', async () => {
    const before = await prisma.creatorMoNumber.findMany({
      where: { creatorId: fx.creatorId },
      select: { phoneNumber: true, status: true },
    });

    const result = await reissueLegacyMoNumbers();

    expect(result.reissued).toHaveLength(0);
    const after = await prisma.creatorMoNumber.findMany({
      where: { creatorId: fx.creatorId },
      select: { phoneNumber: true, status: true },
    });
    expect(after).toEqual(before);
  });
});

describe('신규 크리에이터는 1688 을 받는다', () => {
  it('승인된 신규 크리에이터에게 대표번호 + 4자리를 발급한다', async () => {
    const fresh = await makeCreator('신규채널');

    const issued = await issueMoNumberForCreator(fresh.id);

    expect(issued.baseNumber).toBe(BASE);
    expect(issued.subCode).toMatch(/^\d{4}$/);
    expect(issued.phoneNumber).toBe(`${BASE}${issued.subCode}`);
    expect(digitsOnly(issued.phoneNumber).startsWith('0505')).toBe(false);
    expect(formatMoNumber(issued.phoneNumber)).toMatch(/^1688-1234-\d{4}$/);
  });

  it('신규 10명에게 서로 다른 1688 번호가 나간다', async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const c = await makeCreator(`신규${i}`);
      const issued = await issueMoNumberForCreator(c.id);
      numbers.push(issued.phoneNumber);
    }
    expect(new Set(numbers).size).toBe(10);
    for (const n of numbers) expect(digitsOnly(n).startsWith(BASE)).toBe(true);
  });

  it('구 번호를 들고 있던 크리에이터를 다시 승인하면 1688 로 갈아 끼운다', async () => {
    // 승인 처리(accounts.ts)는 이 함수를 그대로 호출한다.
    const c = await makeCreator('재승인채널');
    await prisma.creatorMoNumber.deleteMany({ where: { creatorId: c.id } });
    await attachNumber(c.id, '05056006006', 'ASSIGNED');

    const issued = await issueMoNumberForCreator(c.id);

    expect(issued.replaced).toBe('05056006006');
    expect(digitsOnly(issued.phoneNumber).startsWith(BASE)).toBe(true);
    expect(await survivingLegacy()).toEqual([]);
  });

  it('승인 상태가 아니면 발급하지 않는다', async () => {
    const p = await makeCreator('심사중채널', 'PENDING');
    await expect(issueMoNumberForCreator(p.id)).rejects.toThrow(/승인된 크리에이터/);
  });
});
