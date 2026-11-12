/**
 * 금액별 후원 연출 차등 시뮬레이션 (2026-11-12).
 *
 * 실제 서버에 로그인해 화면으로 확인한다.
 *  1) 스튜디오: 금액별 연출 카드 · 자동 방식 기본값 · 구간 표
 *  2) 방송 화면(1920x1080): 금액별로 1~5단계가 재생되는지, 5단계 회오리가 뜨는지, 글자를 가리지 않는지
 *  3) 가벼운 효과 모드 · 끄기 방식 · 직접 설정(구간 단계 지정)
 *  4) 최고관리자: 기준 수정 → 다음 테스트 후원부터 반영 → 잘못된 값 거절 → 기본값 복구 → 감사로그
 *
 * 실행: 서버를 띄운 뒤  node e2e/overlay-ladder-e2e.mjs
 *       (최고관리자 단계는 SEED_ADMIN_PASSWORD 로 시드한 DB 가 필요하다)
 *       화면 캡처는 E2E_SHOT_DIR(기본 tmp/overlay-ladder) 에 남는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE, bodyText, createReporter, gotoReady, launch, loginAdmin, loginCreator } from './_helpers.mjs';

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? path.resolve(process.cwd(), 'tmp/overlay-ladder');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const r = createReporter('금액별 후원 연출');
const browser = await launch();

/** 테스트 후원 폼(스튜디오)에 금액을 넣고 보낸다. */
async function sendTest(studio, amount, donorName = '시뮬레이션') {
  const form = studio.locator('form:has(button:has-text("테스트 후원 보내기"))').first();
  await form.locator('input[name=donorName]').fill(donorName);
  await form.locator('input[name=amount]').fill(String(amount));
  await form.locator('button:has-text("테스트 후원 보내기")').click();
}

/** 방송 화면에서 지금 재생 중인 알림의 단계 정보를 읽는다. 재생이 시작될 때까지 기다린다. */
async function waitStage(overlay, timeout = 15_000) {
  const stage = overlay.locator('[data-effect-level]').first();
  await stage.waitFor({ state: 'attached', timeout });
  return {
    level: Number(await stage.getAttribute('data-effect-level')),
    light: (await stage.getAttribute('data-light-effects')) === '1',
    tornado: await overlay.locator('[data-tornado-sweep]').count(),
    sticker: await overlay
      .locator('img[src*="/stickers/donaido/"]')
      .first()
      .getAttribute('src')
      .catch(() => null),
  };
}

/** 알림이 끝나 화면에서 내려갈 때까지 기다린다(다음 알림과 섞이지 않게). */
async function waitIdle(overlay, timeout = 25_000) {
  await overlay.locator('[data-effect-level]').first().waitFor({ state: 'detached', timeout }).catch(() => {});
  await overlay.waitForTimeout(400);
}

/** 글자(후원자 이름)가 화면 안에 있고 다른 요소에 덮이지 않았는지. */
async function nameVisible(overlay, donorName) {
  return overlay.evaluate((name) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.includes(name)) continue;
      const el = node.parentElement;
      if (!el) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const inside = box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const top = document.elementFromPoint(cx, cy);
      // pointer-events:none 인 연출 레이어는 elementFromPoint 에 잡히지 않는다. 글자 자신이나 그 조상이면 통과.
      const covered = top !== null && !(top === el || top.contains(el) || el.contains(top));
      return { found: true, inside, covered };
    }
    return { found: false, inside: false, covered: false };
  }, donorName);
}

async function saveMode(studio, { mode, light, combo }) {
  const form = studio.locator('form:has(button:has-text("연출 방식 저장"))').first();
  await form.locator(`input[name=tierMode][value=${mode}]`).check();
  if (light !== undefined) await form.locator('input[name=lightEffects]').setChecked(light);
  if (combo !== undefined) await form.locator('input[name=comboBoost]').setChecked(combo);
  await form.locator('button:has-text("연출 방식 저장")').click();
  await studio.waitForTimeout(2500);
  return bodyText(studio);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const studio = await ctx.newPage();
  const consoleErrors = [];

  // ══════════════ 1. 스튜디오 화면 ══════════════
  await loginCreator(studio);
  await gotoReady(studio, `${BASE}/studio/overlay`);
  let text = await bodyText(studio);
  r.ok('금액별 연출 카드가 보인다', text.includes('금액별 연출') && text.includes('연출 방식 저장'));
  r.ok('방식 3가지', ['자동 (추천)', '직접 설정', '끄기'].every((t) => text.includes(t)));
  r.ok(
    '자동 방식 구간 표 (기본 기준 5단계)',
    ['1,000원 이상 ~ 10,000원 미만', '10,000원 이상 ~ 30,000원 미만', '30,000원 이상 ~ 50,000원 미만', '50,000원 이상 ~ 100,000원 미만', '100,000원 이상'].every((t) => text.includes(t)),
  );
  r.ok('연속 후원 · 가벼운 효과 스위치', text.includes('연속 후원 단계 상승') && text.includes('가벼운 효과 모드'));
  r.ok(
    '새 크리에이터는 자동 방식이 선택돼 있다',
    await studio.locator('input[name=tierMode][value=AUTO]').first().isChecked(),
  );

  const iframeSrc =
    (await studio.locator('iframe[src*="/overlay/"]').first().getAttribute('src').catch(() => null)) ?? '';
  const creatorId = /\/overlay\/([^/?]+)/.exec(iframeSrc)?.[1] ?? '';
  r.ok('미리보기 주소에서 크리에이터 ID 를 읽는다', Boolean(creatorId), iframeSrc.slice(0, 80));

  // ══════════════ 2. 방송 화면 — 금액별 5단계 ══════════════
  const overlay = await ctx.newPage();
  await overlay.setViewportSize({ width: 1920, height: 1080 });
  overlay.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  overlay.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  await overlay.goto(`${BASE}/overlay/${creatorId}?preview=1&audio=0`, { waitUntil: 'load' });
  await overlay.waitForTimeout(3000);

  // 깨끗한 상태에서 시작한다(이전 실행이 남긴 설정을 지운다).
  await saveMode(studio, { mode: 'AUTO', light: false, combo: true });

  const ladder = [
    [3000, 1, 'heart-peek'],
    [10000, 2, 'thanks-bow'],
    [30000, 3, 'gift-pop'],
    [50000, 4, null],
    [100000, 5, null],
  ];
  for (const [amount, level, stickerHint] of ladder) {
    const name = `단계${level}`;
    await sendTest(studio, amount, name);
    let got = null;
    try {
      got = await waitStage(overlay);
    } catch (e) {
      r.ok(`${amount.toLocaleString('ko-KR')}원 → ${level}단계 재생`, false, String(e.message).slice(0, 120));
      continue;
    }
    r.ok(`${amount.toLocaleString('ko-KR')}원 → ${level}단계 재생`, got.level === level, `실제 ${got.level}단계`);
    if (stickerHint) {
      r.ok(`${level}단계 캐릭터 효과`, Boolean(got.sticker && got.sticker.includes(stickerHint)), String(got.sticker));
    }
    r.ok(`${level}단계 회오리 연출 ${level === 5 ? '있음' : '없음'}`, level === 5 ? got.tornado === 1 : got.tornado === 0, `개수 ${got.tornado}`);

    await overlay.waitForTimeout(1500);
    await overlay.screenshot({ path: path.join(SHOT_DIR, `level-${level}.png`) });
    const vis = await nameVisible(overlay, name);
    r.ok(`${level}단계 글자가 화면 안에 있고 가려지지 않는다`, vis.found && vis.inside && !vis.covered, JSON.stringify(vis));
    await waitIdle(overlay);
  }

  // 경계 금액
  for (const [amount, level] of [[9999, 1], [29999, 2], [49999, 3], [99999, 4]]) {
    await sendTest(studio, amount, `경계${amount}`);
    const got = await waitStage(overlay).catch(() => null);
    r.ok(`경계 ${amount.toLocaleString('ko-KR')}원 → ${level}단계`, got?.level === level, `실제 ${got?.level}`);
    // 경계 확인은 단계만 보면 되므로 다음 알림이 밀리지 않게 끝까지 기다린다.
    await waitIdle(overlay);
  }

  // ══════════════ 3. 가벼운 효과 · 끄기 · 직접 설정 ══════════════
  text = await saveMode(studio, { mode: 'AUTO', light: true });
  r.ok('가벼운 효과 모드 저장', text.includes('저장했습니다'));
  await sendTest(studio, 100000, '가벼운');
  {
    const got = await waitStage(overlay).catch(() => null);
    r.ok('가벼운 효과 모드: 5단계지만 회오리 · 테두리 빛을 뺀다', got?.level === 5 && got.light && got.tornado === 0, JSON.stringify(got));
    await overlay.waitForTimeout(1200);
    await overlay.screenshot({ path: path.join(SHOT_DIR, 'level-5-light.png') });
    await waitIdle(overlay);
  }

  text = await saveMode(studio, { mode: 'OFF', light: false });
  r.ok('끄기 방식 저장', text.includes('[끄기]'));
  await sendTest(studio, 100000, '끄기');
  {
    const got = await waitStage(overlay).catch(() => null);
    r.ok('끄기 방식: 10만원도 1단계 (금액과 무관)', got?.level === 1 && got.tornado === 0, JSON.stringify(got));
    await waitIdle(overlay);
  }

  // 직접 설정: 구간이 없으면 안내가 뜬다 → 추천 구간(5단계)을 불러와 저장한다.
  text = await saveMode(studio, { mode: 'CUSTOM' });
  r.ok('직접 설정 + 구간 없음 → 안내', text.includes('아직 만든 금액 구간이 없어'));
  await gotoReady(studio, `${BASE}/studio/overlay`);
  await studio.locator('summary:has-text("고급 설정")').first().click();
  await studio.waitForTimeout(400);
  await studio.locator('button:has-text("추천 구간 불러오기")').first().click();
  await studio.waitForTimeout(400);
  r.ok('추천 구간 5개가 들어온다', (await studio.locator('button[aria-label="구간 삭제"]').count()) === 5);
  r.ok('구간마다 연출 단계 선택이 있다', (await bodyText(studio)).includes('연출 단계'));
  await studio.locator('button:has-text("구간 저장")').first().click();
  await studio.waitForTimeout(3000);
  r.ok('구간 저장', (await bodyText(studio)).includes('금액 구간 5개를 저장했습니다'));
  await sendTest(studio, 100000, '직접');
  {
    const got = await waitStage(overlay).catch(() => null);
    r.ok('직접 설정: 5단계로 지정한 구간이 5단계로 재생된다', got?.level === 5 && got.tornado === 1, JSON.stringify(got));
    await waitIdle(overlay);
  }

  // 원복: 구간을 지우고 자동 방식으로 되돌린다.
  await gotoReady(studio, `${BASE}/studio/overlay`);
  await studio.locator('summary:has-text("고급 설정")').first().click();
  await studio.waitForTimeout(400);
  for (let i = 0; i < 6; i += 1) {
    const del = studio.locator('button[aria-label="구간 삭제"]').first();
    if ((await del.count()) === 0) break;
    await del.click();
  }
  await studio.locator('button:has-text("구간 저장")').first().click();
  await studio.waitForTimeout(2500);
  text = await saveMode(studio, { mode: 'AUTO', light: false, combo: true });
  r.ok('자동 방식으로 원복', text.includes('[자동]'));

  // ══════════════ 4. 최고관리자 기준 ══════════════
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log('SKIP | 최고관리자 단계 (SEED_ADMIN_PASSWORD 없음)');
  } else {
    const actx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const admin = await actx.newPage();
    // 관리자 화면의 확인창은 브라우저 기본 confirm 이다. 자동으로 수락한다.
    admin.on('dialog', (d) => d.accept().catch(() => {}));
    await loginAdmin(admin);
    await gotoReady(admin, `${BASE}/admin/overlay-effects`);
    let at = await bodyText(admin);
    r.ok('관리자 메뉴에 [후원 연출 기준]', at.includes('후원 연출 기준'));
    r.ok('현재 구간 표', at.includes('100,000원 이상') && at.includes('5단계 · 토네이도'));

    const form = admin.locator('form:has(button:has-text("기준 저장"))').first();
    const submit = async () => {
      await form.locator('button:has-text("기준 저장")').click();
      await admin.waitForTimeout(3000);
      return bodyText(admin);
    };

    // 잘못된 값: 3단계를 2단계보다 작게
    await form.locator('input[name=minAmount3]').fill('5000');
    at = await submit();
    r.ok('금액이 오름차순이 아니면 거절한다', at.includes('3단계 시작 금액은 2단계'), at.slice(-200));

    // 올바른 값: 2단계를 5,000원부터
    await gotoReady(admin, `${BASE}/admin/overlay-effects`);
    await form.locator('input[name=minAmount2]').fill('5000');
    at = await submit();
    r.ok('기준 저장', at.includes('후원 연출 기준을 저장했습니다'), at.slice(-200));
    await gotoReady(admin, `${BASE}/admin/overlay-effects`);
    r.ok('저장한 구간이 표에 반영된다', (await bodyText(admin)).includes('5,000원 이상 ~ 30,000원 미만'));

    // 캐시(5초)가 지난 뒤 크리에이터 화면과 방송에 반영되는지
    await studio.waitForTimeout(6000);
    await gotoReady(studio, `${BASE}/studio/overlay`);
    r.ok('스튜디오 구간 표도 바뀐다', (await bodyText(studio)).includes('5,000원 이상 ~ 30,000원 미만'));
    await sendTest(studio, 5000, '기준변경');
    {
      const got = await waitStage(overlay).catch(() => null);
      r.ok('기준 변경 뒤 5,000원 → 2단계', got?.level === 2, JSON.stringify(got));
      await waitIdle(overlay);
    }

    // 기본값 복구
    await gotoReady(admin, `${BASE}/admin/overlay-effects`);
    await admin.locator('button:has-text("기본값으로 되돌리기")').first().click();
    await admin.waitForTimeout(3000);
    r.ok('기본값으로 되돌리기', (await bodyText(admin)).includes('기본값으로 되돌렸습니다'));
    await studio.waitForTimeout(6000);
    await sendTest(studio, 5000, '복구');
    {
      const got = await waitStage(overlay).catch(() => null);
      r.ok('복구 뒤 5,000원 → 1단계', got?.level === 1, JSON.stringify(got));
      await waitIdle(overlay);
    }

    await gotoReady(admin, `${BASE}/admin/audit`);
    at = await bodyText(admin);
    r.ok('감사로그에 변경·복구 기록', at.includes('OVERLAY_LADDER_UPDATE') && at.includes('OVERLAY_LADDER_RESET'));
    await actx.close();
  }

  r.ok('방송 화면 콘솔 오류 0건', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' / '));
  await ctx.close();
} catch (e) {
  r.ok('시뮬레이션 중단 없이 끝난다', false, String(e?.stack ?? e).slice(0, 400));
} finally {
  await browser.close();
  r.finish();
}
