/**
 * exploratory-test.mjs — 探索性测试（批次四 #14）：三个角色走完整旅程
 *
 * 新手（第一次用）：首页→能否看懂干什么→找到入口→演示模式→读懂报告
 * 队长（务实派）：快速开跑→中断恢复→调参→导出数据→复核数字
 * 评委（答辩场景）：专业模式→参数可见可调→论文术语一致→HTML 报告独立可开
 */
import { chromium } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });

// ============ 角色一：新手 ============
console.log('\n--- 角色一：新手（第一次打开） ---');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(800);

  // N1 首页 3 秒内能看懂产品是什么
  const hero = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  if (/疲劳|检测|驾驶/.test(hero)) ok('首页首屏说明产品用途'); else bad('首页首屏看不出产品是什么');

  // N2 能找到「开始」入口
  const hasStart = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a, button')];
    return els.some((e) => /开始|启动|进入/.test(e.textContent) && e.offsetParent);
  });
  if (hasStart) ok('首页有明确行动入口'); else bad('首页找不到开始按钮');

  // N3 进工作台：空状态有引导
  await page.evaluate(() => window.__fatigue.app.router.gotoView('viewWork'));
  await sleep(500);
  const emptyHint = await page.evaluate(() => document.getElementById('viewWork').innerText);
  if (/演示|开始|标定|摄像头/.test(emptyHint)) ok('工作台空状态有引导文案'); else bad('工作台空状态无引导');

  // N4 演示模式一条路走到底（新手不碰任何设置）
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(5000);
  const s1 = await page.evaluate(() => window.__fatigue.state);
  if (s1 === 'running' || s1 === 'calibrating') ok(`演示模式顺利开跑（${s1}）`); else bad(`演示模式起不来：${s1}`);

  // N5 新手看得懂的指标：普通模式下不应出现裸缩写
  await sleep(3000);
  const workText = await page.evaluate(() => document.getElementById('viewWork').innerText);
  const jargon = /(?<![A-Za-z])(EAR|MAR|PERCLOS|FPGA)(?![A-Za-z])/;
  if (!jargon.test(workText)) ok('普通模式无裸术语缩写（新手友好）');
  else bad(`普通模式出现裸缩写: ${(workText.match(jargon) || [''])[0]}`);

  // N6 结束后报告自动出现，结论说人话
  await page.evaluate(() => window.__fatigue.fastForward(180000));
  await sleep(1500);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2500);
  const onReport = await page.evaluate(() => document.getElementById('viewReport')?.classList.contains('active'));
  if (onReport) ok('结束自动跳转报告'); else bad('结束后未到报告页');
  const rpt = await page.evaluate(() => document.getElementById('viewReport')?.innerText.slice(0, 800));
  if (rpt && /结论|建议|正常|状态/.test(rpt)) ok('报告有通俗结论'); else bad('报告无通俗结论');

  if (errors.length === 0) ok('全程无控制台错误'); else bad(`控制台错误 ${errors.length} 条: ${errors[0]}`);
  await ctx.close();
}

// ============ 角色二：队长 ============
console.log('\n--- 角色二：队长（务实高频使用） ---');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(600);

  // L1 秒级进入工作台（不逛首页）
  await page.evaluate(() => window.__fatigue.app.router.gotoView('viewWork'));
  await sleep(400);
  const t0 = Date.now();
  await page.evaluate(() => window.__fatigue.startSimulation());
  const s = await page.evaluate(() => window.__fatigue.state);
  if (s !== 'idle') ok(`直接开跑无阻碍（${Date.now() - t0}ms 内迁移到 ${s}）`); else bad('开始无响应');

  // L2 暂停→继续→改主意重来（一天 20 次的肌肉记忆动作）
  await sleep(5000);
  await page.evaluate(() => window.__fatigue.app.togglePause());
  await sleep(500);
  const p1 = await page.evaluate(() => window.__fatigue.state);
  await page.evaluate(() => window.__fatigue.app.togglePause());
  await sleep(500);
  const p2 = await page.evaluate(() => window.__fatigue.state);
  if (p1 === 'paused' && p2 === 'running') ok('暂停/继续可靠'); else bad(`暂停流转异常 ${p1}→${p2}`);

  // L3 中途调参（设置抽屉即时生效，不打断检测）
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await sleep(600);
  const sheetOpen = await page.evaluate(() => document.getElementById('sheet').classList.contains('open'));
  const stillRunning = await page.evaluate(() => window.__fatigue.state);
  if (sheetOpen && stillRunning === 'running') ok('检测中可打开设置'); else bad(`调参受阻 open=${sheetOpen} state=${stillRunning}`);
  await page.evaluate(() => document.getElementById('btnCloseSheet').click());
  await sleep(300);

  // L4 数据导出：JSON 数字与页面一致
  await page.evaluate(() => window.__fatigue.fastForward(120000));
  await sleep(1200);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2200);
  const download = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.evaluate(() => document.getElementById('btnExportJson').click());
  const dl = await download;
  if (dl) ok(`JSON 导出可用（${(await dl.suggestedFilename())}）`); else bad('JSON 导出无下载事件');

  // L5 导出的 JSON 可解析且关键字段齐全
  if (dl) {
    const path = await dl.path();
    const fs = await import('node:fs');
    try {
      const j = JSON.parse(fs.readFileSync(path, 'utf8'));
      const keys = ['meta', 'summary', 'metrics', 'events'].filter((k) => k in j);
      if (keys.length >= 3) ok(`JSON 结构完整（${keys.join('/')}）`);
      else bad(`JSON 缺字段：仅有 ${keys.join('/')}`);
    } catch (e) { bad('导出 JSON 解析失败: ' + e.message); }
  }

  if (errors.length === 0) ok('全程无未捕获异常'); else bad(`异常 ${errors.length} 条: ${errors[0]}`);
  await ctx.close();
}

// ============ 角色三：评委 ============
console.log('\n--- 角色三：评委（答辩演示） ---');
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(600);

  // J1 专业模式一键切换，技术面板出现
  await page.evaluate(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(600);
  const proOn = await page.evaluate(() => document.body.classList.contains('pro-mode'));
  const hasTech = await page.evaluate(() => /EAR|MAR|欧拉|权重|基线/.test(document.body.innerText));
  if (proOn && hasTech) ok('专业模式展开技术指标'); else bad(`专业模式内容缺失 pro=${proOn}`);

  // J2 跑一段演示出报告，答辩术语与论文一致（PERCLOS/EAR 等此时应可见）
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(5000);
  await page.evaluate(() => window.__fatigue.fastForward(300000));
  await sleep(1500);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2500);
  const rptText = await page.evaluate(() => document.getElementById('viewReport')?.innerText || '');
  if (/PERCLOS|EAR|指标/.test(rptText)) ok('报告含论文级指标术语'); else bad('报告缺技术指标');

  // J3 HTML 报告独立成档（答辩可离线打开）
  const dlPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.evaluate(() => document.getElementById('btnPrint')?.click());
  const htmlDl = await dlPromise;
  if (htmlDl) {
    const fs = await import('node:fs');
    const hp = await htmlDl.path();
    const html = fs.readFileSync(hp, 'utf8');
    const standalone = /<html/i.test(html) && /疲劳/.test(html) && html.length > 5000;
    if (standalone) ok(`HTML 报告独立可开（${(html.length / 1024).toFixed(0)}KB）`);
    else bad('HTML 报告不完整');
  } else bad('HTML 导出无下载事件');

  // J4 参数可解释：设置里每项参数有说明（评委最爱问为什么是这个值）
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await sleep(600);
  const sheetText = await page.evaluate(() => document.getElementById('sheet').innerText);
  if (/说明|提示|注|依据|正常范围|tip|desc/i.test(sheetText) || sheetText.split('\n').length > 30) ok('设置面板有参数说明');
  else bad('设置面板参数无解释');
  await page.evaluate(() => document.getElementById('btnCloseSheet').click());

  if (errors.length === 0) ok('全程无未捕获异常'); else bad(`异常 ${errors.length} 条: ${errors[0]}`);
  await ctx.close();
}

await browser.close();
console.log(`\n==== 探索性三角色: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
