/**
 * 팬투표 팬 활동 (2026-11-18) — 출석 체크 · 일일 미션 · 친구 초대 · 팬 레벨 · 배지 · 응원 댓글 · 팬 랭킹.
 *
 * - 무료 팬투표권은 모두 FREE 묶음으로 지급하고(유효기간 = 무료 팬투표권 유효기간), 이력에 종류를 남긴다.
 * - 중복 지급은 DB 유니크로 막는다: 출석(회원·날짜) · 미션(회원·미션·날짜) · 초대(초대받은 회원 1명당 1번).
 *   유니크 충돌이면 트랜잭션 전체가 되돌아가므로 팬투표권도 나가지 않는다.
 * - 팬 레벨은 따로 저장하지 않고 활동량(경험치)으로 그때그때 계산한다.
 */
import crypto from 'node:crypto';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey, kstStartOfDay } from '@/lib/datetime';
import { maskContacts } from '@/lib/contact-mask';
import { loadBannedWords } from '@/server/services/donation-flow';
import { filterContent } from '@/server/services/content-filter';
import { getVoteConfig, MISSION_KEYS, type MissionKey, type VoteConfig } from '@/server/services/engagement/config';
import { grantTickets } from './wallet';
import { maskNick } from './ranking';

const DAY_MS = 86_400_000;

export interface FanResult {
  ok: boolean;
  message: string;
  tickets?: number;
}

async function activeUser(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, createdAt: true, phoneHash: true, creatorProfile: { select: { id: true } } } });
  return u && u.status === 'ACTIVE' ? u : null;
}

// ---------------------------------------------------------------------- 출석

function prevDayKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00+09:00`);
  return kstDateKey(new Date(d.getTime() - DAY_MS));
}

/** 오늘 출석했을 때의 연속 일수와 지급 수 (보너스 포함) */
export function attendanceReward(streak: number, cfg: Pick<VoteConfig, 'attendanceTickets' | 'attendanceStreakBonus'>): { tickets: number; bonus: number } {
  let bonus = 0;
  for (const b of cfg.attendanceStreakBonus) if (b.days > 0 && streak % b.days === 0) bonus += b.bonus;
  return { tickets: cfg.attendanceTickets + bonus, bonus };
}

export async function getAttendanceState(userId: string | null, now: Date = new Date()) {
  const cfg = await getVoteConfig();
  const today = kstDateKey(now);
  if (!userId) return { enabled: cfg.enabled && cfg.attendanceEnabled, checkedToday: false, streak: 0, totalDays: 0, todayTickets: cfg.attendanceTickets, week: [] as Array<{ dayKey: string; checked: boolean }> };
  const recent = await prisma.voteAttendance.findMany({ where: { userId }, orderBy: { dayKey: 'desc' }, take: 40, select: { dayKey: true, streak: true } });
  const totalDays = await prisma.voteAttendance.count({ where: { userId } });
  const checkedToday = recent[0]?.dayKey === today;
  const yesterday = prevDayKey(today);
  const streak = checkedToday ? recent[0].streak : recent[0]?.dayKey === yesterday ? recent[0].streak : 0;
  const nextStreak = checkedToday ? streak : streak + 1;
  const set = new Set(recent.map((r) => r.dayKey));
  const week: Array<{ dayKey: string; checked: boolean }> = [];
  let k = today;
  for (let i = 0; i < 7; i++) {
    week.unshift({ dayKey: k, checked: set.has(k) });
    k = prevDayKey(k);
  }
  return { enabled: cfg.enabled && cfg.attendanceEnabled, checkedToday, streak, totalDays, todayTickets: attendanceReward(nextStreak, cfg).tickets, week };
}

export async function checkAttendance(userId: string, now: Date = new Date()): Promise<FanResult & { streak?: number }> {
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.attendanceEnabled) return { ok: false, message: '지금은 출석 체크를 하지 않아요.' };
  if (!(await activeUser(userId))) return { ok: false, message: '출석할 수 없는 계정입니다.' };
  const today = kstDateKey(now);
  const prev = await prisma.voteAttendance.findUnique({ where: { userId_dayKey: { userId, dayKey: prevDayKey(today) } }, select: { streak: true } });
  const streak = (prev?.streak ?? 0) + 1;
  const { tickets, bonus } = attendanceReward(streak, cfg);
  // (회원 · 날짜) 유니크 + ON CONFLICT DO NOTHING: 동시에 눌러도 한 줄만 생기고, 생긴 쪽만 지급한다
  const done = await prisma.$transaction(async (tx) => {
    const id = newId();
    const r = await tx.voteAttendance.createMany({ data: [{ id, userId, dayKey: today, streak, tickets, createdAt: now }], skipDuplicates: true });
    if (r.count === 0) return false;
    if (tickets > 0) {
      await grantTickets(tx, { userId, bucket: 'FREE', amount: tickets, source: 'ATTENDANCE', ledgerType: 'ATTENDANCE', refType: 'ATTENDANCE', refId: id, expiresInDays: cfg.freeExpiryDays, memo: `${today} 출석 (연속 ${streak}일)` }, now);
    }
    return true;
  });
  if (!done) return { ok: false, message: '오늘은 이미 출석했어요. 내일 또 만나요.' };
  await syncFanBadges(userId).catch(() => undefined);
  return { ok: true, streak, tickets, message: bonus > 0 ? `연속 ${streak}일 출석! 보너스 포함 팬투표권 ${tickets}개를 받았어요.` : `출석 완료! 팬투표권 ${tickets}개를 받았어요. (연속 ${streak}일)` };
}

// ---------------------------------------------------------------------- 일일 미션

export const MISSION_META: Record<MissionKey, { title: string; desc: string; href: string }> = {
  VOTE_1: { title: '오늘 첫 팬투표', desc: '아무 크리에이터에게나 1표 이상 팬투표하기', href: '/vote' },
  VOTE_10: { title: '오늘 10표 팬투표', desc: '오늘 모두 10표 이상 팬투표하기', href: '/vote' },
  CHEER: { title: '응원 한마디', desc: '크리에이터에게 응원 댓글 남기기', href: '/vote' },
  SHARE: { title: '팬투표 인증 공유', desc: '팬투표 인증 카드를 저장하거나 공유하기', href: '/vote' },
  AD: { title: '광고 보고 충전', desc: '무료 충전에서 광고·퀴즈 1번 참여하기', href: '/vote/charge?t=free' },
  FANCHAT: { title: '팬챗 답장', desc: '구독 중인 팬챗방에 메시지 1번 보내기', href: '/talk' },
};

export interface MissionView {
  key: MissionKey;
  title: string;
  desc: string;
  href: string;
  tickets: number;
  progress: number;
  goal: number;
  done: boolean;
  claimed: boolean;
}

async function missionProgress(userId: string, key: MissionKey, now: Date): Promise<{ progress: number; goal: number }> {
  const since = kstStartOfDay(now);
  switch (key) {
    case 'VOTE_1':
    case 'VOTE_10': {
      const goal = key === 'VOTE_1' ? 1 : 10;
      const r = await prisma.voteCast.aggregate({ where: { userId, voidedAt: null, createdAt: { gte: since } }, _sum: { votes: true } });
      return { progress: Math.min(goal, r._sum.votes ?? 0), goal };
    }
    case 'CHEER':
      return { progress: Math.min(1, await prisma.voteCheer.count({ where: { userId, createdAt: { gte: since } } })), goal: 1 };
    case 'SHARE':
      return { progress: Math.min(1, await prisma.voteShareLog.count({ where: { userId, createdAt: { gte: since } } })), goal: 1 };
    case 'AD':
      return { progress: Math.min(1, await prisma.offerwallReward.count({ where: { userId, status: 'GRANTED', createdAt: { gte: since } } })), goal: 1 };
    case 'FANCHAT':
      return { progress: Math.min(1, await prisma.talkMessage.count({ where: { fanUserId: userId, kind: 'FAN_REPLY', createdAt: { gte: since } } })), goal: 1 };
  }
}

export async function listMissions(userId: string | null, now: Date = new Date()): Promise<{ enabled: boolean; missions: MissionView[] }> {
  const cfg = await getVoteConfig();
  const enabled = cfg.enabled && cfg.missionsEnabled;
  const keys = MISSION_KEYS.filter((k) => (cfg.missionTickets[k] ?? 0) > 0);
  const today = kstDateKey(now);
  const claimed = userId ? new Set((await prisma.voteMissionClaim.findMany({ where: { userId, dayKey: today }, select: { missionKey: true } })).map((c) => c.missionKey)) : new Set<string>();
  const missions: MissionView[] = [];
  for (const key of keys) {
    const p = userId ? await missionProgress(userId, key, now) : { progress: 0, goal: key === 'VOTE_10' ? 10 : 1 };
    missions.push({ key, ...MISSION_META[key], tickets: cfg.missionTickets[key], progress: p.progress, goal: p.goal, done: p.progress >= p.goal, claimed: claimed.has(key) });
  }
  return { enabled, missions };
}

export async function claimMission(userId: string, key: string, now: Date = new Date()): Promise<FanResult> {
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.missionsEnabled) return { ok: false, message: '지금은 미션을 하지 않아요.' };
  if (!(MISSION_KEYS as readonly string[]).includes(key)) return { ok: false, message: '없는 미션입니다.' };
  const k = key as MissionKey;
  const tickets = cfg.missionTickets[k] ?? 0;
  if (tickets <= 0) return { ok: false, message: '지금은 쉬는 미션이에요.' };
  if (!(await activeUser(userId))) return { ok: false, message: '보상을 받을 수 없는 계정입니다.' };
  const p = await missionProgress(userId, k, now);
  if (p.progress < p.goal) return { ok: false, message: `아직 미션을 마치지 않았어요. (${p.progress}/${p.goal})` };
  const today = kstDateKey(now);
  const done = await prisma.$transaction(async (tx) => {
    const id = newId();
    const r = await tx.voteMissionClaim.createMany({ data: [{ id, userId, missionKey: k, dayKey: today, tickets, createdAt: now }], skipDuplicates: true });
    if (r.count === 0) return false;
    await grantTickets(tx, { userId, bucket: 'FREE', amount: tickets, source: 'MISSION', ledgerType: 'MISSION', refType: 'MISSION', refId: id, expiresInDays: cfg.freeExpiryDays, memo: `${today} ${MISSION_META[k].title}` }, now);
    return true;
  });
  if (!done) return { ok: false, message: '오늘은 이미 보상을 받았어요.' };
  return { ok: true, tickets, message: `미션 완료! 팬투표권 ${tickets}개를 받았어요.` };
}

/** 공유 기록 (SHARE 미션 · 하루 20번까지만 남긴다) */
export async function logShare(userId: string, creatorId: string | null, channel: string, now: Date = new Date()): Promise<void> {
  const today = await prisma.voteShareLog.count({ where: { userId, createdAt: { gte: kstStartOfDay(now) } } });
  if (today >= 20) return;
  await prisma.voteShareLog.create({ data: { id: newId(), userId, creatorId: creatorId || null, channel: channel.slice(0, 20) || 'unknown', createdAt: now } });
}

// ---------------------------------------------------------------------- 친구 초대

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 7): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export async function getOrCreateFanProfile(userId: string) {
  const existing = await prisma.fanProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  // 회원 · 코드 유니크. 겹치면(동시 생성 · 코드 충돌) 건너뛰고 다시 읽는다 — 코드 충돌이면 새 코드로 다시 시도
  for (let i = 0; i < 5; i++) {
    await prisma.fanProfile.createMany({ data: [{ id: newId(), userId, referralCode: randomCode() }], skipDuplicates: true });
    const row = await prisma.fanProfile.findUnique({ where: { userId } });
    if (row) return row;
  }
  throw new Error('초대 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

export async function getReferralState(userId: string, now: Date = new Date()) {
  const cfg = await getVoteConfig();
  const [profile, me, invited, rewarded] = await Promise.all([
    getOrCreateFanProfile(userId),
    prisma.voteReferral.findUnique({ where: { inviteeId: userId } }),
    prisma.voteReferral.count({ where: { inviterId: userId } }),
    prisma.voteReferral.count({ where: { inviterId: userId, status: 'REWARDED' } }),
  ]);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, phoneHash: true } });
  const canEnter = !me && Boolean(user) && now.getTime() - (user?.createdAt.getTime() ?? 0) <= cfg.referralCodeDays * DAY_MS;
  return {
    enabled: cfg.enabled && cfg.referralEnabled,
    code: profile.referralCode,
    invited,
    rewarded,
    canEnter,
    enteredCode: Boolean(me),
    inviterTickets: cfg.referralInviterTickets,
    inviteeTickets: cfg.referralInviteeTickets,
    codeDays: cfg.referralCodeDays,
    /** (7차 P2-4) 휴대폰을 연결해야 코드를 입력할 수 있다 */
    needPhone: cfg.referralRequirePhone && !user?.phoneHash,
  };
}

/** 초대받은 회원이 코드를 입력한다 (가입 후 N일 안 · 1번만). 초대받은 회원에게 바로 지급 */
export async function redeemReferralCode(userId: string, code: string, now: Date = new Date()): Promise<FanResult> {
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.referralEnabled) return { ok: false, message: '지금은 친구 초대 이벤트를 하지 않아요.' };
  const u = await activeUser(userId);
  if (!u) return { ok: false, message: '코드를 입력할 수 없는 계정입니다.' };
  if (now.getTime() - u.createdAt.getTime() > cfg.referralCodeDays * DAY_MS) return { ok: false, message: `초대 코드는 가입 후 ${cfg.referralCodeDays}일 안에만 입력할 수 있어요.` };
  // (7차 P2-4) 다계정으로 초대 보상을 모으지 못하게 휴대폰을 연결한 회원만 (휴대폰 번호는 회원 1명에게만 연결된다)
  if (cfg.referralRequirePhone && !u.phoneHash) return { ok: false, message: '휴대폰 번호를 연결한 회원만 초대 코드를 입력할 수 있어요. 마이페이지 > 내 정보에서 연결해 주세요.' };
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length < 5) return { ok: false, message: '초대 코드를 확인해 주세요.' };
  const inviter = await prisma.fanProfile.findUnique({ where: { referralCode: clean } });
  if (!inviter) return { ok: false, message: '없는 초대 코드예요.' };
  if (inviter.userId === userId) return { ok: false, message: '내 초대 코드는 입력할 수 없어요.' };
  const inviterUser = await activeUser(inviter.userId);
  if (!inviterUser) return { ok: false, message: '사용할 수 없는 초대 코드예요.' };
  // 서로 초대(맞초대)로 보상만 받는 것을 막는다
  const reverse = await prisma.voteReferral.findUnique({ where: { inviteeId: inviter.userId }, select: { inviterId: true } });
  if (reverse?.inviterId === userId) return { ok: false, message: '나를 초대한 친구의 코드는 다시 입력할 수 없어요.' };
  const done = await prisma.$transaction(async (tx) => {
    const id = newId();
    const r = await tx.voteReferral.createMany({ data: [{ id, inviterId: inviter.userId, inviteeId: userId, createdAt: now }], skipDuplicates: true });
    if (r.count === 0) return false;
    if (cfg.referralInviteeTickets > 0) {
      await grantTickets(tx, { userId, bucket: 'FREE', amount: cfg.referralInviteeTickets, source: 'REFERRAL', ledgerType: 'REFERRAL', refType: 'REFERRAL', refId: id, expiresInDays: cfg.freeExpiryDays, memo: '친구 초대 코드 입력' }, now);
    }
    return true;
  });
  if (!done) return { ok: false, message: '초대 코드는 한 번만 입력할 수 있어요.' };
  return { ok: true, tickets: cfg.referralInviteeTickets, message: `초대 코드를 등록했어요. 팬투표권 ${cfg.referralInviteeTickets}개를 받았어요. 첫 팬투표를 하면 친구도 선물을 받아요.` };
}

/** 첫 팬투표를 한 회원을 초대한 사람에게 보상 (castVote 성공 뒤 부른다). 선점(PENDING→REWARDED) 후 지급 */
export async function rewardInviterOnFirstVote(inviteeId: string, now: Date = new Date()): Promise<boolean> {
  const ref = await prisma.voteReferral.findUnique({ where: { inviteeId } });
  if (!ref || ref.status !== 'PENDING') return false;
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.referralEnabled) return false;
  if (!(await activeUser(ref.inviterId))) return false;
  // (7차 P2-4) 휴대폰 조건을 켠 뒤에는 휴대폰을 연결한 친구의 첫 팬투표만 보상한다 (켜기 전에 입력한 코드 포함)
  if (cfg.referralRequirePhone && !(await activeUser(inviteeId))?.phoneHash) return false;
  if (cfg.referralMaxPerInviter > 0) {
    const done = await prisma.voteReferral.count({ where: { inviterId: ref.inviterId, status: 'REWARDED' } });
    if (done >= cfg.referralMaxPerInviter) {
      await prisma.voteReferral.updateMany({ where: { id: ref.id, status: 'PENDING' }, data: { status: 'REWARDED', rewardedAt: now } });
      return false;
    }
  }
  return prisma.$transaction(async (tx) => {
    const moved = await tx.voteReferral.updateMany({ where: { id: ref.id, status: 'PENDING' }, data: { status: 'REWARDED', rewardedAt: now } });
    if (moved.count === 0) return false;
    if (cfg.referralInviterTickets > 0) {
      await grantTickets(tx, { userId: ref.inviterId, bucket: 'FREE', amount: cfg.referralInviterTickets, source: 'REFERRAL', ledgerType: 'REFERRAL', refType: 'REFERRAL', refId: ref.id, expiresInDays: cfg.freeExpiryDays, memo: '초대한 친구의 첫 팬투표' }, now);
    }
    return true;
  });
}

// ---------------------------------------------------------------------- 레벨 · 배지

export const FAN_LEVELS: Array<{ level: number; name: string; xp: number }> = [
  { level: 1, name: '새싹 팬', xp: 0 },
  { level: 2, name: '응원 팬', xp: 100 },
  { level: 3, name: '열정 팬', xp: 300 },
  { level: 4, name: '단골 팬', xp: 700 },
  { level: 5, name: '찐팬', xp: 1_500 },
  { level: 6, name: '골드 팬', xp: 3_000 },
  { level: 7, name: '플래티넘 팬', xp: 6_000 },
  { level: 8, name: '다이아 팬', xp: 12_000 },
  { level: 9, name: '마스터 팬', xp: 25_000 },
  { level: 10, name: '레전드 팬', xp: 50_000 },
];

export function levelOf(xp: number) {
  let cur = FAN_LEVELS[0];
  for (const l of FAN_LEVELS) if (xp >= l.xp) cur = l;
  const next = FAN_LEVELS.find((l) => l.xp > xp) ?? null;
  const span = next ? next.xp - cur.xp : 1;
  return { ...cur, xpTotal: xp, next, progress: next ? Math.min(1, (xp - cur.xp) / span) : 1 };
}

export interface FanStats {
  votes: number;
  attendanceDays: number;
  maxStreak: number;
  missions: number;
  cheers: number;
  supportTickets: number;
  supportCount: number;
  invited: number;
  fanchatMaxDays: number;
}

export async function getFanStats(userId: string): Promise<FanStats> {
  const [votes, att, maxStreak, missions, cheers, support, supportCount, invited, subs] = await Promise.all([
    prisma.voteCast.aggregate({ where: { userId, voidedAt: null }, _sum: { votes: true } }),
    prisma.voteAttendance.count({ where: { userId } }),
    prisma.voteAttendance.aggregate({ where: { userId }, _max: { streak: true } }),
    prisma.voteMissionClaim.count({ where: { userId } }),
    prisma.voteCheer.count({ where: { userId, deletedAt: null } }),
    prisma.voteSupportContribution.aggregate({ where: { userId, refundedAt: null }, _sum: { tickets: true } }),
    prisma.voteSupportContribution.findMany({ where: { userId, refundedAt: null }, distinct: ['supportId'], select: { supportId: true } }),
    prisma.voteReferral.count({ where: { inviterId: userId, status: 'REWARDED' } }),
    prisma.talkSubscription.findMany({ where: { userId, status: 'ACTIVE' }, select: { creatorId: true, startsAt: true, endsAt: true } }),
  ]);
  const now = Date.now();
  const byCreator = new Map<string, number>();
  for (const s of subs) {
    const end = Math.min(s.endsAt.getTime(), now);
    if (end > s.startsAt.getTime()) byCreator.set(s.creatorId, (byCreator.get(s.creatorId) ?? 0) + (end - s.startsAt.getTime()));
  }
  const fanchatMaxDays = byCreator.size ? Math.floor(Math.max(...byCreator.values()) / DAY_MS) + 1 : 0;
  return {
    votes: votes._sum.votes ?? 0,
    attendanceDays: att,
    maxStreak: maxStreak._max.streak ?? 0,
    missions,
    cheers,
    supportTickets: support._sum.tickets ?? 0,
    supportCount: supportCount.length,
    invited,
    fanchatMaxDays,
  };
}

/** 경험치: 팬투표 1표 = 1 · 출석 1일 = 10 · 미션 1개 = 5 · 응원 1개 = 3 · 서포트 팬투표권 1개 = 1 · 초대 1명 = 50 */
export function xpOf(s: FanStats): number {
  return s.votes + s.attendanceDays * 10 + s.missions * 5 + s.cheers * 3 + s.supportTickets + s.invited * 50;
}

export const BADGES: Array<{ key: string; title: string; desc: string; test: (s: FanStats) => boolean }> = [
  { key: 'FIRST_VOTE', title: '첫 팬투표', desc: '처음으로 팬투표했어요', test: (s) => s.votes >= 1 },
  { key: 'VOTES_100', title: '100표 돌파', desc: '누적 100표 팬투표', test: (s) => s.votes >= 100 },
  { key: 'VOTES_1000', title: '1,000표 돌파', desc: '누적 1,000표 팬투표', test: (s) => s.votes >= 1_000 },
  { key: 'VOTES_10000', title: '10,000표 돌파', desc: '누적 10,000표 팬투표', test: (s) => s.votes >= 10_000 },
  { key: 'STREAK_7', title: '일주일 개근', desc: '7일 연속 출석', test: (s) => s.maxStreak >= 7 },
  { key: 'STREAK_30', title: '한 달 개근', desc: '30일 연속 출석', test: (s) => s.maxStreak >= 30 },
  { key: 'ATTEND_100', title: '출석 100일', desc: '누적 100일 출석', test: (s) => s.attendanceDays >= 100 },
  { key: 'CHEER_FIRST', title: '첫 응원', desc: '처음으로 응원 댓글을 남겼어요', test: (s) => s.cheers >= 1 },
  { key: 'SUPPORTER', title: '서포터', desc: '서포트에 참여했어요', test: (s) => s.supportCount >= 1 },
  { key: 'INVITER', title: '인싸 팬', desc: '친구를 초대했어요', test: (s) => s.invited >= 1 },
  { key: 'FANCHAT_100', title: '팬챗 D+100', desc: '한 팬챗방을 100일 넘게 구독', test: (s) => s.fanchatMaxDays >= 100 },
  { key: 'FANCHAT_365', title: '팬챗 D+365', desc: '한 팬챗방을 1년 넘게 구독', test: (s) => s.fanchatMaxDays >= 365 },
];

/** 조건을 채운 배지를 지급한다 (이미 있는 배지는 건너뛴다). 새로 받은 배지 키를 돌려준다 */
export async function syncFanBadges(userId: string, stats?: FanStats): Promise<string[]> {
  const s = stats ?? (await getFanStats(userId));
  const have = new Set((await prisma.fanBadge.findMany({ where: { userId }, select: { badgeKey: true } })).map((b) => b.badgeKey));
  const fresh = BADGES.filter((b) => !have.has(b.key) && b.test(s)).map((b) => b.key);
  if (fresh.length > 0) {
    await prisma.fanBadge.createMany({ data: fresh.map((badgeKey) => ({ id: newId(), userId, badgeKey })), skipDuplicates: true });
  }
  return fresh;
}

export async function getFanCard(userId: string) {
  const stats = await getFanStats(userId);
  await syncFanBadges(userId, stats).catch(() => undefined);
  const [badges, profile] = await Promise.all([
    prisma.fanBadge.findMany({ where: { userId }, orderBy: { earnedAt: 'asc' } }),
    prisma.fanProfile.findUnique({ where: { userId }, select: { featuredBadge: true } }),
  ]);
  const owned = new Map(badges.map((b) => [b.badgeKey, b.earnedAt]));
  return {
    stats,
    level: levelOf(xpOf(stats)),
    featuredBadge: profile?.featuredBadge ?? null,
    badges: BADGES.map((b) => ({ key: b.key, title: b.title, desc: b.desc, earnedAt: owned.get(b.key) ?? null })),
  };
}

export async function setFeaturedBadge(userId: string, badgeKey: string | null): Promise<FanResult> {
  if (badgeKey) {
    const has = await prisma.fanBadge.findUnique({ where: { userId_badgeKey: { userId, badgeKey } }, select: { id: true } });
    if (!has) return { ok: false, message: '받은 배지만 대표로 정할 수 있어요.' };
  }
  await getOrCreateFanProfile(userId);
  await prisma.fanProfile.update({ where: { userId }, data: { featuredBadge: badgeKey } });
  return { ok: true, message: badgeKey ? '대표 배지를 바꿨어요.' : '대표 배지를 내렸어요.' };
}

/**
 * 여러 회원의 레벨을 한 번에 (팬 랭킹 화면용 · 경험치 그대로).
 * (7차 P2-3) 예전에는 회원마다 getFanStats(조회 9번)를 불러 상위 30명이면 약 270번 조회했다.
 * 이제 항목별로 묶어서 한 번씩(9번) 조회한다. 계산식은 getFanStats · xpOf 와 같다.
 */
export async function getFanStatsMany(userIds: string[]): Promise<Map<string, FanStats>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, FanStats>();
  if (ids.length === 0) return out;
  const where = { userId: { in: ids } };
  const [votes, att, streak, missions, cheers, support, supportRows, invited, subs] = await Promise.all([
    prisma.voteCast.groupBy({ by: ['userId'], where: { ...where, voidedAt: null }, _sum: { votes: true } }),
    prisma.voteAttendance.groupBy({ by: ['userId'], where, _count: { _all: true } }),
    prisma.voteAttendance.groupBy({ by: ['userId'], where, _max: { streak: true } }),
    prisma.voteMissionClaim.groupBy({ by: ['userId'], where, _count: { _all: true } }),
    prisma.voteCheer.groupBy({ by: ['userId'], where: { ...where, deletedAt: null }, _count: { _all: true } }),
    prisma.voteSupportContribution.groupBy({ by: ['userId'], where: { ...where, refundedAt: null }, _sum: { tickets: true } }),
    prisma.voteSupportContribution.findMany({ where: { ...where, refundedAt: null }, distinct: ['userId', 'supportId'], select: { userId: true, supportId: true } }),
    prisma.voteReferral.groupBy({ by: ['inviterId'], where: { inviterId: { in: ids }, status: 'REWARDED' }, _count: { _all: true } }),
    prisma.talkSubscription.findMany({ where: { ...where, status: 'ACTIVE' }, select: { userId: true, creatorId: true, startsAt: true, endsAt: true } }),
  ]);
  const now = Date.now();
  const fanchat = new Map<string, Map<string, number>>();
  for (const s of subs) {
    const end = Math.min(s.endsAt.getTime(), now);
    if (end <= s.startsAt.getTime()) continue;
    const m = fanchat.get(s.userId) ?? new Map<string, number>();
    m.set(s.creatorId, (m.get(s.creatorId) ?? 0) + (end - s.startsAt.getTime()));
    fanchat.set(s.userId, m);
  }
  const supportCount = new Map<string, number>();
  for (const r of supportRows) supportCount.set(r.userId, (supportCount.get(r.userId) ?? 0) + 1);
  for (const id of ids) {
    const fc = fanchat.get(id);
    out.set(id, {
      votes: votes.find((x) => x.userId === id)?._sum.votes ?? 0,
      attendanceDays: att.find((x) => x.userId === id)?._count._all ?? 0,
      maxStreak: streak.find((x) => x.userId === id)?._max.streak ?? 0,
      missions: missions.find((x) => x.userId === id)?._count._all ?? 0,
      cheers: cheers.find((x) => x.userId === id)?._count._all ?? 0,
      supportTickets: support.find((x) => x.userId === id)?._sum.tickets ?? 0,
      supportCount: supportCount.get(id) ?? 0,
      invited: invited.find((x) => x.inviterId === id)?._count._all ?? 0,
      fanchatMaxDays: fc && fc.size ? Math.floor(Math.max(...fc.values()) / DAY_MS) + 1 : 0,
    });
  }
  return out;
}

async function levelsOf(userIds: string[]): Promise<Map<string, number>> {
  const stats = await getFanStatsMany(userIds);
  const out = new Map<string, number>();
  for (const [id, s] of stats) out.set(id, levelOf(xpOf(s)).level);
  return out;
}

// ---------------------------------------------------------------------- 팬 랭킹

/** 팬 랭킹: 기간 안에 가장 많이 팬투표한 회원 (크리에이터를 주면 그 크리에이터에게 준 표) */
export async function getFanRanking(opts: { creatorId?: string | null; since?: Date | null; limit?: number } = {}) {
  const grouped = await prisma.voteCast.groupBy({
    by: ['userId'],
    where: { voidedAt: null, ...(opts.creatorId ? { creatorId: opts.creatorId } : {}), ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    _sum: { votes: true },
    orderBy: { _sum: { votes: 'desc' } },
    take: Math.min(opts.limit ?? 30, 100),
  });
  const ids = grouped.map((g) => g.userId);
  const [users, donors, profiles, levels] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatarIndex: true } }),
    prisma.donorProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, displayName: true } }),
    prisma.fanProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, featuredBadge: true } }),
    levelsOf(ids.slice(0, 30)),
  ]);
  return grouped.map((g, i) => {
    const u = users.find((x) => x.id === g.userId);
    const name = donors.find((d) => d.userId === g.userId)?.displayName ?? u?.name ?? null;
    const badgeKey = profiles.find((p) => p.userId === g.userId)?.featuredBadge ?? null;
    return {
      rank: i + 1,
      userId: g.userId,
      name: maskNick(name),
      avatarIndex: u?.avatarIndex ?? 0,
      votes: g._sum.votes ?? 0,
      level: levels.get(g.userId) ?? null,
      badge: badgeKey ? BADGES.find((b) => b.key === badgeKey)?.title ?? null : null,
    };
  });
}

// ---------------------------------------------------------------------- 응원 댓글

export async function postCheer(userId: string, input: { creatorId: string; body: string; roundId?: string | null }, now: Date = new Date()): Promise<FanResult> {
  const cfg = await getVoteConfig();
  if (!cfg.enabled || !cfg.cheerEnabled) return { ok: false, message: '지금은 응원 댓글을 받지 않아요.' };
  const u = await activeUser(userId);
  if (!u) return { ok: false, message: '댓글을 남길 수 없는 계정입니다.' };
  const creator = await prisma.creatorProfile.findUnique({ where: { id: input.creatorId }, select: { id: true, status: true } });
  if (!creator || creator.status !== 'APPROVED') return { ok: false, message: '응원할 수 없는 크리에이터입니다.' };
  if (input.roundId) {
    const cand = await prisma.voteRoundCandidate.findUnique({ where: { roundId_creatorId: { roundId: input.roundId, creatorId: creator.id } }, select: { id: true } });
    if (!cand) return { ok: false, message: '이 이벤트의 후보가 아니에요.' };
  }
  const today = await prisma.voteCheer.count({ where: { userId, createdAt: { gte: kstStartOfDay(now) } } });
  if (today >= cfg.cheerDailyLimit) return { ok: false, message: `응원 댓글은 하루 ${cfg.cheerDailyLimit}개까지 남길 수 있어요.` };
  const raw = input.body.replace(/\s+/g, ' ').trim();
  if (raw.length < 2) return { ok: false, message: '응원 한마디를 2자 이상 써 주세요.' };
  if (raw.length > cfg.cheerMaxLength) return { ok: false, message: `응원 댓글은 ${cfg.cheerMaxLength}자까지 쓸 수 있어요.` };
  const banned = await loadBannedWords(creator.id);
  const f = filterContent(raw, { bannedWords: banned, maxLength: cfg.cheerMaxLength });
  if (f.action === 'BLOCK') return { ok: false, message: '쓸 수 없는 표현이 있어요. 고쳐서 다시 남겨 주세요.' };
  const body = maskContacts(f.clean || raw).text;
  await prisma.voteCheer.create({ data: { id: newId(), creatorId: creator.id, userId, roundId: input.roundId ?? null, body, createdAt: now } });
  await syncFanBadges(userId).catch(() => undefined);
  return { ok: true, message: '응원을 남겼어요.' };
}

export async function listCheers(opts: { creatorId?: string | null; roundId?: string | null; limit?: number; viewerId?: string | null }) {
  const rows = await prisma.voteCheer.findMany({
    where: { deletedAt: null, ...(opts.creatorId ? { creatorId: opts.creatorId } : {}), ...(opts.roundId ? { roundId: opts.roundId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 20, 100),
  });
  const ids = [...new Set(rows.map((r) => r.userId))];
  const cids = [...new Set(rows.map((r) => r.creatorId))];
  const [users, donors, creators] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatarIndex: true } }),
    prisma.donorProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, displayName: true } }),
    prisma.creatorProfile.findMany({ where: { id: { in: cids } }, select: { id: true, displayName: true, code: true } }),
  ]);
  return rows.map((r) => {
    const u = users.find((x) => x.id === r.userId);
    const name = donors.find((d) => d.userId === r.userId)?.displayName ?? u?.name ?? null;
    const c = creators.find((x) => x.id === r.creatorId);
    return { id: r.id, body: r.body, createdAt: r.createdAt, name: maskNick(name), avatarIndex: u?.avatarIndex ?? 0, mine: opts.viewerId === r.userId, creatorName: c?.displayName ?? '', creatorCode: c?.code ?? '' };
  });
}

export async function deleteCheer(cheerId: string, by: { type: 'USER'; userId: string } | { type: 'CREATOR'; creatorId: string } | { type: 'ADMIN'; userId: string }): Promise<FanResult> {
  const c = await prisma.voteCheer.findUnique({ where: { id: cheerId } });
  if (!c || c.deletedAt) return { ok: false, message: '댓글을 찾을 수 없습니다.' };
  if (by.type === 'USER' && c.userId !== by.userId) return { ok: false, message: '내가 쓴 댓글만 지울 수 있어요.' };
  if (by.type === 'CREATOR' && c.creatorId !== by.creatorId) return { ok: false, message: '나에게 온 댓글만 지울 수 있어요.' };
  await prisma.voteCheer.update({ where: { id: c.id }, data: { deletedAt: new Date(), deletedBy: `${by.type}:${by.type === 'CREATOR' ? by.creatorId : by.userId}` } });
  return { ok: true, message: '댓글을 지웠어요.' };
}
