/**
 * 팬챗(버블형) · 팬투표 고도화 E2E (2026-11-18)
 *
 * 전제: 미리보기 서버 + 시드 + DEMO_DATA=true. engage-e2e.mjs 를 먼저 돌려 바람소리 팬챗방이 열려 있고
 *       후원자 계정이 바람소리를 구독 중인 상태에서 실행한다(그래야 팬챗방 화면까지 확인한다).
 * 실행: node e2e/fan-e2e.mjs  (E2E_SHOTS=폴더 를 주면 화면을 저장한다)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTS, BASE, PASSWORD, SEED, bodyText, createReporter, desktop, gotoReady, launch, login, loginAdmin, loginCreator, mobile } from './_helpers.mjs';

const { ok, step, finish } = createReporter('팬챗 · 팬투표 고도화 E2E');
const SHOTS = process.env.E2E_SHOTS ?? '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
};
const noError = (t) => !/문제가 발생했습니다|Application error|Internal Server Error|Unhandled Runtime Error|This page could not be found/.test(t);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const kstInput = (ms) => new Date(Date.now() + ms + 9 * 3600_000).toISOString().slice(0, 16);

const browser = await launch();
const errors = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => errors.push(`${label} ${page.url().replace(BASE, "")}: ${e.message.slice(0, 60)}`));
  page.on('dialog', (d) => d.accept().catch(() => {}));
};
try {
  // ================================================================ 로그인 화면 · PC 우측 메뉴
  const pc = await (await browser.newContext({ viewport: { width: 1405, height: 922 } })).newPage();
  watch(pc, 'pc');
  await step('PC 1405×922: 우측 메뉴와 문의 버튼이 겹치지 않는다', async () => {
    await gotoReady(pc, `${BASE}/`);
    const r = await pc.evaluate(() => {
      const nav = document.querySelector('aside[aria-label="PC 메뉴"]');
      const btn = document.querySelector('button[aria-label="문의하기"]');
      if (!nav || !btn) return null;
      const a = nav.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return { navBottom: a.bottom, btnTop: b.top, overlapX: a.right > b.left && a.left < b.right };
    });
    await shot(pc, 'pc-home-rail');
    return Boolean(r) && (!r.overlapX || r.navBottom <= r.btnTop);
  });
  await step('PC 1405×700(낮은 화면): 메뉴가 문의 버튼을 덮지 않는다', async () => {
    await pc.setViewportSize({ width: 1405, height: 700 });
    await gotoReady(pc, `${BASE}/`);
    const r = await pc.evaluate(() => {
      const nav = document.querySelector('aside[aria-label="PC 메뉴"]');
      const btn = document.querySelector('button[aria-label="문의하기"]');
      if (!nav || !btn) return null;
      return nav.getBoundingClientRect().bottom <= btn.getBoundingClientRect().top + 1;
    });
    await pc.setViewportSize({ width: 1405, height: 922 });
    return r === true;
  });
  await step('로그인 화면: 테스트 로그인 버튼 하나만 "로그인 중" 으로 바뀐다', async () => {
    const ctx = await browser.newContext(desktop);
    const p = await ctx.newPage();
    await gotoReady(p, `${BASE}/login`);
    const panel = p.locator('form').filter({ has: p.locator('input[name=account][value=creator]') });
    if (!(await panel.count())) {
      await ctx.close();
      return true; // 테스트 로그인이 숨겨진 환경
    }
    await Promise.all([p.waitForURL(/\/studio/, { timeout: 20_000 }).catch(() => null), panel.getByRole('button').click()]);
    // 누르는 순간 다른 버튼 글자는 그대로여야 한다 (화면 이동 전에 확인)
    const texts = await p.locator('form button[type=submit]').allInnerTexts().catch(() => []);
    await ctx.close();
    return texts.length === 0 || texts.filter((t) => t.includes('로그인 중')).length <= 1;
  });

  // ================================================================ 관리자
  const admin = await (await browser.newContext(desktop)).newPage();
  watch(admin, 'admin');
  await step('관리자 로그인', () => loginAdmin(admin));
  for (const p of ['/admin/vote/activity', '/admin/vote/rewards', '/admin/vote/support', '/admin/talk/advanced', '/admin/talk', '/admin/vote/rounds']) {
    await step(`관리자 새 화면 ${p}`, async () => {
      await gotoReady(admin, `${BASE}${p}`);
      const t = await bodyText(admin);
      await shot(admin, `admin${p.replaceAll('/', '-')}`);
      return noError(t);
    });
  }
  await step('관리자: 팬챗방 방식 기본값 = 버블형', async () => {
    await gotoReady(admin, `${BASE}/admin/talk`);
    return (await admin.locator('select[name=roomMode]').inputValue()) === 'BUBBLE';
  });
  await step('관리자: 보상 정책 추가 (월간 1위 신문 광고)', async () => {
    await gotoReady(admin, `${BASE}/admin/vote/rewards`);
    await admin.fill('input[name=title]', 'E2E 월간 1위 신문 광고');
    await admin.getByRole('button', { name: '추가', exact: true }).first().click();
    await admin.waitForTimeout(1500);
    await gotoReady(admin, `${BASE}/admin/vote/rewards`);
    return (await bodyText(admin)).includes('E2E 월간 1위 신문 광고');
  });
  await step('관리자: 보상 집행 기록 (집행 완료 + 매체)', async () => {
    await gotoReady(admin, `${BASE}/admin/vote/rewards`);
    const card = admin.locator('form').filter({ has: admin.locator('input[name=grantId]') }).first();
    if (!(await card.count())) return true;
    await card.locator('select[name=status]').selectOption('PUBLISHED');
    await card.locator('input[name=mediaName]').fill('E2E일보');
    await card.getByRole('button', { name: '저장', exact: true }).click();
    await admin.waitForTimeout(1500);
    await gotoReady(admin, `${BASE}/admin/vote/rewards`);
    return (await bodyText(admin)).includes('E2E일보') || (await admin.locator('input[name=mediaName]').first().inputValue()) === 'E2E일보';
  });
  await step('관리자: 서포트 열기 (바람소리 · 목표 100)', async () => {
    await gotoReady(admin, `${BASE}/admin/vote/support`);
    await admin.fill('input[name=code]', SEED.creator1Code);
    await admin.fill('input[name=goalTickets]', '100');
    await admin.fill('input[name=title]', 'E2E 바람소리 신문 광고 서포트');
    await admin.getByRole('button', { name: '열기', exact: true }).click();
    await admin.waitForTimeout(1500);
    await gotoReady(admin, `${BASE}/admin/vote/support`);
    return (await bodyText(admin)).includes('E2E 바람소리 신문 광고 서포트');
  });
  await step('관리자: 이벤트 팬투표 만들기 (보상 안내 · 하루 한도)', async () => {
    await gotoReady(admin, `${BASE}/admin/vote/rounds`);
    await admin.selectOption('select[name=kind]', 'EVENT');
    await admin.fill('input[name=title]', 'E2E 이벤트 팬투표');
    await admin.fill('textarea[name=codes]', `${SEED.creator1Code}, ${SEED.creator2Code}`);
    await admin.fill('input[name=rewardText]', '1위 E2E 신문 광고');
    await admin.fill('input[name=dailyMaxVotes]', '50');
    await admin.getByRole('button', { name: '만들기', exact: true }).click();
    await admin.waitForTimeout(1500);
    await gotoReady(admin, `${BASE}/admin/vote/rounds`);
    return (await bodyText(admin)).includes('E2E 이벤트 팬투표');
  });
  await step('관리자: 팬챗 고급 설정 저장 (답장 3번 유지)', async () => {
    await gotoReady(admin, `${BASE}/admin/talk/advanced`);
    await admin.getByRole('button', { name: '저장', exact: true }).click();
    await admin.waitForTimeout(1500);
    return (await bodyText(admin)).includes('저장했습니다');
  });
  await step('관리자: 팬 활동 설정 저장', async () => {
    await gotoReady(admin, `${BASE}/admin/vote/activity`);
    await admin.getByRole('button', { name: '저장', exact: true }).first().click();
    await admin.waitForTimeout(1500);
    return (await bodyText(admin)).includes('저장했습니다');
  });

  // ================================================================ 크리에이터
  const studio = await (await browser.newContext(desktop)).newPage();
  watch(studio, 'studio');
  await step('크리에이터 로그인', () => loginCreator(studio));
  await step('스튜디오 메뉴: 팬챗 · 팬투표 그룹 + 팬레터', async () => {
    await gotoReady(studio, `${BASE}/studio/talk`);
    const t = await bodyText(studio);
    await shot(studio, 'studio-talk');
    return t.includes('팬챗 · 팬투표') && t.includes('팬레터') && t.includes('메시지 보내기') && noError(t);
  });
  await step('스튜디오: 음성 메시지 올리기(파일) + 보내기', async () => {
    await gotoReady(studio, `${BASE}/studio/talk`);
    await studio.getByRole('button', { name: '음성', exact: true }).click();
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(2048, 0xff)]);
    await studio.locator('input[type=file]').setInputFiles({ name: 'hello.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
    await studio.waitForSelector('audio', { timeout: 15_000 });
    await studio.fill('textarea[name=body]', 'E2E 음성 인사');
    await studio.getByRole('button', { name: '보내기', exact: true }).click();
    await studio.waitForTimeout(2000);
    await gotoReady(studio, `${BASE}/studio/talk`);
    const t = await bodyText(studio);
    return t.includes('E2E 음성 인사') && t.includes('음성');
  });
  await step('스튜디오: 예약 발송 → 예약된 메시지 목록', async () => {
    await gotoReady(studio, `${BASE}/studio/talk`);
    await studio.fill('textarea[name=body]', 'E2E 예약 메시지');
    await studio.getByRole('button', { name: '예약 발송' }).click();
    await studio.locator('input[type=datetime-local]').fill(kstInput(2 * 3600_000));
    await studio.getByRole('button', { name: '예약하기' }).click();
    await studio.waitForTimeout(2000);
    await gotoReady(studio, `${BASE}/studio/talk`);
    const t = await bodyText(studio);
    return t.includes('예약된 메시지') && t.includes('E2E 예약 메시지');
  });
  await step('스튜디오: 기념일 저장 (오늘 생일)', async () => {
    await gotoReady(studio, `${BASE}/studio/vote`);
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    await studio.fill('input[name=date]', today);
    await studio.getByRole('button', { name: '기념일 저장' }).click();
    await studio.waitForTimeout(1500);
    await gotoReady(studio, `${BASE}/studio/vote`);
    const t = await bodyText(studio);
    await shot(studio, 'studio-vote');
    return t.includes('기념일') && t.includes('생일') && noError(t);
  });
  await step('스튜디오 팬레터함 화면', async () => {
    await gotoReady(studio, `${BASE}/studio/talk/letters`);
    return noError(await bodyText(studio));
  });

  // ================================================================ 구독자 (모바일)
  const fan = await (await browser.newContext(mobile)).newPage();
  watch(fan, 'fan');
  await step('구독자 로그인', () => login(fan, ACCOUNTS.donor));
  await step('충전소: 출석 체크 → 팬투표권 지급', async () => {
    await gotoReady(fan, `${BASE}/vote/charge`);
    const btn = fan.getByRole('button', { name: /출석하고 팬투표권/ });
    if (await btn.count()) {
      await btn.click();
      await fan.waitForTimeout(1500);
    }
    const t = await bodyText(fan);
    await shot(fan, 'm-charge-free');
    return t.includes('오늘 출석 완료') || t.includes('출석 완료');
  });
  await step('충전소: 오늘의 미션 · 친구 초대 코드 표시', async () => {
    await gotoReady(fan, `${BASE}/vote/charge`);
    const t = await bodyText(fan);
    return t.includes('오늘의 미션') && t.includes('내 초대 코드') && (await noOverflow(fan));
  });
  await step('팬투표 → 인증 카드 → 공유 미션 보상', async () => {
    await gotoReady(fan, `${BASE}/vote?vote=${SEED.creator1Code}`);
    const sheet = fan.locator('[role=dialog][aria-label$="팬투표"]');
    await sheet.getByRole('button', { name: /^1표$/ }).click();
    await sheet.getByRole('button', { name: /표 보내기/ }).click();
    await fan.waitForTimeout(2000);
    const hasCard = (await sheet.locator('canvas').count()) > 0;
    const [download] = await Promise.all([fan.waitForEvent('download', { timeout: 8000 }).catch(() => null), sheet.getByRole('button', { name: '카드 저장' }).click()]);
    await fan.waitForTimeout(800);
    await shot(fan, 'm-vote-share-card');
    await gotoReady(fan, `${BASE}/vote/charge`);
    const row = fan.locator('li').filter({ hasText: '팬투표 인증 공유' });
    const claim = row.getByRole('button', { name: /받기/ });
    if (await claim.count()) {
      await claim.click();
      await fan.waitForTimeout(1500);
    }
    return hasCard && Boolean(download) && (await row.innerText()).includes('받음');
  });
  await step('미션: 오늘 첫 팬투표 보상 받기', async () => {
    await gotoReady(fan, `${BASE}/vote/charge`);
    const row = fan.locator('li').filter({ hasText: '오늘 첫 팬투표' });
    const claim = row.getByRole('button', { name: /받기/ });
    if (await claim.count()) {
      await claim.click();
      await fan.waitForTimeout(1500);
    }
    return (await row.innerText()).includes('받음');
  });
  await step('팬투표 메뉴: 랭킹 화면 하위 메뉴 · 오늘 기념일', async () => {
    await gotoReady(fan, `${BASE}/vote`);
    const t = await bodyText(fan);
    await shot(fan, 'm-vote');
    return t.includes('이벤트') && t.includes('서포트') && t.includes('보상') && t.includes('오늘은 이런 날이에요') && (await noOverflow(fan));
  });
  await step('크리에이터 팬투표 페이지: 응원 댓글 남기기', async () => {
    await gotoReady(fan, `${BASE}/vote/creator/${SEED.creator1Code}`);
    await fan.fill('input[name=body]', 'E2E 응원합니다 화이팅');
    await fan.getByRole('button', { name: '응원 남기기' }).click();
    await fan.waitForTimeout(1500);
    await gotoReady(fan, `${BASE}/vote/creator/${SEED.creator1Code}`);
    const t = await bodyText(fan);
    await shot(fan, 'm-creator-vote');
    return t.includes('E2E 응원합니다 화이팅') && t.includes('최근 30일 팬 랭킹') && (await noOverflow(fan));
  });
  await step('이벤트 목록 → 상세 → 이벤트 팬투표', async () => {
    await gotoReady(fan, `${BASE}/vote/events`);
    await fan.getByText('E2E 이벤트 팬투표').first().click();
    await fan.waitForURL(/\/vote\/events\//, { timeout: 15000 });
    await fan.waitForTimeout(800);
    const t = await bodyText(fan);
    await shot(fan, 'm-event');
    const btn = fan.getByRole('button', { name: /팬투표하기$/ }).first();
    await btn.click();
    const sheet = fan.locator('[role=dialog][aria-label$="팬투표"]');
    await sheet.getByRole('button', { name: /^1표$/ }).click();
    await sheet.getByRole('button', { name: /표 보내기/ }).click();
    await fan.waitForTimeout(2000);
    return t.includes('1위 E2E 신문 광고') && (await sheet.innerText()).includes('보냈어요');
  });
  await step('서포트 참여 (팬투표권 10개)', async () => {
    await gotoReady(fan, `${BASE}/vote/support`);
    await fan.getByText('E2E 바람소리 신문 광고 서포트').first().click();
    await fan.waitForURL(/\/vote\/support\//, { timeout: 15000 });
    await fan.fill('input[name=tickets]', '10');
    await fan.getByRole('button', { name: /개로 서포트하기/ }).click();
    await fan.waitForTimeout(2000);
    const t = await bodyText(fan);
    await shot(fan, 'm-support');
    return t.includes('서포트에 참여했어요') || t.includes('목표를 채웠어요');
  });
  for (const p of ['/vote/rewards', '/vote/fans', '/vote/calendar', '/vote/hall-of-fame', '/vote/support?s=done']) {
    await step(`팬투표 화면 ${p}`, async () => {
      await gotoReady(fan, `${BASE}${p}`);
      const t = await bodyText(fan);
      await shot(fan, `m${p.replace(/[/?=]/g, '-')}`);
      return noError(t) && (await noOverflow(fan));
    });
  }
  await step('보상 화면: 정책 · 집행 기록 공개', async () => {
    await gotoReady(fan, `${BASE}/vote/rewards`);
    const t = await bodyText(fan);
    return t.includes('E2E 월간 1위 신문 광고') && t.includes('보상 현황');
  });
  await step('마이페이지 팬투표: 팬 레벨 · 배지', async () => {
    await gotoReady(fan, `${BASE}/my/votes`);
    const t = await bodyText(fan);
    await shot(fan, 'm-my-votes');
    return t.includes('Lv.') && t.includes('배지') && t.includes('첫 팬투표') && (await noOverflow(fan));
  });

  // ---------------------------------------------------------------- 팬챗방
  const subscribed = await (async () => {
    await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}?tab=talk`);
    return (await bodyText(fan)).includes('팬챗방 들어가기');
  })();
  ok('구독자: 바람소리 팬챗 구독 중 (engage-e2e 선행)', subscribed);
  if (subscribed) {
    await step('팬챗방: 머리(D+ · 실시간) · 음성 메시지 · 예약 메시지는 아직 안 보임', async () => {
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk`);
      await fan.waitForTimeout(1500);
      const t = await bodyText(fan);
      await shot(fan, 'm-talk-room');
      const audio = await fan.locator('audio').count();
      return t.includes('D+') && t.includes('E2E 음성 인사') && audio > 0 && !t.includes('E2E 예약 메시지') && (await noOverflow(fan));
    });
    await step('팬챗방: 답장 남은 수 표시 · 답장 보내기', async () => {
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk`);
      const before = await bodyText(fan);
      await fan.fill('textarea[name=body]', 'E2E 답장이에요');
      await fan.getByRole('button', { name: '보내기', exact: true }).click();
      await fan.waitForTimeout(2500);
      const t = await bodyText(fan);
      return /답장 \d\/3/.test(before) && t.includes('E2E 답장이에요');
    });
    await step('팬챗방: 크리에이터 메시지에 하트', async () => {
      const heart = fan.getByRole('button', { name: '하트 보내기' }).last();
      await heart.click();
      await fan.waitForTimeout(1200);
      return (await fan.getByRole('button', { name: '하트 취소' }).count()) > 0;
    });
    await step('팬챗방: 닉네임 정하기 → {닉네임} 치환', async () => {
      await fan.getByRole('button', { name: '팬챗방 설정' }).click();
      await fan.fill('input[name=nickname]', '이투이팬');
      await fan.getByRole('button', { name: '저장', exact: true }).click();
      await fan.waitForTimeout(1500);
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk`);
      await fan.waitForTimeout(800);
      return (await bodyText(fan)).includes('이투이팬님');
    });
    await step('실시간: 크리에이터가 보낸 메시지가 새로고침 없이 도착', async () => {
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk`);
      await fan.waitForTimeout(1500);
      await gotoReady(studio, `${BASE}/studio/talk`);
      await studio.fill('textarea[name=body]', 'E2E 실시간 도착 확인');
      await studio.getByRole('button', { name: '보내기', exact: true }).click();
      const got = await fan
        .getByText('E2E 실시간 도착 확인')
        .first()
        .waitFor({ timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      return got;
    });
    await step('보관함: 음성 필터', async () => {
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk/archive`);
      await fan.getByRole('button', { name: '음성', exact: true }).click();
      await fan.waitForTimeout(1500);
      const t = await bodyText(fan);
      await shot(fan, 'm-talk-archive');
      return t.includes('E2E 음성 인사') && (await noOverflow(fan));
    });
    await step('팬레터 보내기 → 크리에이터 팬레터함 · 답장', async () => {
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk/letters`);
      await fan.fill('textarea[name=body]', 'E2E 팬레터: 항상 방송 잘 보고 있어요. 고마워요!');
      await fan.getByRole('button', { name: /팬레터 보내기/ }).click();
      await fan.waitForTimeout(2000);
      const t = await bodyText(fan);
      await shot(fan, 'm-letters');
      await gotoReady(studio, `${BASE}/studio/talk/letters`);
      const s = await bodyText(studio);
      await studio.getByText('답장 쓰기').first().click();
      await studio.locator('textarea[name=body]').first().fill('E2E 답장 고마워요');
      await studio.getByRole('button', { name: '답장 보내기' }).first().click();
      await studio.waitForTimeout(1500);
      await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk/letters`);
      const t2 = await bodyText(fan);
      return t.includes('팬레터를 보냈어요') && s.includes('E2E 팬레터') && t2.includes('E2E 답장 고마워요');
    });
    await step('크리에이터: 메시지별 읽음 · 답장 수 · 답장 모아보기', async () => {
      await gotoReady(studio, `${BASE}/studio/talk`);
      const t = await bodyText(studio);
      const link = studio.locator('a[href*="/studio/talk?re="]').first();
      await link.click();
      await studio.waitForTimeout(1200);
      const t2 = await bodyText(studio);
      await shot(studio, 'studio-talk-replies');
      return t.includes('읽음') && t2.includes('이 메시지에 온 답장');
    });
  }
  await step('하단 [팬챗]: D+ 표시 · 묶음 구독 견적', async () => {
    await gotoReady(fan, `${BASE}/talk`);
    const t = await bodyText(fan);
    await shot(fan, 'm-talk-hub');
    const builder = fan.locator('section', { has: fan.locator('h2', { hasText: '묶음 구독으로 함께 시작하기' }) }).last();
    if (!(await builder.count())) return t.includes('D+');
    const cards = builder.locator('button[aria-pressed]');
    if ((await cards.count()) < 2) return t.includes('D+');
    await cards.nth(0).click();
    await cards.nth(1).click();
    await fan.waitForTimeout(1800);
    const b = await builder.innerText();
    return t.includes('D+') && b.includes('% 할인') && b.includes('함께 구독하기');
  });
  await step('묶음 구독 결제 (테스트 결제)', async () => {
    const builder = fan.locator('section', { has: fan.locator('h2', { hasText: '묶음 구독으로 함께 시작하기' }) }).last();
    if (!(await builder.count())) return true;
    await builder.locator('input[name=agree]').check();
    await builder.getByRole('button', { name: /함께 구독하기$/ }).click();
    await fan.waitForTimeout(2500);
    return (await bodyText(fan)).includes('함께 구독했어요') || (await bodyText(fan)).includes('D+');
  });

  // ---------------------------------------------------------------- 문구 변경
  await step('문구: 화면에 "소통"·단독 "투표" 가 남아 있지 않다', async () => {
    const pages = ['/vote', '/talk', `/c/${SEED.creator1Code}?tab=talk`, '/vote/charge', '/my/votes'];
    const bad = [];
    for (const p of pages) {
      await gotoReady(fan, `${BASE}${p}`);
      const t = await bodyText(fan);
      if (/소통/.test(t)) bad.push(`${p}: 소통`);
      if (/(?<!팬)투표/.test(t)) bad.push(`${p}: 투표`);
    }
    await gotoReady(studio, `${BASE}/studio/talk`);
    const s = await bodyText(studio);
    if (/소통/.test(s) || /(?<!팬)투표/.test(s)) bad.push('studio');
    await gotoReady(admin, `${BASE}/admin/talk`);
    const a = await bodyText(admin);
    if (/소통/.test(a) || /(?<!팬)투표/.test(a)) bad.push('admin');
    if (bad.length) console.log('  남은 문구:', bad.join(', '));
    return bad.length === 0;
  });

  ok('브라우저 스크립트 오류 없음', errors.length === 0, errors.slice(0, 5).join(' / '));
  void PASSWORD;
} finally {
  await browser.close();
}
finish();
