/**
 * 전 메뉴 순회 점검 (2026-11-17). 관리자·스튜디오·마이페이지·공개 화면의 메뉴 링크를 모두 열어
 * 오류 화면(화면을 불러오지 못했습니다 / Application error / 500)이 뜨는지 확인한다.
 *   node e2e/menu-crawl.mjs
 */
import { ACCOUNTS, BASE, createReporter, launch, login, mobile } from './_helpers.mjs';

const { ok, finish } = createReporter('전 메뉴 순회');
const ERR = /화면을 불러오지 못했습니다|Application error|Internal Server Error|This page could not be found|페이지를 찾을 수 없습니다|server-side exception/;

async function collect(page, start, prefix) {
  await page.goto(`${BASE}${start}`, { waitUntil: 'load' });
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  return [...new Set(hrefs.filter((h) => h && h.startsWith(prefix) && !h.includes('logout') && !h.includes('/export')).map((h) => h.split('#')[0]))];
}

async function visitAll(ctx, label, start, prefix, extra = []) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const links = [...new Set([...(await collect(page, start, prefix)), ...extra])].filter((h) => !/^\/(api|overlay|r)\//.test(h));
  for (const href of links) {
    errors.length = 0;
    let status = 0;
    try {
      const res = await page.goto(`${BASE}${href}`, { waitUntil: 'load', timeout: 45_000 });
      status = res?.status() ?? 0;
      await page.waitForTimeout(150);
      const text = await page.locator('body').innerText();
      const bad = ERR.test(text) || status >= 500;
      ok(`${label} ${href}`, !bad && errors.length === 0, bad ? `status ${status} ${text.match(ERR)?.[0] ?? ''}` : errors.join(' / ').slice(0, 160));
    } catch (e) {
      ok(`${label} ${href}`, false, String(e.message).slice(0, 160));
    }
  }
  await page.close();
  return links.length;
}

const browser = await launch();
const viewport = process.env.CRAWL_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const mk = async () => browser.newContext({ viewport, ...(process.env.CRAWL_MOBILE ? { isMobile: true, hasTouch: true } : {}) });

const admin = await mk();
const ap = await admin.newPage();
await login(ap, ACCOUNTS.admin, { expectUrl: /\/admin/ });
await ap.close();
await visitAll(admin, '[관리자]', '/admin', '/admin', ['/admin/vote', '/admin/vote/products', '/admin/vote/offerwall', '/admin/vote/rounds', '/admin/vote/casts', '/admin/vote/tickets', '/admin/talk', '/admin/talk/creators', '/admin/talk/sessions', '/admin/talk/subscriptions', '/admin/talk/reports', '/admin/youtube']);

const creator = await mk();
const cp = await creator.newPage();
await login(cp, ACCOUNTS.creator1, { expectUrl: /\/studio/ });
await cp.close();
await visitAll(creator, '[스튜디오]', '/studio', '/studio', ['/studio/vote', '/studio/talk', '/studio/talk/sessions', '/studio/youtube']);

const donor = await mk();
const dp = await donor.newPage();
await login(dp, ACCOUNTS.donor, { expectUrl: /\/(my)?$/ });
await dp.close();
await visitAll(donor, '[마이]', '/my', '/my', ['/my/votes', '/talk', '/vote', '/vote/charge', '/vote/charge?t=free', '/vote/hall-of-fame', '/']);

// 공개 화면 — 비로그인 / 로그인 각각 메인 페이지의 모든 내부 링크
const anon = await mk();
await visitAll(anon, '[공개]', '/', '/', ['/vote', '/vote/charge', '/vote/charge?t=free', '/vote/hall-of-fame', '/talk']);
await visitAll(donor, '[로그인 메인]', '/', '/');

// 크리에이터 페이지(샵) 탭 — 첫 번째 크리에이터 링크
{
  const p = await donor.newPage();
  await p.goto(`${BASE}/vote`, { waitUntil: 'load' });
  const codes = [...new Set((await p.$$eval('a[href^="/c/"]', (as) => as.map((a) => a.getAttribute('href')))).map((h) => h.split('?')[0]))].slice(0, 3);
  await p.close();
  const extra = codes.flatMap((c) => [c, `${c}?tab=talk`, `${c}/talk`, `${c}/talk/book`]);
  await visitAll(donor, '[크리에이터 페이지]', '/', '/__none__', extra);
}

await browser.close();
finish();
