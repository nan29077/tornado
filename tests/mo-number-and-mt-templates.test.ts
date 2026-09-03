import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import {
  issueMoNumberForCreator,
  reissueLegacyMoNumbers,
  reissueMoNumberForCreator,
} from '@/server/services/mo-number-issue';
import { formatMoNumber } from '@/server/emma';
import { SNS_PLATFORMS, deriveLiveState, readSnsLinks } from '@/lib/sns-platforms';
import {
  MT_TEMPLATE,
  applyMtTemplateOverride,
  clearMtTemplateOverrideCache,
  tplDonationSuccess,
  tplPinRequest,
  tplRegisterGuide,
  validateMtTemplateBody,
} from '@/server/services/mt-templates';

/**
 * 2026-09-03 지시분 회귀 테스트.
 *
 *  1) MO 수신번호를 대표번호 + 서브번호(`1688-□□□□-XXXX`) 체계로 강제한다.
 *  2) 최초·확인·PIN 문자는 최고관리자가 안내 문장만 고칠 수 있고 보안링크는 뺄 수 없다.
 *  3) 후원 감사 문자는 크리에이터 설정이 최고관리자 설정보다 우선한다.
 *
 * 각 테스트는 "고치기 전이었다면 실패했을" 조건만 검사한다.
 */

let fx: Fixture;

/** 테스트 환경의 계약 대표번호 (tests/setup.ts 의 EMMA_MO_BASE_NUMBER 와 같아야 한다) */
const BASE = '16881234';

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  clearMtTemplateOverrideCache();
});

/** 크리에이터의 현재 배정 번호를 구 체계 번호로 바꿔 둔다. */
async function giveLegacyNumber(creatorId: string, phoneNumber: string) {
  await prisma.creatorMoNumber.updateMany({
    where: { creatorId },
    data: { status: 'RECLAIMED', creatorId: null, releasedAt: new Date() },
  });
  const row = await prisma.creatorMoNumber.create({
    data: {
      id: newId(),
      phoneNumber,
      mode: 'DEDICATED',
      status: 'ASSIGNED',
      creatorId,
      providerId: 'mtonet',
      assignedAt: new Date(),
    },
  });
  return row.id;
}

// ───────────────────── 1. MO 번호 체계 ─────────────────────

describe('구 체계 번호는 다시 발급될 때 1688 체계로 교체된다', () => {
  /**
   * 예전 issueMoNumberForCreator 는 "이미 ASSIGNED 인 번호가 있으면 그대로 반환" 했다.
   * 그 번호가 구 0505 체계인지 검사하지 않아서, 옛 번호를 받아 둔 크리에이터는
   * 재승인을 몇 번 하든 영원히 0505 를 유지했다. 실제로 보고된 증상이다.
   */
  it('0505 번호를 들고 있으면 새 대표번호 체계로 재발급한다', async () => {
    const legacyId = await giveLegacyNumber(fx.creatorId, '05051001001');

    const issued = await issueMoNumberForCreator(fx.creatorId);

    expect(issued.reused).toBe(false);
    expect(issued.replaced).toBe('05051001001');
    expect(issued.phoneNumber.startsWith(BASE)).toBe(true);
    expect(issued.phoneNumber).toHaveLength(BASE.length + 4);

    // 옛 번호는 회수되어야 한다. 남겨 두면 그 번호로 온 문자가 계속 결제로 이어진다.
    const legacy = await prisma.creatorMoNumber.findUnique({ where: { id: legacyId } });
    expect(legacy?.status).toBe('RECLAIMED');
    expect(legacy?.creatorId).toBeNull();
    expect(legacy?.releasedAt).not.toBeNull();

    // 한 크리에이터에게 배정된 번호는 항상 하나뿐이어야 한다.
    const assigned = await prisma.creatorMoNumber.findMany({
      where: { creatorId: fx.creatorId, status: 'ASSIGNED' },
    });
    expect(assigned).toHaveLength(1);
  });

  it('이미 현재 대표번호 체계면 새로 발급하지 않고 그대로 돌려준다', async () => {
    const issued = await issueMoNumberForCreator(fx.creatorId);
    expect(issued.reused).toBe(true);
    expect(issued.phoneNumber).toBe(fx.moNumber);
    expect(issued.replaced).toBeUndefined();
  });

  it('일괄 재발급은 구 체계만 골라 바꾸고 미승인 채널은 회수만 한다', async () => {
    // 승인된 크리에이터 - 구 번호
    await giveLegacyNumber(fx.creatorId, '15881001');

    // 정지된 크리에이터 - 구 번호. 새 번호를 주면 안 된다.
    const user2 = await prisma.user.create({
      data: { id: newId(), email: `c2-${newId()}@test.kr`, name: '정지채널', role: 'CREATOR' },
    });
    const suspended = await prisma.creatorProfile.create({
      data: {
        id: newId(), userId: user2.id, code: `TOR-${newId().slice(-4)}`,
        displayName: '정지채널', status: 'SUSPENDED', donationAmount: 3000n,
      },
    });
    await giveLegacyNumber(suspended.id, '05059000000');

    const result = await reissueLegacyMoNumbers();

    expect(result.failed).toHaveLength(0);
    expect(result.reissued).toHaveLength(1);
    expect(result.reissued[0].creatorId).toBe(fx.creatorId);
    expect(result.reissued[0].from).toBe('15881001');
    expect(result.reissued[0].to.startsWith(BASE)).toBe(true);

    expect(result.reclaimedOnly).toHaveLength(1);
    expect(result.reclaimedOnly[0].creatorId).toBe(suspended.id);

    // 정지 채널에는 새 번호가 붙지 않아야 한다.
    const suspendedNumbers = await prisma.creatorMoNumber.findMany({
      where: { creatorId: suspended.id, status: 'ASSIGNED' },
    });
    expect(suspendedNumbers).toHaveLength(0);

    // 두 번 돌려도 더 바꿀 것이 없다(멱등).
    const again = await reissueLegacyMoNumbers();
    expect(again.reissued).toHaveLength(0);
    expect(again.reclaimedOnly).toHaveLength(0);
  });

  it('회수한 번호는 냉각기간 때문에 곧바로 재사용되지 않는다', async () => {
    const before = await issueMoNumberForCreator(fx.creatorId);
    const after = await reissueMoNumberForCreator(fx.creatorId, '테스트 재발급');

    expect(after.replaced).toBe(before.phoneNumber);
    expect(after.phoneNumber).not.toBe(before.phoneNumber);
    expect(after.phoneNumber.startsWith(BASE)).toBe(true);
  });

  it('표시 형식은 대표번호와 서브번호를 나눠 보여 준다', () => {
    expect(formatMoNumber('168812345678')).toBe('1688-1234-5678');
    // 대표번호만 있는 경우(키워드 방식)도 사람이 읽을 수 있어야 한다.
    expect(formatMoNumber('16881234')).toBe('1688-1234');
  });
});

// ───────────────────── 2. 보안링크 문자 ─────────────────────

describe('최초·확인·PIN 문자는 안내 문장만 고칠 수 있다', () => {
  it('{보안링크} 가 빠진 본문은 저장을 거부한다', () => {
    const problem = validateMtTemplateBody(
      MT_TEMPLATE.REGISTER_GUIDE,
      '{크리에이터} 크리에이터 후원을 이용하려면 등록이 필요합니다.',
    );
    expect(problem).toContain('{보안링크}');
  });

  it('{보안링크} 가 들어 있으면 저장할 수 있다', () => {
    expect(
      validateMtTemplateBody(
        MT_TEMPLATE.PIN_REQUEST,
        '{크리에이터} 후원 {금액} 진행합니다. 아직 결제되지 않았습니다. 결제: {보안링크} ({유효시간}분)',
      ),
    ).toBeNull();
  });

  it('주소를 직접 적으면 거부한다 (1회용 링크 대신 고정 주소가 나가는 것을 막는다)', () => {
    const problem = validateMtTemplateBody(
      MT_TEMPLATE.CONFIRM_PAYMENT,
      '{크리에이터} 후원 확인: https://example.com {보안링크}',
    );
    expect(problem).toContain('주소를 직접');
  });

  it('정의되지 않은 치환자는 거부한다', () => {
    const problem = validateMtTemplateBody(MT_TEMPLATE.REGISTER_GUIDE, '{없는값} 안내 {보안링크}');
    expect(problem).toContain('{없는값}');
  });

  it('저장한 본문이 실제 발송에 적용되고 링크는 로그에서 마스킹된다', async () => {
    await prisma.mtMessageTemplate.create({
      data: {
        id: newId(),
        code: MT_TEMPLATE.REGISTER_GUIDE,
        body: '{크리에이터} 채널 후원은 {등록수단}이 먼저 필요합니다. 최초 문자는 후원 처리되지 않았습니다. 등록: {보안링크}',
      },
    });
    clearMtTemplateOverrideCache();

    const out = await applyMtTemplateOverride(
      tplRegisterGuide('테스트크리에이터', 'https://donaeido.test/r/abcd1234'),
    );

    expect(out.text).toContain('테스트크리에이터 채널 후원은 계좌 등록이 먼저 필요합니다');
    expect(out.text).toContain('https://donaeido.test/r/abcd1234');
    // 발신 주체 표기는 어떤 본문에서도 강제로 붙는다.
    expect(out.text.startsWith('[도네이도] ')).toBe(true);
    // DB·로그에 남는 본문에는 링크 원문이 없어야 한다.
    expect(out.masked).not.toContain('abcd1234');
    expect(out.masked).toContain('[보안링크]');
  });

  it('mock 결제 표시는 관리자가 문구를 바꿔도 남는다', async () => {
    await prisma.mtMessageTemplate.create({
      data: {
        id: newId(),
        code: MT_TEMPLATE.PIN_REQUEST,
        body: '{크리에이터} 후원 {금액} 진행합니다. 결제: {보안링크}',
      },
    });
    clearMtTemplateOverrideCache();

    const out = await applyMtTemplateOverride(
      tplPinRequest({
        creatorName: '테스트크리에이터',
        amount: 3000n,
        pinUrl: 'https://pg.test/pin/zzzz9999',
        ttlMin: 5,
        mock: true,
      }),
    );

    // [MOCK] 이 사라지면 연동 시험용 문자를 실제 결제로 오인한다.
    expect(out.text.startsWith('[도네이도] [MOCK] ')).toBe(true);
    expect(out.masked).not.toContain('zzzz9999');
  });
});

// ───────────────────── 3. 감사 문자 우선순위 ─────────────────────

describe('후원 감사 문자는 크리에이터 설정이 최고관리자 설정보다 우선한다', () => {
  const input = {
    donorName: '후원자',
    creatorName: '테스트크리에이터',
    amount: 10_000n,
    message: '응원합니다',
    cumulative: 52_000n,
  };

  it('크리에이터가 설정하지 않으면 최고관리자 문구가 나간다', async () => {
    await prisma.mtMessageTemplate.create({
      data: {
        id: newId(),
        code: MT_TEMPLATE.DONATION_SUCCESS,
        body: '{후원자}님 {금액} 감사합니다. (플랫폼 기본)',
      },
    });
    clearMtTemplateOverrideCache();

    const out = await applyMtTemplateOverride(tplDonationSuccess({ ...input, custom: null }));
    expect(out.text).toBe('[도네이도] 후원자님 10,000원 감사합니다. (플랫폼 기본)');
  });

  it('크리에이터가 설정하면 그 문구가 나가고 최고관리자 문구는 무시된다', async () => {
    await prisma.mtMessageTemplate.create({
      data: {
        id: newId(),
        code: MT_TEMPLATE.DONATION_SUCCESS,
        body: '{후원자}님 {금액} 감사합니다. (플랫폼 기본)',
      },
    });
    clearMtTemplateOverrideCache();

    const out = await applyMtTemplateOverride(
      tplDonationSuccess({ ...input, custom: '{후원자}님 고마워요! {메시지}' }),
    );
    expect(out.text).toBe('[도네이도] 후원자님 고마워요! 응원합니다');
    expect(out.text).not.toContain('플랫폼 기본');
  });

  it('둘 다 없으면 코드 기본 문구가 나간다', async () => {
    const out = await applyMtTemplateOverride(tplDonationSuccess({ ...input, custom: null }));
    expect(out.text).toContain('후원자님');
    expect(out.text).toContain('10,000원이 후원되었습니다');
  });
});

// ───────────────────── 4. SNS 링크 · 플랫폼별 라이브 ─────────────────────

describe('SNS 링크와 플랫폼별 방송중 스위치', () => {
  it('주소가 없는 플랫폼은 후원 페이지에 버튼으로 그리지 않는다', () => {
    const links = readSnsLinks({
      youtubeLiveUrl: 'https://www.youtube.com/@test',
      instagramLiveUrl: null,
      tiktokLiveUrl: '',
      facebookLiveUrl: 'https://www.facebook.com/test',
      youtubeLive: true,
      instagramLive: true, // 주소가 없으므로 무시돼야 한다
      tiktokLive: false,
      facebookLive: false,
    });

    expect(links.map((l) => l.platform.value)).toEqual(['YOUTUBE', 'FACEBOOK']);
    expect(links[0].live).toBe(true);
    expect(links[1].live).toBe(false);
  });

  it('동시송출이면 우선순위(유튜브 > 인스타 > 틱톡 > 페이스북)가 대표 라이브가 된다', () => {
    const links = readSnsLinks({
      youtubeLiveUrl: null,
      instagramLiveUrl: 'https://www.instagram.com/test',
      tiktokLiveUrl: 'https://www.tiktok.com/@test',
      facebookLiveUrl: null,
      youtubeLive: false,
      instagramLive: true,
      tiktokLive: true,
      facebookLive: false,
    });

    const derived = deriveLiveState(links);
    expect(derived.liveOn).toBe(true);
    expect(derived.livePlatform).toBe('INSTAGRAM');
    expect(derived.liveUrl).toBe('https://www.instagram.com/test');

    // 배지는 켜 둔 플랫폼마다 하나씩 붙는다.
    expect(links.filter((l) => l.live)).toHaveLength(2);
  });

  it('아무 스위치도 켜지 않으면 파생 라이브 상태가 모두 비워진다', () => {
    const links = readSnsLinks({
      youtubeLiveUrl: 'https://www.youtube.com/@test',
      instagramLiveUrl: null,
      tiktokLiveUrl: null,
      facebookLiveUrl: null,
      youtubeLive: false,
      instagramLive: false,
      tiktokLive: false,
      facebookLive: false,
    });

    expect(deriveLiveState(links)).toEqual({ liveOn: false, livePlatform: null, liveUrl: null });
  });

  it('플랫폼마다 호스트를 검사한다 (엉뚱한 주소를 저장하면 후원자가 빈 페이지로 간다)', () => {
    const yt = SNS_PLATFORMS.find((p) => p.value === 'YOUTUBE')!;
    const fb = SNS_PLATFORMS.find((p) => p.value === 'FACEBOOK')!;

    expect(yt.test('https://www.youtube.com/@test')).toBe(true);
    expect(yt.test('https://youtu.be/abc123')).toBe(true);
    expect(yt.test('https://www.instagram.com/test')).toBe(false);
    // 호스트 끝을 검사하므로 유사 도메인은 통과하지 못한다.
    expect(yt.test('https://youtube.com.evil.example/watch')).toBe(false);

    expect(fb.test('https://www.facebook.com/page')).toBe(true);
    expect(fb.test('https://fb.watch/abc')).toBe(true);
    expect(fb.test('주소아님')).toBe(false);
  });

  it('네 플랫폼이 서로 다른 컬럼을 쓴다 (컬럼이 겹치면 한 링크가 다른 링크를 덮는다)', () => {
    const urlFields = SNS_PLATFORMS.map((p) => p.urlField);
    const liveFields = SNS_PLATFORMS.map((p) => p.liveField);
    expect(new Set(urlFields).size).toBe(SNS_PLATFORMS.length);
    expect(new Set(liveFields).size).toBe(SNS_PLATFORMS.length);
  });
});
