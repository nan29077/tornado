/**
 * 오퍼월(광고 시청·퀴즈 등 참여형 광고)로 무료 팬투표권 받기 (2026-11-17).
 *
 * 구조
 *  ① 회원이 충전소에서 광고·퀴즈에 참여
 *  ② 광고사 서버가 우리 서버로 "리워드 지급 요청"(콜백)을 보낸다
 *  ③ 서명·IP 확인 → (광고사, 거래 고유값) 중복 확인 → 무료(FREE) 팬투표권 지급
 *  ④ 광고사가 부정 참여로 취소하면 남은 만큼 회수
 * 팬투표권은 반드시 ② 서버 콜백으로만 지급한다(화면의 "완료" 신호로 지급하지 않는다).
 *
 * 연동 상태 (CLAUDE.md 규칙 2: 실제 계약이 없는 외부 연동을 성공 처리하지 않는다)
 *  - mock      테스트용 가짜 광고 목록. 화면에 "테스트 광고"로 표시한다. 운영(APP_ENV=prod)에서는 꺼진다.
 *  - buzzvil   계약 전 — 연동 규격(콜백 파라미터·서명 방식)을 받으면 어댑터를 완성한다
 *  - adpopcorn 계약 전 — 웹 매체는 S2S(서버 간) 방식으로 연동 예정
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { newId } from '@/lib/id';
import { hmac, safeEqual } from '@/lib/crypto';
import { kstDateKey } from '@/lib/datetime';
import { getVoteConfig } from '@/server/services/engagement/config';
import { grantTickets, revokeLot } from './wallet';

export type OfferwallProviderKey = 'mock' | 'buzzvil' | 'adpopcorn';

export const OFFERWALL_PROVIDERS: Array<{ key: OfferwallProviderKey; label: string; note: string; live: boolean }> = [
  { key: 'mock', label: '테스트 광고 (mock)', note: '실제 광고가 아닙니다. 흐름 확인용 가짜 광고 목록입니다. 운영 환경에서는 자동으로 꺼집니다.', live: true },
  { key: 'buzzvil', label: '버즈빌', note: '계약 전 · 연동 대기. 웹(모바일 브라우저) 매체 지원 여부와 콜백 규격을 받으면 연동합니다.', live: false },
  { key: 'adpopcorn', label: '애드팝콘', note: '계약 전 · 연동 대기. 웹 매체는 S2S(서버 간 API) 방식으로 연동 예정입니다.', live: false },
];

export const OFFERWALL_SETTING_KEY = 'vote.offerwall';

export interface OfferwallSettings {
  providers: Record<OfferwallProviderKey, { enabled: boolean; ratio: number }>;
}

export const DEFAULT_OFFERWALL_SETTINGS: OfferwallSettings = {
  providers: { mock: { enabled: true, ratio: 1 }, buzzvil: { enabled: false, ratio: 1 }, adpopcorn: { enabled: false, ratio: 1 } },
};

export function normalizeOfferwallSettings(raw: unknown): OfferwallSettings {
  const p = ((raw ?? {}) as { providers?: Record<string, { enabled?: unknown; ratio?: unknown }> }).providers ?? {};
  const out = structuredClone(DEFAULT_OFFERWALL_SETTINGS);
  for (const k of Object.keys(out.providers) as OfferwallProviderKey[]) {
    const v = p[k];
    if (!v) continue;
    out.providers[k].enabled = typeof v.enabled === 'boolean' ? v.enabled : out.providers[k].enabled;
    const r = Number(v.ratio);
    out.providers[k].ratio = Number.isFinite(r) && r > 0 && r <= 1000 ? r : out.providers[k].ratio;
  }
  return out;
}

export async function getOfferwallSettings(): Promise<OfferwallSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: OFFERWALL_SETTING_KEY } }).catch(() => null);
  return normalizeOfferwallSettings(row?.value);
}

export async function saveOfferwallSettings(s: OfferwallSettings, adminUserId?: string) {
  const value = normalizeOfferwallSettings(s) as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({
    where: { key: OFFERWALL_SETTING_KEY },
    create: { key: OFFERWALL_SETTING_KEY, value, updatedBy: adminUserId ?? null },
    update: { value, updatedBy: adminUserId ?? null },
  });
}

/** 테스트 광고를 쓸 수 있는가 — 운영에서는 OFFERWALL_MOCK_ALLOW=true 가 아니면 꺼진다 */
export function mockOfferwallAllowed(): boolean {
  if (env.appEnv !== 'prod') return true;
  return (process.env.OFFERWALL_MOCK_ALLOW ?? '').trim().toLowerCase() === 'true';
}

// ---------------------------------------------------------------------- 테스트 광고 목록

export interface MockMission {
  id: string;
  kind: 'VIDEO' | 'QUIZ' | 'VISIT' | 'SURVEY';
  title: string;
  advertiser: string;
  points: number;
  /** 시청 시간(초) — VIDEO/VISIT */
  seconds?: number;
  quiz?: { question: string; options: string[]; answer: number };
}

export const MOCK_MISSIONS: MockMission[] = [
  { id: 'mock-video-1', kind: 'VIDEO', title: '15초 광고 보고 팬투표권 받기', advertiser: '테스트 광고주 A', points: 10, seconds: 15 },
  { id: 'mock-video-2', kind: 'VIDEO', title: '신규 게임 트레일러 시청', advertiser: '테스트 광고주 B', points: 20, seconds: 30 },
  { id: 'mock-quiz-1', kind: 'QUIZ', title: '광고 퀴즈 풀기', advertiser: '테스트 광고주 C', points: 15, quiz: { question: '테스트 광고주 C 의 대표 색은 무엇일까요? (힌트: 꿀)', options: ['초록', '노랑', '파랑'], answer: 1 } },
  { id: 'mock-visit-1', kind: 'VISIT', title: '브랜드 페이지 10초 둘러보기', advertiser: '테스트 광고주 D', points: 8, seconds: 10 },
  { id: 'mock-survey-1', kind: 'SURVEY', title: '1문항 설문 참여', advertiser: '테스트 광고주 E', points: 12, quiz: { question: '도네이도 팬투표 기능이 마음에 드시나요?', options: ['좋아요', '보통이에요', '아쉬워요'], answer: -1 } },
];

/** 오늘 이미 참여한 테스트 광고 ID */
export async function completedMockMissionsToday(userId: string, now: Date = new Date()): Promise<Set<string>> {
  const day = kstDateKey(now);
  const rows = await prisma.offerwallReward.findMany({ where: { provider: 'mock', userId, rewardKey: { endsWith: `:${day}` } }, select: { campaign: true } });
  return new Set(rows.map((r) => r.campaign ?? ''));
}

// ---------------------------------------------------------------------- 지급 · 회수 (모든 광고사 공통)

export interface RewardInput {
  provider: OfferwallProviderKey;
  rewardKey: string;
  userId: string;
  points: number;
  campaign?: string | null;
  payloadMasked?: Prisma.InputJsonValue;
  ip?: string | null;
}

export type RewardResult = { ok: true; duplicate: boolean; tickets: number } | { ok: false; reason: string };

/** 리워드 지급. 같은 (광고사, 거래 고유값) 이 다시 와도 한 번만 지급한다 */
export async function grantOfferwallReward(input: RewardInput): Promise<RewardResult> {
  const [cfg, settings] = await Promise.all([getVoteConfig(), getOfferwallSettings()]);
  if (!cfg.enabled || !cfg.offerwallEnabled) return { ok: false, reason: '무료 충전이 꺼져 있습니다.' };
  const p = settings.providers[input.provider];
  if (!p?.enabled) return { ok: false, reason: '사용하지 않는 광고사입니다.' };
  if (input.provider === 'mock' && !mockOfferwallAllowed()) return { ok: false, reason: '운영 환경에서는 테스트 광고를 쓸 수 없습니다.' };
  if (!input.rewardKey || input.rewardKey.length > 200) return { ok: false, reason: '거래 고유값이 올바르지 않습니다.' };
  const points = Math.trunc(Number(input.points));
  if (!Number.isFinite(points) || points <= 0 || points > 1_000_000) return { ok: false, reason: '리워드 수량이 올바르지 않습니다.' };
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
  if (!user || user.status !== 'ACTIVE') return { ok: false, reason: '회원을 찾을 수 없습니다.' };

  const existing = await prisma.offerwallReward.findUnique({ where: { provider_rewardKey: { provider: input.provider, rewardKey: input.rewardKey } }, select: { tickets: true, status: true } });
  if (existing) return { ok: true, duplicate: true, tickets: existing.tickets };

  const tickets = Math.max(1, Math.floor(points * p.ratio));
  const id = newId();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.offerwallReward.create({
        data: { id, provider: input.provider, rewardKey: input.rewardKey, userId: user.id, campaign: input.campaign ?? null, points, tickets, payloadMasked: input.payloadMasked, ip: input.ip ?? null },
      });
      const lotId = await grantTickets(tx, {
        userId: user.id,
        bucket: 'FREE',
        amount: tickets,
        source: 'OFFERWALL',
        ledgerType: 'OFFERWALL_EARN',
        refType: 'OFFERWALL_REWARD',
        refId: id,
        expiresInDays: cfg.freeExpiryDays,
        memo: `${OFFERWALL_PROVIDERS.find((x) => x.key === input.provider)?.label ?? input.provider} ${input.campaign ?? ''}`.trim(),
      });
      await tx.offerwallReward.update({ where: { id }, data: { lotId } });
    });
  } catch (e) {
    // 동시에 같은 콜백이 두 번 들어와 유니크 제약에 걸린 경우 → 이미 지급된 것으로 본다
    if ((e as { code?: string })?.code === 'P2002') return { ok: true, duplicate: true, tickets };
    throw e;
  }
  return { ok: true, duplicate: false, tickets };
}

/** 광고사 취소(부정 참여) — 남은 만큼 회수. 이미 팬투표에 쓴 만큼은 회수하지 못하고 사유에 남긴다 */
export async function revokeOfferwallReward(provider: OfferwallProviderKey, rewardKey: string, reason: string): Promise<{ ok: boolean; revoked: number }> {
  const row = await prisma.offerwallReward.findUnique({ where: { provider_rewardKey: { provider, rewardKey } } });
  if (!row || row.status !== 'GRANTED') return { ok: false, revoked: 0 };
  const revoked = await prisma.$transaction(async (tx) => {
    const n = row.lotId ? await revokeLot(tx, row.lotId, 'OFFERWALL_REVOKE', `광고사 취소: ${reason}`.slice(0, 200), { refType: 'OFFERWALL_REWARD', refId: row.id }) : 0;
    const shortage = row.tickets - n;
    await tx.offerwallReward.update({
      where: { id: row.id },
      data: { status: 'REVOKED', revokedAt: new Date(), reason: `${reason}${shortage > 0 ? ` (이미 사용된 ${shortage}개는 회수하지 못함)` : ''}`.slice(0, 300) },
    });
    return n;
  });
  return { ok: true, revoked };
}

// ---------------------------------------------------------------------- 테스트 광고 서버 콜백

/** 테스트 광고 콜백 서명: HMAC(SESSION_SECRET, provider|rewardKey|userId|points) */
export function mockCallbackSignature(rewardKey: string, userId: string, points: number): string {
  return hmac(`mock|${rewardKey}|${userId}|${points}`, env.crypto.sessionSecret);
}

export function verifyMockCallback(rewardKey: string, userId: string, points: number, signature: string): boolean {
  return safeEqual(mockCallbackSignature(rewardKey, userId, points), signature);
}

/**
 * 테스트 광고 참여 완료 → 서버 콜백과 같은 경로로 지급한다.
 * (실제 광고사는 광고사 서버가 /api/offerwall/{광고사}/callback 으로 보낸다)
 */
export async function completeMockMission(userId: string, missionId: string, answer: number | null, now: Date = new Date()): Promise<RewardResult> {
  const mission = MOCK_MISSIONS.find((m) => m.id === missionId);
  if (!mission) return { ok: false, reason: '광고를 찾을 수 없습니다.' };
  if (mission.kind === 'QUIZ' && mission.quiz && answer !== mission.quiz.answer) return { ok: false, reason: '정답이 아니에요. 다시 골라 주세요.' };
  if (mission.kind === 'SURVEY' && (answer == null || answer < 0 || answer >= (mission.quiz?.options.length ?? 0))) return { ok: false, reason: '답을 골라 주세요.' };
  const rewardKey = `${mission.id}:${userId}:${kstDateKey(now)}`;
  const sig = mockCallbackSignature(rewardKey, userId, mission.points);
  if (!verifyMockCallback(rewardKey, userId, mission.points, sig)) return { ok: false, reason: '서명 오류' };
  return grantOfferwallReward({ provider: 'mock', rewardKey, userId, points: mission.points, campaign: mission.id, payloadMasked: { mission: mission.id, kind: mission.kind } });
}
