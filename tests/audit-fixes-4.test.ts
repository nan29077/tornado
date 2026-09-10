import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { moPayload, resetDb, seedBasics, seedRegisteredDonor, matureDonations, type Fixture } from './helpers';
import { createGame, spinRound, startRound } from '@/server/services/games';
import { buildStudioStateShared } from '@/server/services/game-state';
import {
  closeOverlayConnections,
  registerOverlayConnection,
} from '@/server/services/overlay-connections';
import {
  createSettlementRequest,
  getSettlementSummary,
  markSettlementPaid,
  markSettlementPayoutFailed,
} from '@/server/services/settlement';
import { isRecord, readJsonObject, stringList } from '@/lib/json-body';
import { answerIndexAfterRemove } from '@/lib/game-catalog';
import { pageParam } from '@/components/studio/shared';
import { kstMonthKey, kstMonthRange } from '@/lib/datetime';
import { isFanSort } from '@/server/services/creator-fans';
import { snsPlatform } from '@/lib/sns-platforms';
import { imageUrlSchema } from '@/lib/image-url';
import { newId } from '@/lib/id';
import { scrubText } from '@/lib/logger';
import { encrypt } from '@/lib/crypto';
import { handleMoInbound } from '@/server/services/donation-flow';
import { mockMoAdapter } from '@/server/adapters/mo';

/**
 * 크리에이터 계정 관리자(스튜디오) 전 기능 검수에서 나온 결함의 재발 방지.
 *
 * 각 검사는 **고치기 전에는 실패해야 하는** 형태로 적었다.
 * 검사 이름 앞의 기호는 검수 보고서의 등급이다. (A=높음 · B=보통 · C=낮음)
 */

let fx: Fixture;

// ──────────────────────────────────────────────────────────────
// 순수 계산 — DB 없이 도는 것들
// ──────────────────────────────────────────────────────────────

describe('C-3 · JSON 본문은 객체일 때만 받는다', () => {
  const bodyOf = (raw: string) =>
    readJsonObject(new Request('http://x/', { method: 'POST', body: raw }));

  it('null · 숫자 · 문자열 · 배열 본문은 빈 객체가 된다', async () => {
    // 고치기 전에는 body.action 을 읽는 순간 TypeError → 500 이었다.
    // (JSON 규격상 이것들도 전부 "유효한" 본문이다)
    expect(await bodyOf('null')).toEqual({});
    expect(await bodyOf('123')).toEqual({});
    expect(await bodyOf('"start"')).toEqual({});
    expect(await bodyOf('[1,2,3]')).toEqual({});
  });

  it('깨진 JSON 도 빈 객체가 된다', async () => {
    expect(await bodyOf('{oops')).toEqual({});
  });

  it('객체는 그대로 통과한다', async () => {
    expect(await bodyOf('{"action":"start","gameId":"g1"}')).toEqual({
      action: 'start',
      gameId: 'g1',
    });
  });

  it('빈 객체에서 값을 읽어도 터지지 않고 "알 수 없는 요청" 경로를 탄다', async () => {
    const body = await bodyOf('null');
    expect(String(body.action ?? '')).toBe(''); // switch 의 default 로 간다 → 400
  });

  it('isRecord 는 배열과 null 을 객체로 보지 않는다', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('stringList 는 문자열만 남긴다', () => {
    // 항목에 객체가 섞이면 뒤에서 .trim() 을 부르다 500 이 났다.
    expect(stringList(['가', 1, null, { a: 1 }, '나'])).toEqual(['가', '나']);
    expect(stringList('가나다')).toEqual([]);
    expect(stringList(undefined)).toEqual([]);
  });
});

describe('B-6 · 선택지를 지우면 정답 번호가 따라간다', () => {
  it('정답보다 앞을 지우면 한 칸 당긴다', () => {
    // A B C D 에서 C 가 정답(2) → B 삭제 → A C D 에서 C 는 1 번
    expect(answerIndexAfterRemove(2, 1)).toBe(1);
  });

  it('정답 자체를 지우면 첫 선택지로 내린다', () => {
    expect(answerIndexAfterRemove(2, 2)).toBe(0);
  });

  it('정답보다 뒤를 지우면 그대로 둔다', () => {
    expect(answerIndexAfterRemove(1, 3)).toBe(1);
  });

  it('고치기 전 동작(그대로 두기)과 결과가 다르다', () => {
    // 이 검사가 이번 결함의 핵심이다. 그대로 두면 정답이 조용히 옆 선택지로 옮겨간다.
    expect(answerIndexAfterRemove(2, 0)).not.toBe(2);
  });
});

describe('C-1 · 목록 페이지 번호', () => {
  it('음수 · 0 · 글자 · 없음은 모두 1 쪽이 된다', () => {
    // 고치기 전에는 skip 이 음수가 되어 Prisma 가 500 을 냈다.
    expect(pageParam('-5')).toBe(1);
    expect(pageParam('0')).toBe(1);
    expect(pageParam('abc')).toBe(1);
    expect(pageParam(undefined)).toBe(1);
    expect(pageParam('')).toBe(1);
  });

  it('소수는 내림한다', () => {
    expect(pageParam('2.9')).toBe(2);
  });

  it('배열로 들어오면 첫 값을 쓴다', () => {
    expect(pageParam(['3', '9'])).toBe(3);
  });

  it('정상 값은 그대로 쓴다', () => {
    expect(pageParam('4')).toBe(4);
  });
});

describe('C-2 · 정산 달력의 월 검증', () => {
  const now = kstMonthKey();

  it('연도가 터무니없으면 이번 달로 되돌린다', () => {
    // 고치기 전에는 월(01~12)만 봤다. 9999-12 → 다음 달 키가 10000-01 →
    // Invalid Date 가 Prisma 조건에 들어가 정산 화면 전체가 500 이었다.
    expect(kstMonthRange('9999-12').key).toBe(now);
    expect(kstMonthRange('0001-05').key).toBe(now);
  });

  it('어떤 입력에도 시작·끝이 유효한 날짜다', () => {
    for (const bad of ['9999-12', '0000-00', '2026-13', 'abcd-ef', '', '2026-1']) {
      const r = kstMonthRange(bad);
      expect(Number.isNaN(r.start.getTime()), `${bad} 의 시작이 Invalid Date`).toBe(false);
      expect(Number.isNaN(r.end.getTime()), `${bad} 의 끝이 Invalid Date`).toBe(false);
    }
  });

  it('정상 월은 그대로 쓰고 앞뒤 달을 바르게 계산한다', () => {
    const r = kstMonthRange('2026-01');
    expect(r.key).toBe('2026-01');
    expect(r.prevKey).toBe('2025-12');
    expect(r.nextKey).toBe('2026-02');
  });
});

describe('C-5 · 팬 정렬 기준', () => {
  it('프로토타입 키는 정렬 기준이 아니다', () => {
    // `in` 을 쓰던 시절에는 이것들이 통과해 정렬이 통째로 무시됐다.
    expect(isFanSort('toString')).toBe(false);
    expect(isFanSort('constructor')).toBe(false);
    expect(isFanSort('__proto__')).toBe(false);
  });

  it('진짜 정렬 기준은 통과한다', () => {
    expect(isFanSort('amount')).toBe(true);
    expect(isFanSort('joinedAsc')).toBe(true);
  });
});

describe('A-2 · SNS 주소는 호스트로만 판단한다', () => {
  const ok = (v: string) => snsPlatform('YOUTUBE').test(v);

  it('호스트 이름을 흉내 낸 javascript: 주소를 거른다', () => {
    // 고치기 전에는 문자열에 youtube.com 이 들어 있는지만 봤다.
    // new URL('javascript://www.youtube.com/%0Aalert(1)').hostname 은 www.youtube.com 이다.
    expect(ok('javascript://www.youtube.com/%0Aalert(1)')).toBe(false);
    expect(ok('data://www.youtube.com/x')).toBe(false);
  });

  it('진짜 주소는 통과한다', () => {
    expect(ok('https://www.youtube.com/@tornado')).toBe(true);
    expect(snsPlatform('FACEBOOK').test('https://fb.com/page')).toBe(true);
  });

  it('다른 사이트 주소는 그 칸에 들어가지 않는다', () => {
    expect(ok('https://example.com/@tornado')).toBe(false);
    // 호스트 끝이 정확히 일치해야 한다 (youtube.com.evil.kr 은 통과하면 안 된다)
    expect(ok('https://www.youtube.com.evil.kr/@tornado')).toBe(false);
  });
});

describe('B-8 · 프로필 이미지 주소', () => {
  const ok = (v: string) => imageUrlSchema.safeParse(v).success;

  it('javascript: · data: 주소를 거른다', () => {
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('data:image/png;base64,AAAA')).toBe(false);
  });

  it('길이 상한을 넘는 주소를 거른다', () => {
    expect(ok(`https://cdn.test.kr/${'a'.repeat(600)}.png`)).toBe(false);
  });

  it('http(s) 주소와 사이트 내 경로, 빈 값은 허용한다', () => {
    expect(ok('https://cdn.test.kr/a.png')).toBe(true);
    expect(ok('/uploads/a.png')).toBe(true);
    expect(ok('')).toBe(true);
  });
});

describe('추가 · 로그의 카드번호 마스킹이 주문번호를 지우지 않는다', () => {
  it('진짜 카드번호는 끝 4자리만 남긴다', () => {
    expect(scrubText('승인 실패 4111111111111111')).toContain('************1111');
    expect(scrubText('승인 실패 4111111111111111')).not.toContain('4111111111111111');
    expect(scrubText('card=5555555555554444')).toContain('************4444');
  });

  it('14자리 주문번호는 그대로 남는다', () => {
    // 자릿수만 보던 시절에는 주문번호까지 **********3456 이 되어
    // 결제 장애를 추적할 때 로그로 건을 특정할 수 없었다.
    expect(scrubText('주문번호 20260902123456')).toContain('20260902123456');
  });

  it('금액은 건드리지 않는다', () => {
    expect(scrubText('후원 16000000원 처리')).toContain('16000000');
  });
});

describe('C-4 · 주민등록번호를 숨은 입력칸에 다시 담지 않는다', () => {
  it('입력 화면에 13자리를 합쳐 넣는 hidden 칸이 없다', () => {
    const src = readFileSync('src/components/studio/resident-field.tsx', 'utf8');
    // 뒤 7자리를 type=password 로 가려 놓고 hidden 칸에 원문을 그대로 담으면
    // 개발자 도구·확장 프로그램·자동완성이 전체 번호를 그대로 읽는다.
    expect(src).not.toMatch(/type="hidden"[^>]*name="resident"/);
    expect(src).not.toContain('${front}${back}');
    // 대신 앞·뒤를 따로 보내고 서버에서 합친다.
    expect(src).toContain('name="residentFront"');
    expect(src).toContain('name="residentBack"');
  });

  it('서버가 앞·뒤 칸을 합쳐서 읽는다', () => {
    const src = readFileSync('src/app/actions/studio.ts', 'utf8');
    expect(src).toContain("text(formData, 'residentFront')");
    expect(src).toContain("text(formData, 'residentBack')");
  });
});

// ──────────────────────────────────────────────────────────────
// DB 가 필요한 것들
// ──────────────────────────────────────────────────────────────

const GAME = {
  type: 'ROULETTE',
  title: '검수용 룰렛',
  items: ['가', '나', '다'],
  config: {},
  entryMode: 'FREE',
  donationMinAmount: 0,
  autoCloseSec: 0,
} as const;

describe('DB 검사', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  describe('A-1 · 게임을 띄운 직후의 상태 캐시', () => {
    it('시작 직후 곧바로 물어봐도 진행 중인 회차가 나온다', async () => {
      // 증상: [방송에 시작] → 화면에 잠깐 떴다가 사라졌다가 2초 뒤 다시 나타난다.
      // 원인: 스냅샷 캐시(1.5초)에 "게임 없음" 이 남아 있는데 시작 직후 그 캐시를 지우지 않았다.
      const before = await buildStudioStateShared(fx.creatorId);
      expect(before, '시작 전에는 띄운 게임이 없어야 한다').toBeNull(); // ← 캐시에 null 이 박힌다

      const gameId = await createGame(fx.creatorId, { ...GAME, items: [...GAME.items] });
      await startRound(fx.creatorId, gameId);

      // 캐시 유효시간(1.5초) 안에 다시 물어본다. 예전에는 여기서 null 이 나왔다.
      const after = await buildStudioStateShared(fx.creatorId);
      expect(after, '띄운 직후인데 "게임 없음" 으로 나옵니다 (캐시가 안 갱신됨)').not.toBeNull();
      expect(after?.title).toBe('검수용 룰렛');
    });
  });

  describe('B-1 · 룰렛 돌리기', () => {
    it('범위를 벗어난 번호는 거부한다', async () => {
      const gameId = await createGame(fx.creatorId, { ...GAME, items: [...GAME.items] });
      const roundId = await startRound(fx.creatorId, gameId);

      await expect(spinRound(fx.creatorId, roundId, 99)).rejects.toThrow();
      await expect(spinRound(fx.creatorId, roundId, -1)).rejects.toThrow();

      const row = await prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
      expect(row.status, '거부됐는데 회차가 이미 넘어가 있습니다').toBe('OPEN');
    });

    it('동시에 두 번 돌려도 당첨자가 겹쳐 쌓이지 않는다', async () => {
      const gameId = await createGame(fx.creatorId, { ...GAME, items: [...GAME.items] });
      const roundId = await startRound(fx.creatorId, gameId);

      const results = await Promise.allSettled([
        spinRound(fx.creatorId, roundId),
        spinRound(fx.creatorId, roundId),
      ]);
      expect(results.some((r) => r.status === 'fulfilled'), '둘 다 실패했습니다').toBe(true);

      const winners = await prisma.gameWinner.count({ where: { roundId } });
      const rounds = await prisma.gameRound.count({ where: { id: roundId, status: 'RESULT' } });
      expect(rounds).toBe(1);
      // 예전에는 두 번 다 통과해 당첨자가 두 벌 쌓였다(같은 회차에 당첨자 2배).
      expect(winners, `당첨자가 ${winners}명 — 결과가 두 번 기록됐습니다`).toBeLessThanOrEqual(1);
    });
  });

  describe('B-3 · 지급 실패로 되돌린 정산', () => {
    async function fundedRequest() {
      const account = {
        bankCode: '004',
        bankName: 'KB국민은행',
        accountEnc: encrypt('11122233344455'),
        accountTail4: '4455',
        holderNameEnc: encrypt('김도네'),
        holderMasked: '김*네',
        verified: true,
        verifiedAt: new Date(),
      };
      await prisma.settlementAccount.upsert({
        where: { creatorId: fx.creatorId },
        create: { id: newId(), creatorId: fx.creatorId, ...account },
        update: account,
      });
      await seedRegisteredDonor(fx.donorPhone);
      for (let i = 0; i < 5; i += 1) {
        await handleMoInbound(
          mockMoAdapter.parse(
            moPayload({ to: fx.moNumber, messageId: `B3-${i}-${Date.now()}`, text: `응원 ${i}` }),
          ),
        );
      }
      // 보류 기간을 지난 상태로 만든다(이 검사는 지급 실패 되돌리기이지 보류 규칙이 아니다).
      await matureDonations(fx.creatorId);
      const available = (await getSettlementSummary(fx.creatorId)).available;
      expect(available).toBeGreaterThan(0n);
      const req = await createSettlementRequest(fx.creatorId, available, {
        resident: '9010101234567',
      });
      await prisma.settlementRequest.update({
        where: { id: req.id },
        data: { status: 'APPROVED' },
      });
      return { id: req.id, available };
    }

    it('지급 실패로 되돌리면 지급일도 지운다', async () => {
      const { id } = await fundedRequest();
      await markSettlementPaid(id, 'admin');
      expect((await prisma.settlementRequest.findUniqueOrThrow({ where: { id } })).paidAt).not.toBeNull();

      await markSettlementPayoutFailed(id, '계좌 오류', 'admin');
      const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('PAYOUT_FAILED');
      // 예전에는 paidAt 을 남겨 두어 크리에이터 화면에 "지급완료" 로 보였다.
      // 돈은 안 나갔는데 지급됐다고 뜨고, 잔액은 환입되어 다시 요청하라고 한다.
      expect(row.paidAt, '이체가 실패했는데 지급일이 남아 있습니다').toBeNull();
    });

    it('이미 다른 요청으로 지급된 뒤 옛 실패 건을 다시 지급완료로 올릴 수 없다', async () => {
      const { id, available } = await fundedRequest();
      await markSettlementPaid(id, 'admin');
      await markSettlementPayoutFailed(id, '계좌 오류', 'admin');

      // 환입된 잔액으로 크리에이터가 다시 요청해서 지급받았다.
      const again = await createSettlementRequest(fx.creatorId, available, {
        resident: '9010101234567',
      });
      await prisma.settlementRequest.update({
        where: { id: again.id },
        data: { status: 'APPROVED' },
      });
      await markSettlementPaid(again.id, 'admin');
      expect((await getSettlementSummary(fx.creatorId)).balance).toBe(0n);

      // 여기서 옛 건을 다시 지급완료로 올리면 같은 돈이 두 번 나간다.
      await expect(markSettlementPaid(id, 'admin')).rejects.toThrow(/잔액/);
      expect((await getSettlementSummary(fx.creatorId)).balance).toBe(0n);
    });
  });

  describe('B-4 · 연결 주소를 다시 발급하면 열린 방송 연결을 끊는다', () => {
    it('방송 연결만 끊고 미리보기는 남긴다', () => {
      const closed: string[] = [];
      registerOverlayConnection(fx.creatorId, () => closed.push('b1'), 'broadcast');
      registerOverlayConnection(fx.creatorId, () => closed.push('b2'), 'broadcast');
      registerOverlayConnection(fx.creatorId, () => closed.push('p1'), 'preview');

      // 예전에는 주소를 다시 발급해도 이미 열려 있던 OBS 연결이 그대로 살아 있었다.
      // 옛 주소로도 계속 후원 알림이 나가 "주소를 바꿨는데 왜 그대로냐" 가 됐다.
      const n = closeOverlayConnections(fx.creatorId, 'broadcast');
      expect(n).toBe(2);
      expect(closed.sort()).toEqual(['b1', 'b2']);

      // 두 번째 호출은 끊을 것이 없다.
      expect(closeOverlayConnections(fx.creatorId, 'broadcast')).toBe(0);
      // 미리보기는 살아 있다.
      expect(closeOverlayConnections(fx.creatorId, 'preview')).toBe(1);
    });
  });
});
