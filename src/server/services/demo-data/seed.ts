/**
 * 테스트용 더미 데이터 넣기 · 정리 (2026-11-17) — 배포 전 정리 대상.
 *
 * - 모든 더미 행의 ID 는 demo- 로 시작한다. 정리는 이 접두사로만 찾는다(실제 데이터는 건드리지 않는다).
 * - 여러 번 실행해도 같은 결과가 되도록 전부 upsert 한다.
 * - 서버(DEMO_DATA=true 첫 접속)와 스크립트(scripts/demo-data.ts)가 함께 쓴다.
 *   그래서 prisma 클라이언트를 인자로 받고, env·db 모듈을 import 하지 않는다.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import {
  DEMO_CREATORS,
  DEMO_ID_PREFIX,
  DEMO_PRODUCTS,
  demoCreatorCode,
  demoCreatorId,
  demoProductId,
} from './catalog';
import { periodKey } from '../../../lib/vote-period';
import { DEFAULT_TICKET_PRODUCTS } from '../vote/purchase';

const pad = (n: number) => String(n).padStart(2, '0');
const userId = (n: number) => `${DEMO_ID_PREFIX}user-${pad(n)}`;

/** 크리에이터 n 의 샵에 진열할 상품 번호 (30개 중 10개씩 겹치게 돌려 가며) */
export function demoDisplayProducts(creatorN: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 10; k++) out.push((((creatorN - 1) * 5 + k) % DEMO_PRODUCTS.length) + 1);
  return out;
}

export async function seedDemoData(db: PrismaClient): Promise<{ creators: number; products: number }> {
  const now = new Date();

  for (const c of DEMO_CREATORS) {
    const id = demoCreatorId(c.n);
    const code = demoCreatorCode(c.n);
    await db.user.upsert({
      where: { id: userId(c.n) },
      create: {
        id: userId(c.n),
        email: `demo-creator-${pad(c.n)}@demo.donaido.invalid`,
        role: 'CREATOR',
        name: c.name,
        avatarIndex: c.avatarIndex,
      },
      update: { name: c.name, avatarIndex: c.avatarIndex, role: 'CREATOR', status: 'ACTIVE' },
    });
    const live = c.liveViewers != null;
    const profile = {
      displayName: c.name,
      channelName: `${c.name} 채널`,
      description: c.description,
      contentCategory: c.category,
      status: 'APPROVED' as const,
      approvedAt: now,
      liveOn: live,
      livePlatform: live ? (c.livePlatform ?? 'YOUTUBE') : null,
      youtubeLive: live && (c.livePlatform ?? 'YOUTUBE') === 'YOUTUBE',
      instagramLive: live && c.livePlatform === 'INSTAGRAM',
      tiktokLive: live && c.livePlatform === 'TIKTOK',
      shopDefaultTab: 'SHOP',
    };
    await db.creatorProfile.upsert({
      where: { id },
      create: { id, userId: userId(c.n), code, ...profile },
      update: profile,
    });
    await db.creatorCode.upsert({
      where: { id: `${DEMO_ID_PREFIX}code-${pad(c.n)}` },
      create: { id: `${DEMO_ID_PREFIX}code-${pad(c.n)}`, creatorId: id, code, active: true },
      update: { active: true },
    });
  }

  for (const p of DEMO_PRODUCTS) {
    const id = demoProductId(p.n);
    const data = {
      ownerType: 'ADMIN',
      name: p.name,
      category: p.category,
      summary: p.summary,
      description: `${p.summary}\n\n테스트용 샘플 상품입니다. 실제로 판매·배송되지 않습니다.`,
      thumbnailUrl: p.image,
      price: BigInt(p.price),
      listPrice: p.listPrice ? BigInt(p.listPrice) : null,
      shippingFee: BigInt(3000),
      freeShippingOver: BigInt(30000),
      referralRate: '0.100000',
      status: 'ON_SALE',
      reviewStatus: 'APPROVED',
      soldCount: p.soldCount,
      notice: [
        { label: '제조국', value: '대한민국' },
        { label: '안내', value: '테스트용 샘플 상품' },
      ],
      deletedAt: null,
    };
    await db.product.upsert({ where: { id }, create: { id, ...data }, update: data });
    for (let i = 0; i < p.variants.length; i++) {
      const vid = `${DEMO_ID_PREFIX}variant-${pad(p.n)}-${i + 1}`;
      await db.productVariant.upsert({
        where: { id: vid },
        create: { id: vid, productId: id, name: p.variants[i], stock: 999, sortOrder: i },
        update: { name: p.variants[i], active: true, sortOrder: i },
      });
    }
    const imgId = `${DEMO_ID_PREFIX}image-${pad(p.n)}-1`;
    await db.productImage.upsert({
      where: { id: imgId },
      create: { id: imgId, productId: id, url: p.image, sortOrder: 0 },
      update: { url: p.image },
    });
  }

  for (const c of DEMO_CREATORS) {
    const list = demoDisplayProducts(c.n);
    for (let i = 0; i < list.length; i++) {
      const pid = demoProductId(list[i]);
      const did = `${DEMO_ID_PREFIX}display-${pad(c.n)}-${pad(list[i])}`;
      await db.creatorProduct.upsert({
        where: { id: did },
        create: { id: did, creatorId: demoCreatorId(c.n), productId: pid, sortOrder: i },
        update: { active: true, blocked: false, sortOrder: i },
      });
    }
  }

  await seedDemoEngagement(db, now);

  return { creators: DEMO_CREATORS.length, products: DEMO_PRODUCTS.length };
}

/**
 * 팬투표 랭킹 · 팬챗방 더미 (2026-11-17). 표 수는 크리에이터마다 고정 비율로 만들어 새로 고쳐도 순위가 흔들리지 않는다.
 * 지난 일·주·월 집계도 넣어 두면 화면을 열 때 확정 순위(일간 탭 · 명예의 전당)가 만들어진다.
 */
async function seedDemoEngagement(db: PrismaClient, now: Date) {
  // 지금 진행 중인 기간 + 지난 기간(일 7 · 주 4 · 월 6). 지난 기간은 확정 순위(vote_period_result)까지 넣어
  // 일간 탭 · 순위 변동(▲▼) · 명예의 전당 · 크리에이터 순위 기록이 모두 채워지게 한다.
  const DAY = 86_400_000;
  const specs: Array<{ type: 'DAY' | 'WEEK' | 'MONTH' | 'ALL'; key: string; mul: number; past: boolean }> = [];
  for (let i = 0; i <= 7; i++) specs.push({ type: 'DAY', key: periodKey('DAY', new Date(now.getTime() - i * DAY)), mul: i === 0 ? 1 : 1.1 + (i % 3) * 0.12, past: i > 0 });
  for (let i = 0; i <= 4; i++) specs.push({ type: 'WEEK', key: periodKey('WEEK', new Date(now.getTime() - i * 7 * DAY)), mul: i === 0 ? 5.5 : 7 + (i % 2), past: i > 0 });
  let monthCursor = now;
  for (let i = 0; i <= 6; i++) {
    specs.push({ type: 'MONTH', key: periodKey('MONTH', monthCursor), mul: i === 0 ? 18 : 26 + (i % 3) * 3, past: i > 0 });
    monthCursor = new Date(new Date(`${periodKey('MONTH', monthCursor)}-01T00:00:00+09:00`).getTime() - DAY);
  }
  specs.push({ type: 'ALL', key: 'ALL', mul: 160, past: false });

  for (const sp of specs) {
    const rows = DEMO_CREATORS.map((c) => {
      const base = c.weeklyDonations * 3 + c.growth * 17 + c.n * 7;
      // 기간마다 순위가 조금씩 바뀌도록 크리에이터 번호와 기간 키로 흔든다
      const seed = [...sp.key].reduce((a, ch) => a + ch.charCodeAt(0), 0);
      const wobble = 1 + (((c.n * 37 + seed * 13) % 17) - 8) / 22;
      return { c, votes: BigInt(Math.max(3, Math.round(base * sp.mul * wobble))) };
    });
    for (const r of rows) {
      await db.voteTally.upsert({
        where: { periodType_periodKey_creatorId: { periodType: sp.type, periodKey: sp.key, creatorId: demoCreatorId(r.c.n) } },
        create: { id: `${DEMO_ID_PREFIX}tally-${sp.type}-${sp.key}-${pad(r.c.n)}`, periodType: sp.type, periodKey: sp.key, creatorId: demoCreatorId(r.c.n), votes: r.votes, lastVoteAt: new Date(now.getTime() - r.c.n * 60_000) },
        update: {},
      });
    }
    if (sp.past) {
      const ranked = [...rows].sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : a.c.n - b.c.n));
      for (let i = 0; i < ranked.length; i++) {
        const r = ranked[i];
        await db.votePeriodResult.upsert({
          where: { periodType_periodKey_creatorId: { periodType: sp.type, periodKey: sp.key, creatorId: demoCreatorId(r.c.n) } },
          create: { id: `${DEMO_ID_PREFIX}result-${sp.type}-${sp.key}-${pad(r.c.n)}`, periodType: sp.type, periodKey: sp.key, creatorId: demoCreatorId(r.c.n), rank: i + 1, votes: r.votes },
          update: {},
        });
      }
    }
  }

  // 단체 팬챗방에 보이는 더미 팬 (프로필 캐릭터 · 닉네임)
  const FANS = ['꿀벌단장', '민트초코', '별빛소녀', '야식요정', '캠핑러버', '댕댕맘', '고양이집사', '새벽감성', '노래방왕', '먹방매니아', '여행가자', '주식초보'];
  for (let i = 0; i < FANS.length; i++) {
    const id = `${DEMO_ID_PREFIX}fan-${pad(i + 1)}`;
    await db.user.upsert({
      where: { id },
      create: { id, email: `demo-fan-${pad(i + 1)}@demo.donaido.invalid`, role: 'DONOR', name: FANS[i], avatarIndex: (i * 7 + 5) % 50 },
      update: { name: FANS[i] },
    });
  }

  for (const c of DEMO_CREATORS) {
    const roomId = `${DEMO_ID_PREFIX}talk-room-${pad(c.n)}`;
    await db.talkRoom.upsert({
      where: { creatorId: demoCreatorId(c.n) },
      create: { id: roomId, creatorId: demoCreatorId(c.n), open: true, welcomeMessage: `${c.name} 팬챗방에 오신 걸 환영해요!`, sessionEnabled: c.n <= 4, sessionMinutes: 20 },
      update: {},
    });
    const msgId = `${DEMO_ID_PREFIX}talk-msg-${pad(c.n)}-1`;
    await db.talkMessage.upsert({
      where: { id: msgId },
      create: { id: msgId, creatorId: demoCreatorId(c.n), kind: 'BROADCAST', body: `{닉네임}님 안녕하세요! ${c.name}이에요. ${c.description}`, createdAt: new Date(now.getTime() - 3600_000), notifiedAt: now },
      update: {},
    });
    // 더미 팬 구독 + 단체방 대화 (팬 3명씩)
    for (let k = 0; k < 3; k++) {
      const fi = ((c.n - 1) * 3 + k) % FANS.length;
      const fanId = `${DEMO_ID_PREFIX}fan-${pad(fi + 1)}`;
      const subId = `${DEMO_ID_PREFIX}talk-sub-${pad(c.n)}-${k}`;
      await db.talkSubscription.upsert({
        where: { id: subId },
        create: { id: subId, userId: fanId, creatorId: demoCreatorId(c.n), startsAt: new Date(now.getTime() - 5 * DAY), endsAt: new Date(now.getTime() + 25 * DAY), price: 4900n, method: 'CARD' },
        update: {},
      });
      const replyId = `${DEMO_ID_PREFIX}talk-msg-${pad(c.n)}-r${k}`;
      const lines = ['오늘 방송 최고였어요!', '매일 기다리고 있어요', '다음 방송은 언제 해요?'];
      await db.talkMessage.upsert({
        where: { id: replyId },
        create: { id: replyId, creatorId: demoCreatorId(c.n), kind: 'FAN_REPLY', fanUserId: fanId, body: lines[k], replyToId: msgId, createdAt: new Date(now.getTime() - 3600_000 + (k + 1) * 600_000), notifiedAt: now },
        update: {},
      });
    }
    if (c.n <= 4) {
      for (const wd of [1, 3, 5, 6]) {
        const rid = `${DEMO_ID_PREFIX}slot-${pad(c.n)}-${wd}`;
        await db.talkSlotRule.upsert({ where: { id: rid }, create: { id: rid, creatorId: demoCreatorId(c.n), weekday: wd, startMinute: 20 * 60, endMinute: 23 * 60 }, update: {} });
      }
    }
  }
  // 팬투표권 상품 더미 — 관리자가 만든 상품이 하나도 없을 때만 넣는다(실제 상품과 섞이지 않게).
  const realProducts = await db.voteTicketProduct.count({ where: { NOT: { id: { startsWith: DEMO_ID_PREFIX } } } });
  if (realProducts === 0) {
    for (let i = 0; i < DEFAULT_TICKET_PRODUCTS.length; i++) {
      const p = DEFAULT_TICKET_PRODUCTS[i];
      const id = `${DEMO_ID_PREFIX}ticket-${pad(i + 1)}`;
      await db.voteTicketProduct.upsert({
        where: { id },
        create: { id, name: p.name, price: p.price, tickets: p.tickets, bonus: p.bonus, badge: p.badge, sortOrder: i, active: true },
        update: {},
      });
    }
  }

  const pastRoundId = `${DEMO_ID_PREFIX}round-champion-past`;
  if (!(await db.voteRound.findUnique({ where: { id: pastRoundId }, select: { id: true } }))) {
    const picks = DEMO_CREATORS.slice(2, 8);
    await db.voteRound.create({
      data: {
        id: pastRoundId,
        kind: 'CHAMPION',
        title: '지난 시즌 왕중왕전',
        description: '테스트용 더미 — 지난 시즌 결과',
        startsAt: new Date(now.getTime() - 40 * DAY),
        endsAt: new Date(now.getTime() - 33 * DAY),
        status: 'CLOSED',
        candidates: { create: picks.map((c, i) => ({ id: `${DEMO_ID_PREFIX}round-past-cand-${pad(c.n)}`, creatorId: demoCreatorId(c.n), sortOrder: i })) },
      },
    });
    for (let i = 0; i < picks.length; i++) {
      const c = picks[i];
      const votes = BigInt(9000 - i * 1100 + c.n * 3);
      await db.voteTally.create({ data: { id: `${DEMO_ID_PREFIX}tally-round-past-${pad(c.n)}`, periodType: 'ROUND', periodKey: pastRoundId, creatorId: demoCreatorId(c.n), votes, lastVoteAt: new Date(now.getTime() - 34 * DAY) } });
      await db.votePeriodResult.create({ data: { id: `${DEMO_ID_PREFIX}result-round-past-${pad(c.n)}`, periodType: 'ROUND', periodKey: pastRoundId, creatorId: demoCreatorId(c.n), rank: i + 1, votes } });
    }
  }

  const roundId = `${DEMO_ID_PREFIX}round-champion`;
  const exists = await db.voteRound.findUnique({ where: { id: roundId }, select: { id: true } });
  if (!exists) {
    const picks = DEMO_CREATORS.slice(0, 6);
    await db.voteRound.create({
      data: {
        id: roundId,
        kind: 'CHAMPION',
        title: '테스트 왕중왕전',
        description: '지난달 월간 상위 크리에이터끼리 겨루는 왕중왕전입니다. (테스트용 더미)',
        startsAt: new Date(now.getTime() - 86_400_000),
        endsAt: new Date(now.getTime() + 6 * 86_400_000),
        status: 'OPEN',
        candidates: { create: picks.map((c, i) => ({ id: `${DEMO_ID_PREFIX}round-cand-${pad(c.n)}`, creatorId: demoCreatorId(c.n), sortOrder: i })) },
      },
    });
    for (const c of picks) {
      await db.voteTally.create({ data: { id: `${DEMO_ID_PREFIX}tally-round-${pad(c.n)}`, periodType: 'ROUND', periodKey: roundId, creatorId: demoCreatorId(c.n), votes: BigInt(c.weeklyDonations * 2 + c.n * 13), lastVoteAt: now } });
    }
  }

  await seedFanvoteDemo(db, now, FANS.length);
}

/**
 * 팬투표 고도화 더미 (2026-11-18): 이벤트 팬투표 · 보상 정책/집행 · 서포트 · 기념일 · 응원 댓글 · 팬챗 크리에이터 메시지(답장 대상).
 * 정책은 관리자가 만든 것이 하나도 없을 때만 넣는다(실제 정책과 섞이지 않게).
 */
async function seedFanvoteDemo(db: PrismaClient, now: Date, fanCount: number) {
  const DAY = 86_400_000;
  const eventId = `${DEMO_ID_PREFIX}round-event`;
  if (!(await db.voteRound.findUnique({ where: { id: eventId }, select: { id: true } }))) {
    const picks = DEMO_CREATORS.slice(3, 11);
    await db.voteRound.create({
      data: {
        id: eventId,
        kind: 'EVENT',
        title: '2026 올해의 신인 크리에이터',
        description: '올해 가장 빛난 신인 크리에이터를 팬투표로 뽑아요. (테스트용 더미)',
        rewardText: '1위 신문 전면 광고 · 2~3위 메인 배너',
        dailyMaxVotes: 0,
        startsAt: new Date(now.getTime() - 2 * DAY),
        endsAt: new Date(now.getTime() + 12 * DAY),
        status: 'OPEN',
        candidates: { create: picks.map((c, i) => ({ id: `${DEMO_ID_PREFIX}round-event-cand-${pad(c.n)}`, creatorId: demoCreatorId(c.n), sortOrder: i })) },
      },
    });
    for (const c of picks) {
      await db.voteTally.create({ data: { id: `${DEMO_ID_PREFIX}tally-round-event-${pad(c.n)}`, periodType: 'ROUND', periodKey: eventId, creatorId: demoCreatorId(c.n), votes: BigInt(3000 - c.n * 170 + (c.n % 3) * 40), lastVoteAt: now } });
    }
  }

  const realPolicies = await db.voteRewardPolicy.count({ where: { NOT: { id: { startsWith: DEMO_ID_PREFIX } } } });
  if (realPolicies === 0) {
    const policies = [
      { id: `${DEMO_ID_PREFIX}policy-month-1`, scope: 'PERIOD', periodType: 'MONTH', rankFrom: 1, rankTo: 1, rewardType: 'NEWSPAPER', title: '일간지 전면 축하 광고', description: '월간 1위 확정 후 2주 안에 집행해요' },
      { id: `${DEMO_ID_PREFIX}policy-week-1`, scope: 'PERIOD', periodType: 'WEEK', rankFrom: 1, rankTo: 1, rewardType: 'BANNER', title: '도네이도 메인 배너 1주', description: '주간 1위는 다음 주 내내 메인 배너에 올라가요' },
      { id: `${DEMO_ID_PREFIX}policy-event-1`, scope: 'ROUND', periodType: null, rankFrom: 1, rankTo: 1, rewardType: 'BILLBOARD', title: '강남역 전광판 광고', description: '이벤트 1위에게 드려요' },
    ];
    for (const [i, p] of policies.entries()) {
      await db.voteRewardPolicy.upsert({ where: { id: p.id }, create: { ...p, sortOrder: i, active: true }, update: {} });
    }
  }
  // 지난 시즌 왕중왕전 · 지난달 1위 보상 집행 기록 (공개 화면 확인용)
  const pastWinner = DEMO_CREATORS[2];
  const grants = [
    { id: `${DEMO_ID_PREFIX}grant-past-champ`, creatorId: demoCreatorId(pastWinner.n), sourceType: 'ROUND', sourceKey: `${DEMO_ID_PREFIX}round-champion-past`, sourceLabel: '지난 시즌 왕중왕전', rank: 1, rewardType: 'BILLBOARD', title: '강남역 전광판 광고', status: 'PUBLISHED', mediaName: '강남역 대형 전광판', publishedAt: new Date(now.getTime() - 20 * DAY) },
    { id: `${DEMO_ID_PREFIX}grant-month`, creatorId: demoCreatorId(DEMO_CREATORS[0].n), sourceType: 'MANUAL', sourceKey: `${DEMO_ID_PREFIX}month`, sourceLabel: '지난달 월간 랭킹', rank: 1, rewardType: 'NEWSPAPER', title: '일간지 전면 축하 광고', status: 'SCHEDULED', mediaName: '○○일보', scheduledAt: new Date(now.getTime() + 5 * DAY) },
    { id: `${DEMO_ID_PREFIX}grant-week`, creatorId: demoCreatorId(DEMO_CREATORS[1].n), sourceType: 'MANUAL', sourceKey: `${DEMO_ID_PREFIX}week`, sourceLabel: '지난주 주간 랭킹', rank: 1, rewardType: 'BANNER', title: '도네이도 메인 배너 1주', status: 'PUBLISHED', mediaName: '도네이도 메인', publishedAt: new Date(now.getTime() - DAY) },
  ];
  for (const g of grants) {
    await db.voteRewardGrant.upsert({ where: { id: g.id }, create: { ...g, note: '테스트용 더미 기록' }, update: {} });
  }
  // 서포트 (진행 중 1 · 성공 1)
  const supports = [
    { id: `${DEMO_ID_PREFIX}support-open`, creatorId: demoCreatorId(DEMO_CREATORS[4].n), title: `${DEMO_CREATORS[4].name} 생일 축하 신문 광고`, rewardType: 'NEWSPAPER', goalTickets: 50_000, raisedTickets: 31_420, participantCount: 214, status: 'OPEN', startsAt: new Date(now.getTime() - 3 * DAY), endsAt: new Date(now.getTime() + 9 * DAY) },
    { id: `${DEMO_ID_PREFIX}support-done`, creatorId: demoCreatorId(DEMO_CREATORS[2].n), title: `${DEMO_CREATORS[2].name} 100만 구독 축하 지하철 광고`, rewardType: 'SUBWAY', goalTickets: 30_000, raisedTickets: 30_000, participantCount: 388, status: 'SUCCESS', startsAt: new Date(now.getTime() - 30 * DAY), endsAt: new Date(now.getTime() - 16 * DAY), closedAt: new Date(now.getTime() - 18 * DAY) },
  ];
  for (const sp of supports) {
    await db.voteSupport.upsert({ where: { id: sp.id }, create: { ...sp, description: '테스트용 더미 서포트예요. 목표를 채우면 광고가 집행돼요.' }, update: {} });
  }
  // 기념일 (한 명은 오늘)
  const k = new Date(now.getTime() + 9 * 3_600_000);
  const annis = [
    { c: DEMO_CREATORS[0], kind: 'BIRTHDAY', month: k.getUTCMonth() + 1, day: k.getUTCDate() },
    { c: DEMO_CREATORS[1], kind: 'DEBUT', month: ((k.getUTCMonth() + 1) % 12) + 1, day: 3 },
    { c: DEMO_CREATORS[5], kind: 'BIRTHDAY', month: k.getUTCMonth() + 1, day: Math.min(28, k.getUTCDate() + 4) },
  ];
  for (const a of annis) {
    const id = `${DEMO_ID_PREFIX}anni-${pad(a.c.n)}-${a.kind}`;
    await db.creatorAnniversary.upsert({ where: { id }, create: { id, creatorId: demoCreatorId(a.c.n), kind: a.kind, month: a.month, day: a.day, title: a.kind === 'BIRTHDAY' ? '생일' : '데뷔일' }, update: {} }).catch(() => undefined);
  }
  // 응원 댓글
  const lines = ['오늘도 응원해요!', '1위 가자!!', '항상 고마워요', '방송 너무 재밌어요', '꽃길만 걸어요'];
  for (let i = 0; i < 10; i++) {
    const c = DEMO_CREATORS[i % DEMO_CREATORS.length];
    const id = `${DEMO_ID_PREFIX}cheer-${pad(i + 1)}`;
    await db.voteCheer.upsert({ where: { id }, create: { id, creatorId: demoCreatorId(c.n), userId: `${DEMO_ID_PREFIX}fan-${pad((i % fanCount) + 1)}`, body: lines[i % lines.length], createdAt: new Date(now.getTime() - i * 3_600_000) }, update: {} });
  }
}

export interface DemoCleanResult {
  products: number;
  creators: number;
  /** 주문·정산 기록이 남아 지우지 못하고 숨김·정지 처리한 크리에이터 수 */
  creatorsSuspended: number;
}

/**
 * 더미 행 정리. demo- 접두사로만 찾는다.
 * - 상품: 장바구니·찜·진열은 함께 지워진다(Cascade). 주문 항목은 상품명 스냅샷이라 남아도 된다.
 * - 크리에이터: 테스트 중 주문·정산 기록이 생겼으면 FK 때문에 지울 수 없다 → 정지(SUSPENDED)로 숨긴다.
 */
export async function cleanDemoData(db: PrismaClient): Promise<DemoCleanResult> {
  const startsWith = { startsWith: DEMO_ID_PREFIX };
  // 팬투표 고도화 더미 (2026-11-18)
  await db.voteCheer.deleteMany({ where: { OR: [{ id: startsWith }, { creatorId: startsWith }] } });
  await db.creatorAnniversary.deleteMany({ where: { OR: [{ id: startsWith }, { creatorId: startsWith }] } });
  await db.voteSupportContribution.deleteMany({ where: { supportId: startsWith } });
  await db.voteSupport.deleteMany({ where: { id: startsWith } });
  await db.voteRewardGrant.deleteMany({ where: { OR: [{ id: startsWith }, { creatorId: startsWith }] } });
  await db.voteRewardPolicy.deleteMany({ where: { id: startsWith } });
  await db.talkReaction.deleteMany({ where: { creatorId: startsWith } });
  await db.talkLetter.deleteMany({ where: { creatorId: startsWith } });
  // 팬투표 · 팬챗 더미 (2026-11-17)
  await db.voteRound.deleteMany({ where: { id: startsWith } });
  await db.talkSubscription.deleteMany({ where: { id: startsWith } });
  await db.voteTally.deleteMany({ where: { creatorId: startsWith } });
  await db.votePeriodResult.deleteMany({ where: { creatorId: startsWith } });
  await db.talkSlotRule.deleteMany({ where: { creatorId: startsWith } });
  await db.talkMessage.deleteMany({ where: { id: startsWith } });
  await db.talkRoom.deleteMany({ where: { id: startsWith } });
  // 팬투표권 상품 더미: 주문 기록은 상품명 스냅샷이라 상품을 지워도 남는다(product_id 는 FK 가 아니다).
  await db.voteTicketProduct.deleteMany({ where: { id: startsWith } });
  await db.creatorProduct.deleteMany({ where: { OR: [{ id: startsWith }, { productId: startsWith }, { creatorId: startsWith }] } });
  const products = await db.product.deleteMany({ where: { id: startsWith } });

  const creators = await db.creatorProfile.findMany({ where: { id: startsWith }, select: { id: true, userId: true } });
  let removed = 0;
  let suspended = 0;
  for (const c of creators) {
    try {
      await db.$transaction([
        db.memberFollow.deleteMany({ where: { creatorId: c.id } }),
        db.creatorCode.deleteMany({ where: { creatorId: c.id } }),
        db.creatorProfile.delete({ where: { id: c.id } }),
        db.user.delete({ where: { id: c.userId } }),
      ]);
      removed++;
    } catch {
      await db.creatorProfile.update({ where: { id: c.id }, data: { status: 'SUSPENDED', liveOn: false, suspendedAt: new Date() } });
      await db.user.update({ where: { id: c.userId }, data: { status: 'SUSPENDED' } });
      suspended++;
    }
  }
  // 더미 팬 계정 (팬챗방 대화용)
  await db.talkMessage.deleteMany({ where: { fanUserId: { startsWith: `${DEMO_ID_PREFIX}fan-` } } });
  await db.user.deleteMany({ where: { id: { startsWith: `${DEMO_ID_PREFIX}fan-` } } }).catch(() => undefined);
  return { products: products.count, creators: removed, creatorsSuspended: suspended };
}
