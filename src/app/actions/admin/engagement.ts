'use server';

/**
 * 최고관리자 — 팬투표 관리 · 팬챗 관리 (2026-11-17)
 * 권한: 운영 설정·회차·무효 처리 = 운영(OPERATION) 이상 / 비율·가격·환불 = 재무(FINANCE) 이상
 * 모든 변경은 감사로그에 남긴다.
 */
import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { percentToRate } from '@/server/services/shop/config';
import {
  getTalkConfig, getVoteConfig, normalizeTalkConfig, normalizeVoteConfig, saveTalkConfig, saveVoteConfig, type TalkConfig, type VoteConfig,
} from '@/server/services/engagement/config';
import { getOfferwallSettings, saveOfferwallSettings, type OfferwallProviderKey } from '@/server/services/vote/offerwall';
import { DEFAULT_TICKET_PRODUCTS, refundTicketOrder } from '@/server/services/vote/purchase';
import { createRound, setRoundStatus, suggestChampionCandidates } from '@/server/services/vote/rounds';
import { ensureRecentFinalized, finalizePeriod } from '@/server/services/vote/ranking';
import { voidVoteCast } from '@/server/services/vote/cast';
import { adminRevokeTickets, expireLots, grantTickets, type TicketBucket } from '@/server/services/vote/wallet';
import { deleteTalkMessage, refundTalkSubscription } from '@/server/services/talk/talk';
import { adminRefundSession, closeAllPendingSessions, sweepSessions } from '@/server/services/talk/sessions';
import { assertFinanceAdmin, assertOperationAdmin, run, text, type AdminActionState } from './shared';
import { CONTENT_CATEGORY_SLUGS } from '@/lib/video-hub';
import { isOwnUploadUrl } from '@/server/uploads';
import { MISSION_KEYS } from '@/server/services/engagement/config';
import { createManualGrant, createRewardPolicy, deleteRewardPolicy, setRewardPolicyActive, updateRewardGrant } from '@/server/services/vote/rewards';
import { cancelSupport, createSupport } from '@/server/services/vote/support';
import { deleteCheer } from '@/server/services/vote/fan';
import { deleteLetter } from '@/server/services/talk/talk';

const on = (fd: FormData, key: string) => text(fd, key) === 'on';

function int(fd: FormData, key: string, label: string, min: number, max: number): number {
  const raw = text(fd, key).replace(/[,\s]/g, '');
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < min || n > max) throw new Error(`${label}은(는) ${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')} 사이 정수로 입력해 주세요.`);
  return n;
}

function pct(fd: FormData, key: string, label: string, max = 100): number {
  const r = percentToRate(text(fd, key), max);
  if (r == null) throw new Error(`${label}은(는) 0~${max} 사이 퍼센트로 입력해 주세요.`);
  return Number(r);
}

async function creatorByCode(code: string) {
  const c = await prisma.creatorProfile.findFirst({ where: { code: code.trim().toUpperCase() }, select: { id: true, code: true, displayName: true } });
  if (!c) throw new Error('크리에이터 코드를 찾을 수 없습니다.');
  return c;
}

function refreshVote() {
  revalidatePath('/admin/vote');
  revalidatePath('/vote');
}

// ====================================================================== 팬투표

export async function saveVoteSettingsAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 설정 변경');
    const before = await getVoteConfig();
    const quick = text(fd, 'quickVotes').split(/[,\s]+/).filter(Boolean).map(Number);
    const next: VoteConfig = normalizeVoteConfig({
      ...before,
      enabled: on(fd, 'enabled'),
      rankingPublic: on(fd, 'rankingPublic'),
      purchaseEnabled: on(fd, 'purchaseEnabled'),
      offerwallEnabled: on(fd, 'offerwallEnabled'),
      requirePhone: on(fd, 'requirePhone'),
      ticketsPerVote: int(fd, 'ticketsPerVote', '1표당 소진 팬투표권', 1, 1000),
      maxVotesPerAction: int(fd, 'maxVotesPerAction', '한 번에 최대 표', 1, 1_000_000),
      dailyMaxVotesPerUser: int(fd, 'dailyMaxVotesPerUser', '회원 하루 최대 표', 0, 10_000_000),
      dailyMaxVotesPerCreator: int(fd, 'dailyMaxVotesPerCreator', '크리에이터별 하루 최대 표', 0, 10_000_000),
      spendOrder: text(fd, 'spendOrder') === 'PAID_FIRST' ? 'PAID_FIRST' : 'FREE_FIRST',
      freeExpiryDays: int(fd, 'freeExpiryDays', '무료 팬투표권 유효기간', 0, 3650),
      bonusExpiryDays: int(fd, 'bonusExpiryDays', '보너스 팬투표권 유효기간', 0, 3650),
      paidExpiryDays: int(fd, 'paidExpiryDays', '유료 팬투표권 유효기간', 0, 3650),
      refundDays: int(fd, 'refundDays', '환불 가능 기간', 0, 365),
      quickVotes: quick,
    });
    await saveVoteConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_CONFIG_SAVE', targetType: 'SystemSetting', targetId: 'vote.config', before, after: next });
    refreshVote();
    return '팬투표 설정을 저장했습니다. 바로 적용됩니다.';
  });
}

export async function saveVoteShareRateAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '팬투표 수익 배분 비율 변경');
    const before = await getVoteConfig();
    const next = { ...before, shareRate: pct(fd, 'shareRate', '크리에이터 몫 비율') };
    await saveVoteConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_SHARE_RATE_SAVE', targetType: 'SystemSetting', targetId: 'vote.config', before: { shareRate: before.shareRate }, after: { shareRate: next.shareRate } });
    refreshVote();
    return next.shareRate > 0 ? `전역 크리에이터 몫을 ${(next.shareRate * 100).toFixed(2)}% 로 저장했습니다. 이후 팬투표부터 적용됩니다.` : '전역 크리에이터 몫을 0% (나누지 않음) 로 저장했습니다.';
  });
}

export async function saveTicketProductAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '팬투표권 상품 저장');
    const id = text(fd, 'id');
    const name = text(fd, 'name').slice(0, 40);
    if (!name) throw new Error('상품 이름을 입력해 주세요.');
    const data = {
      name,
      price: BigInt(int(fd, 'price', '가격(원)', 100, 10_000_000)),
      tickets: int(fd, 'tickets', '팬투표권 수', 1, 10_000_000),
      bonus: int(fd, 'bonus', '보너스 팬투표권', 0, 10_000_000),
      badge: text(fd, 'badge').slice(0, 10) || null,
      sortOrder: int(fd, 'sortOrder', '노출 순서', 0, 999),
      active: on(fd, 'active'),
    };
    if (id) await prisma.voteTicketProduct.update({ where: { id }, data });
    else await prisma.voteTicketProduct.create({ data: { id: newId(), ...data } });
    await writeAudit({ adminUserId: admin.id, action: id ? 'VOTE_PRODUCT_UPDATE' : 'VOTE_PRODUCT_CREATE', targetType: 'VoteTicketProduct', targetId: id || undefined, after: { ...data, price: data.price.toString() } });
    revalidatePath('/admin/vote/products');
    revalidatePath('/vote/charge');
    return '팬투표권 상품을 저장했습니다.';
  });
}

export async function createDefaultTicketProductsAction(_p: AdminActionState): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '기본 팬투표권 상품 만들기');
    const count = await prisma.voteTicketProduct.count();
    if (count > 0) throw new Error('이미 상품이 있습니다. 개별로 추가해 주세요.');
    await prisma.voteTicketProduct.createMany({ data: DEFAULT_TICKET_PRODUCTS.map((p, i) => ({ id: newId(), ...p, sortOrder: i })) });
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_PRODUCT_DEFAULTS', targetType: 'VoteTicketProduct' });
    revalidatePath('/admin/vote/products');
    return `기본 상품 ${DEFAULT_TICKET_PRODUCTS.length}개를 만들었습니다. 가격·수량은 바로 고칠 수 있습니다.`;
  });
}

export async function saveOfferwallAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '오퍼월 설정 변경');
    const before = await getOfferwallSettings();
    const next = structuredClone(before);
    for (const k of Object.keys(next.providers) as OfferwallProviderKey[]) {
      next.providers[k].enabled = on(fd, `${k}_enabled`);
      const r = Number(text(fd, `${k}_ratio`));
      if (!Number.isFinite(r) || r <= 0 || r > 1000) throw new Error('전환 비율은 0보다 크고 1000 이하인 숫자로 입력해 주세요.');
      next.providers[k].ratio = r;
    }
    await saveOfferwallSettings(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'OFFERWALL_SAVE', targetType: 'SystemSetting', targetId: 'vote.offerwall', before, after: next });
    revalidatePath('/admin/vote/offerwall');
    revalidatePath('/vote/charge');
    return '오퍼월 설정을 저장했습니다.';
  });
}

export async function createRoundAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 회차 만들기');
    const kind = text(fd, 'kind') === 'EVENT' ? 'EVENT' : 'CHAMPION';
    const startsAt = parseKstInput(text(fd, 'startsAt'));
    const endsAt = parseKstInput(text(fd, 'endsAt'));
    if (!startsAt || !endsAt) throw new Error('시작·종료 시각을 입력해 주세요.');
    let ids: string[] = [];
    const codes = text(fd, 'codes').split(/[\s,]+/).filter(Boolean);
    if (codes.length > 0) {
      const rows = await prisma.creatorProfile.findMany({ where: { code: { in: codes.map((c) => c.toUpperCase()) } }, select: { id: true, code: true } });
      const found = new Set(rows.map((r) => r.code));
      const missing = codes.map((c) => c.toUpperCase()).filter((c) => !found.has(c));
      if (missing.length) throw new Error(`찾을 수 없는 코드: ${missing.join(', ')}`);
      ids = codes.map((c) => rows.find((r) => r.code === c.toUpperCase())!.id);
    } else if (kind === 'CHAMPION') {
      // 카테고리를 고르면 그 카테고리의 지난달 상위 N명이 후보가 된다 (카테고리 왕중왕전, 2026-11-18)
      const cat = text(fd, 'category');
      const category = cat && (CONTENT_CATEGORY_SLUGS as string[]).includes(cat) ? cat : null;
      ids = await suggestChampionCandidates(int(fd, 'topN', '자동 후보 수', 2, 50), new Date(), category);
      if (category && ids.length < 2) throw new Error('이 카테고리에는 후보가 될 크리에이터가 2명 이상 없습니다. 후보 코드를 직접 입력해 주세요.');
    }
    const banner = text(fd, 'bannerUrl');
    if (banner && !isOwnUploadUrl(banner)) throw new Error('배너는 [사진 올리기]로 올린 이미지만 쓸 수 있습니다.');
    const id = await createRound(
      {
        kind,
        title: text(fd, 'title'),
        description: text(fd, 'description'),
        startsAt,
        endsAt,
        creatorIds: ids,
        status: on(fd, 'openNow') ? 'OPEN' : 'DRAFT',
        bannerUrl: banner || null,
        rewardText: text(fd, 'rewardText') || null,
        dailyMaxVotes: text(fd, 'dailyMaxVotes') ? int(fd, 'dailyMaxVotes', '하루 최대 표', 0, 10_000_000) : 0,
      },
      admin.id,
    );
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_ROUND_CREATE', targetType: 'VoteRound', targetId: id, after: { kind, title: text(fd, 'title'), candidates: ids.length } });
    revalidatePath('/admin/vote/rounds');
    refreshVote();
    return `회차를 만들었습니다. (후보 ${ids.length}명)`;
  });
}

/** datetime-local 입력(KST 기준) → UTC Date */
function parseKstInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - 9 * 3600_000);
}

export async function setRoundStatusAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 회차 상태 변경');
    const status = text(fd, 'status') as 'DRAFT' | 'OPEN' | 'CLOSED';
    if (!['DRAFT', 'OPEN', 'CLOSED'].includes(status)) throw new Error('알 수 없는 상태입니다.');
    await setRoundStatus(text(fd, 'roundId'), status);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_ROUND_STATUS', targetType: 'VoteRound', targetId: text(fd, 'roundId'), after: { status } });
    revalidatePath('/admin/vote/rounds');
    refreshVote();
    return status === 'OPEN' ? '회차를 열었습니다.' : status === 'CLOSED' ? '회차를 종료하고 결과를 확정했습니다.' : '준비 상태로 바꿨습니다.';
  });
}

export async function finalizeNowAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '기간 마감 확정');
    const type = text(fd, 'periodType');
    const key = text(fd, 'periodKey');
    if (type && key) {
      const n = await finalizePeriod(type, key);
      await writeAudit({ adminUserId: admin.id, action: 'VOTE_FINALIZE', targetType: 'VotePeriodResult', targetId: `${type}:${key}`, after: { rows: n } });
      refreshVote();
      return n > 0 ? `${key} 순위 ${n}건을 확정했습니다.` : '이미 확정됐거나 집계가 없습니다.';
    }
    await ensureRecentFinalized(new Date(), true);
    const expired = await expireLots();
    refreshVote();
    return `지난 기간 확정 점검을 마쳤습니다. 만료 처리한 팬투표권 묶음 ${expired}개.`;
  });
}

export async function voidCastAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 무효 처리');
    const reason = text(fd, 'reason');
    if (!reason) throw new Error('무효 사유를 입력해 주세요.');
    await voidVoteCast(text(fd, 'castId'), admin.id, reason, on(fd, 'refund'));
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_CAST_VOID', targetType: 'VoteCast', targetId: text(fd, 'castId'), after: { reason, refund: on(fd, 'refund') } });
    revalidatePath('/admin/vote/casts');
    refreshVote();
    return '팬투표를 무효 처리했습니다. 집계에서 빠졌습니다.';
  });
}

export async function adjustTicketsAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표권 지급·회수');
    const email = text(fd, 'email').toLowerCase();
    const userId = text(fd, 'userId');
    const user = await prisma.user.findFirst({ where: userId ? { id: userId } : { email }, select: { id: true, email: true, name: true } });
    if (!user) throw new Error('회원을 찾을 수 없습니다. (이메일 또는 회원 ID)');
    const bucket = (['FREE', 'BONUS', 'PAID'].includes(text(fd, 'bucket')) ? text(fd, 'bucket') : 'BONUS') as TicketBucket;
    const amount = int(fd, 'amount', '수량', 1, 10_000_000);
    const memo = text(fd, 'memo');
    if (!memo) throw new Error('사유를 입력해 주세요. 회원 내역에 표시됩니다.');
    const cfg = await getVoteConfig();
    if (text(fd, 'op') === 'revoke') {
      const done = await adminRevokeTickets(user.id, bucket, amount, `관리자 회수: ${memo}`);
      await writeAudit({ adminUserId: admin.id, action: 'VOTE_TICKET_REVOKE', targetType: 'User', targetId: user.id, after: { bucket, amount, done, memo } });
      revalidatePath('/admin/vote/tickets');
      return `${user.name ?? user.email} 님에게서 ${done.toLocaleString('ko-KR')}개를 회수했습니다.`;
    }
    if (bucket === 'PAID') throw new Error('유료 팬투표권은 결제로만 생깁니다. 관리자 지급은 무료·보너스만 가능합니다.');
    await prisma.$transaction((tx) =>
      grantTickets(tx, { userId: user.id, bucket, amount, source: 'ADMIN', ledgerType: 'ADMIN_GRANT', refType: 'ADMIN', refId: admin.id, expiresInDays: bucket === 'FREE' ? cfg.freeExpiryDays : cfg.bonusExpiryDays, memo: `관리자 지급: ${memo}` }),
    );
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_TICKET_GRANT', targetType: 'User', targetId: user.id, after: { bucket, amount, memo } });
    revalidatePath('/admin/vote/tickets');
    return `${user.name ?? user.email} 님에게 ${amount.toLocaleString('ko-KR')}개를 지급했습니다.`;
  });
}

export async function refundTicketOrderAdminAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '팬투표권 결제 환불');
    const r = await refundTicketOrder(text(fd, 'orderId'), { type: 'ADMIN', userId: admin.id }, text(fd, 'reason') || '관리자 환불');
    if (!r.ok) throw new Error(r.message);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_ORDER_REFUND', targetType: 'VoteTicketOrder', targetId: text(fd, 'orderId') });
    revalidatePath('/admin/vote/tickets');
    return r.message;
  });
}

// ====================================================================== 팬챗

export async function saveTalkSettingsAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬챗 설정 변경');
    const before = await getTalkConfig();
    const minutes = text(fd, 'sessionMinutesOptions').split(/[,\s]+/).filter(Boolean).map(Number);
    const next: TalkConfig = normalizeTalkConfig({
      ...before,
      enabled: on(fd, 'enabled'),
      roomMode: text(fd, 'roomMode') === 'GROUP' ? 'GROUP' : 'BUBBLE',
      subPeriodDays: int(fd, 'subPeriodDays', '구독 기간(일)', 1, 365),
      subRefundDays: int(fd, 'subRefundDays', '구독 환불 기간(일)', 0, 365),
      fanReplyDailyLimit: int(fd, 'fanReplyDailyLimit', '팬 하루 최대 메시지', 0, 10_000),
      fanReplyMaxLength: int(fd, 'fanReplyMaxLength', '팬 메시지 최대 글자', 10, 2000),
      sessionMinutesOptions: minutes,
      sessionApprovalHours: int(fd, 'sessionApprovalHours', '승인 기한(시간)', 1, 720),
      sessionLeadHours: int(fd, 'sessionLeadHours', '최소 신청 시간(시간)', 0, 720),
      sessionBookDays: int(fd, 'sessionBookDays', '일정표 공개 기간(일)', 1, 90),
      sessionFullRefundHours: int(fd, 'sessionFullRefundHours', '전액 환불 기준(시간)', 0, 720),
      sessionLateRefundRate: pct(fd, 'sessionLateRefundRate', '늦은 취소 환불 비율'),
      sessionNoShowMinutes: int(fd, 'sessionNoShowMinutes', '불참 판정(분)', 1, 180),
      sessionRequireAdult: on(fd, 'sessionRequireAdult'),
    });
    await saveTalkConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'TALK_CONFIG_SAVE', targetType: 'SystemSetting', targetId: 'talk.config', before, after: next });
    revalidatePath('/admin/talk');
    return '팬챗 설정을 저장했습니다. 바로 적용됩니다.';
  });
}

/** ★ 1:1 채팅 전역 스위치 */
export async function setSessionSwitchAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '1:1 채팅 켜기·끄기');
    const before = await getTalkConfig();
    const enable = text(fd, 'enable') === '1';
    await saveTalkConfig({ ...before, sessionEnabled: enable }, admin.id);
    let cancelled = 0;
    if (!enable && text(fd, 'pending') === 'cancel') cancelled = await closeAllPendingSessions(admin.id);
    await writeAudit({ adminUserId: admin.id, action: enable ? 'TALK_SESSION_ON' : 'TALK_SESSION_OFF', targetType: 'SystemSetting', targetId: 'talk.config', before: { sessionEnabled: before.sessionEnabled }, after: { sessionEnabled: enable, cancelled } });
    revalidatePath('/admin/talk');
    revalidatePath('/studio/talk');
    return enable
      ? '1:1 채팅을 켰습니다. 크리에이터 샵·마이페이지·스튜디오에 노출됩니다.'
      : `1:1 채팅을 껐습니다. 어디에도 노출되지 않습니다.${cancelled > 0 ? ` 시작 전 예약 ${cancelled}건을 취소·전액 환불했습니다.` : ' 이미 잡힌 예약은 대화를 할 수 없으므로, 종료 시각이 지나면 자동으로 전액 환불됩니다.'}`;
  });
}

/** 팬챗 구독·1:1 가격과 플랫폼 수수료 (전역) */
export async function saveTalkPricingAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '팬챗 가격·수수료 변경');
    const before = await getTalkConfig();
    const next = normalizeTalkConfig({
      ...before,
      subPriceMode: text(fd, 'subPriceMode') === 'CREATOR' ? 'CREATOR' : 'FIXED',
      subPrice: int(fd, 'subPrice', '월 구독 가격', 100, 10_000_000),
      subPriceMin: int(fd, 'subPriceMin', '월 구독 최소 가격', 0, 10_000_000),
      subPriceMax: int(fd, 'subPriceMax', '월 구독 최대 가격', 0, 10_000_000),
      subFeeRate: pct(fd, 'subFeeRate', '팬챗 구독 플랫폼 수수료'),
      sessionPriceMode: text(fd, 'sessionPriceMode') === 'CREATOR' ? 'CREATOR' : 'FIXED',
      sessionPrice: int(fd, 'sessionPrice', '1:1 가격', 100, 100_000_000),
      sessionPriceMin: int(fd, 'sessionPriceMin', '1:1 최소 가격', 0, 100_000_000),
      sessionPriceMax: int(fd, 'sessionPriceMax', '1:1 최대 가격', 0, 100_000_000),
      sessionFeeRate: pct(fd, 'sessionFeeRate', '1:1 플랫폼 수수료'),
    });
    if (next.subPriceMin > next.subPriceMax || next.sessionPriceMin > next.sessionPriceMax) throw new Error('최소 가격은 최대 가격보다 클 수 없습니다.');
    await saveTalkConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'TALK_PRICING_SAVE', targetType: 'SystemSetting', targetId: 'talk.config', before, after: next });
    revalidatePath('/admin/talk');
    return '가격·수수료를 저장했습니다. 이후 결제부터 적용됩니다. (크리에이터별 지정이 있으면 그 값이 우선합니다)';
  });
}

/** 크리에이터별 지정 — 비우면 전역 값을 따른다 */
export async function saveCreatorPolicyAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '크리에이터별 요율·권한 지정');
    const c = await creatorByCode(text(fd, 'creatorCode'));
    const optPct = (key: string, label: string) => (text(fd, key) === '' ? null : pct(fd, key, label).toFixed(6));
    const optMoney = (key: string, label: string) => (text(fd, key) === '' ? null : BigInt(int(fd, key, label, 0, 100_000_000)));
    const optMode = (key: string) => (text(fd, key) === 'FIXED' || text(fd, key) === 'CREATOR' ? text(fd, key) : null);
    const allowed = text(fd, 'sessionAllowed');
    const data = {
      voteShareRate: optPct('voteShareRate', '팬투표 수익 크리에이터 몫'),
      talkSubFeeRate: optPct('talkSubFeeRate', '팬챗 구독 수수료'),
      talkSubPriceMode: optMode('talkSubPriceMode'),
      talkSubPrice: optMoney('talkSubPrice', '팬챗 구독 가격'),
      talkSubPriceMin: optMoney('talkSubPriceMin', '팬챗 구독 최소 가격'),
      talkSubPriceMax: optMoney('talkSubPriceMax', '팬챗 구독 최대 가격'),
      sessionFeeRate: optPct('sessionFeeRate', '1:1 수수료'),
      sessionPriceMode: optMode('sessionPriceMode'),
      sessionPrice: optMoney('sessionPrice', '1:1 가격'),
      sessionPriceMin: optMoney('sessionPriceMin', '1:1 최소 가격'),
      sessionPriceMax: optMoney('sessionPriceMax', '1:1 최대 가격'),
      sessionAllowed: allowed === 'allow' ? true : allowed === 'deny' ? false : null,
      memo: text(fd, 'memo').slice(0, 200) || null,
      updatedBy: admin.id,
    };
    if (data.talkSubPriceMin != null && data.talkSubPriceMax != null && data.talkSubPriceMin > data.talkSubPriceMax) throw new Error('팬챗 구독 최소 가격이 최대 가격보다 큽니다.');
    if (data.sessionPriceMin != null && data.sessionPriceMax != null && data.sessionPriceMin > data.sessionPriceMax) throw new Error('1:1 최소 가격이 최대 가격보다 큽니다.');
    const before = await prisma.creatorEngagementPolicy.findUnique({ where: { creatorId: c.id } });
    await prisma.creatorEngagementPolicy.upsert({ where: { creatorId: c.id }, create: { id: newId(), creatorId: c.id, ...data }, update: data });
    const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    await writeAudit({ adminUserId: admin.id, action: 'ENGAGEMENT_POLICY_SAVE', targetType: 'CreatorEngagementPolicy', targetId: c.id, before: before ? json(before) : null, after: json(data) });
    revalidatePath('/admin/talk/creators');
    return `${c.displayName} (${c.code}) 크리에이터별 설정을 저장했습니다. 비워 둔 칸은 전역 값을 따릅니다.`;
  });
}

export async function clearCreatorPolicyAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '크리에이터별 지정 해제');
    const id = text(fd, 'creatorId');
    await prisma.creatorEngagementPolicy.deleteMany({ where: { creatorId: id } });
    await writeAudit({ adminUserId: admin.id, action: 'ENGAGEMENT_POLICY_CLEAR', targetType: 'CreatorEngagementPolicy', targetId: id });
    revalidatePath('/admin/talk/creators');
    return '크리에이터별 지정을 지웠습니다. 이제 전역 값을 따릅니다.';
  });
}

export async function adminSessionOpAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const op = text(fd, 'op');
    if (op === 'sweep') {
      assertOperationAdmin(admin, '예약 기한 정리');
      const r = await sweepSessions();
      revalidatePath('/admin/talk/sessions');
      return `기한 만료 ${r.expired}건 환불, 종료 ${r.completed}건 완료·정산 처리했습니다.`;
    }
    assertFinanceAdmin(admin, '1:1 예약 환불');
    const r = await adminRefundSession(text(fd, 'sessionId'), admin.id, text(fd, 'reason') || '관리자 처리');
    if (!r.ok) throw new Error(r.message);
    await writeAudit({ adminUserId: admin.id, action: 'TALK_SESSION_REFUND', targetType: 'TalkSession', targetId: text(fd, 'sessionId'), after: { reason: text(fd, 'reason') } });
    revalidatePath('/admin/talk/sessions');
    return r.message;
  });
}

export async function refundTalkSubscriptionAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertFinanceAdmin(admin, '팬챗 구독 환불');
    const r = await refundTalkSubscription(text(fd, 'subscriptionId'), admin.id, text(fd, 'reason') || '관리자 환불');
    if (!r.ok) throw new Error(r.message);
    await writeAudit({ adminUserId: admin.id, action: 'TALK_SUBSCRIPTION_REFUND', targetType: 'TalkSubscription', targetId: text(fd, 'subscriptionId') });
    revalidatePath('/admin/talk/subscriptions');
    return r.message;
  });
}

export async function handleTalkReportAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬챗 신고 처리');
    const id = text(fd, 'reportId');
    const decision = text(fd, 'decision');
    const report = await prisma.talkReport.findUnique({ where: { id } });
    if (!report) throw new Error('신고를 찾을 수 없습니다.');
    if (decision === 'delete') {
      if (report.target === 'MESSAGE') await deleteTalkMessage(report.messageId, { type: 'ADMIN', userId: admin.id }).catch(() => undefined);
      else await prisma.talkSessionMessage.updateMany({ where: { id: report.messageId }, data: { body: '[운영 정책에 따라 가려진 메시지입니다]' } });
    }
    await prisma.talkReport.update({ where: { id }, data: { status: decision === 'dismiss' ? 'DISMISSED' : 'RESOLVED', handledBy: admin.id, handledAt: new Date() } });
    await writeAudit({ adminUserId: admin.id, action: 'TALK_REPORT_HANDLE', targetType: 'TalkReport', targetId: id, after: { decision } });
    revalidatePath('/admin/talk/reports');
    return decision === 'dismiss' ? '신고를 기각했습니다.' : decision === 'delete' ? '메시지를 가리고 신고를 처리했습니다.' : '처리 완료로 표시했습니다.';
  });
}


// ====================================================================== 팬챗 · 팬투표 고도화 (2026-11-18)

/** "0:50, 14:80" 같은 줄을 [{a,b}] 로 */
function pairs(raw: string, label: string, opts: { percent?: boolean } = {}): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const part of raw.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[:=]\s*(\d+(?:\.\d+)?)$/.exec(part.replace(/\s+/g, ''));
    if (!m) throw new Error(`${label} 형식을 확인해 주세요. 예) 0:50, 14:80`);
    out.push([Number(m[1]), opts.percent ? Number(m[2]) / 100 : Number(m[2])]);
  }
  return out;
}

export async function saveFanchatAdvancedAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬챗 고도화 설정 변경');
    const before = await getTalkConfig();
    const tiers = pairs(text(fd, 'replyLengthTiers'), '답장 글자 수 단계').map(([days, length]) => ({ days, length }));
    const bundles = pairs(text(fd, 'bundleDiscounts'), '묶음 할인', { percent: true }).map(([count, rate]) => ({ count, rate }));
    const milestones = text(fd, 'dayMilestones').split(/[,\s]+/).filter(Boolean).map(Number);
    const next: TalkConfig = normalizeTalkConfig({
      ...before,
      replyPerMessage: int(fd, 'replyPerMessage', '메시지당 답장 수', 0, 100),
      replyLengthTiers: tiers.length ? tiers : before.replyLengthTiers,
      letterEnabled: on(fd, 'letterEnabled'),
      letterMaxLength: int(fd, 'letterMaxLength', '팬레터 최대 글자', 100, 5000),
      letterPerWeek: int(fd, 'letterPerWeek', '7일 팬레터 수', 1, 50),
      bundleEnabled: on(fd, 'bundleEnabled'),
      bundleDiscounts: bundles.length ? bundles : before.bundleDiscounts,
      voiceMaxSeconds: int(fd, 'voiceMaxSeconds', '음성 최대 길이(초)', 10, 600),
      notifyOnBroadcast: on(fd, 'notifyOnBroadcast'),
      dayMilestones: milestones.length ? milestones : before.dayMilestones,
    });
    await saveTalkConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'TALK_CONFIG_SAVE', targetType: 'SystemSetting', targetId: 'talk.config', before, after: next });
    revalidatePath('/admin/talk');
    return '팬챗 설정을 저장했습니다. 바로 적용됩니다.';
  });
}

export async function saveFanvoteExtrasAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 활동 설정 변경');
    const before = await getVoteConfig();
    const missionTickets: Record<string, number> = {};
    for (const k of MISSION_KEYS) missionTickets[k] = int(fd, `mission_${k}`, '미션 지급 수', 0, 10_000);
    const streak = pairs(text(fd, 'attendanceStreakBonus'), '연속 출석 보너스').map(([days, bonus]) => ({ days, bonus }));
    const next: VoteConfig = normalizeVoteConfig({
      ...before,
      attendanceEnabled: on(fd, 'attendanceEnabled'),
      attendanceTickets: int(fd, 'attendanceTickets', '출석 지급 수', 0, 10_000),
      attendanceStreakBonus: streak,
      missionsEnabled: on(fd, 'missionsEnabled'),
      missionTickets,
      referralEnabled: on(fd, 'referralEnabled'),
      referralInviterTickets: int(fd, 'referralInviterTickets', '초대한 회원 보상', 0, 100_000),
      referralInviteeTickets: int(fd, 'referralInviteeTickets', '초대받은 회원 보상', 0, 100_000),
      referralCodeDays: int(fd, 'referralCodeDays', '초대 코드 입력 기간', 1, 365),
      referralMaxPerInviter: int(fd, 'referralMaxPerInviter', '1명당 최대 초대 보상', 0, 100_000),
      referralRequirePhone: on(fd, 'referralRequirePhone'),
      cheerEnabled: on(fd, 'cheerEnabled'),
      cheerDailyLimit: int(fd, 'cheerDailyLimit', '하루 응원 댓글 수', 1, 1000),
      cheerMaxLength: int(fd, 'cheerMaxLength', '응원 댓글 글자 수', 10, 500),
      supportEnabled: on(fd, 'supportEnabled'),
      supportMinTickets: int(fd, 'supportMinTickets', '서포트 최소 참여', 1, 1_000_000),
    });
    await saveVoteConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_CONFIG_SAVE', targetType: 'SystemSetting', targetId: 'vote.config', before, after: next });
    refreshVote();
    revalidatePath('/vote/charge');
    return '팬투표 활동 설정을 저장했습니다. 바로 적용됩니다.';
  });
}

export async function createRewardPolicyAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 보상 정책 추가');
    const scope = text(fd, 'scope') === 'ROUND' ? 'ROUND' : 'PERIOD';
    const pt = text(fd, 'periodType');
    const p = await createRewardPolicy({
      scope,
      periodType: pt === 'DAY' || pt === 'WEEK' || pt === 'MONTH' ? pt : null,
      roundId: text(fd, 'roundId') || null,
      rankFrom: int(fd, 'rankFrom', '시작 순위', 1, 100),
      rankTo: int(fd, 'rankTo', '끝 순위', 1, 100),
      rewardType: text(fd, 'rewardType'),
      title: text(fd, 'title'),
      description: text(fd, 'description'),
    });
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_REWARD_POLICY_CREATE', targetType: 'VoteRewardPolicy', targetId: p.id, after: p });
    revalidatePath('/admin/vote/rewards');
    revalidatePath('/vote/rewards');
    return '보상 정책을 추가했습니다. 다음 확정 순위부터 적용됩니다.';
  });
}

export async function rewardPolicyOpAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 보상 정책 변경');
    const id = text(fd, 'policyId');
    const op = text(fd, 'op');
    if (op === 'delete') await deleteRewardPolicy(id);
    else await setRewardPolicyActive(id, op === 'on');
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_REWARD_POLICY_OP', targetType: 'VoteRewardPolicy', targetId: id, after: { op } });
    revalidatePath('/admin/vote/rewards');
    revalidatePath('/vote/rewards');
    return op === 'delete' ? '보상 정책을 지웠습니다.' : op === 'on' ? '보상 정책을 켰습니다.' : '보상 정책을 껐습니다.';
  });
}

export async function updateRewardGrantAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 보상 집행 기록');
    const proof = text(fd, 'proofImageUrl');
    if (proof && !isOwnUploadUrl(proof)) throw new Error('인증 사진은 [사진 올리기]로 올린 이미지만 쓸 수 있습니다.');
    const status = text(fd, 'status') as 'PENDING' | 'SCHEDULED' | 'PUBLISHED' | 'CANCELLED';
    const id = text(fd, 'grantId');
    await updateRewardGrant(id, {
      status,
      mediaName: text(fd, 'mediaName'),
      scheduledAt: text(fd, 'scheduledAt') ? parseKstInput(`${text(fd, 'scheduledAt')}T09:00`) : null,
      publishedAt: text(fd, 'publishedAt') ? parseKstInput(`${text(fd, 'publishedAt')}T09:00`) : null,
      proofImageUrl: proof || null,
      note: text(fd, 'note'),
    }, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_REWARD_GRANT_UPDATE', targetType: 'VoteRewardGrant', targetId: id, after: { status, mediaName: text(fd, 'mediaName') } });
    revalidatePath('/admin/vote/rewards');
    revalidatePath('/vote/rewards');
    return '보상 집행 기록을 저장했습니다.';
  });
}

export async function createManualGrantAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬투표 특별 보상 추가');
    const c = await creatorByCode(text(fd, 'code'));
    await createManualGrant({ creatorId: c.id, rewardType: text(fd, 'rewardType'), title: text(fd, 'title'), sourceLabel: text(fd, 'sourceLabel') });
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_REWARD_GRANT_MANUAL', targetType: 'CreatorProfile', targetId: c.id, after: { title: text(fd, 'title') } });
    revalidatePath('/admin/vote/rewards');
    revalidatePath('/vote/rewards');
    return `${c.displayName} 님에게 특별 보상을 추가했습니다.`;
  });
}

export async function createSupportAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '서포트 열기');
    const c = await creatorByCode(text(fd, 'code'));
    const startsAt = parseKstInput(text(fd, 'startsAt'));
    const endsAt = parseKstInput(text(fd, 'endsAt'));
    if (!startsAt || !endsAt) throw new Error('시작·종료 시각을 입력해 주세요.');
    const banner = text(fd, 'bannerUrl');
    if (banner && !isOwnUploadUrl(banner)) throw new Error('배너는 [사진 올리기]로 올린 이미지만 쓸 수 있습니다.');
    const id = await createSupport({
      creatorId: c.id,
      title: text(fd, 'title'),
      description: text(fd, 'description'),
      rewardType: text(fd, 'rewardType') || 'NEWSPAPER',
      bannerUrl: banner || null,
      goalTickets: int(fd, 'goalTickets', '목표 팬투표권', 10, 1_000_000_000),
      startsAt,
      endsAt,
    }, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_SUPPORT_CREATE', targetType: 'VoteSupport', targetId: id, after: { creator: c.code, title: text(fd, 'title') } });
    revalidatePath('/admin/vote/support');
    revalidatePath('/vote/support');
    return `${c.displayName} 님 서포트를 열었습니다.`;
  });
}

export async function cancelSupportAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '서포트 취소');
    const id = text(fd, 'supportId');
    await cancelSupport(id, text(fd, 'reason') || '관리자 취소');
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_SUPPORT_CANCEL', targetType: 'VoteSupport', targetId: id, after: { reason: text(fd, 'reason') } });
    revalidatePath('/admin/vote/support');
    revalidatePath('/vote/support');
    return '서포트를 취소하고 참여한 팬투표권을 돌려줬습니다.';
  });
}

export async function deleteCheerAdminAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '응원 댓글 삭제');
    const r = await deleteCheer(text(fd, 'cheerId'), { type: 'ADMIN', userId: admin.id });
    if (!r.ok) throw new Error(r.message);
    await writeAudit({ adminUserId: admin.id, action: 'VOTE_CHEER_DELETE', targetType: 'VoteCheer', targetId: text(fd, 'cheerId') });
    revalidatePath('/admin/vote/cheers');
    return '응원 댓글을 지웠습니다.';
  });
}

export async function deleteLetterAdminAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertOperationAdmin(admin, '팬레터 삭제');
    await deleteLetter(text(fd, 'letterId'), { type: 'ADMIN', userId: admin.id });
    await writeAudit({ adminUserId: admin.id, action: 'TALK_LETTER_DELETE', targetType: 'TalkLetter', targetId: text(fd, 'letterId') });
    revalidatePath('/admin/talk');
    return '팬레터를 지웠습니다.';
  });
}
