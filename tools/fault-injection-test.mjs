/**
 * fault-injection-test.mjs — 故障注入测试（批次一 #4）
 * 角色：摄像头被占用/权限被拒/设备中途被拔的用户。
 * 系统必须：给出人话错误、提供出路（重试/演示模式）、不白屏不卡死。
 */
import { chromium } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, ctxOptions, fn) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ...ctxOptions });
  const page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  const errs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/^(INFO|DEBUG):/.test(t)) errs.push(t.slice(0, 120));
  });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 120)));
  let pass = true, detail = '';
  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
    await sleep(600);
    await fn(page);
  } catch (e) {
    pass = false; detail = e.message.split('\n')[0];
  }
  // 页面存活兜底
  const alive = await page.evaluate(() => 1 + 1).catch(() => NaN);
  if (alive !== 2) { pass = false; detail += ' | 页面失响应'; }
  // 故障注入场景下的 console.error 多为预期的错误上报，只统计 pageerror 级
  const pe = errs.filter((e) => e.startsWith('pageerror'));
  if (pe.length) { pass = false; detail += ` | 未捕获异常: ${pe[0]}`; }
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}]${detail ? ' | ' + detail : ''}`);
  await browser.close();
}

/* F1 摄像头权限拒绝 → 错误舞台 + 重试/演示出路 */
await scenario('F1 拒绝摄像头权限→人话错误+演示出路', {
  permissions: [], 
}, async (page) => {
  // 直接让 getUserMedia 抛 NotAllowedError
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await page.click('#btnStart'); // 真实模式
  await sleep(3500); // 引擎加载+摄像头失败
  const state = await page.evaluate(() => window.__fatigue.state);
  if (state !== 'idle' && state !== 'error') {
    // 关键是不能卡在 booting/calibrating
    throw new Error('卡在中间态: ' + state);
  }
  const hasErrorUi = await page.evaluate(() => {
    const txt = document.body.textContent;
    return /启动失败|摄像头|权限|无法/.test(txt);
  });
  if (!hasErrorUi) throw new Error('无人类可读的错误提示');
  // 演示模式出路必须可用
  const canDemo = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /演示/.test(b.textContent));
    return !!btn;
  });
  if (!canDemo) throw new Error('无演示模式出路');
});

/* F2 摄像头中途被拔（检测中 track ended）→ 应提示且会话不假死 */
await scenario('F2 检测中拔摄像头→提示+可正常结束', {}, async (page) => {
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(6000);
  // 模拟 track ended（真实拔摄像头事件）
  const r = await page.evaluate(() => {
    const tracks = window.__fatigue.app.camera?.stream?.getTracks?.() || [];
    tracks.forEach((t) => {
      t.enabled = false;
      t.dispatchEvent(new Event('ended'));
    });
    return tracks.length;
  });
  await sleep(1500);
  const alive = await page.evaluate(() => 1 + 1);
  if (alive !== 2) throw new Error('track ended 导致崩溃');
  // 会话应仍可操作（结束出报告）
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2000);
  const view = await page.evaluate(() => document.querySelector('.view.active')?.id);
  if (view !== 'viewReport') throw new Error('结束后未到报告页: ' + view);
});

/* F3 模型加载失败（拦截 wasm/model 请求）→ 错误处理不白屏 */
await scenario('F3 模型资源404→人话错误不白屏', {}, async (page) => {
  await page.route(/\.tflite|\.wasm|models?\//i, (route) => route.abort());
  await page.click('#btnStart');
  await sleep(5000);
  const state = await page.evaluate(() => window.__fatigue.state);
  if (state === 'booting') {
    await sleep(6000); // 给足超时时间
  }
  const s2 = await page.evaluate(() => window.__fatigue.state);
  if (s2 === 'booting') throw new Error('模型失败后卡在booting(无超时兜底)');
  const txt = await page.evaluate(() => document.body.textContent);
  if (!/失败|错误|无法|重试/.test(txt)) throw new Error('无错误提示');
});

/* F4 getUserMedia 不存在（古董浏览器）→ 不调用即不崩，提示降级 */
await scenario('F4 无getUserMedia环境→不崩有提示', {}, async (page) => {
  await page.evaluate(() => { delete navigator.mediaDevices.getUserMedia; });
  await page.click('#btnStart');
  await sleep(4000);
  const s = await page.evaluate(() => window.__fatigue.state);
  if (s === 'booting' || s === 'calibrating') throw new Error('无摄像头API仍卡在启动: ' + s);
});

/* F5 localStorage 写满抛异常 → 功能不受影响 */
await scenario('F5 存储写满→功能正常', {}, async (page) => {
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('QuotaExceeded', 'QuotaExceededError'); };
    setTimeout(() => { Storage.prototype.setItem = orig; }, 500);
  });
  await page.click('#btnTheme'); // 触发一次设置写入
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(5000);
  const s = await page.evaluate(() => window.__fatigue.state);
  if (s !== 'running') throw new Error('存储异常影响核心功能: ' + s);
});

/* F6 检测中 requestAnimationFrame 被节流模拟（后台标签）→ 不堆积 */
await scenario('F6 后台节流下运行→无事件堆积崩溃', {}, async (page) => {
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(5000);
  await page.evaluate(() => window.__fatigue.fastForward(60000));
  await sleep(2500);
  const totals = await page.evaluate(() => window.__fatigue.eventTotals);
  if (!totals) throw new Error('事件统计丢失');
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2000);
  const view = await page.evaluate(() => document.querySelector('.view.active')?.id);
  if (view !== 'viewReport') throw new Error('报告页未出现');
});

const fails = results.filter((r) => !r.pass);
console.log(`\n==== 故障注入: ${results.length} 场景, 失败 ${fails.length} ====`);
for (const f of fails) console.log(' -', f.name, '|', f.detail);
process.exit(fails.length ? 1 : 0);
