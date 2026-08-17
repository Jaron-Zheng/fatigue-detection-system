/**
 * cross-browser-test.mjs — Firefox / WebKit(Safari 近似) 跨内核实测
 * （第五轮遗留项 #3：此前仅有 Chromium 系证据）
 *
 * Playwright 自带构建：Firefox(Juggler) + WebKit(与 Safari 同引擎)。
 * 覆盖每个引擎的应用启动、三视图、演示会话全流程、三种导出、
 * 专业模式、主题切换、控制台零报错。真实摄像头路径不在无头
 * 跨内核环境覆盖（与 Chromium e2e 互补，见测试报告未验证项表）。
 *
 * 用法: node tools/cross-browser-test.mjs
 */
import { firefox, webkit } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

async function waitUntil(cond, timeoutMs = 10000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(intervalMs);
  }
  return await cond();
}

/** 单引擎全流程 */
async function runSuite(label, launcher) {
  console.log(`\n--- ${label} ---`);
  const browser = await launcher();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));

  try {
    // 1. 应用启动
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    const booted = await waitUntil(() => page.evaluate(() => !!window.__fatigue), 20000, 300);
    if (booted) ok('应用启动（__fatigue 就绪）');
    else { bad('应用未启动'); throw new Error('boot fail'); }

    // 2. 三视图切换
    await page.evaluate(() => window.__fatigue.app.router.gotoView('viewWork'));
    await sleep(500);
    if (await page.evaluate(() => document.getElementById('viewWork').classList.contains('active'))) ok('工作台视图激活');
    else bad('工作台未激活');
    await page.evaluate(() => window.__fatigue.app.router.gotoView('viewReport'));
    await sleep(500);
    if (await page.evaluate(() => document.getElementById('viewReport').classList.contains('active'))) ok('报告视图激活');
    else bad('报告未激活');

    // 3. 空报告态导出按钮禁用
    const disabledAll = await page.evaluate(() =>
      ['btnPrint', 'btnExportJson', 'btnExportCsv'].every((id) => document.getElementById(id)?.disabled === true));
    if (disabledAll) ok('空态导出按钮全部禁用'); else bad('空态导出未禁用');

    // 4. 演示会话全流程（含 canvas 渲染）
    await page.evaluate(() => window.__fatigue.startSimulation());
    const running = await waitUntil(() => page.evaluate(() => String(window.__fatigue.state).toLowerCase() === 'running'), 20000, 400);
    if (running) ok('演示会话进入 running');
    else bad('演示会话未 running: ' + await page.evaluate(() => window.__fatigue.state));
    await sleep(2500);
    const score = await page.evaluate(() => window.__fatigue.score);
    if (typeof score === 'number' && !Number.isNaN(score)) ok(`指标计算正常（score=${score.toFixed(1)}）`);
    else bad('指标异常: ' + score);

    // 5. 暂停/恢复
    await page.evaluate(() => window.__fatigue.app.togglePause());
    await sleep(600);
    const paused = await page.evaluate(() => window.__fatigue.state);
    await page.evaluate(() => window.__fatigue.app.togglePause());
    await sleep(600);
    const resumed = await page.evaluate(() => window.__fatigue.state);
    if (String(paused).toLowerCase() === 'paused' && String(resumed).toLowerCase() === 'running') ok('暂停/恢复正常');
    else bad(`暂停流转异常 ${paused}→${resumed}`);

    // 6. 结束 → 报告 + 三种导出
    await page.evaluate(() => window.__fatigue.fastForward(120000));
    await sleep(1500);
    await page.evaluate(() => window.__fatigue.stop());
    await sleep(2500);
    const onReport = await page.evaluate(() => document.getElementById('viewReport').classList.contains('active'));
    if (onReport) ok('结束自动跳报告'); else bad('未跳报告');
    const dlBefore = downloads.length;
    await page.evaluate(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
    await sleep(500);
    for (const id of ['btnPrint', 'btnExportJson', 'btnExportCsv']) {
      await page.evaluate((i) => document.getElementById(i).click(), id);
      await sleep(900);
    }
    const dlOk = await waitUntil(() => Promise.resolve(downloads.length >= dlBefore + 3), 9000, 300);
    if (dlOk) ok(`三种导出均产生下载（+${downloads.length - dlBefore}）`);
    else bad(`导出下载不足: +${downloads.length - dlBefore}`);

    // 7. 专业模式视觉 + 主题切换
    // 注意只断言「激活视图内」的元素：WebKit 对祖先 display:none 的后代
    // 也返回 computed display:none（Chromium/Firefox 返回级联值），
    // 非激活视图里的 .pro-only 不应计入（v2 诊断实测结论）
    const proVisible = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.pro-only')].filter((el) => {
        const v = el.closest('.view');
        return !v || v.classList.contains('active');
      });
      return els.length > 0 && els.every((el) => getComputedStyle(el).display !== 'none');
    });
    if (proVisible) ok('专业模式面板可见（激活视图内）'); else bad('专业模式不可见');
    await page.evaluate(() => window.__fatigue.app.chrome.toggleProMode());
    await page.evaluate(() => window.__fatigue.app.chrome.toggleTheme());
    await sleep(700);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    if (theme === 'dark' || theme === 'light') ok(`主题切换生效（${theme}）`); else bad('主题异常: ' + theme);

    // 8. 控制台
    const realErrors = errors.filter((e) => !/favicon|Download the React/i.test(e));
    if (realErrors.length === 0) ok('全程控制台零报错');
    else bad(`控制台错误 ${realErrors.length} 条: ${realErrors[0]}`);
  } catch (e) {
    bad('套件异常中断: ' + e.message);
  } finally {
    await browser.close();
  }
}

await runSuite('Firefox 153（Playwright 构建）', () => firefox.launch({ headless: true }));
await runSuite('WebKit 26.5（Safari 同引擎）', () => webkit.launch({ headless: true }));

console.log(`\n==== 跨内核实测: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
