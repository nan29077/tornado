import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import {
  DEFAULT_OVERLAY_LADDER,
  boostedLevel,
  comboBoostOf,
  countComboChain,
  ladderLevelFor,
  ladderOf,
  ladderRangeText,
  tierModeOf,
  validateLadder,
} from '@/lib/overlay-ladder';
import {
  EFFECT_LEVELS,
  LIGHT_MAX_PARTICLES,
  MAX_PARTICLES,
  effectLevelOf,
  effectLevelOfRank,
  particleCountFor,
} from '@/lib/overlay-effect-level';
import { resolveTextAnim } from '@/lib/overlay-text-anim';
import { OVERLAY_EFFECT_VALUES } from '@/lib/overlay-effect-catalog';
import { buildOverlayPayload, sendTestOverlay } from '@/server/services/broadcast-dispatch';
import {
  getOverlayLadder,
  invalidateOverlayLadderCache,
  resetOverlayLadder,
  saveOverlayLadder,
} from '@/server/services/overlay-ladder';
import { resetDb, seedBasics, seedRegisteredDonor, type Fixture } from './helpers';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/public-base-url', () => ({ getPublicBaseUrl: async () => 'http://localhost:3025' }));

/**
 * 금액별 후원 연출 차등 (2026-11-12) 회귀 테스트.
 *
 *  - 자동 방식의 금액 구간 경계
 *  - 최고관리자 기준 검증·저장
 *  - 기존 크리에이터(직접 설정·끄기)의 화면이 바뀌지 않는다
 *  - 연속 후원 단계 상승 (후원자 식별값 기준, 환불·테스트 제외)
 *  - 테스트 후원과 실제 후원의 재생값이 같다
 */

let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  invalidateOverlayLadderCache();
});

async function setMode(mode: 'AUTO' | 'CUSTOM' | 'OFF', extra: { comboBoost?: boolean; light?: boolean } = {}) {
  await prisma.creatorProfile.update({
    where: { id: fx.creatorId },
    data: {
      overlayTierMode: mode,
      ...(extra.comboBoost !== undefined ? { overlayComboBoost: extra.comboBoost } : {}),
      ...(extra.light !== undefined ? { overlayLightEffects: extra.light } : {}),
    },
  });
}

async function paidDonation(input: {
  donorId: string | null;
  amount: bigint;
  paidAt: Date;
  status?: 'BROADCASTED' | 'REFUNDED' | 'SETTLEMENT_PENDING';
  anonymous?: boolean;
}) {
  const id = newId();
  await prisma.donation.create({
    data: {
      id,
      transactionNo: id,
      creatorId: fx.creatorId,
      donorId: input.donorId,
      amount: input.amount,
      displayName: '연속후원자',
      message: '응원합니다',
      status: input.status ?? 'SETTLEMENT_PENDING',
      paidAt: input.paidAt,
      anonymous: input.anonymous ?? false,
    },
  });
  return id;
}

// ---------------------------------------------------------------- 순수 계산

describe('자동 방식 금액 구간', () => {
  it('기본 기준의 경계 금액이 정한 단계로 떨어진다', () => {
    const l = DEFAULT_OVERLAY_LADDER;
    const cases: [bigint, number][] = [
      [100n, 1], // 1단계 시작 금액 미만도 1단계
      [999n, 1],
      [1_000n, 1],
      [9_999n, 1],
      [10_000n, 2],
      [29_999n, 2],
      [30_000n, 3],
      [49_999n, 3],
      [50_000n, 4],
      [99_999n, 4],
      [100_000n, 5],
      [5_000_000n, 5],
    ];
    for (const [amount, level] of cases) {
      expect(ladderLevelFor(l, amount), `${amount}원`).toBe(level);
    }
  });

  it('기본 기준의 효과는 모두 카탈로그에 있고 단계마다 다르다', () => {
    const effects = DEFAULT_OVERLAY_LADDER.levels.map((x) => x.effect);
    for (const e of effects) expect(OVERLAY_EFFECT_VALUES).toContain(e);
    expect(new Set(effects).size).toBe(5);
    // 단계가 오를수록 오래 보여 준다.
    const durations = DEFAULT_OVERLAY_LADDER.levels.map((x) => x.durationMs);
    expect([...durations].sort((a, b) => a - b)).toEqual(durations);
  });

  it('구간 문구가 사람이 읽는 형태로 나온다', () => {
    expect(ladderRangeText(DEFAULT_OVERLAY_LADDER, 1)).toBe('1,000원 이상 ~ 10,000원 미만');
    expect(ladderRangeText(DEFAULT_OVERLAY_LADDER, 5)).toBe('100,000원 이상');
  });

  it('모르는 연출 방식 값은 끄기로 본다', () => {
    expect(tierModeOf('AUTO')).toBe('AUTO');
    expect(tierModeOf('custom')).toBe('CUSTOM');
    expect(tierModeOf('???')).toBe('OFF');
    expect(tierModeOf(null)).toBe('OFF');
  });
});

describe('기준 검증', () => {
  const base = () => JSON.parse(JSON.stringify(DEFAULT_OVERLAY_LADDER));

  it('기본 기준은 통과한다', () => {
    expect(validateLadder(base()).ok).toBe(true);
  });

  it('금액이 오름차순이 아니면 거절한다', () => {
    const l = base();
    l.levels[2].minAmount = 10_000; // 3단계가 2단계와 같다
    const v = validateLadder(l);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('3단계');

    const l2 = base();
    l2.levels[4].minAmount = 20_000; // 5단계가 4단계보다 작다
    expect(validateLadder(l2).ok).toBe(false);
  });

  it('단계 수·효과·시간·연속 후원 규칙이 범위를 벗어나면 거절한다', () => {
    const four = base();
    four.levels.pop();
    expect(validateLadder(four).ok).toBe(false);

    const badEffect = base();
    badEffect.levels[0].effect = 'NOT_AN_EFFECT';
    expect(validateLadder(badEffect).ok).toBe(false);

    const badDuration = base();
    badDuration.levels[0].durationMs = 100;
    expect(validateLadder(badDuration).ok).toBe(false);

    const badCombo = base();
    badCombo.combo.plusTwoAt = badCombo.combo.plusOneAt; // +2 기준이 +1 기준보다 뒤여야 한다
    expect(validateLadder(badCombo).ok).toBe(false);

    const fractional = base();
    fractional.levels[0].minAmount = 1000.5;
    expect(validateLadder(fractional).ok).toBe(false);
  });

  it('저장된 값이 깨져 있으면 기본 기준으로 돌아간다', () => {
    expect(ladderOf(null)).toEqual(DEFAULT_OVERLAY_LADDER);
    expect(ladderOf({ levels: 'x' })).toEqual(DEFAULT_OVERLAY_LADDER);
    expect(ladderOf([])).toEqual(DEFAULT_OVERLAY_LADDER);
  });
});

describe('연속 후원 계산', () => {
  const rule = DEFAULT_OVERLAY_LADDER.combo; // 180초, 2번째 +1, 4번째 +2
  const t0 = 1_800_000_000_000;

  it('간격이 창 안이면 이어 세고, 한 번 벌어지면 거기서 끊는다', () => {
    expect(countComboChain([t0], 180)).toBe(1);
    expect(countComboChain([t0, t0 - 60_000], 180)).toBe(2);
    expect(countComboChain([t0, t0 - 180_000], 180)).toBe(2); // 정확히 3분은 인정
    expect(countComboChain([t0, t0 - 180_001], 180)).toBe(1);
    // 3번째와 4번째 사이가 벌어졌다 → 3연속까지만
    expect(countComboChain([t0, t0 - 60_000, t0 - 120_000, t0 - 600_000], 180)).toBe(3);
  });

  it('상승 폭은 최대 2단계이고 5단계를 넘지 않는다', () => {
    expect(comboBoostOf(rule, 1)).toBe(0);
    expect(comboBoostOf(rule, 2)).toBe(1);
    expect(comboBoostOf(rule, 3)).toBe(1);
    expect(comboBoostOf(rule, 4)).toBe(2);
    expect(comboBoostOf(rule, 99)).toBe(2);
    expect(comboBoostOf({ ...rule, enabled: false }, 99)).toBe(0);
    expect(boostedLevel(4, 2)).toBe(5);
    expect(boostedLevel(5, 2)).toBe(5);
    expect(boostedLevel(1, 0)).toBe(1);
  });
});

describe('연출 단계 정의', () => {
  it('구간 순위로 정하는 예전 방식은 지금도 최대 4단계다', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(effectLevelOfRank)).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });

  it('페이로드 값은 1~5 로 좁혀진다', () => {
    expect([undefined, 'x', 0, 1, 3, 5, 9].map(effectLevelOf)).toEqual([1, 1, 1, 1, 3, 5, 5]);
  });

  it('5단계는 가장 많은 파티클과 회오리 연출을 쓴다', () => {
    expect(EFFECT_LEVELS[5].tornado).toBe(true);
    expect(EFFECT_LEVELS[4].tornado).toBe(false);
    expect(EFFECT_LEVELS[5].particles).toBeGreaterThan(EFFECT_LEVELS[4].particles);
    expect(EFFECT_LEVELS[5].mascot).toBe('giant');
  });

  it('파티클 수는 상한을 넘지 않고 가벼운 효과 모드에서 줄어든다', () => {
    expect(particleCountFor(5, 3)).toBeLessThanOrEqual(MAX_PARTICLES);
    expect(particleCountFor(5, 3, true)).toBeLessThanOrEqual(LIGHT_MAX_PARTICLES);
    expect(particleCountFor(5, 1, true)).toBeLessThan(particleCountFor(5, 1));
    // 기존 1~4단계의 개수는 그대로다.
    expect([1, 2, 3, 4].map((lv) => particleCountFor(lv as 1 | 2 | 3 | 4, 1))).toEqual([10, 15, 20, 30]);
  });

  it('글자 등장 효과는 5단계에서도 정해진 값을 돌려준다', () => {
    expect(resolveTextAnim('AUTO', 5)).toBe('SHAKE');
    expect(resolveTextAnim('AUTO', 1)).toBe('SLIDE_UP');
  });
});

// --------------------------------------------------------- DB 를 쓰는 흐름

describe('신규 크리에이터 기본값', () => {
  it('새로 만든 크리에이터는 자동 방식 · 연속 후원 상승 켬 · 가벼운 효과 끔이다', async () => {
    const c = await prisma.creatorProfile.findUniqueOrThrow({ where: { id: fx.creatorId } });
    expect(c.overlayTierMode).toBe('AUTO');
    expect(c.overlayComboBoost).toBe(true);
    expect(c.overlayLightEffects).toBe(false);
  });

  it('설정 없이도 금액에 따라 5단계가 갈린다 (테스트 후원)', async () => {
    const amounts: [bigint, number, string][] = [
      [3_000n, 1, 'DONAIDO_HEART_PEEK'],
      [10_000n, 2, 'DONAIDO_THANKS_BOW'],
      [30_000n, 3, 'DONAIDO_GIFT_POP'],
      [50_000n, 4, 'DONAIDO_FRIENDS'],
      [100_000n, 5, 'DONAIDO_CROWN_CEREMONY'],
    ];
    for (const [amount, level, effect] of amounts) {
      const p = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount, message: 'm' });
      expect(p.effectLevel, `${amount}원 단계`).toBe(level);
      expect(p.effect, `${amount}원 효과`).toBe(effect);
      expect(p.durationMs).toBe(DEFAULT_OVERLAY_LADDER.levels[level - 1]!.durationMs);
      expect(p.banner).toBe(true);
      // 테스트 후원은 연속 후원을 세지 않는다.
      expect(p.comboCount).toBeUndefined();
    }
  });
});

describe('기존 크리에이터의 화면은 바뀌지 않는다', () => {
  it('끄기 방식 — 금액과 무관하게 전역 효과 · 1단계', async () => {
    await setMode('OFF');
    await prisma.overlaySetting.update({
      where: { creatorId: fx.creatorId },
      data: { stickerSet: 'DONAIDO_MIC_DANCE', durationMs: 7000 },
    });
    for (const amount of [900n, 10_000n, 500_000n]) {
      const p = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount, message: 'm' });
      expect(p.effect).toBe('DONAIDO_MIC_DANCE');
      expect(p.effectLevel).toBe(1);
      expect(p.durationMs).toBe(7000);
      expect(p.tierLabel).toBe('');
    }
  });

  it('직접 설정 방식 — 단계를 지정하지 않은 예전 구간은 구간 순서(최대 4단계)로 재생된다', async () => {
    await setMode('CUSTOM');
    await prisma.overlaySetting.update({
      where: { creatorId: fx.creatorId },
      data: { stickerSet: 'DONAIDO_MIC_DANCE', durationMs: 7000 },
    });
    const tiers: [bigint, string, string, number][] = [
      [1_000n, '기본', 'HEART', 5000],
      [5_000n, '감사', 'CONFETTI', 7000],
      [10_000n, '최고', 'DONAIDO_THANKS_BOW', 10000],
    ];
    for (const [minAmount, label, effect, durationMs] of tiers) {
      await prisma.overlayTier.create({
        data: { id: newId(), creatorId: fx.creatorId, minAmount, label, effect, durationMs },
      });
    }
    // 9/1 점검 보고서의 실측 표와 같은 결과가 나와야 한다.
    const expected: [bigint, string, number, number, string][] = [
      [900n, 'DONAIDO_MIC_DANCE', 7000, 1, ''],
      [1_000n, 'HEART', 5000, 1, '기본'],
      [4_999n, 'HEART', 5000, 1, '기본'],
      [5_000n, 'CONFETTI', 7000, 2, '감사'],
      [7_000n, 'CONFETTI', 7000, 2, '감사'],
      [10_000n, 'DONAIDO_THANKS_BOW', 10000, 3, '최고'],
      [1_000_000n, 'DONAIDO_THANKS_BOW', 10000, 3, '최고'],
    ];
    for (const [amount, effect, durationMs, level, label] of expected) {
      const p = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount, message: 'm' });
      expect(p.effect, `${amount}원 효과`).toBe(effect);
      expect(p.durationMs, `${amount}원 시간`).toBe(durationMs);
      expect(p.effectLevel, `${amount}원 단계`).toBe(level);
      expect(p.tierLabel, `${amount}원 구간`).toBe(label);
    }
  });

  it('직접 설정 방식 — 구간에 단계를 지정하면 그 값을 쓴다 (5단계 포함)', async () => {
    await setMode('CUSTOM');
    await prisma.overlayTier.create({
      data: { id: newId(), creatorId: fx.creatorId, minAmount: 2_000n, label: '한방', effect: 'STAR', intensity: 5 },
    });
    const p = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount: 2_000n, message: 'm' });
    expect(p.effectLevel).toBe(5);
    expect(p.effect).toBe('STAR');
  });

  it('마이그레이션은 기존 크리에이터를 직접 설정/끄기로 옮기고 연속 후원 상승을 꺼 둔다', () => {
    const dir = path.resolve(process.cwd(), 'prisma/migrations/20261112230000_overlay_effect_ladder');
    const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
    expect(sql).toContain(`THEN 'CUSTOM'`);
    expect(sql).toContain(`ELSE 'OFF'`);
    expect(sql).toContain(`"overlay_combo_boost" = false`);
    expect(sql).toContain(`DEFAULT 'AUTO'`);
    // 기존 마이그레이션 규칙: 순서에 의존하는 DROP 을 넣지 않는다.
    expect(sql.toUpperCase()).not.toContain('DROP ');
  });
});

describe('최고관리자 기준 변경', () => {
  it('저장한 기준이 다음 후원부터 적용되고, 되돌리면 기본 기준으로 돌아온다', async () => {
    const custom = JSON.parse(JSON.stringify(DEFAULT_OVERLAY_LADDER));
    custom.levels[1].minAmount = 5_000; // 2단계를 5,000원부터로 당긴다
    custom.levels[1].effect = 'COIN';
    const v = validateLadder(custom);
    expect(v.ok).toBe(true);
    if (!v.ok) return;

    const before = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount: 5_000n, message: 'm' });
    expect(before.effectLevel).toBe(1);

    await saveOverlayLadder(v.ladder, fx.creatorUserId);
    expect((await getOverlayLadder()).levels[1]!.minAmount).toBe(5_000);

    const after = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount: 5_000n, message: 'm' });
    expect(after.effectLevel).toBe(2);
    expect(after.effect).toBe('COIN');

    await resetOverlayLadder(fx.creatorUserId);
    const reset = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount: 5_000n, message: 'm' });
    expect(reset.effectLevel).toBe(1);
  });

  it('저장된 기준이 깨져 있어도 후원 알림은 기본 기준으로 나간다', async () => {
    await prisma.systemSetting.create({ data: { key: 'overlay.ladder', value: { levels: 'broken' } } });
    invalidateOverlayLadderCache();
    const p = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount: 100_000n, message: 'm' });
    expect(p.effectLevel).toBe(5);
  });
});

describe('연속 후원 단계 상승', () => {
  const now = () => new Date();
  const ago = (sec: number) => new Date(Date.now() - sec * 1000);

  it('같은 후원자가 3분 안에 이어서 후원하면 단계가 오른다', async () => {
    const donor = await seedRegisteredDonor();

    // 첫 후원 3,000원 → 1단계
    const first = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(100) });
    const p1 = await buildOverlayPayload(first);
    expect(p1?.effectLevel).toBe(1);
    expect(p1?.comboCount).toBe(1);

    // 두 번째 → +1
    const second = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(50) });
    const p2 = await buildOverlayPayload(second);
    expect(p2?.comboCount).toBe(2);
    expect(p2?.baseLevel).toBe(1);
    expect(p2?.effectLevel).toBe(2);
    // 자동 방식은 오른 단계의 효과·시간을 쓴다.
    expect(p2?.effect).toBe(DEFAULT_OVERLAY_LADDER.levels[1]!.effect);
    expect(p2?.durationMs).toBe(DEFAULT_OVERLAY_LADDER.levels[1]!.durationMs);

    // 세 번째 → 여전히 +1, 네 번째 → +2
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(30) });
    const fourth = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: now() });
    const p4 = await buildOverlayPayload(fourth);
    expect(p4?.comboCount).toBe(4);
    expect(p4?.effectLevel).toBe(3);
  });

  it('5단계를 넘지 않는다', async () => {
    const donor = await seedRegisteredDonor();
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(90) });
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(60) });
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(30) });
    const big = await paidDonation({ donorId: donor.id, amount: 60_000n, paidAt: now() });
    const p = await buildOverlayPayload(big);
    expect(p?.baseLevel).toBe(4);
    expect(p?.effectLevel).toBe(5);
  });

  it('3분이 지나면 연속이 끊긴다', async () => {
    const donor = await seedRegisteredDonor();
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(400) });
    const next = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: now() });
    const p = await buildOverlayPayload(next);
    expect(p?.comboCount).toBe(1);
    expect(p?.effectLevel).toBe(1);
  });

  it('다른 후원자의 후원은 섞이지 않는다 (익명이어도 사람이 다르면 따로 센다)', async () => {
    const a = await seedRegisteredDonor('01011112222');
    const b = await seedRegisteredDonor('01033334444');
    await paidDonation({ donorId: a.id, amount: 3_000n, paidAt: ago(60), anonymous: true });
    const other = await paidDonation({ donorId: b.id, amount: 3_000n, paidAt: now(), anonymous: true });
    const p = await buildOverlayPayload(other);
    expect(p?.anonymous).toBe(true);
    expect(p?.comboCount).toBe(1);
    expect(p?.effectLevel).toBe(1);
  });

  it('환불된 후원과 후원자를 모르는 후원은 세지 않는다', async () => {
    const donor = await seedRegisteredDonor();
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(60), status: 'REFUNDED' });
    const next = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: now() });
    expect((await buildOverlayPayload(next))?.comboCount).toBe(1);

    await paidDonation({ donorId: null, amount: 3_000n, paidAt: ago(20) });
    const unknown = await paidDonation({ donorId: null, amount: 3_000n, paidAt: now() });
    const p = await buildOverlayPayload(unknown);
    expect(p?.comboCount).toBe(1);
    expect(p?.effectLevel).toBe(1);
  });

  it('크리에이터가 끄면 세지 않고, 끄기 방식에서도 세지 않는다', async () => {
    const donor = await seedRegisteredDonor();
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(60) });
    const next = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: now() });

    await setMode('AUTO', { comboBoost: false });
    const off = await buildOverlayPayload(next);
    expect(off?.comboCount).toBeUndefined();
    expect(off?.effectLevel).toBe(1);

    await setMode('OFF', { comboBoost: true });
    const modeOff = await buildOverlayPayload(next);
    expect(modeOff?.comboCount).toBeUndefined();
    expect(modeOff?.effectLevel).toBe(1);
  });

  it('최고관리자가 연속 후원 상승을 끄면 전체에 적용된다', async () => {
    const donor = await seedRegisteredDonor();
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(60) });
    const next = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: now() });

    const l = JSON.parse(JSON.stringify(DEFAULT_OVERLAY_LADDER));
    l.combo.enabled = false;
    const v = validateLadder(l);
    if (!v.ok) throw new Error(v.message);
    await saveOverlayLadder(v.ladder, fx.creatorUserId);

    const p = await buildOverlayPayload(next);
    expect(p?.comboCount).toBeUndefined();
    expect(p?.effectLevel).toBe(1);
  });

  it('직접 설정 방식은 효과를 그대로 두고 단계만 올린다', async () => {
    await setMode('CUSTOM', { comboBoost: true });
    await prisma.overlayTier.create({
      data: { id: newId(), creatorId: fx.creatorId, minAmount: 1_000n, label: '기본', effect: 'HEART', durationMs: 5000 },
    });
    const donor = await seedRegisteredDonor();
    await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: ago(60) });
    const next = await paidDonation({ donorId: donor.id, amount: 3_000n, paidAt: now() });
    const p = await buildOverlayPayload(next);
    expect(p?.effect).toBe('HEART');
    expect(p?.durationMs).toBe(5000);
    expect(p?.baseLevel).toBe(1);
    expect(p?.effectLevel).toBe(2);
  });
});

describe('테스트 후원과 실제 후원의 재생값', () => {
  it('연속 후원이 없을 때 두 경로의 효과 · 단계 · 시간 · 구간이 같다', async () => {
    const donor = await seedRegisteredDonor();
    for (const amount of [3_000n, 30_000n, 100_000n]) {
      const id = await paidDonation({ donorId: donor.id, amount, paidAt: new Date(Date.now() - 86_400_000) });
      const real = await buildOverlayPayload(id);
      const test = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount, message: 'm' });
      expect(real).not.toBeNull();
      for (const key of ['effect', 'banner', 'durationMs', 'tierLabel', 'effectLevel', 'baseLevel', 'lightEffects'] as const) {
        expect(real![key], `${amount}원 ${key}`).toEqual(test[key]);
      }
      // 하루 전 후원 한 건뿐이므로 다음 금액의 후원과 이어지지 않게 지운다.
      await prisma.donation.delete({ where: { id } });
    }
  });

  it('가벼운 효과 모드가 페이로드에 실린다', async () => {
    await setMode('AUTO', { light: true });
    const p = await sendTestOverlay(fx.creatorId, { donorName: '테스트', amount: 100_000n, message: 'm' });
    expect(p.lightEffects).toBe(true);
    expect(p.effectLevel).toBe(5);
  });
});
