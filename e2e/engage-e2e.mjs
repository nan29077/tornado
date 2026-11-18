/**
 * 팬투표 · 팬투표권 충전 · 팬챗방 · 1:1 예약 채팅 E2E (2026-11-17)
 *
 * 전제: 미리보기 서버 + 시드 + DEMO_DATA=true (더미 크리에이터 랭킹)
 * 실행: node e2e/engage-e2e.mjs  (E2E_SHOTS=폴더 를 주면 화면을 저장한다)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTS, BASE, SEED, bodyText, createReporter, desktop, gotoReady, launch, login, loginAdmin, loginCreator, mobile } from './_helpers.mjs';

const { ok, step, finish } = createReporter('팬투표 · 팬챗 E2E');
const SHOTS = process.env.E2E_SHOTS ?? '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
};
const noError = (t) => !/문제가 발생했습니다|Application error|Internal Server Error|Unhandled Runtime Error/.test(t);

const browser = await launch();
try {
  // ---------------------------------------------------------------- 관리자 준비
  const admin = await (await browser.newContext(desktop)).newPage();
  admin.on('dialog', (d) => d.accept().catch(() => {}));
  await step('관리자 로그인', () => loginAdmin(admin));
  await step('팬투표권 기본 상품 만들기', async () => {
    await gotoReady(admin, `${BASE}/admin/vote/products`);
    const btn = admin.getByRole('button', { name: '기본 상품 만들기' });
    if (await btn.count()) {

      await btn.click();
      await admin.waitForTimeout(1500);
    }
    await gotoReady(admin, `${BASE}/admin/vote/products`);
    return (await bodyText(admin)).includes('팬투표권 1,000개');
  });
  await step('1:1 채팅 켜기 (전역 스위치)', async () => {
    await gotoReady(admin, `${BASE}/admin/talk`);
    const on = admin.getByRole('button', { name: '1:1 채팅 켜기' });
    if (await on.count()) {

      await on.click();
      await admin.waitForTimeout(1500);
      await gotoReady(admin, `${BASE}/admin/talk`);
    }
    return (await bodyText(admin)).includes('1:1 채팅 끄기');
  });
  await step('크리에이터별 요율 지정 (팬투표 몫 10%, 팬챗 가격 크리에이터 결정)', async () => {
    await gotoReady(admin, `${BASE}/admin/talk/creators?code=${SEED.creator1Code}`);
    await admin.fill('input[name=voteShareRate]', '10');
    await admin.selectOption('select[name=talkSubPriceMode]', 'CREATOR');

    await admin.getByRole('button', { name: '저장', exact: true }).click();
    await admin.waitForTimeout(1500);
    await gotoReady(admin, `${BASE}/admin/talk/creators`);
    const t = await bodyText(admin);
    return t.includes(SEED.creator1Name) && t.includes('10%');
  });
  for (const p of ['/admin/vote', '/admin/vote/offerwall', '/admin/vote/rounds', '/admin/vote/casts', '/admin/vote/tickets', '/admin/talk/subscriptions', '/admin/talk/sessions', '/admin/talk/reports']) {
    await step(`관리자 화면 ${p}`, async () => {
      await gotoReady(admin, `${BASE}${p}`);
      return noError(await bodyText(admin));
    });
  }
  await shot(admin, 'admin-vote');
  await gotoReady(admin, `${BASE}/admin/talk`);
  await shot(admin, 'admin-talk');

  // ---------------------------------------------------------------- 공개 화면
  const pub = await (await browser.newContext(mobile)).newPage();
  await step('모바일 하단 메뉴: 홈 · 팬투표 · 팬챗 · 후원확인 · 마이페이지 (방송국·이용방법 없음)', async () => {
    await gotoReady(pub, `${BASE}/`);
    const bottom = pub.locator('nav').filter({ hasText: '후원확인' }).last();
    const t = await bottom.innerText();
    return t.includes('팬투표') && t.includes('팬챗') && !t.includes('방송국') && !t.includes('이용방법');
  });
  await step('구독자 전용 탭에 팬투표 랭킹 섹션', async () => {
    await gotoReady(pub, `${BASE}/?tab=fan`);
    await pub.waitForTimeout(1500);
    const t = await bodyText(pub);
    await shot(pub, 'mobile-fan-home');
    return t.includes('크리에이터 팬투표 랭킹') && t.includes('실시간') && t.includes('왕중왕');
  });
  await step('/vote 랭킹 (더미 크리에이터 시상대)', async () => {
    await gotoReady(pub, `${BASE}/vote`);
    const t = await bodyText(pub);
    await shot(pub, 'mobile-vote');
    return t.includes('실시간 랭킹') && t.includes('하루먹방');
  });
  for (const tab of ['day', 'week', 'month', 'champion']) {
    await step(`/vote?p=${tab}`, async () => {
      await gotoReady(pub, `${BASE}/vote?p=${tab}`);
      return noError(await bodyText(pub));
    });
  }
  await step('명예의 전당', async () => {
    await gotoReady(pub, `${BASE}/vote/hall-of-fame`);
    return noError(await bodyText(pub));
  });

  // ---------------------------------------------------------------- 크리에이터: 팬챗방 열기 · 1:1 시간
  const studio = await (await browser.newContext(desktop)).newPage();
  await step('크리에이터 로그인', () => loginCreator(studio));
  await step('스튜디오 메뉴에 팬챗 그룹', async () => {
    await gotoReady(studio, `${BASE}/studio`);
    const t = await bodyText(studio);
    return t.includes('팬투표·랭킹') && t.includes('팬챗 관리') && t.includes('1:1 채팅');
  });
  await step('스튜디오 팬투표·랭킹 화면 + 안내', async () => {
    await gotoReady(studio, `${BASE}/studio/vote`);
    const t = await bodyText(studio);
    await shot(studio, 'studio-vote');
    return t.includes('팬투표 기능 안내') && t.includes('10%');
  });
  await step('팬챗방 열기 + 가격 9,900원 (크리에이터 결정 권한)', async () => {
    await gotoReady(studio, `${BASE}/studio/talk`);
    await studio.check('input[name=open]');
    await studio.fill('input[name=subPrice]', '9900');
    await studio.fill('input[name=welcomeMessage]', '바람소리 팬챗방입니다!');
    await studio.getByRole('button', { name: '저장', exact: true }).click();
    await studio.waitForTimeout(1500);
    return (await bodyText(studio)).includes('저장했습니다');
  });
  await step('구독자에게 메시지 보내기', async () => {
    await gotoReady(studio, `${BASE}/studio/talk`);
    await studio.fill('textarea[name=body]', '{닉네임}님 오늘도 와 줘서 고마워요!');
    await studio.getByRole('button', { name: '보내기', exact: true }).click();
    await studio.waitForTimeout(1500);
    await gotoReady(studio, `${BASE}/studio/talk`);
    await shot(studio, 'studio-talk');
    return (await bodyText(studio)).includes('오늘도 와 줘서 고마워요');
  });
  await step('1:1 신청 받기 + 가능 시간 저장', async () => {
    await gotoReady(studio, `${BASE}/studio/talk/sessions`);
    await studio.check('input[name=sessionEnabled]');
    await studio.getByRole('button', { name: '저장', exact: true }).click();
    await studio.waitForTimeout(1200);
    await gotoReady(studio, `${BASE}/studio/talk/sessions`);
    await studio.fill('textarea[name=rules]', ['일', '월', '화', '수', '목', '금', '토'].map((d) => `${d} 00:00-23:59`).join('\n'));
    await studio.getByRole('button', { name: '가능 시간 저장' }).click();
    await studio.waitForTimeout(1200);
    return (await bodyText(studio)).includes('가능 시간 7개');
  });

  // ---------------------------------------------------------------- 구독자: 충전 · 팬투표 · 팬챗 · 1:1
  const fan = await (await browser.newContext(mobile)).newPage();
  await step('구독자 로그인', () => login(fan, ACCOUNTS.donor));
  await step('무료 충전: 테스트 광고 퀴즈', async () => {
    await gotoReady(fan, `${BASE}/vote/charge`);
    const card = fan.locator('li').filter({ hasText: '광고 퀴즈 풀기' });
    await card.getByRole('button', { name: '참여하기' }).click();
    await card.locator('label').filter({ hasText: '노랑' }).click();
    await card.getByRole('button', { name: /받기/ }).click();
    await fan.waitForTimeout(1500);
    await shot(fan, 'mobile-charge-free');
    return (await card.innerText()).includes('받았어요');
  });
  await step('구매 충전: 팬투표권 1,000개 (테스트 결제)', async () => {
    await gotoReady(fan, `${BASE}/vote/charge?t=buy`);
    await fan.getByRole('button', { name: /팬투표권 1,000개/ }).first().click();
    await fan.check('input[name=agree]');
    await fan.getByRole('button', { name: /결제하고 충전하기/ }).click();
    await fan.waitForTimeout(2000);
    await shot(fan, 'mobile-charge-buy');
    return (await bodyText(fan)).includes('충전되었어요');
  });
  await step('팬투표하기: 바람소리에게 10표', async () => {
    await gotoReady(fan, `${BASE}/vote?vote=${SEED.creator1Code}`);
    const sheet = fan.locator('[role=dialog][aria-label$="팬투표"]');
    await sheet.getByRole('button', { name: '10표' }).click();
    await sheet.getByRole('button', { name: /표 보내기/ }).click();
    await fan.waitForTimeout(2000);
    await shot(fan, 'mobile-vote-done');
    return (await sheet.innerText()).includes('10표를 보냈어요');
  });
  await step('마이페이지 팬투표 탭: 잔액 · 내역', async () => {
    await gotoReady(fan, `${BASE}/my/votes`);
    const t = await bodyText(fan);
    await shot(fan, 'mobile-my-votes');
    return t.includes('내 팬투표권') && t.includes('구매');
  });
  await step('샵 상단 팬투표 순위 + 팬챗 탭', async () => {
    await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}?tab=talk`);
    const t = await bodyText(fan);
    await shot(fan, 'mobile-shop-talk');
    return t.includes('실시간') && t.includes('팬챗방') && t.includes('9,900');
  });
  await step('팬챗 구독 (9,900원)', async () => {
    await fan.check('input[name=agree]');
    await fan.getByRole('button', { name: /팬챗 시작하기/ }).click();
    await fan.waitForTimeout(2000);
    return (await bodyText(fan)).includes('팬챗방 들어가기');
  });
  await step('팬챗방: 크리에이터 메시지 (닉네임 치환) + 내 메시지', async () => {
    await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk`);
    await fan.fill('textarea[name=body]', '안녕하세요! 제 번호는 010-9999-8888 이에요');
    await fan.getByRole('button', { name: '보내기', exact: true }).click();
    await fan.waitForTimeout(2500);
    const t = await bodyText(fan);
    await shot(fan, 'mobile-talk-room');
    return t.includes('오늘도 와 줘서 고마워요') && !t.includes('{닉네임}') && t.includes('안녕하세요') && !t.includes('9999-8888');
  });
  await step('1:1 채팅 예약 신청', async () => {
    await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk/book`);
    await fan.locator('form button:not([disabled])').filter({ hasText: /^\d{2}:\d{2}$/ }).first().click();
    await fan.check('input[name=agree]');
    await shot(fan, 'mobile-book');
    await fan.getByRole('button', { name: /결제하고 신청하기/ }).click();
    await fan.waitForURL(/\/my\/talk\/sessions\//, { timeout: 15000 });
    return (await bodyText(fan)).includes('승인 대기');
  });
  await step('하단 [팬챗] 화면: 팬챗방 · 1:1 목록', async () => {
    await gotoReady(fan, `${BASE}/talk`);
    const t1 = await bodyText(fan);
    await shot(fan, 'mobile-talk-hub');
    await gotoReady(fan, `${BASE}/talk?t=one`);
    const t2 = await bodyText(fan);
    await shot(fan, 'mobile-talk-hub-one');
    return t1.includes(SEED.creator1Name) && t1.includes('크리에이터 팬챗방') && t2.includes('다가오는 예약');
  });

  // ---------------------------------------------------------------- 크리에이터: 승인 · 팬 메시지 확인
  await step('크리에이터: 1:1 신청 수락', async () => {
    await gotoReady(studio, `${BASE}/studio/talk/sessions`);
    await studio.getByRole('button', { name: '수락', exact: true }).first().click();
    await studio.waitForTimeout(1500);
    await gotoReady(studio, `${BASE}/studio/talk/sessions`);
    await shot(studio, 'studio-sessions');
    return (await bodyText(studio)).includes('확정된 예약 (1)');
  });
  await step('크리에이터: 팬 메시지 (연락처 가림)', async () => {
    await gotoReady(studio, `${BASE}/studio/talk`);
    const t = await bodyText(studio);
    return t.includes('안녕하세요') && !t.includes('9999-8888');
  });
  await step('크리에이터 정산 원장에 팬챗 구독 정산 적립', async () => {
    await gotoReady(studio, `${BASE}/studio/settlement`);
    const t = await bodyText(studio);
    return noError(t);
  });

  // ---------------------------------------------------------------- 기존 화면 회귀
  for (const p of ['/', '/videos', `/c/${SEED.creator1Code}`, `/c/${SEED.creator1Code}?tab=shop`, `/c/${SEED.creator1Code}?tab=donate`, '/my', '/how-it-works', '/faq']) {
    await step(`기존 화면 ${p}`, async () => {
      await gotoReady(fan, `${BASE}${p}`);
      return noError(await bodyText(fan));
    });
  }
  for (const p of ['/studio', '/studio/donations', '/studio/shop', '/studio/settlement']) {
    await step(`기존 스튜디오 ${p}`, async () => {
      await gotoReady(studio, `${BASE}${p}`);
      return noError(await bodyText(studio));
    });
  }
  for (const p of ['/admin', '/admin/users', '/admin/settlements', '/admin/shop/products', '/admin/payments']) {
    await step(`기존 관리자 ${p}`, async () => {
      await gotoReady(admin, `${BASE}${p}`);
      return noError(await bodyText(admin));
    });
  }

  // ---------------------------------------------------------------- 1:1 스위치 끄기 → 어디에도 안 보임
  await step('1:1 채팅 끄기 → 샵·팬챗·스튜디오에서 사라짐', async () => {
    await gotoReady(admin, `${BASE}/admin/talk`);

    await admin.getByRole('button', { name: '1:1 채팅 끄기' }).click();
    await admin.waitForTimeout(1500);
    await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}?tab=talk`);
    const shop = await bodyText(fan);
    await gotoReady(fan, `${BASE}/talk`);
    const hub = await bodyText(fan);
    await gotoReady(fan, `${BASE}/c/${SEED.creator1Code}/talk/book`);
    const redirected = !fan.url().includes('/talk/book');
    await gotoReady(studio, `${BASE}/studio`);
    const menu = await bodyText(studio);
    return !shop.includes('1:1 채팅 예약') && !hub.includes('1:1 채팅') && redirected && !menu.includes('1:1 채팅');
  });
  ok('완료', true);
} finally {
  await browser.close();
  finish();
}
