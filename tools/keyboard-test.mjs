/**
 * keyboard-test.mjs — 纯键盘可用性（批次三 #11 下半场）
 * 覆盖：Tab 全遍历可达性、焦点环可见性、Enter/Space 激活、
 *       Esc 关闭设置抽屉、模态焦点圈禁、空格暂停仅限工作台。
 */
import { chromium } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
await sleep(800);

// ---------- 1. Tab 全遍历：收集可达的交互元素 ----------
{
  const focusables = await page.evaluate(() =>
    [...document.querySelectorAll('a[href], button:not([disabled]), input, select, [tabindex="0"]')]
      .filter((el) => el.offsetParent !== null || el === document.activeElement)
  );
  const seen = new Set();
  let guard = 0, loopedEarly = false;
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  while (guard++ < 200) {
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      return a.id || a.tagName.toLowerCase() + (a.textContent.trim().slice(0, 12) ? ':' + a.textContent.trim().slice(0, 12) : '');
    });
    if (info === null) break;
    if (seen.has(info)) { loopedEarly = true; break; } // 回到起点=一轮完成
    seen.add(info);
    await page.keyboard.press('Tab');
  }
  console.log(`[Tab遍历] 可聚焦元素 ${focusables.length} 个，Tab 实际到达 ${seen.size} 个${loopedEarly ? '（回到起点，一轮完整）' : ''}`);
  if (seen.size >= Math.floor(focusables.length * 0.9)) ok(`Tab 覆盖 ${seen.size}/${focusables.length} 交互元素`);
  else bad(`Tab 只到达 ${seen.size}/${focusables.length}，存在键盘不可达元素`);
}

// ---------- 2. 焦点环可见性 ----------
{
  const invisible = [];
  const handles = await page.$$('#btnStart, #btnSettings, .gn-links a, #btnTheme, #btnProMode');
  let count = 0;
  for (const t of handles) {
    const visible = await t.evaluate((el) => el.offsetParent !== null);
    if (!visible) continue;
    count++;
    const vis = await t.evaluate((el) => {
      el.focus();
      const s = getComputedStyle(el);
      const has = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
      return { has, tag: el.id || el.tagName };
    });
    if (!vis.has) invisible.push(vis.tag);
  }
  if (invisible.length === 0) ok(`关键控件 ${count} 个全部有可见焦点指示`);
  else bad(`无焦点指示: ${invisible.join(', ')}`);
}

// ---------- 3. Enter 激活开始按钮（键盘开检测） ----------
{
  await page.evaluate(() => document.getElementById('btnStart')?.focus());
  await page.keyboard.press('Enter');
  await sleep(1200);
  const state1 = await page.evaluate(() => window.__fatigue.state);
  // headless 无摄像头：booting→error 也证明 Enter 激活成功（状态从 idle 发生迁移）
  if (['booting', 'calibrating', 'running', 'error'].includes(state1)) ok(`Enter 可开始检测（state=${state1}${state1 === 'error' ? '，headless 无摄像头的预期路径' : ''}）`);
  else bad(`Enter 未触发开始（state=${state1}）`);
  // 空格暂停（工作台内）：headless 下用演示模式（不依赖摄像头）
  await page.evaluate(() => { try { const r = window.__fatigue.stop(); if (r && r.catch) r.catch(() => {}); } catch { /* noop */ } });
  await sleep(800);
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(4000);
  await page.keyboard.press(' ');
  await sleep(500);
  const st = await page.evaluate(() => window.__fatigue.state);
  if (st === 'paused') ok('空格在工作台可暂停');
  else bad(`空格未暂停（state=${st}）`);
  await page.keyboard.press(' ');
  await sleep(400);
  // Esc 不应中止检测（留给抽屉）
  await page.keyboard.press('Escape');
  await sleep(400);
  const st2 = await page.evaluate(() => window.__fatigue.state);
  if (st2 === 'running') ok('Esc 在工作台不误伤检测');
  else bad(`Esc 意外改变检测状态（state=${st2}）`);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(1500);
}

// ---------- 4. 设置抽屉：Esc 关闭 + 焦点圈禁 ----------
{
  await page.evaluate(() => document.getElementById('btnSettings')?.click());
  await sleep(700);
  const open = await page.evaluate(() => document.getElementById('sheet').classList.contains('open'));
  if (open) ok('设置抽屉打开');
  else bad('抽屉未打开');

  // 焦点圈禁：Tab 30 次不出抽屉
  let escaped = false;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.getElementById('sheet').contains(document.activeElement));
    if (!inside) { escaped = true; break; }
  }
  if (!escaped) ok('模态打开时 Tab 焦点被困在抽屉内');
  else bad('Tab 从抽屉逃逸到页面底层（无焦点陷阱）');

  await page.keyboard.press('Escape');
  await sleep(500);
  const closed = await page.evaluate(() => !document.getElementById('sheet').classList.contains('open'));
  if (closed) ok('Esc 关闭设置抽屉');
  else bad('Esc 未关闭抽屉');
}

// ---------- 5. 视图切换链接键盘可用 ----------
{
  await page.evaluate(() => document.querySelector('.gn-links a[data-goto="viewHome"]')?.focus());
  await page.keyboard.press('Enter');
  await sleep(500);
  const onHome = await page.evaluate(() => document.getElementById('viewHome').classList.contains('active'));
  if (onHome) ok('Enter 可从导航切回首页');
  else bad('导航链接 Enter 无效');
}

await browser.close();
console.log(`\n==== 键盘可用性: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
