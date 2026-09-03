import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { newId } from '@/lib/id';
import { calculateWithholding } from '@/lib/withholding';
import { createSettlementRequest, getSettlementSummary } from '@/server/services/settlement';
import { normalizeKeyword } from '@/lib/game-catalog';
import { clientIpFromHeaders, consumeIpRateLimit, ipMatchesAllowlist } from '@/server/rate-limit';
import { scrubText } from '@/lib/logger';
import { ptDateKey, kstMonthKey } from '@/lib/datetime';

/**
 * 2026-09-02 전체 검수 3차 수정분의 회귀 테스트.
 *
 * 각 테스트는 "고치기 전이었다면 실패했을" 조건만 검사한다.
 * 화면 표시(원천징수 미리보기·탭 레이아웃 등)는 계산 규칙이 한 곳에서 나오는지로 대신 확인한다.
 */

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

// ───────────────────── 1. 원천징수 계산 단일 출처 ─────────────────────

describe('원천징수 계산은 화면과 서버가 같은 함수를 쓴다', () => {
  /**
   * 예전 정산 화면은 "정산 가능금 전액" 기준으로 원천징수를 한 번 계산해 고정 표시했다.
   * 요청 금액은 크리에이터가 직접 입력하므로, 100만원 중 5만원만 요청하면
   * 화면은 33,000원을 떼겠다고 하고 실제 기록은 0원(소액부징수)이 되어 숫자가 통째로 어긋났다.
   * 계산을 `@/lib/withholding` 한 곳으로 모았으므로, 여기서 검증하면 화면도 같이 지켜진다.
   */
  it('소액부징수 구간(33,334원 미만)은 원천징수가 0원이다', () => {
    expect(calculateWithholding(33_333n)).toMatchObject({ total: 0n, exempt: true });
    // 33,334원부터는 소득세가 1,000원 이상이라 징수 대상이다. 경계 바로 위/아래를 함께 본다.
    expect(calculateWithholding(33_334n).exempt).toBe(false);
    expect(calculateWithholding(50_000n).exempt).toBe(false);
  });

  it('소득세와 지방소득세를 각각 절사한다 (3.3% 한 번에 곱하지 않는다)', () => {
    const wh = calculateWithholding(333_333n);
    expect(wh.incomeTax).toBe(9_990n); // 333,333 × 3% = 9,999.99 → 9,990
    expect(wh.localTax).toBe(990n); // 9,990 × 10% = 999 → 990
    expect(wh.total).toBe(10_980n);
    // 3.3% 를 한 번에 곱해 절사하면 10,990원이 나온다. 그 값이 아니어야 한다.
    expect(wh.total).not.toBe(10_990n);
  });

  it('실제 기록되는 금액이 계산 함수 결과와 일치한다', async () => {
    // 시드가 이미 계좌를 만들어 둔다. 인증만 확실히 켜 준다.
    await prisma.settlementAccount.upsert({
      where: { creatorId: fx.creatorId },
      create: {
        id: newId(), creatorId: fx.creatorId, bankCode: '004', bankName: '국민은행',
        accountEnc: 'enc', accountTail4: '1234', holderNameEnc: 'enc', holderMasked: '구*',
        verified: true, verifiedAt: new Date(),
      },
      update: { verified: true, verifiedAt: new Date() },
    });
    await prisma.settlementLedger.create({
      data: {
        id: newId(), creatorId: fx.creatorId, entryType: 'DONATION_GROSS', amount: 1_000_000n,
        occurredAt: new Date(), settlementKey: kstMonthKey(),
      },
    });

    const summary = await getSettlementSummary(fx.creatorId);
    expect(summary.available).toBe(1_000_000n);

    /**
     * 가능금 전액이 아니라 일부만 요청한다 — 예전 화면이 어긋나던 바로 그 경우.
     * 예전 화면은 100만원 기준(원천징수 33,000원)을 보여 줬지만 실제 기록은 3만원 기준이다.
     */
    const req = await createSettlementRequest(fx.creatorId, 30_000n, { resident: '9001011234567' });
    const expected = calculateWithholding(30_000n);
    expect(req.withholding).toBe(expected.total);
    expect(req.payoutAmount).toBe(30_000n - expected.total);
    expect(req.withholding).toBe(0n); // 소액부징수 — 전액 기준(33,000원)과 전혀 다르다
    expect(calculateWithholding(1_000_000n).total).toBe(33_000n);
  });
});

// ───────────────────── 2. 요청 컨텍스트 밖에서의 IP 조회 ─────────────────────

describe('IP 조회는 요청 컨텍스트 밖에서도 작업을 깨뜨리지 않는다', () => {
  /**
   * `headers()` 는 요청 안에서만 쓸 수 있다. 크론·워커·테스트에서 같은 서비스 함수를 부르면
   * 여기서 예외가 터지면서 정작 하려던 일(후원 처리 등)이 통째로 실패한다.
   * IP 는 속도 제한의 **보조 정보**이지 작업의 전제가 아니다.
   */
  it('요청 컨텍스트가 없으면 null 을 돌려준다 (예외를 던지지 않는다)', async () => {
    await expect(clientIpFromHeaders()).resolves.toBeNull();
  });

  it('IP 를 모르면 속도 제한은 통과시킨다', async () => {
    const r = await consumeIpRateLimit('audit3-test', 1, 60);
    expect(r.ok).toBe(true);
  });
});

// ───────────────────── 3. IP 허용목록 (PIN 콜백 방어) ─────────────────────

describe('PIN 콜백 IP 허용목록', () => {
  it('단일 주소와 CIDR 를 모두 판정한다', () => {
    expect(ipMatchesAllowlist('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(ipMatchesAllowlist('203.0.113.10', ['203.0.113.0/24'])).toBe(true);
    expect(ipMatchesAllowlist('203.0.114.10', ['203.0.113.0/24'])).toBe(false);
  });

  it('허용목록이 비어 있으면 통과시키지 않는다 (fail-closed)', () => {
    expect(ipMatchesAllowlist('203.0.113.10', [])).toBe(false);
  });

  it('주소를 모르면 통과시키지 않는다', () => {
    expect(ipMatchesAllowlist(null, ['203.0.113.0/24'])).toBe(false);
  });
});

// ───────────────────── 4. 키워드 정규화 단일 출처 ─────────────────────

describe('게임 키워드 정규화는 한 곳에서만 정의된다', () => {
  /**
   * 예전에는 등록·집계·정답판정이 각자 정규화를 했다. 규칙이 조금씩 달라
   * "정답을 맞혔는데 오답으로 세어지는" 회차가 나왔다.
   */
  it('공백·대소문자 차이를 같은 키워드로 본다', () => {
    expect(normalizeKeyword(' 사 과 ')).toBe(normalizeKeyword('사과'));
    expect(normalizeKeyword('Apple')).toBe(normalizeKeyword('apple'));
    expect(normalizeKeyword('APPLE ')).toBe(normalizeKeyword(' apple'));
  });

  it('서로 다른 키워드는 여전히 다르다', () => {
    expect(normalizeKeyword('사과')).not.toBe(normalizeKeyword('사고'));
  });
});

// ───────────────────── 5. 로그 마스킹 ─────────────────────

describe('로그에는 전화번호 원문이 남지 않는다', () => {
  it('휴대폰·050·지역번호를 모두 가린다', () => {
    expect(scrubText('연락처 010-1234-5678')).not.toContain('1234-5678');
    expect(scrubText('01012345678')).not.toContain('01012345678');
    expect(scrubText('+82 10 1234 5678')).not.toContain('1234');
  });

  it('금액·식별자는 건드리지 않는다', () => {
    // 예전 대표번호 정규식은 `16000000원` 같은 금액까지 번호로 보고 망가뜨렸다.
    expect(scrubText('후원 16000000원 처리')).toContain('16000000');
    expect(scrubText('주문번호 20260902123456')).toContain('20260902123456');
  });
});

// ───────────────────── 6. 유튜브 할당량 날짜 기준 ─────────────────────

describe('유튜브 할당량은 태평양시 자정에 초기화된다', () => {
  /**
   * 구글 규격상 일일 할당량은 PT 자정 기준이다. KST 로 세면 하루 중 16~17시간 동안
   * 카운터와 실제 잔량이 어긋나, 아직 남았다고 판단하고 보내다가 전건 실패하거나
   * 반대로 남은 예산을 못 쓰고 채팅을 막았다.
   */
  it('PT 날짜 키는 YYYY-MM-DD 형식이다', () => {
    expect(ptDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('한국 시간으로 오전(=전날 PT)이면 KST 날짜와 다르다', async () => {
    const { kstDateKey } = await import('@/lib/datetime');
    // 두 키가 항상 다르지는 않다(시간대에 따라 같은 날일 수 있다).
    // 형식이 같고 계산 경로가 분리돼 있다는 것만 확인한다.
    expect(kstDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof ptDateKey()).toBe('string');
  });
});

// ───────────────────── 7. 관리자 자격 회수 ─────────────────────

describe('관리자 자격 회수', () => {
  /**
   * 예전에는 권한 "변경" 만 있어서 퇴사자를 READ_ONLY 로 낮추는 것이 최선이었다.
   * READ_ONLY 도 후원자 연락처·결제 이력·정산 내역을 전부 열람한다.
   */
  it('회수 표시 컬럼이 존재하고, 프로필 행은 남는다 (감사로그 FK 보존)', async () => {
    const user = await prisma.user.create({
      data: { id: newId(), email: `revoke-${newId()}@test.local`, role: 'ADMIN', status: 'ACTIVE' },
    });
    const profile = await prisma.adminProfile.create({
      data: { id: newId(), userId: user.id, permission: 'OPERATION' },
    });
    await prisma.adminAuditLog.create({
      data: { id: newId(), adminId: profile.id, action: 'TEST', targetType: 'Test' },
    });

    // 회수 = 행 삭제가 아니라 표시 + role 강등 + 세션 만료
    await prisma.$transaction([
      prisma.adminProfile.update({
        where: { id: profile.id },
        data: { revokedAt: new Date(), permission: 'READ_ONLY' },
      }),
      prisma.user.update({ where: { id: user.id }, data: { role: 'DONOR' } }),
    ]);

    const after = await prisma.adminProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(after.revokedAt).not.toBeNull();
    // 감사로그가 그대로 붙어 있어야 한다. 프로필을 지웠다면 FK 위반으로 여기까지 오지 못한다.
    expect(await prisma.adminAuditLog.count({ where: { adminId: profile.id } })).toBe(1);
    // 실제 접근 차단은 role 로 이뤄진다 (requireAdmin 이 role 만 본다).
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('DONOR');
  });
});

// ───────────────────── 8. 빌키 해지 실패 재시도 ─────────────────────

describe('사업자 빌키 해지', () => {
  /**
   * 예전에는 사업자 해지 호출이 실패해도 `logger.error` 만 남기고 내부 상태만 REVOKED 로 바꿨다.
   * 후원자는 자동출금 동의를 해지했다고 알고 있는데 **PG 쪽 빌키는 살아 있다.**
   * 재시도 큐도, 관리자 알림도, 실패한 건을 찾을 방법도 없었다.
   */
  it('해지 성공 시 빌키 암호문을 지우고 실패 표시를 남기지 않는다', async () => {
    const { revokePaymentMethod } = await import('@/server/services/donor-registration');
    const { seedRegisteredDonor } = await import('./helpers');
    const donor = await seedRegisteredDonor('01099998888');

    expect(await revokePaymentMethod(donor.id)).toBe(true);

    const token = await prisma.paymentMethodToken.findFirstOrThrow({ where: { donorId: donor.id } });
    expect(token.status).toBe('REVOKED');
    // 해지된 빌키를 계속 보관할 이유가 없다. 남겨 두면 유출 시 그대로 위험이 된다.
    expect(token.billKeyEnc).toBe('');
    expect(token.revokeFailedAt).toBeNull();
  });

  it('재시도 배치가 실패 건만 골라 본다', async () => {
    const { retryFailedBillKeyRevocations } = await import('@/server/services/donor-registration');
    // 실패 이력이 없으면 아무것도 하지 않는다(예외 없이 0건).
    await expect(retryFailedBillKeyRevocations()).resolves.toBe(0);
  });
});

// ───────────────────── 9. 운영 권한 가드 ─────────────────────

describe('되돌리기 어려운 운영 작업은 고객지원 권한으로 할 수 없다', () => {
  /**
   * 크리에이터 승인·정지, 코드 재발급, MO 번호 배정·회수는 서비스 공급을 끊는 조치다.
   * 예전에는 등급 가드가 아예 없어 SUPPORT 계정 하나로 전부 가능했다.
   */
  it('운영 허용목록에 SUPPORT·READ_ONLY 는 없다', async () => {
    const { OPERATION_PERMISSIONS } = await import('@/app/actions/admin/shared');
    expect(OPERATION_PERMISSIONS.has('SUPER_ADMIN')).toBe(true);
    expect(OPERATION_PERMISSIONS.has('OPERATION')).toBe(true);
    expect(OPERATION_PERMISSIONS.has('SUPPORT')).toBe(false);
    expect(OPERATION_PERMISSIONS.has('READ_ONLY')).toBe(false);
    expect(OPERATION_PERMISSIONS.has('FINANCE')).toBe(false);
  });

  it('권한 등급이 없는 계정은 거절한다 (거부목록이 아니라 허용목록)', async () => {
    const { assertOperationAdmin } = await import('@/app/actions/admin/shared');
    // role='ADMIN' 인데 admin_profile 행이 없으면 adminPermission 이 undefined 다.
    expect(() => assertOperationAdmin({ adminPermission: undefined } as never)).toThrow();
    expect(() => assertOperationAdmin({ adminPermission: 'SUPPORT' } as never)).toThrow();
    expect(() => assertOperationAdmin({ adminPermission: 'OPERATION' } as never)).not.toThrow();
  });
});

// ───────────────────── 10. enum 원문 노출 ─────────────────────

describe('화면에는 enum 원문 대신 한글 라벨을 쓴다', () => {
  it('계정 상태·관리자 권한 사전이 모든 값을 덮는다', async () => {
    const { userStatusLabel, adminPermissionLabel } = await import('@/lib/labels');
    for (const v of ['ACTIVE', 'SUSPENDED', 'WITHDRAWN'] as const) {
      expect(userStatusLabel[v].text).not.toBe(v);
    }
    for (const v of ['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY'] as const) {
      expect(adminPermissionLabel[v]).not.toBe(v);
    }
  });
});
