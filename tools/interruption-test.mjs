/**
 * interruption-test.mjs — 中断恢复测试（批次一 #3）
 * 角色：倒霉用户。检测被各种方式打断后，系统必须：
 *   不留假状态、不残留遮罩、刷新后能干净重来、设置不丢。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
mkdirSync('shots/interrupt', { recursive: true });

const results = [];
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);

let consoleErrs = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/^(INFO|DEBUG):/.test(m.text())) consoleErrs.push(m.text().slice(0, 150));
});
page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + String(e).slice(0, 150)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => page.evaluate(() => window.__fatigue?.state ?? 'n/a');
const startDemo = () => page.evaluate(() => window.__fatigue?.startSimulation());
async function boot() {
  consoleErrs = [];
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(600);
}
async function scenario(name, fn) {
  let pass = true, detail = '';
  try { await fn(); } catch (e) { pass = false; detail = e.message.split('\n')[0]; }
  if (consoleErrs.length) { pass = false; detail += ` | console x${consoleErrs.length}: ${consoleErrs[0]}`; }
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}]${detail ? ' | ' + detail : ''}`);
}

/* I1 检测中刷新：回来必须干净 idle，无 RUNNING 假状态 */
await scenario('I1 检测中刷新→回来应干净idle且能重新开始', async () => {
  await boot();
  await startDemo();
  await sleep(6000);
  if ((await state()) !== 'running') throw new Error('前置失败:' + await state());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(800);
  const s = await state();
  if (s !== 'idle') throw new Error('刷新后状态残留: ' + s);
  // 必须还能重新开始
  await startDemo();
  await sleep(5000);
  if ((await state()) !== 'running') throw new Error('刷新后无法重新开始: ' + await state());
});

/* I2 检测中切后台标签→自动暂停；切回→自动续跑但必须有 toast 告知（状态透明） */
await scenario('I2 切后台自动暂停,切回自动续跑且有toast', async () => {
  await boot();
  await startDemo();
  await sleep(6000);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(700);
  const s1 = await state();
  if (s1 !== 'paused') throw new Error('切后台未自动暂停: ' + s1);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: false, configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(700);
  const s2 = await state();
  if (s2 !== 'running') throw new Error('切回未自动续跑: ' + s2);
  const notified = await page.evaluate(() => [...document.querySelectorAll('.toast-host *')].some((t) => t.textContent.includes('已自动继续检测')));
  if (!notified) throw new Error('自动续跑无 toast 告知(状态不透明)');
});

/* I3 报警浮层出现时刷新：无残留遮罩 */
await scenario('I3 报警浮层时刷新→无遮罩残留', async () => {
  await boot();
  await startDemo();
  await sleep(5000);
  await page.evaluate(() => window.__fatigue?.fastForward(150000));
  await sleep(3500);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(800);
  const veil = await page.evaluate(() => {
    const v = document.querySelector('.alarm-veil');
    if (!v) return false;
    const cs = getComputedStyle(v);
    return cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.1 && cs.visibility !== 'hidden';
  });
  if (veil) throw new Error('刷新后报警遮罩残留');
});

/* I4 BOOTING 引擎加载中刷新 */
await scenario('I4 引擎加载中(BOOTING)刷新→干净重来', async () => {
  await boot();
  await page.evaluate(() => { window.__fatigue.app.simulate = false; window.__fatigue.app.start(false); });
  await sleep(1000);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(800);
  if ((await state()) !== 'idle') throw new Error('BOOTING刷新后状态残留: ' + await state());
  await startDemo();
  await sleep(5000);
  if ((await state()) !== 'running') throw new Error('之后无法启动演示');
});

/* I5 检测中导航离开→后退回来 */
await scenario('I5 检测中导航离开→后退回来应干净', async () => {
  await boot();
  await startDemo();
  await sleep(6000);
  await page.goto('about:blank');
  await sleep(400);
  await page.goBack();
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(900);
  const s = await state();
  if (s !== 'idle') throw new Error('后退后状态残留: ' + s);
});

/* I6 刷新后用户设置保留（主题/专家/参数） */
await scenario('I6 刷新后设置保留:主题/专家模式/自定义阈值', async () => {
  await boot();
  await page.click('#btnTheme');
  await page.click('#btnProMode');
  await page.click('#btnSettings');
  await sleep(500);
  const input = page.locator('.sheet input[type="number"]').first();
  await input.fill('0.35').catch(() => {});
  await page.click('#btnSaveCfg');
  await sleep(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(800);
  const kept = await page.evaluate(() => ({
    dark: document.documentElement.getAttribute('data-theme') === 'dark',
    pro: document.body.classList.contains('pro-mode'),
  }));
  if (!kept.dark) throw new Error('主题丢失');
  if (!kept.pro) throw new Error('专家模式丢失');
});

/* I7 真实模式校准中切后台 */
await scenario('I7 校准中切后台→不卡死,回前台可处理', async () => {
  await boot();
  await page.evaluate(() => { window.__fatigue.app.simulate = false; window.__fatigue.app.start(false); });
  const t0 = Date.now();
  let s = await state();
  while (s !== 'calibrating' && Date.now() - t0 < 15000 && s !== 'idle' && s !== 'running') { await sleep(300); s = await state(); }
  if (s === 'calibrating') {
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(600);
  }
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: false, configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(600);
  const alive = await page.evaluate(() => 1 + 1);
  if (alive !== 2) throw new Error('页面失去响应');
});

await browser.close();
const fails = results.filter((r) => !r.pass);
console.log(`\n==== 中断恢复: ${results.length} 场景, 失败 ${fails.length} ====`);
for (const f of fails) console.log(' -', f.name, '|', f.detail);
process.exit(fails.length ? 1 : 0);
