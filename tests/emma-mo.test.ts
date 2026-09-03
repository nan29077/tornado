import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import {
  restoreMoNumber,
  splitMoNumber,
  composeMoNumber,
  formatMoNumber,
  isUsableSubCode,
  queueEmmaMt,
  moTableSuffix,
} from '@/server/emma';
import { ensureDevEmmaTables, insertDevMo, splitForCarrier } from '@/server/emma/dev-schema';
import { runEmmaMoPolling } from '@/server/services/emma-mo-ingest';
import {
  issueMoNumberForCreator,
  reclaimMoNumberForCreator,
  getMoNumberCapacity,
} from '@/server/services/mo-number-issue';
import { resetDb, seedBasics, seedRegisteredDonor, type Fixture } from './helpers';
import { createEmmaTables, clearEmmaTables, insertFakeMo, readMoStatus, readMtQueue } from './emma-helpers';

/**
 * EMMA(인포뱅크 온프레미스 에이전트) 문자 수신 연동.
 *
 * 번호 체계는 `1688-□□□□-XXXX` 다.
 *   - 앞 8자리(테스트에서는 16881234)는 계약한 대표번호로 고정
 *   - 뒤 4자리는 토네이도가 크리에이터에게 직접 부여
 *
 * 이 파일이 지키는 것
 *  1) 사업자가 번호를 어디서 끊어 주든(A/B/C) 같은 수신번호로 복원된다.
 *  2) 같은 문자를 몇 번 폴링하든 후원은 한 번만 생성된다.
 *  3) 남의 대표번호로 온 문자는 처리하지 않고 그대로 남긴다.
 *  4) 처리 중 오류가 나면 신규 상태로 되돌아가 다음 폴링에서 재시도된다.
 *  5) 회수한 서브번호는 냉각기간 안에는 다시 배정되지 않는다.
 */

const BASE = '16881234';

let fx: Fixture;

/** 픽스처 크리에이터에게 1688 계열 전용번호를 붙인다. */
async function assignBaseNumber(subCode: string, creatorId: string) {
  const phoneNumber = composeMoNumber(BASE, subCode);
  await prisma.creatorMoNumber.create({
    data: {
      id: newId(),
      phoneNumber,
      keyword: null,
      baseNumber: BASE,
      subCode,
      mode: 'DEDICATED',
      status: 'ASSIGNED',
      creatorId,
      providerId: 'emma',
      assignedAt: new Date(),
    },
  });
  return phoneNumber;
}

describe('번호 복원 (사업자가 어디서 끊어 주든 같은 결과)', () => {
  it('[A] 대표번호 8자리 + 서브번호 4자리로 나뉘어 온 경우', () => {
    expect(restoreMoNumber('16881234', '5678')).toBe('168812345678');
  });

  it('[B] 앞 4자리 + 뒤 8자리로 나뉘어 온 경우', () => {
    expect(restoreMoNumber('1688', '12345678')).toBe('168812345678');
  });

  it('[C] 전체번호가 한 컬럼에 통째로 온 경우', () => {
    expect(restoreMoNumber('168812345678', null)).toBe('168812345678');
    expect(restoreMoNumber('168812345678', '')).toBe('168812345678');
  });

  it('[변형] 추가번호 컬럼에 전체번호가 중복해서 온 경우 번호가 두 번 반복되지 않는다', () => {
    // 이 방어가 없으면 1688123416881234... 로 이어 붙어 라우팅이 전건 실패한다.
    expect(restoreMoNumber('16881234', '168812345678')).toBe('168812345678');
  });

  it('대시·공백·샵 기호가 섞여 와도 숫자만 남긴다', () => {
    expect(restoreMoNumber('1688-1234', ' 5678 ')).toBe('168812345678');
    expect(restoreMoNumber('#2540', '4679')).toBe('25404679');
  });

  it('전체번호를 대표번호와 서브번호로 다시 나눌 수 있다', () => {
    expect(splitMoNumber('168812345678')).toEqual({ base: '16881234', sub: '5678' });
    expect(formatMoNumber('168812345678')).toBe('1688-1234-5678');
  });

  it('오입력이 몰리는 번호는 서브번호로 쓰지 않는다', () => {
    expect(isUsableSubCode('5678')).toBe(true);
    expect(isUsableSubCode('0000')).toBe(false);
    expect(isUsableSubCode('1234')).toBe(false);
    expect(isUsableSubCode('123')).toBe(false);
    expect(isUsableSubCode('abcd')).toBe(false);
  });
});

describe('EMMA MO 폴링 → 후원 처리', () => {
  beforeAll(async () => {
    await createEmmaTables();
  });

  beforeEach(async () => {
    await resetDb();
    await clearEmmaTables();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('[1] 등록 팬의 수신 문자가 후원으로 만들어지고 결제까지 진행된다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    const moKey = await insertFakeMo({ moRecipient: BASE, emoRecipient: '5678', from: fx.donorPhone });
    const result = await runEmmaMoPolling();

    expect(result.handed).toBe(1);
    expect(result.failed).toBe(0);

    const donation = await prisma.donation.findFirst();
    expect(donation).not.toBeNull();
    // 결제가 끝나면 곧바로 송출까지 이어지므로 최종 상태는 BROADCASTED 다.
    expect(['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED']).toContain(donation!.status);
    expect(donation!.amount).toBe(3000n); // 문자 한 통 = 크리에이터가 정한 고정 금액
    expect(donation!.channel).toBe('MO');
    expect(donation!.paidAt).not.toBeNull();

    // 실제로 승인된 결제가 정확히 한 건 있어야 한다.
    const txns = await prisma.paymentTransaction.findMany();
    expect(txns).toHaveLength(1);
    expect(txns[0].status).toBe('APPROVED');

    // 정산 원장 3분개(총액·PG수수료·플랫폼수수료)가 쌓였는지 확인한다.
    expect(await prisma.settlementLedger.count({ where: { donationId: donation!.id } })).toBeGreaterThanOrEqual(3);

    // 수신 로그의 사업자 메시지 ID 는 EMMA 의 mo_key 를 그대로 쓴다(중복 차단 1차 키).
    const mo = await prisma.moInboundMessage.findUnique({ where: { providerMessageId: moKey } });
    expect(mo).not.toBeNull();
    expect(mo!.receivedNumber).toBe('168812345678');
    expect(mo!.result).toBe('ROUTED');

    // 처리를 끝낸 행은 EMMA 가 쓰지 않는 상태값으로 표시해 다시 읽지 않는다.
    expect(await readMoStatus(moKey)).toBe('9');
  });

  it('[2] 같은 문자를 여러 번 폴링해도 후원은 한 번만 만들어진다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    const moKey = await insertFakeMo({ moRecipient: BASE, emoRecipient: '5678', from: fx.donorPhone });
    await runEmmaMoPolling();

    // 사업자 재전송을 흉내내 상태를 신규로 되돌린 뒤 다시 폴링한다.
    await prisma.$executeRawUnsafe(
      `UPDATE em_mo_log_${moTableSuffix()} SET msg_status = '3' WHERE mo_key = $1`,
      moKey,
    );
    const second = await runEmmaMoPolling();

    expect(second.handed).toBe(1); // 처리는 했지만
    expect(await prisma.donation.count()).toBe(1); // 후원은 하나뿐이다
    expect(await prisma.paymentTransaction.count()).toBe(1);
  });

  it('[3] 폴링이 겹쳐 동시에 돌아도 후원은 한 번만 만들어진다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);
    await insertFakeMo({ moRecipient: BASE, emoRecipient: '5678', from: fx.donorPhone });

    const [a, b] = await Promise.all([runEmmaMoPolling(), runEmmaMoPolling()]);

    expect(a.handed + b.handed).toBeGreaterThanOrEqual(1);
    expect(await prisma.donation.count()).toBe(1);
    expect(await prisma.paymentTransaction.count()).toBe(1);
  });

  it('[4] 배정되지 않은 서브번호로 온 문자는 후원이 만들어지지 않는다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    const moKey = await insertFakeMo({ moRecipient: BASE, emoRecipient: '9911', from: fx.donorPhone });
    const result = await runEmmaMoPolling();

    expect(result.handed).toBe(1);
    expect(result.details[0]?.detail).toBe('UNKNOWN_ROUTE');
    expect(await prisma.donation.count()).toBe(0);
    expect(await readMoStatus(moKey)).toBe('9');
  });

  it('[5] 다른 대표번호로 온 문자는 처리하지 않고 그대로 남긴다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    // 한 EMMA 에 여러 서비스의 번호가 물린 구성에서 남의 후원을 가로채는 사고를 막는 안전판.
    const moKey = await insertFakeMo({ moRecipient: '16889999', emoRecipient: '5678', from: fx.donorPhone });
    const result = await runEmmaMoPolling();

    expect(result.handed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.donation.count()).toBe(0);
    expect(await prisma.moInboundMessage.count()).toBe(0);
    // 우리가 손대지 않았으므로 신규 상태 그대로여야 한다(다른 서비스가 가져갈 수 있게).
    expect(await readMoStatus(moKey)).toBe('3');
  });

  it('[6] 서브번호 없이 대표번호로만 온 문자(답장 등)는 후원이 되지 않는다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    const moKey = await insertFakeMo({ moRecipient: BASE, emoRecipient: null, from: fx.donorPhone });
    const result = await runEmmaMoPolling();

    // 16881234 는 서브번호를 떼면 대표번호가 1688 이 되어 설정값과 다르다 → 처리 대상 아님
    expect(await prisma.donation.count()).toBe(0);
    expect(result.handed + result.skipped).toBe(1);
    expect(await readMoStatus(moKey)).not.toBe('9');
  });

  it('[7] 미등록 팬의 문자는 결제되지 않고 안내만 나간다', async () => {
    await assignBaseNumber('5678', fx.creatorId);

    // 수신 행이 없으면 아무것도 하지 않는다.
    const empty = await runEmmaMoPolling();
    expect(empty.fetched).toBe(0);

    await insertFakeMo({ moRecipient: BASE, emoRecipient: '5678', from: '01099998888' });
    const second = await runEmmaMoPolling();

    expect(second.details[0]?.detail).toBe('UNREGISTERED_DONOR');
    expect(await prisma.donation.count()).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('[8] 배정이 회수된 번호로 온 문자는 결제되지 않는다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    const moKey = await insertFakeMo({ moRecipient: BASE, emoRecipient: '5678', from: fx.donorPhone });

    // 크리에이터가 정지·탈퇴해 번호를 회수한 상황. 라우팅이 끊겨 후원이 만들어지면 안 된다.
    await prisma.creatorMoNumber.updateMany({
      where: { creatorId: fx.creatorId },
      data: { status: 'RECLAIMED', creatorId: null, releasedAt: new Date() },
    });
    const result = await runEmmaMoPolling();

    expect(await prisma.donation.count()).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.details[0]?.detail).toBe('UNKNOWN_ROUTE');
    expect(await readMoStatus(moKey)).toBe('9');
  });

  it('[9] 중단돼 선점 상태로 남은 건은 일정 시간 뒤 다시 처리된다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    // 선점('2') 상태로 오래 방치된 행 — 처리 도중 프로세스가 죽은 상황
    const moKey = await insertFakeMo({
      moRecipient: BASE,
      emoRecipient: '5678',
      from: fx.donorPhone,
      status: '2',
      receivedAgoSec: 600, // 기본 임계값 300초보다 오래됨
    });

    const result = await runEmmaMoPolling();
    expect(result.handed).toBe(1);
    expect(await prisma.donation.count()).toBe(1);
    expect(await readMoStatus(moKey)).toBe('9');
  });

  it('[10] 방금 선점된 건은 다른 폴링이 가져가지 않는다', async () => {
    await assignBaseNumber('5678', fx.creatorId);
    await seedRegisteredDonor(fx.donorPhone);

    const moKey = await insertFakeMo({
      moRecipient: BASE,
      emoRecipient: '5678',
      from: fx.donorPhone,
      status: '2',
      receivedAgoSec: 5, // 임계값 이내 → 진행 중으로 본다
    });

    const result = await runEmmaMoPolling();
    expect(result.fetched).toBe(0);
    expect(await prisma.donation.count()).toBe(0);
    expect(await readMoStatus(moKey)).toBe('2');
    void moKey;
  });
});

describe('로컬 시뮬레이터 경로 (관리자 화면에서 쓰는 것과 같은 코드)', () => {
  beforeAll(async () => {
    await createEmmaTables();
  });

  beforeEach(async () => {
    await resetDb();
    await clearEmmaTables();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  /**
   * 사업자가 수신번호를 어느 지점에서 끊어 보내는지는 계약 후에야 확정된다.
   * A/B/C 어느 방식으로 들어와도 같은 크리에이터에게 후원이 붙어야 한다.
   * 이게 깨지면 계약 형태에 따라 문자후원이 통째로 라우팅되지 않는다.
   */
  const modes = [
    { mode: 'BASE_SUB' as const, label: 'A) 대표번호 8 + 서브 4' },
    { mode: 'PREFIX_REST' as const, label: 'B) 앞 4 + 나머지 8' },
    { mode: 'WHOLE' as const, label: 'C) 전체번호 한 컬럼' },
  ];

  for (const { mode, label } of modes) {
    it(`${label} 로 들어와도 같은 크리에이터에게 후원된다`, async () => {
      const phoneNumber = await assignBaseNumber('5678', fx.creatorId);
      await seedRegisteredDonor(fx.donorPhone);

      await ensureDevEmmaTables();
      const inserted = await insertDevMo({
        fullNumber: phoneNumber,
        from: fx.donorPhone,
        content: '오늘 방송 좋았어요',
        splitMode: mode,
      });

      const poll = await runEmmaMoPolling();
      expect(poll.handed).toBe(1);

      const mo = await prisma.moInboundMessage.findUnique({
        where: { providerMessageId: inserted.moKey },
        select: { receivedNumber: true, creatorId: true, result: true },
      });
      expect(mo?.receivedNumber).toBe('168812345678');
      expect(mo?.creatorId).toBe(fx.creatorId);
      expect(mo?.result).toBe('ROUTED');
      expect(await prisma.donation.count()).toBe(1);
    });
  }

  it('세 방식 모두 같은 수신번호로 복원된다 (계산만 — 후원 생성 없음)', () => {
    const full = '168812345678';
    for (const { mode } of modes) {
      const { moRecipient, emoRecipient } = splitForCarrier(full, mode);
      expect(restoreMoNumber(moRecipient, emoRecipient)).toBe(full);
    }
  });
});

describe('EMMA MT 발송 큐', () => {
  beforeAll(async () => {
    await createEmmaTables();
  });

  beforeEach(async () => {
    await resetDb();
    await clearEmmaTables();
  });

  it('발송 큐에 EMMA 가 픽업할 수 있는 형태로 적재된다', async () => {
    const queued = await queueEmmaMt({ to: '010-1234-5678', callback: '1688-1234', content: '테스트 문자' });
    expect(queued.providerMessageId).toMatch(/^SMT-\d+$/);

    const rows = await readMtQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_num).toBe('01012345678'); // 숫자만 남긴다
    expect(rows[0].callback).toBe('16881234');
    expect(rows[0].msg_status).toBe('1'); // EMMA 가 집어가는 대기 상태
  });

  it('이중화를 쓰지 않으면 emma_id 를 비워 둔다', async () => {
    // emma_id 에 EMMA 설정과 다른 값이 들어가면 큐에 쌓이기만 하고 영원히 발송되지 않는다.
    await queueEmmaMt({ to: '01012345678', callback: '16881234', content: '테스트' });
    const rows = await readMtQueue();
    expect((rows[0].emma_id ?? '').trim()).toBe('');
  });

  it('빈 수신번호·본문은 큐에 넣지 않는다', async () => {
    await expect(queueEmmaMt({ to: '', callback: '16881234', content: '본문' })).rejects.toThrow();
    await expect(queueEmmaMt({ to: '01012345678', callback: '16881234', content: '   ' })).rejects.toThrow();
    expect(await readMtQueue()).toHaveLength(0);
  });
});

describe('서브번호 발급 · 회수', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    // 기본 픽스처는 050/1588 계열 번호를 미리 붙여 준다. 발급 로직 자체를 보려면
    // 배정이 없는 상태에서 시작해야 한다(이미 있으면 재사용이 정상 동작이다).
    await prisma.creatorMoNumber.deleteMany({ where: { creatorId: fx.creatorId } });
  });

  it('승인된 크리에이터에게 대표번호 + 4자리 번호를 발급한다', async () => {
    const issued = await issueMoNumberForCreator(fx.creatorId);

    expect(issued.baseNumber).toBe(BASE);
    expect(issued.subCode).toMatch(/^\d{4}$/);
    expect(issued.phoneNumber).toBe(`${BASE}${issued.subCode}`);
    expect(issued.reused).toBe(false);

    const row = await prisma.creatorMoNumber.findFirst({ where: { creatorId: fx.creatorId, status: 'ASSIGNED' } });
    expect(row?.mode).toBe('DEDICATED');
    expect(row?.keyword).toBeNull();
  });

  it('이미 번호가 있으면 새로 발급하지 않는다', async () => {
    const first = await issueMoNumberForCreator(fx.creatorId);
    const second = await issueMoNumberForCreator(fx.creatorId);

    expect(second.reused).toBe(true);
    expect(second.phoneNumber).toBe(first.phoneNumber);
    expect(await prisma.creatorMoNumber.count({ where: { creatorId: fx.creatorId } })).toBe(1);
  });

  it('오입력이 몰리는 번호는 발급되지 않는다', async () => {
    // 난수 채번이므로 여러 번 돌려 규칙이 지켜지는지 본다.
    for (let i = 0; i < 30; i += 1) {
      const user = await prisma.user.create({
        data: { id: newId(), email: `c-${newId()}@test.kr`, name: 'c', role: 'CREATOR' },
      });
      const creator = await prisma.creatorProfile.create({
        data: { id: newId(), userId: user.id, code: `TOR-${newId().slice(-6)}`, displayName: 'c', status: 'APPROVED' },
      });
      const issued = await issueMoNumberForCreator(creator.id);
      expect(isUsableSubCode(issued.subCode)).toBe(true);
    }
  });

  it('회수한 번호는 냉각기간 안에는 다시 배정되지 않는다', async () => {
    const issued = await issueMoNumberForCreator(fx.creatorId);
    await reclaimMoNumberForCreator(fx.creatorId, '테스트 회수');

    const row = await prisma.creatorMoNumber.findFirst({ where: { subCode: issued.subCode } });
    expect(row?.status).toBe('RECLAIMED');
    expect(row?.creatorId).toBeNull();
    expect(row?.releasedAt).not.toBeNull();

    // 회수된 번호는 여전히 후보에서 제외된다(냉각기간 미경과).
    const capacity = await getMoNumberCapacity(BASE);
    expect(capacity.blocked).toBe(1);
    expect(capacity.available).toBe(10000 - 1);
  });

  it('승인되지 않은 크리에이터에게는 발급하지 않는다', async () => {
    await prisma.creatorProfile.update({ where: { id: fx.creatorId }, data: { status: 'PENDING' } });
    await expect(issueMoNumberForCreator(fx.creatorId)).rejects.toThrow('승인된 크리에이터');
  });
});
