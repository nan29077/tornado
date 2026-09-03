import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Local preview only. Never performs a payment, sends an MT, or changes a real donation.
const base = process.env.E2E_BASE ?? 'http://localhost:3025';
if (!/^http:\/\/(localhost|127\.0\.0\.1):3025$/.test(base)) throw new Error('Local Donaido preview only.');
const output = path.resolve('tmp/donor-experience-qa');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
const checks = [];
function check(name, valid) { assert.ok(valid, name); checks.push(name); console.log('PASS', name); }
async function ready(page, suffix) {
  await page.goto(base + suffix, { waitUntil: 'networkidle' });
  check('HTTP 화면: ' + suffix, !(await page.locator('body').innerText()).includes('화면을 불러오지 못했습니다'));
}
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
try {
  await ready(page, '/c/TOR-8K2M');
  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    check(width + 'px 가로 넘침 없음', dimensions.scroll <= dimensions.width + 1);
    const rail = page.locator('aside');
    check(width + 'px PC 메뉴 표시', await rail.isVisible() === (width >= 1024));
    if (width < 1024) {
      const items = await page.getByRole('navigation', { name: '후원자 모바일 메뉴' }).locator('a').evaluateAll((links) => links.map((link) => { const r = link.getBoundingClientRect(); return { x: r.x, right: r.right }; }));
      check(width + 'px 모바일 메뉴 4개 모두 화면 안', items.length === 4 && items.every((r) => r.x >= 0 && r.right <= width));
    }
    if (width >= 1024) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const rect = await rail.boundingBox();
      check(width + 'px 스크롤 후 메뉴 고정', rect && rect.y >= 0 && rect.y < 60 && rect.y + rect.height <= 950);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(output, 'donation-' + width + '.png') });
  }
  check('모든 후원 페이지 이미지 로드', await page.locator('img').evaluateAll((images) => images.every((img) => img.complete && img.naturalWidth > 0)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page, '/c/TOR-8K2M/messages');
  check('비로그인 문자내역 접근 시 로그인으로', page.url().includes('/c/TOR-8K2M/login'));
  check('카카오 로그인 버튼', await page.getByRole('link', { name: '카카오로 로그인', exact: true }).count() === 1);
  check('네이버 로그인 버튼', await page.getByRole('link', { name: '네이버로 로그인', exact: true }).count() === 1);
  await page.screenshot({ path: path.join(output, 'donor-login.png') });
  await Promise.all([page.waitForURL('**/c/TOR-8K2M/messages'), page.getByRole('button', { name: '테스트 후원자로 바로 로그인' }).click()]);
  await page.waitForLoadState('networkidle');
  check('테스트 후원자 로그인', (await page.locator('aside').innerText()).includes('테스트후원자'));
  check('내역과 시드 답글 표시', (await page.locator('main').innerText()).includes('검수용 답글'));
  await page.screenshot({ path: path.join(output, 'donor-messages.png') });
  await ready(page, '/my');
  check('마이페이지 답글 표시', (await page.locator('body').innerText()).includes('검수용 답글'));
  // Separate creator session so donor's session remains unchanged.
  const creatorContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const creator = await creatorContext.newPage();
  creator.on('pageerror', (e) => errors.push(e.message));
  await ready(creator, '/login');
  await Promise.all([creator.waitForURL('**/studio'), creator.getByRole('button', { name: /크리에이터로 로그인/ }).click()]);
  await ready(creator, '/studio/donations?q=PREVIEW-DONOR-REPLY-1&period=all');
  const detail = creator.locator('a[href^="/studio/donations/"]').first();
  check('검수용 후원만 선택', await detail.count() === 1);
  await Promise.all([creator.waitForURL(/\/studio\/donations\/[^/?]+$/), detail.click()]);
  await creator.waitForLoadState('networkidle');
  await creator.locator('textarea[name="body"]').waitFor();
  check('실거래 아닌 테스트 후원 확인', (await creator.locator('body').innerText()).includes('테스트 거래'));
  const textarea = creator.locator('textarea[name="body"]');
  const original = await textarea.inputValue();
  const reply = '화면 점검용 답글입니다. 응원 감사합니다.';
  await textarea.fill(reply);
  await creator.getByRole('button', { name: '답글 수정', exact: true }).click();
  await creator.getByText('답글을 저장했습니다.', { exact: false }).waitFor();
  await ready(page, '/c/TOR-8K2M/messages');
  check('크리에이터 저장 후 후원자에게 답글 반영', (await page.locator('main').innerText()).includes(reply));
  await textarea.fill(original);
  await Promise.all([
    creator.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/studio/donations/')),
    creator.getByRole('button', { name: '답글 수정', exact: true }).click(),
  ]);
  await creator.waitForLoadState('networkidle');
  await creatorContext.close();
  check('브라우저 런타임 오류 없음', errors.length === 0);
  console.log(JSON.stringify({ checks: checks.length, screenshots: output, errors }, null, 2));
} finally { await context.close(); await browser.close(); }
