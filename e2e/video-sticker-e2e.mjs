/**
 * 영상 상품 스티커 · 유튜브 API 관리 E2E (2026-11-18)
 *
 *   npm run preview  (다른 터미널)
 *   node e2e/video-sticker-e2e.mjs
 *
 * 1) 크리에이터: 상품 진열 → 직접 등록 영상(틱톡·유튜브)·라이브에 상품 연결(유튜브는 시간 지정)
 * 2) 후원자: 샵 영상 탭에서 상품 배지·스티커·[이 영상 속 상품] → 시트에서 장바구니 담기 → 장바구니 확인
 * 3) 최고관리자: 유튜브 연동 탭 3개, 잘못된 API 키 거절, 영상 수집 화면
 */
import { ACCOUNTS, BASE, SEED, bodyText, createReporter, desktop, gotoReady, launch, login, loginCreator, mobile } from './_helpers.mjs';

const { ok, step, finish } = createReporter('영상 상품 스티커 · 유튜브 API 관리');
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS ?? '';

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    // 유튜브 · 틱톡 플레이어(외부 iframe)가 남기는 콘솔 오류는 우리 화면 오류가 아니다
    const from = m.location()?.url ?? '';
    if (from && !from.startsWith(BASE)) return;
    if (m.type() === 'error' && !/favicon|Failed to load resource|youtube|tiktok|ytimg|googlevideo|Permissions policy violation/i.test(m.text())) errors.push(`${tag} console: ${m.text().slice(0, 200)}`);
  });
}

/** 스튜디오 액션 폼 결과 문구(폼 아래 알림)를 기다려 읽는다 */
async function resultText(scope, pattern) {
  const n = scope.getByText(pattern).first();
  await n.waitFor({ timeout: 20_000 });
  return n.innerText();
}

const TIKTOK = 'https://www.tiktok.com/@donaido/video/7300000000000000001';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// ------------------------------------------------------------------ 1) 크리에이터
const cctx = await browser.newContext(desktop);
const cpage = await cctx.newPage();
watch(cpage, 'creator');
await step('크리에이터 로그인', () => loginCreator(cpage));

await step('상품 1개 이상 진열', async () => {
  await gotoReady(cpage, `${BASE}/studio/shop/products`);
  const shown = await cpage.getByRole('button', { name: '진열 중 · 내리기' }).count();
  if (shown > 0) return true;
  await cpage.getByRole('button', { name: '내 샵에 진열' }).first().click();
  await cpage.waitForTimeout(1500);
  await gotoReady(cpage, `${BASE}/studio/shop/products`);
  return (await cpage.getByRole('button', { name: '진열 중 · 내리기' }).count()) > 0;
});

for (const url of [TIKTOK, YT]) {
  await step(`영상 직접 등록 (${url.includes('tiktok') ? '틱톡' : '유튜브'})`, async () => {
    await gotoReady(cpage, `${BASE}/studio/shop`);
    if ((await bodyText(cpage)).includes(url.includes('tiktok') ? '7300000000000000001' : 'dQw4w9WgXcQ')) return true;
    await cpage.fill('input[name=url]', url);
    await cpage.getByRole('button', { name: '영상 추가' }).click();
    await cpage.waitForTimeout(1500);
    await gotoReady(cpage, `${BASE}/studio/shop`);
    return (await bodyText(cpage)).includes(url.includes('tiktok') ? 'TikTok' : 'YouTube');
  });
}

await step('스튜디오: 라이브 방송 상품 섹션과 영상별 상품 연결 설정이 보인다', async () => {
  await gotoReady(cpage, `${BASE}/studio/shop`);
  const t = await bodyText(cpage);
  return t.includes('라이브 방송 상품') && (t.includes('이 영상에 상품 연결하기') || t.includes('클릭 '));
});

async function attach(summaryIndexMatcher, opts = {}) {
  await gotoReady(cpage, `${BASE}/studio/shop`);
  const expect = opts.expect ?? /연결했습니다|처리하지|뒤여야|오류/;
  const details = cpage.locator('details').filter({ has: cpage.locator(`input[name=externalId][value="${summaryIndexMatcher}"]`) }).first();
  await details.locator('summary').click();
  const select = details.locator('select[name=productId]');
  const values = await select.locator('option:not([disabled])').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  if (!values.length) throw new Error('고를 수 있는 상품이 없습니다');
  await select.selectOption(values[0]);
  if (opts.range) {
    await details.getByText('시간 지정').click();
    await details.locator('input[name=start]').fill(opts.range[0]);
    await details.locator('input[name=end]').fill(opts.range[1]);
  }
  await details.getByRole('button', { name: /상품 연결|변경 저장/ }).click();
  return resultText(details, expect);
}

await step('틱톡 영상에 상품 연결 (시간 지정 칸 없음)', async () => {
  await gotoReady(cpage, `${BASE}/studio/shop`);
  const d = cpage.locator('details').filter({ has: cpage.locator('input[name=externalId][value="7300000000000000001"]') }).first();
  await d.locator('summary').click();
  const noTiming = (await d.getByText('시간 지정').count()) === 0;
  const t = await attach('7300000000000000001');
  return noTiming && t.includes('연결했습니다');
});

await step('유튜브 영상에 상품 연결 + 잘못된 시간은 거절', async () => {
  const bad = await attach('dQw4w9WgXcQ', { range: ['2:00', '1:00'], expect: /뒤여야/ });
  if (!bad.includes('뒤여야')) throw new Error(`거절 문구 없음: ${bad.slice(0, 80)}`);
  const good = await attach('dQw4w9WgXcQ', { range: ['0:05', '9:00'] });
  return good.includes('연결했습니다');
});

await step('라이브 방송에 상품 연결', async () => {
  const t = await attach('LIVE');
  return t.includes('라이브 방송에 상품을 연결했습니다');
});

await step('스튜디오 요약: 시간대 배지가 보인다', async () => {
  await gotoReady(cpage, `${BASE}/studio/shop`);
  const t = await bodyText(cpage);
  return t.includes('0:05 ~ 9:00') && t.includes('방송 내내') && t.includes('클릭 0');
});
if (shots) await cpage.screenshot({ path: `${shots}/studio-shop.png`, fullPage: true });

// ------------------------------------------------------------------ 2) 후원자
for (const [label, ctxOpt] of [['PC', desktop], ['모바일', mobile]]) {
  const dctx = await browser.newContext(ctxOpt);
  const dpage = await dctx.newPage();
  watch(dpage, `donor-${label}`);
  await step(`[${label}] 후원자 로그인`, () => login(dpage, ACCOUNTS.donor, { expectUrl: /\/(my|)$|\/$/ }));
  await step(`[${label}] 영상 탭: 상품이 연결된 영상에 '상품' 배지`, async () => {
    await gotoReady(dpage, `${BASE}/c/${SEED.creator1Code}?tab=video`);
    return (await dpage.locator('button[aria-pressed] >> text=상품').count()) >= 2;
  });
  await step(`[${label}] 틱톡 영상 재생: 플레이어 아래 [이 영상 속 상품] 1개`, async () => {
    await dpage.locator('button[aria-pressed]').filter({ hasText: 'TikTok' }).first().click();
    await dpage.waitForTimeout(500);
    const strip = dpage.getByRole('button', { name: /이 영상 속 상품/ });
    return (await strip.count()) === 1;
  });
  await step(`[${label}] 외부 플레이어 위에는 아무것도 겹치지 않는다 (유튜브 임베드 정책, 7차 P1-2)`, async () => {
    const overlapped = await dpage.evaluate(() => {
      const frame = document.querySelector('iframe[src*="tiktok.com/embed"]');
      if (!frame) return 'no-frame';
      const box = frame.parentElement;
      // 플레이어 상자 안에는 iframe 말고 다른 요소가 없어야 한다
      const extra = box ? [...box.children].filter((el) => el !== frame) : [];
      const r = frame.getBoundingClientRect();
      const strip = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('이 영상 속 상품'));
      const sr = strip?.getBoundingClientRect();
      const stripOverlaps = sr ? sr.top < r.bottom - 1 && sr.bottom > r.top + 1 && sr.left < r.right && sr.right > r.left : true;
      return extra.length === 0 && !stripOverlaps ? 'ok' : `extra=${extra.length} overlap=${stripOverlaps}`;
    });
    if (overlapped !== 'ok') throw new Error(overlapped);
    return true;
  });
  await step(`[${label}] 시트에서 장바구니 담기 (영상은 그대로)`, async () => {
    await dpage.getByRole('button', { name: /이 영상 속 상품/ }).click();
    const sheet = dpage.locator('[role=dialog]').last();
    await sheet.waitFor();
    if (shots) await dpage.screenshot({ path: `${shots}/sheet-${label}.png` });
    await sheet.getByRole('button', { name: '장바구니' }).click();
    await sheet.getByText('장바구니에 담았습니다').waitFor({ timeout: 15_000 });
    const iframeStill = (await dpage.locator('iframe[src*="tiktok.com/embed"]').count()) === 1;
    await sheet.getByRole('button', { name: '닫기' }).last().click();
    return iframeStill;
  });
  await step(`[${label}] 유튜브 영상: 시간 지정 상품은 재생 위치를 모를 때 강조하지 않고 아래 줄은 보인다`, async () => {
    await dpage.locator('button[aria-pressed]').filter({ hasText: 'YouTube' }).first().click();
    await dpage.waitForTimeout(800);
    const src = await dpage.locator('iframe[src*="youtube-nocookie.com/embed/dQw4w9WgXcQ"]').getAttribute('src');
    const strip = dpage.getByRole('button', { name: /이 영상 속 상품/ });
    const notHighlighted = (await strip.getAttribute('data-now-showing')) === 'off';
    return Boolean(src?.includes('enablejsapi=1')) && notHighlighted && (await strip.count()) === 1;
  });
  await step(`[${label}] 장바구니에 담긴 상품 확인`, async () => {
    await gotoReady(dpage, `${BASE}/c/${SEED.creator1Code}/cart`);
    const t = await bodyText(dpage);
    return !t.includes('장바구니가 비어');
  });
  await dctx.close();
}

// ------------------------------------------------------------------ 3) 최고관리자
const actx = await browser.newContext(desktop);
const apage = await actx.newPage();
watch(apage, 'admin');
await step('관리자 로그인', () => login(apage, ACCOUNTS.admin, { expectUrl: /\/admin/ }));
await step('유튜브 연동: 탭 3개(채널 연동·API 키 관리·영상 수집)', async () => {
  await gotoReady(apage, `${BASE}/admin/youtube`);
  const nav = apage.locator('nav[aria-label="유튜브 연동 메뉴"]');
  return (await nav.getByRole('link').count()) === 3 && (await bodyText(apage)).includes('채널 연결 상태');
});
await step('API 키 관리: 형식이 틀린 키는 저장하지 않는다', async () => {
  await gotoReady(apage, `${BASE}/admin/youtube/api`);
  await apage.fill('input[name=apiKey]', 'not-a-key');
  await apage.getByRole('button', { name: /키 저장하고 확인|새 키로 바꾸기/ }).click();
  await apage.getByText(/API 키 형식이 아닙니다/).waitFor({ timeout: 15_000 });
  return true;
});
await step('API 키 관리: 키는 원문 대신 마스킹 · 연결 확인 버튼', async () => {
  const t = await bodyText(apage);
  return t.includes('연결 확인') && t.includes('키 만드는 방법');
});
await step('영상 수집: 키가 없으면 안내 · 채널 추가 잠금', async () => {
  await gotoReady(apage, `${BASE}/admin/youtube/videos`);
  const t = await bodyText(apage);
  return t.includes('수집 채널') && (t.includes('API 키가 없습니다') || t.includes('채널 추가'));
});
if (shots) await apage.screenshot({ path: `${shots}/admin-videos.png`, fullPage: true });
await step('방송국·시청 화면 회귀: /videos 정상', async () => {
  const r = await apage.goto(`${BASE}/videos`);
  return r?.status() === 200;
});

ok('브라우저 오류 없음', errors.length === 0, errors.slice(0, 5).join(' / '));
await browser.close();
finish();
