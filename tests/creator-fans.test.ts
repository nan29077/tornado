import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone } from '@/lib/crypto';
import {
  attributeFanByCreatorCode,
  attributeFanToCreator,
  promoteSignupFan,
  listCreatorFans,
} from '@/server/services/creator-fans';

/**
 * 팬 귀속 회귀 테스트.
 *
 * 규칙: 후원자는 (1) 그 크리에이터의 MO 번호로 후원했거나 (2) 그 크리에이터의 후원 페이지로
 * 로그인·가입했으면 그 크리에이터의 팬이다. 신원이 둘(전화번호 / 계정)이라 저장 위치가
 * 갈리므로, **두 경로가 한 목록에 모두 나오는지**가 이 파일의 핵심 검증이다.
 */

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

/** 계정만 있는(휴대폰 미연결) 후원자 */
async function makeUser(name: string) {
  return prisma.user.create({
    data: { id: newId(), name, role: 'DONOR', email: `${newId()}@test.kr` },
    select: { id: true, name: true },
  });
}

/** 번호가 연결된 후원자(계정 + DonorProfile) */
async function makeLinkedDonor(name: string, phone: string) {
  const user = await makeUser(name);
  const donor = await prisma.donorProfile.create({
    data: {
      id: newId(),
      userId: user.id,
      phoneHash: phoneHash(phone),
      phoneEnc: encrypt(phone),
      phoneMasked: maskPhone(phone),
      displayName: name,
    },
    select: { id: true },
  });
  return { userId: user.id, donorId: donor.id };
}

/** 이 크리에이터에게 후원한 이력을 링크 행으로 만든다(문자후원으로 생기는 것과 같은 형태). */
async function giveDonationHistory(donorId: string, creatorId: string, amount: bigint, count: number) {
  await prisma.donorCreatorLink.create({
    data: {
      id: newId(),
      donorId,
      creatorId,
      joinedVia: 'DONATION',
      totalAmount: amount,
      totalCount: count,
      lastDonatedAt: new Date(),
    },
  });
}

describe('후원 페이지 로그인은 그 크리에이터에게 귀속된다', () => {
  it('로그인하면 signupCreatorId 가 채워진다', async () => {
    const user = await makeUser('가입팬');
    await attributeFanByCreatorCode(user.id, fx.creatorCode);

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { signupCreatorId: true },
    });
    expect(after?.signupCreatorId).toBe(fx.creatorId);
  });

  /**
   * "누구를 통해 들어왔는가"는 사실 기록이다. 나중에 다른 크리에이터 페이지를 봤다고
   * 소급해 바꾸면 유입 경로가 사라진다.
   */
  it('이미 귀속된 계정은 다른 크리에이터 페이지를 방문해도 바뀌지 않는다', async () => {
    const user = await makeUser('가입팬');
    await attributeFanByCreatorCode(user.id, fx.creatorCode);

    const other = await prisma.user.create({
      data: { id: newId(), email: `c2-${newId()}@test.kr`, name: '다른채널', role: 'CREATOR' },
    });
    const otherCreator = await prisma.creatorProfile.create({
      data: {
        id: newId(), userId: other.id, code: `TOR-${newId().slice(-4)}`,
        displayName: '다른채널', status: 'APPROVED', donationAmount: 3000n,
      },
    });
    await attributeFanToCreator(user.id, otherCreator.id);

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { signupCreatorId: true },
    });
    expect(after?.signupCreatorId).toBe(fx.creatorId);
  });

  it('승인되지 않은 채널에는 귀속하지 않는다', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { status: 'SUSPENDED' } });
    const user = await makeUser('가입팬');
    await attributeFanByCreatorCode(user.id, fx.creatorCode);

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { signupCreatorId: true },
    });
    expect(after?.signupCreatorId).toBeNull();
  });

  it('번호가 이미 연결된 계정이면 링크 행까지 만든다', async () => {
    const { userId, donorId } = await makeLinkedDonor('번호연결팬', '01011112222');
    await attributeFanByCreatorCode(userId, fx.creatorCode);

    const link = await prisma.donorCreatorLink.findFirst({ where: { donorId, creatorId: fx.creatorId } });
    expect(link?.joinedVia).toBe('SIGNUP');
  });

  /**
   * 후원으로 먼저 팬이 된 사람이 나중에 로그인한다고 유입 경로가 뒤집히면 안 된다.
   */
  it('후원으로 이미 생긴 링크는 SIGNUP 으로 덮이지 않는다', async () => {
    const { userId, donorId } = await makeLinkedDonor('후원팬', '01033334444');
    await giveDonationHistory(donorId, fx.creatorId, 30_000n, 6);

    await attributeFanByCreatorCode(userId, fx.creatorCode);

    const links = await prisma.donorCreatorLink.findMany({ where: { donorId, creatorId: fx.creatorId } });
    expect(links).toHaveLength(1);
    expect(links[0].joinedVia).toBe('DONATION');
    expect(links[0].totalAmount).toBe(30_000n);
  });

  it('나중에 번호를 연결하면 링크 행으로 승격된다', async () => {
    const user = await makeUser('나중연결팬');
    await attributeFanByCreatorCode(user.id, fx.creatorCode);

    const donor = await prisma.donorProfile.create({
      data: {
        id: newId(), userId: user.id, phoneHash: phoneHash('01055556666'),
        phoneEnc: encrypt('01055556666'), phoneMasked: maskPhone('01055556666'),
      },
      select: { id: true },
    });
    await promoteSignupFan(user.id, donor.id);

    const link = await prisma.donorCreatorLink.findFirst({ where: { donorId: donor.id, creatorId: fx.creatorId } });
    expect(link?.joinedVia).toBe('SIGNUP');
  });
});

describe('팬 목록은 두 경로를 한자리에 모은다', () => {
  it('문자후원 팬과 가입만 한 팬이 모두 나온다', async () => {
    const a = await makeLinkedDonor('후원많이', '01000000001');
    await giveDonationHistory(a.donorId, fx.creatorId, 50_000n, 10);

    const b = await makeLinkedDonor('후원조금', '01000000002');
    await giveDonationHistory(b.donorId, fx.creatorId, 3_000n, 1);

    const c = await makeUser('가입만');
    await attributeFanByCreatorCode(c.id, fx.creatorCode);

    const board = await listCreatorFans(fx.creatorId, { sort: 'amount' });

    expect(board.summary.fanCount).toBe(3);
    expect(board.summary.supporterCount).toBe(2);
    expect(board.summary.totalAmount).toBe(53_000n);
    expect(board.fans.map((f) => f.name)).toEqual(['후원많이', '후원조금', '가입만']);

    // 번호를 연결하지 않은 팬은 후원 집계 대상이 아니라는 것이 화면에 드러나야 한다.
    expect(board.fans[2].linked).toBe(false);
    expect(board.fans[2].phoneMasked).toBeNull();
  });

  it('상위 10위는 후원한 팬만, 후원금 순으로 뽑는다', async () => {
    for (let i = 1; i <= 12; i += 1) {
      const d = await makeLinkedDonor(`팬${String(i).padStart(2, '0')}`, `0101000${String(i).padStart(4, '0')}`);
      await giveDonationHistory(d.donorId, fx.creatorId, BigInt(i * 1000), i);
    }
    const onlySignup = await makeUser('가입만');
    await attributeFanByCreatorCode(onlySignup.id, fx.creatorCode);

    const board = await listCreatorFans(fx.creatorId);

    expect(board.top).toHaveLength(10);
    expect(board.top[0].totalAmount).toBe(12_000n);
    expect(board.top[9].totalAmount).toBe(3_000n);
    // 후원 이력이 없는 팬은 순위에 들어가지 않는다.
    expect(board.top.some((f) => f.name === '가입만')).toBe(false);
  });

  it('상위 10위는 검색어와 무관하게 전체 기준이다', async () => {
    const a = await makeLinkedDonor('가나다', '01000000011');
    await giveDonationHistory(a.donorId, fx.creatorId, 90_000n, 3);
    const b = await makeLinkedDonor('라마바', '01000000012');
    await giveDonationHistory(b.donorId, fx.creatorId, 10_000n, 1);

    const board = await listCreatorFans(fx.creatorId, { q: '라마바' });

    expect(board.fans).toHaveLength(1);
    expect(board.total).toBe(1);
    // 목록은 걸러졌지만 순위표는 전체를 본다.
    expect(board.top.map((f) => f.name)).toEqual(['가나다', '라마바']);
  });

  it('정렬 기준을 바꾸면 순서가 바뀐다', async () => {
    const older = await makeLinkedDonor('먼저가입', '01000000021');
    await giveDonationHistory(older.donorId, fx.creatorId, 1_000n, 1);
    await prisma.donorCreatorLink.updateMany({
      where: { donorId: older.donorId },
      data: { createdAt: new Date('2026-01-01T00:00:00Z') },
    });

    const newer = await makeLinkedDonor('나중가입', '01000000022');
    await giveDonationHistory(newer.donorId, fx.creatorId, 99_000n, 9);

    const byAmount = await listCreatorFans(fx.creatorId, { sort: 'amount' });
    expect(byAmount.fans[0].name).toBe('나중가입');

    const byOldest = await listCreatorFans(fx.creatorId, { sort: 'joinedAsc' });
    expect(byOldest.fans[0].name).toBe('먼저가입');

    const byCount = await listCreatorFans(fx.creatorId, { sort: 'count' });
    expect(byCount.fans[0].name).toBe('나중가입');
  });

  it('다른 크리에이터의 팬은 섞이지 않는다', async () => {
    const mine = await makeLinkedDonor('내팬', '01000000031');
    await giveDonationHistory(mine.donorId, fx.creatorId, 5_000n, 1);

    const otherUser = await prisma.user.create({
      data: { id: newId(), email: `c3-${newId()}@test.kr`, name: '다른채널', role: 'CREATOR' },
    });
    const otherCreator = await prisma.creatorProfile.create({
      data: {
        id: newId(), userId: otherUser.id, code: `TOR-${newId().slice(-4)}`,
        displayName: '다른채널', status: 'APPROVED', donationAmount: 3000n,
      },
    });
    const theirs = await makeLinkedDonor('남의팬', '01000000032');
    await giveDonationHistory(theirs.donorId, otherCreator.id, 70_000n, 7);

    const board = await listCreatorFans(fx.creatorId);
    expect(board.fans.map((f) => f.name)).toEqual(['내팬']);
    expect(board.summary.totalAmount).toBe(5_000n);
  });

  it('전화번호는 마스킹된 값만 나간다', async () => {
    const d = await makeLinkedDonor('마스킹확인', '01098765432');
    await giveDonationHistory(d.donorId, fx.creatorId, 1_000n, 1);

    const board = await listCreatorFans(fx.creatorId);
    const fan = board.fans[0];
    expect(fan.phoneMasked).not.toContain('9876');
    expect(fan.phoneMasked).toContain('*');
    // 목록 어디에도 번호 원문이 실리지 않아야 한다 (bigint 가 섞여 있어 직접 직렬화한다).
    const dumped = JSON.stringify(board, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(dumped).not.toContain('01098765432');
  });
});

// ───────────── 여러 크리에이터의 팬이 되는 경우 (A · B 동시 소속) ─────────────

describe('한 사람이 여러 크리에이터의 팬이 될 수 있다', () => {
  /** 두 번째 크리에이터를 만든다. */
  async function makeCreator(name: string) {
    const user = await prisma.user.create({
      data: { id: newId(), email: `${newId()}@test.kr`, name, role: 'CREATOR' },
    });
    return prisma.creatorProfile.create({
      data: {
        id: newId(), userId: user.id, code: `TOR-${newId().slice(-4)}`,
        displayName: name, status: 'APPROVED', donationAmount: 3000n,
      },
      select: { id: true, code: true, displayName: true },
    });
  }

  /**
   * 민수: A 에 가입하고 후원 → 그다음 B 에 로그인하고 후원.
   * 두 크리에이터 모두의 팬 목록에 나와야 한다.
   */
  it('A 에 가입·후원한 뒤 B 에도 가입·후원하면 양쪽 팬이 된다', async () => {
    const b = await makeCreator('두번째채널');
    const minsu = await makeLinkedDonor('민수', '01077778888');

    // A: 후원 페이지 로그인 + 문자후원
    await attributeFanByCreatorCode(minsu.userId, fx.creatorCode);
    await prisma.donorCreatorLink.updateMany({
      where: { donorId: minsu.donorId, creatorId: fx.creatorId },
      data: { totalAmount: 20_000n, totalCount: 4, lastDonatedAt: new Date() },
    });

    // B: 후원 페이지 로그인 + 문자후원
    await attributeFanByCreatorCode(minsu.userId, b.code);
    await prisma.donorCreatorLink.updateMany({
      where: { donorId: minsu.donorId, creatorId: b.id },
      data: { totalAmount: 7_000n, totalCount: 2, lastDonatedAt: new Date() },
    });

    const boardA = await listCreatorFans(fx.creatorId);
    const boardB = await listCreatorFans(b.id);

    expect(boardA.fans.map((f) => f.name)).toContain('민수');
    expect(boardB.fans.map((f) => f.name)).toContain('민수');
  });

  /**
   * **가장 중요한 규칙.**
   * A 는 A 에게 들어온 후원만 본다. 민수가 B 에게 얼마를 냈는지는 A 에게 보이면 안 된다.
   */
  it('각 크리에이터는 자기에게 온 후원금만 본다 (남의 채널 후원금이 합산되지 않는다)', async () => {
    const b = await makeCreator('두번째채널');
    const minsu = await makeLinkedDonor('민수', '01077778888');

    await giveDonationHistory(minsu.donorId, fx.creatorId, 20_000n, 4);
    await giveDonationHistory(minsu.donorId, b.id, 7_000n, 2);

    const boardA = await listCreatorFans(fx.creatorId);
    const boardB = await listCreatorFans(b.id);

    const minsuInA = boardA.fans.find((f) => f.name === '민수')!;
    const minsuInB = boardB.fans.find((f) => f.name === '민수')!;

    expect(minsuInA.totalAmount).toBe(20_000n);
    expect(minsuInA.totalCount).toBe(4);
    expect(minsuInB.totalAmount).toBe(7_000n);
    expect(minsuInB.totalCount).toBe(2);

    // 두 채널 합계(27,000원)가 어느 한쪽에도 나타나면 안 된다.
    expect(minsuInA.totalAmount).not.toBe(27_000n);
    expect(boardA.summary.totalAmount).toBe(20_000n);
    expect(boardB.summary.totalAmount).toBe(7_000n);
  });

  it('번호를 연결하지 않은 계정도 A·B 양쪽 팬 목록에 나온다', async () => {
    const b = await makeCreator('두번째채널');
    const user = await makeUser('번호없는팬');

    await attributeFanByCreatorCode(user.id, fx.creatorCode);
    await attributeFanByCreatorCode(user.id, b.code);

    const boardA = await listCreatorFans(fx.creatorId);
    const boardB = await listCreatorFans(b.id);

    expect(boardA.fans.map((f) => f.name)).toContain('번호없는팬');
    expect(boardB.fans.map((f) => f.name)).toContain('번호없는팬');

    // 유입 실적(처음 데려온 크리에이터)은 여전히 A 하나뿐이다.
    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { signupCreatorId: true },
    });
    expect(after?.signupCreatorId).toBe(fx.creatorId);
  });

  it('번호를 나중에 연결하면 양쪽 팬 소속이 모두 후원 집계용으로 옮겨진다', async () => {
    const b = await makeCreator('두번째채널');
    const user = await makeUser('나중연결');
    await attributeFanByCreatorCode(user.id, fx.creatorCode);
    await attributeFanByCreatorCode(user.id, b.code);

    const donor = await prisma.donorProfile.create({
      data: {
        id: newId(), userId: user.id, phoneHash: phoneHash('01099990000'),
        phoneEnc: encrypt('01099990000'), phoneMasked: maskPhone('01099990000'),
      },
      select: { id: true },
    });
    await promoteSignupFan(user.id, donor.id);

    const links = await prisma.donorCreatorLink.findMany({ where: { donorId: donor.id } });
    expect(links.map((l) => l.creatorId).sort()).toEqual([fx.creatorId, b.id].sort());

    // 중복 표시를 막기 위해 계정 기록은 지워진다.
    const leftover = await prisma.creatorFanAccount.findMany({ where: { userId: user.id } });
    expect(leftover).toHaveLength(0);

    // 양쪽 목록에 한 번씩만 나온다.
    const boardA = await listCreatorFans(fx.creatorId);
    expect(boardA.fans.filter((f) => f.name === '나중연결')).toHaveLength(1);
  });
});
