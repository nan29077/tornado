/**
 * 투표 · 소통 운영 설정 (2026-11-17). 최고관리자가 바꾼다.
 *
 * - 전역 값은 system_setting(JSON) 에, 크리에이터별 값은 creator_engagement_policy 에 저장한다.
 * - **크리에이터별로 최고관리자가 지정한 값이 항상 전역 값보다 우선한다.** (비율·가격·권한 모두)
 * - 가격은 기본적으로 관리자 고정(FIXED). 크리에이터에게 권한을 주면(CREATOR) 관리자가 정한 최소~최대 범위 안에서
 *   크리에이터가 직접 정한다.
 */
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';

export const VOTE_SETTING_KEY = 'vote.config';
export const TALK_SETTING_KEY = 'talk.config';

export type SpendOrder = 'FREE_FIRST' | 'PAID_FIRST';
export type PriceMode = 'FIXED' | 'CREATOR';

export interface VoteConfig {
  /** 투표 기능 전체 */
  enabled: boolean;
  /** 1표당 소진되는 투표권 수 */
  ticketsPerVote: number;
  /** 한 번에 던질 수 있는 최대 표 */
  maxVotesPerAction: number;
  /** 회원 1명 하루 최대 표 (0 = 제한 없음) */
  dailyMaxVotesPerUser: number;
  /** 회원 1명이 크리에이터 1명에게 하루 최대 표 (0 = 제한 없음) */
  dailyMaxVotesPerCreator: number;
  /** 휴대폰 번호를 연결한 회원만 투표 */
  requirePhone: boolean;
  /** 투표권 사용 순서 */
  spendOrder: SpendOrder;
  /** 무료(오퍼월) 투표권 유효기간(일). 0 = 만료 없음 */
  freeExpiryDays: number;
  /** 보너스 투표권 유효기간(일). 0 = 만료 없음 */
  bonusExpiryDays: number;
  /** 유료 투표권 유효기간(일). 0 = 만료 없음 */
  paidExpiryDays: number;
  /** 유료 투표권 사용분 중 크리에이터 몫 (전역 기본값). 0 = 나누지 않음 */
  shareRate: number;
  /** 결제 충전 판매 */
  purchaseEnabled: boolean;
  /** 오퍼월(무료 충전) */
  offerwallEnabled: boolean;
  /** 미사용 결제분 환불 가능 기간(일) */
  refundDays: number;
  /** 랭킹 공개 */
  rankingPublic: boolean;
  /** 투표 창의 빠른 선택 표 수 */
  quickVotes: number[];
}

export const DEFAULT_VOTE_CONFIG: VoteConfig = {
  enabled: true,
  ticketsPerVote: 1,
  maxVotesPerAction: 10_000,
  dailyMaxVotesPerUser: 0,
  dailyMaxVotesPerCreator: 0,
  requirePhone: false,
  spendOrder: 'FREE_FIRST',
  freeExpiryDays: 90,
  bonusExpiryDays: 90,
  paidExpiryDays: 1825,
  shareRate: 0,
  purchaseEnabled: true,
  offerwallEnabled: true,
  refundDays: 7,
  rankingPublic: true,
  quickVotes: [1, 10, 100],
};

export type TalkRoomMode = 'GROUP' | 'BUBBLE';

export interface TalkConfig {
  /** 소통 기능 전체 */
  enabled: boolean;
  /**
   * 소통방 방식.
   *  GROUP  1:N 단체방 — 크리에이터와 구독자 여러 명이 함께 대화하고, 구독자끼리도 서로의 메시지를 본다 (기본)
   *  BUBBLE 버블형 — 크리에이터 메시지는 모두에게, 구독자 메시지는 크리에이터에게만 보인다
   */
  roomMode: TalkRoomMode;
  subPriceMode: PriceMode;
  /** 월 구독 기본 가격(원) */
  subPrice: number;
  subPriceMin: number;
  subPriceMax: number;
  /** 구독 1회 기간(일) */
  subPeriodDays: number;
  /** 소통 구독 플랫폼 수수료율 (전역) */
  subFeeRate: number;
  /** 구독 결제 후 환불 가능 기간(일, 관리자 처리) */
  subRefundDays: number;
  /** 팬 답장 하루 최대 횟수 (크리에이터 1명 기준, 0 = 제한 없음) */
  fanReplyDailyLimit: number;
  /** 팬 답장 최대 글자 수 */
  fanReplyMaxLength: number;
  /** ★ 1:1 채팅 전역 스위치. 끄면 1:1 채팅은 어디에도 보이지 않고 서버도 거절한다 */
  sessionEnabled: boolean;
  sessionPriceMode: PriceMode;
  /** 1:1 채팅 1회 기본 가격(원) */
  sessionPrice: number;
  sessionPriceMin: number;
  sessionPriceMax: number;
  /** 1:1 채팅 플랫폼 수수료율 (전역) */
  sessionFeeRate: number;
  /** 크리에이터가 고를 수 있는 1회 시간(분) */
  sessionMinutesOptions: number[];
  /** 신청 후 승인 기한(시간). 시작 1시간 전을 넘지 않는다 */
  sessionApprovalHours: number;
  /** 최소 몇 시간 뒤부터 신청 가능한가 */
  sessionLeadHours: number;
  /** 며칠 뒤까지 일정표를 연다 */
  sessionBookDays: number;
  /** 시작 N시간 전까지 취소하면 전액 환불 */
  sessionFullRefundHours: number;
  /** 그 이후 취소 시 환불 비율 (0.5 = 50%) */
  sessionLateRefundRate: number;
  /** 시작 후 N분 동안 크리에이터 메시지가 없으면 불참으로 보고 전액 환불 가능 */
  sessionNoShowMinutes: number;
  /** 1:1 채팅은 성인 인증 회원만 */
  sessionRequireAdult: boolean;
}

export const DEFAULT_TALK_CONFIG: TalkConfig = {
  enabled: true,
  roomMode: 'GROUP',
  subPriceMode: 'FIXED',
  subPrice: 4_900,
  subPriceMin: 1_900,
  subPriceMax: 19_900,
  subPeriodDays: 30,
  subFeeRate: 0.3,
  subRefundDays: 7,
  fanReplyDailyLimit: 30,
  fanReplyMaxLength: 300,
  sessionEnabled: false,
  sessionPriceMode: 'FIXED',
  sessionPrice: 30_000,
  sessionPriceMin: 10_000,
  sessionPriceMax: 300_000,
  sessionFeeRate: 0.3,
  sessionMinutesOptions: [10, 20, 30],
  sessionApprovalHours: 48,
  sessionLeadHours: 3,
  sessionBookDays: 14,
  sessionFullRefundHours: 24,
  sessionLateRefundRate: 0.5,
  sessionNoShowMinutes: 10,
  sessionRequireAdult: false,
};

// ---------------------------------------------------------------------- 정규화

function num(v: unknown, def: number, min: number, max: number, integer = true): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const x = integer ? Math.trunc(n) : n;
  return x < min || x > max ? def : x;
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}
function intList(v: unknown, def: number[], min: number, max: number): number[] {
  if (!Array.isArray(v)) return def;
  const out = v.map((x) => Math.trunc(Number(x))).filter((x) => Number.isFinite(x) && x >= min && x <= max);
  const uniq = [...new Set(out)].sort((a, b) => a - b).slice(0, 6);
  return uniq.length > 0 ? uniq : def;
}

export function normalizeVoteConfig(raw: unknown): VoteConfig {
  const v = (raw ?? {}) as Partial<Record<keyof VoteConfig, unknown>>;
  const d = DEFAULT_VOTE_CONFIG;
  return {
    enabled: bool(v.enabled, d.enabled),
    ticketsPerVote: num(v.ticketsPerVote, d.ticketsPerVote, 1, 1000),
    maxVotesPerAction: num(v.maxVotesPerAction, d.maxVotesPerAction, 1, 1_000_000),
    dailyMaxVotesPerUser: num(v.dailyMaxVotesPerUser, d.dailyMaxVotesPerUser, 0, 10_000_000),
    dailyMaxVotesPerCreator: num(v.dailyMaxVotesPerCreator, d.dailyMaxVotesPerCreator, 0, 10_000_000),
    requirePhone: bool(v.requirePhone, d.requirePhone),
    spendOrder: v.spendOrder === 'PAID_FIRST' ? 'PAID_FIRST' : 'FREE_FIRST',
    freeExpiryDays: num(v.freeExpiryDays, d.freeExpiryDays, 0, 3650),
    bonusExpiryDays: num(v.bonusExpiryDays, d.bonusExpiryDays, 0, 3650),
    paidExpiryDays: num(v.paidExpiryDays, d.paidExpiryDays, 0, 3650),
    shareRate: num(v.shareRate, d.shareRate, 0, 1, false),
    purchaseEnabled: bool(v.purchaseEnabled, d.purchaseEnabled),
    offerwallEnabled: bool(v.offerwallEnabled, d.offerwallEnabled),
    refundDays: num(v.refundDays, d.refundDays, 0, 365),
    rankingPublic: bool(v.rankingPublic, d.rankingPublic),
    quickVotes: intList(v.quickVotes, d.quickVotes, 1, 1_000_000),
  };
}

export function normalizeTalkConfig(raw: unknown): TalkConfig {
  const v = (raw ?? {}) as Partial<Record<keyof TalkConfig, unknown>>;
  const d = DEFAULT_TALK_CONFIG;
  const subMin = num(v.subPriceMin, d.subPriceMin, 0, 10_000_000);
  const subMax = Math.max(subMin, num(v.subPriceMax, d.subPriceMax, 0, 10_000_000));
  const sesMin = num(v.sessionPriceMin, d.sessionPriceMin, 0, 100_000_000);
  const sesMax = Math.max(sesMin, num(v.sessionPriceMax, d.sessionPriceMax, 0, 100_000_000));
  return {
    enabled: bool(v.enabled, d.enabled),
    roomMode: v.roomMode === 'BUBBLE' ? 'BUBBLE' : 'GROUP',
    subPriceMode: v.subPriceMode === 'CREATOR' ? 'CREATOR' : 'FIXED',
    subPrice: num(v.subPrice, d.subPrice, 100, 10_000_000),
    subPriceMin: subMin,
    subPriceMax: subMax,
    subPeriodDays: num(v.subPeriodDays, d.subPeriodDays, 1, 365),
    subFeeRate: num(v.subFeeRate, d.subFeeRate, 0, 1, false),
    subRefundDays: num(v.subRefundDays, d.subRefundDays, 0, 365),
    fanReplyDailyLimit: num(v.fanReplyDailyLimit, d.fanReplyDailyLimit, 0, 10_000),
    fanReplyMaxLength: num(v.fanReplyMaxLength, d.fanReplyMaxLength, 10, 2000),
    sessionEnabled: bool(v.sessionEnabled, d.sessionEnabled),
    sessionPriceMode: v.sessionPriceMode === 'CREATOR' ? 'CREATOR' : 'FIXED',
    sessionPrice: num(v.sessionPrice, d.sessionPrice, 100, 100_000_000),
    sessionPriceMin: sesMin,
    sessionPriceMax: sesMax,
    sessionFeeRate: num(v.sessionFeeRate, d.sessionFeeRate, 0, 1, false),
    sessionMinutesOptions: intList(v.sessionMinutesOptions, d.sessionMinutesOptions, 5, 180),
    sessionApprovalHours: num(v.sessionApprovalHours, d.sessionApprovalHours, 1, 720),
    sessionLeadHours: num(v.sessionLeadHours, d.sessionLeadHours, 0, 720),
    sessionBookDays: num(v.sessionBookDays, d.sessionBookDays, 1, 90),
    sessionFullRefundHours: num(v.sessionFullRefundHours, d.sessionFullRefundHours, 0, 720),
    sessionLateRefundRate: num(v.sessionLateRefundRate, d.sessionLateRefundRate, 0, 1, false),
    sessionNoShowMinutes: num(v.sessionNoShowMinutes, d.sessionNoShowMinutes, 1, 180),
    sessionRequireAdult: bool(v.sessionRequireAdult, d.sessionRequireAdult),
  };
}

export async function getVoteConfig(): Promise<VoteConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: VOTE_SETTING_KEY } }).catch(() => null);
  return normalizeVoteConfig(row?.value);
}

export async function getTalkConfig(): Promise<TalkConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: TALK_SETTING_KEY } }).catch(() => null);
  return normalizeTalkConfig(row?.value);
}

export async function saveVoteConfig(cfg: VoteConfig, adminUserId?: string) {
  const value = normalizeVoteConfig(cfg) as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({
    where: { key: VOTE_SETTING_KEY },
    create: { key: VOTE_SETTING_KEY, value, updatedBy: adminUserId ?? null },
    update: { value, updatedBy: adminUserId ?? null },
  });
}

export async function saveTalkConfig(cfg: TalkConfig, adminUserId?: string) {
  const value = normalizeTalkConfig(cfg) as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({
    where: { key: TALK_SETTING_KEY },
    create: { key: TALK_SETTING_KEY, value, updatedBy: adminUserId ?? null },
    update: { value, updatedBy: adminUserId ?? null },
  });
}

// ---------------------------------------------------------------------- 크리에이터별 우선 적용

export type Source = 'CREATOR' | 'GLOBAL';

export const SOURCE_LABEL: Record<Source, string> = {
  CREATOR: '크리에이터별 지정',
  GLOBAL: '전역 기본값',
};

export interface PriceTerms {
  mode: PriceMode;
  modeSource: Source;
  /** 지금 팬에게 받는 가격 */
  price: number;
  /** 관리자 고정 가격 (FIXED 일 때 쓰는 값) */
  fixedPrice: number;
  priceSource: Source | 'ROOM';
  min: number;
  max: number;
  feeRate: number;
  feeSource: Source;
}

export interface CreatorEngagement {
  voteShareRate: number;
  voteShareSource: Source;
  talkSub: PriceTerms;
  session: PriceTerms & { allowed: boolean; allowedSource: Source };
}

type PolicyRow = {
  voteShareRate: Prisma.Decimal | null;
  talkSubFeeRate: Prisma.Decimal | null;
  talkSubPriceMode: string | null;
  talkSubPrice: bigint | null;
  talkSubPriceMin: bigint | null;
  talkSubPriceMax: bigint | null;
  sessionFeeRate: Prisma.Decimal | null;
  sessionPriceMode: string | null;
  sessionPrice: bigint | null;
  sessionPriceMin: bigint | null;
  sessionPriceMax: bigint | null;
  sessionAllowed: boolean | null;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function terms(input: {
  modeOverride: string | null;
  globalMode: PriceMode;
  priceOverride: bigint | null;
  globalPrice: number;
  minOverride: bigint | null;
  globalMin: number;
  maxOverride: bigint | null;
  globalMax: number;
  feeOverride: Prisma.Decimal | null;
  globalFee: number;
  roomPrice: bigint | null | undefined;
}): PriceTerms {
  const mode: PriceMode = input.modeOverride === 'CREATOR' || input.modeOverride === 'FIXED' ? input.modeOverride : input.globalMode;
  const modeSource: Source = input.modeOverride === 'CREATOR' || input.modeOverride === 'FIXED' ? 'CREATOR' : 'GLOBAL';
  const fixedPrice = input.priceOverride != null ? Number(input.priceOverride) : input.globalPrice;
  const min = input.minOverride != null ? Number(input.minOverride) : input.globalMin;
  const max = Math.max(min, input.maxOverride != null ? Number(input.maxOverride) : input.globalMax);
  let price = fixedPrice;
  let priceSource: PriceTerms['priceSource'] = input.priceOverride != null ? 'CREATOR' : 'GLOBAL';
  if (mode === 'CREATOR') {
    if (input.roomPrice != null && input.roomPrice > 0n) {
      price = Number(input.roomPrice);
      priceSource = 'ROOM';
    }
    price = clamp(price, min, max);
  }
  const feeRate = input.feeOverride != null ? Number(input.feeOverride) : input.globalFee;
  return { mode, modeSource, price, fixedPrice, priceSource, min, max, feeRate, feeSource: input.feeOverride != null ? 'CREATOR' : 'GLOBAL' };
}

export function resolveEngagement(
  vote: VoteConfig,
  talk: TalkConfig,
  policy: PolicyRow | null,
  room: { subPrice: bigint | null; sessionPrice: bigint | null } | null,
): CreatorEngagement {
  const p = policy;
  const talkSub = terms({
    modeOverride: p?.talkSubPriceMode ?? null,
    globalMode: talk.subPriceMode,
    priceOverride: p?.talkSubPrice ?? null,
    globalPrice: talk.subPrice,
    minOverride: p?.talkSubPriceMin ?? null,
    globalMin: talk.subPriceMin,
    maxOverride: p?.talkSubPriceMax ?? null,
    globalMax: talk.subPriceMax,
    feeOverride: p?.talkSubFeeRate ?? null,
    globalFee: talk.subFeeRate,
    roomPrice: room?.subPrice,
  });
  const session = terms({
    modeOverride: p?.sessionPriceMode ?? null,
    globalMode: talk.sessionPriceMode,
    priceOverride: p?.sessionPrice ?? null,
    globalPrice: talk.sessionPrice,
    minOverride: p?.sessionPriceMin ?? null,
    globalMin: talk.sessionPriceMin,
    maxOverride: p?.sessionPriceMax ?? null,
    globalMax: talk.sessionPriceMax,
    feeOverride: p?.sessionFeeRate ?? null,
    globalFee: talk.sessionFeeRate,
    roomPrice: room?.sessionPrice,
  });
  return {
    voteShareRate: p?.voteShareRate != null ? Number(p.voteShareRate) : vote.shareRate,
    voteShareSource: p?.voteShareRate != null ? 'CREATOR' : 'GLOBAL',
    talkSub,
    session: { ...session, allowed: p?.sessionAllowed ?? true, allowedSource: p?.sessionAllowed != null ? 'CREATOR' : 'GLOBAL' },
  };
}

type Db = Pick<Prisma.TransactionClient, 'creatorEngagementPolicy' | 'talkRoom'>;

export async function getCreatorEngagement(creatorId: string, db: Db = prisma, configs?: { vote?: VoteConfig; talk?: TalkConfig }): Promise<CreatorEngagement> {
  const [vote, talk, policy, room] = await Promise.all([
    configs?.vote ?? getVoteConfig(),
    configs?.talk ?? getTalkConfig(),
    db.creatorEngagementPolicy.findUnique({ where: { creatorId } }),
    db.talkRoom.findUnique({ where: { creatorId }, select: { subPrice: true, sessionPrice: true } }),
  ]);
  return resolveEngagement(vote, talk, policy, room);
}

/** 금액(원) × 비율 — 6자리 고정소수점으로 계산해 부동소수점 오차를 피한다. 원 미만 절사 */
export function rateOf(amount: bigint, rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) return 0n;
  const micro = BigInt(Math.round(rate * 1_000_000));
  return (amount * micro) / 1_000_000n;
}

/** 수수료 계산: 총액 → (수수료, 크리에이터 정산액) */
export function splitFee(gross: bigint, feeRate: number): { fee: bigint; net: bigint } {
  const fee = rateOf(gross, feeRate);
  return { fee, net: gross - fee };
}
