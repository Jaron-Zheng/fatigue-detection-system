/**
 * toggle-chaos-test.mjs — 开关状态一致性混沌测试（第六轮）
 *
 * 核心思想：不测"功能能不能点"，测"开关状态在乱序操作后是否仍然真实"——
 * 打开→关闭→打开，功能必须是打开的；导出的文件必须与开关状态一致。
 *
 * 重点复现用户报告：专业模式下下载的 HTML 报告有时和普通模式一样。
 * 嫌疑：exportReportHtml 的空壳折叠不区分专业模式（export-report.js L69-87），
 * 普通模式导出会把空的专业卡折成「未运行」可见文字；专业模式导出时
 * 三张分析卡没跑也折成同样文字 → 两份文件肉眼相同。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const OUT = 'shots/toggle-chaos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
await sleep(600);

const state = () => page.evaluate(() => ({
  proClass: document.body.classList.contains('pro-mode'),
  aria: document.getElementById('btnProMode')?.getAttribute('aria-pressed'),
  ls: localStorage.getItem('fatigue.proMode'),
}));

/** 跑一段演示会话并停在报告页 */
async function runSession() {
  await page.evaluate(() => window.__fatigue.startSimulation());
  await page.waitForFunction(() => window.__fatigue.state === 'running', null, { timeout: 20000 });
  await sleep(1500);
  await page.evaluate(() => window.__fatigue.fastForward(120000));
  await sleep(1200);
  await page.evaluate(() => window.__fatigue.stop());
  await page.waitForFunction(() => document.getElementById('viewReport')?.classList.contains('active'), null, { timeout: 10000 });
  await sleep(600);
}

/** 点击导出并保存文件，返回 { body, html } */
async function exportHtml(tag) {
  const dlPromise = page.waitForEvent('download', { timeout: 10000 });
  await page.evaluate(() => document.getElementById('btnPrint').click());
  const dl = await dlPromise;
  const file = `${OUT}/${tag}.html`;
  await dl.saveAs(file);
  const html = readFileSync(file, 'utf8');
  const body = html.match(/<body[^>]*>/)?.[0] || '';
  return { body, html };
}

// ---------- T1 开→关→开×5：状态必须是开的 ----------
{
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__fatigue.app.chrome.toggleProMode(); });
  // 5 次 = 关→开→关→开→关，最终应为开？初始 idle 无类：1开2关3开4关5开 → 开
  const s = await state();
  if (s.proClass && s.aria === 'true') ok(`奇数次切换后专业模式为开（class=${s.proClass} aria=${s.aria}）`);
  else bad(`奇数次切换后状态错乱: ${JSON.stringify(s)}`);
  // 补一次到关，再开一次：确保「关→开」干净路径
  await page.evaluate(() => window.__fatigue.app.chrome.toggleProMode());
  await page.evaluate(() => window.__fatigue.app.chrome.toggleProMode());
  const s2 = await state();
  if (s2.proClass) ok('关→开后仍为开'); else bad(`关→开失败: ${JSON.stringify(s2)}`);
}

// ---------- T2 会话后专业模式导出：body 必须带 pro-mode ----------
await runSession();
{
  await page.evaluate(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  const { body, html } = await exportHtml('T2-pro');
  if (/class="[^"]*pro-mode/.test(body)) ok('专业模式导出 body 带 pro-mode 类');
  else bad(`专业模式导出丢失 pro-mode: ${body}`);
  if (/id="rpParams"/.test(html) && /<tr/.test(html.match(/id="rpParams"[\s\S]{0,2000}/)?.[0] || '')) ok('专业导出含参数表数据行');
  else bad('专业导出缺参数表');
}

// ---------- T3 【复现用户 bug】普通模式导出不得含专业折叠文案 ----------
{
  await page.evaluate(() => { if (document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  const s = await state();
  if (s.proClass) { bad('前置失败：无法切回普通模式'); }
  else {
    const { body, html } = await exportHtml('T3-normal');
    const noProBody = !/pro-mode/.test(body);
    if (noProBody) ok('普通模式导出 body 无 pro-mode');
    else bad(`普通模式导出 body 泄漏 pro-mode: ${body}`);
    const leak = (html.match(/「[^”]*」本次会话未运行/g) || []).length;
    if (leak === 0) ok('普通模式导出无专业折叠文案泄漏');
    else bad(`普通模式导出泄漏 ${leak} 条专业折叠文案（用户报告的 bug 实锤）`);
    if (!/id="rpParams"/.test(html)) ok('普通模式导出不含专业参数表（整体剥离干净）');
    else bad('普通模式导出仍含专业参数表 DOM');
    // pro-only 元素本身应不可见（display:none 规则存在且 body 无 pro-mode）
    if (/\.pro-only\{[^}]*display:\s*none/.test(html.replace(/\s/g, '')) || /\.pro-only\s*\{[^}]*display:none/.test(html)) ok('导出文件含 .pro-only 隐藏规则');
    else bad('导出文件缺 .pro-only 隐藏规则');
  }
}

// ---------- T4 专业 vs 普通两份文件必须肉眼可辨 ----------
{
  const n = readFileSync(`${OUT}/T3-normal.html`, 'utf8');
  await page.evaluate(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  const { body } = await exportHtml('T4-pro2');
  const p = readFileSync(`${OUT}/T4-pro2.html`, 'utf8');
  const diffMarker = /class="[^"]*pro-mode/.test(body) && !/pro-mode/.test(n.match(/<body[^>]*>/)?.[0] || '');
  if (diffMarker) ok('两份文件 body 类可区分（专业/普通）');
  else bad('两份文件无法区分');
  // 关键差异点：专业版含 pro-only 复活规则（cssText 序列化带空格，正则需兼容）
  const proHasParamsVisible = /body\.pro-mode\s+\.pro-only\s*\{\s*display:\s*revert/.test(p);
  if (proHasParamsVisible) ok('专业版含 pro-only 复活规则');
  else bad('专业版缺 pro-only 复活规则');
}

// ---------- T5 导出瞬间狂切开关（竞态）：文件状态必须取导出那一刻 ----------
{
  // 连续点击导出+切换，验证每次导出的 body 类都自洽（要么 pro 要么普通，不出现半截）
  for (let i = 0; i < 4; i++) {
    const wantPro = i % 2 === 1;
    await page.evaluate((w) => {
      const has = document.body.classList.contains('pro-mode');
      if (has !== w) window.__fatigue.app.chrome.toggleProMode();
    }, wantPro);
    const { body } = await exportHtml(`T5-${i}`);
    const got = /class="[^"]*pro-mode/.test(body);
    if (got === wantPro) ok(`第 ${i + 1} 次导出状态一致（${wantPro ? '专业' : '普通'}）`);
    else bad(`第 ${i + 1} 次导出状态错乱: 期望${wantPro ? '专业' : '普通'} 实得 ${body}`);
  }
}

// ---------- T6 深色主题 + 专业模式：主题强制浅色但 pro 保留 ----------
{
  await page.evaluate(() => {
    if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode();
    if (document.documentElement.dataset.theme !== 'dark') window.__fatigue.app.chrome.toggleTheme();
  });
  await sleep(300);
  const { body } = await exportHtml('T6-dark-pro');
  if (/data-theme="light"/.test(body) && /class="[^"]*pro-mode/.test(body)) ok('深色+专业导出：主题转浅色且 pro 保留');
  else bad(`深色+专业导出异常: ${body}`);
  // 还原主题
  await page.evaluate(() => window.__fatigue.app.chrome.toggleTheme());
}

// ---------- T7 刷新后开关持久化：开着的还是开的 ----------
{
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(600);
  const s = await state();
  if (s.proClass && s.ls === '1') ok(`刷新后专业模式仍为开（ls=${s.ls}）`);
  else bad(`刷新后专业模式丢失: ${JSON.stringify(s)}`);
  // 刷新后直接导出：会话数据在内存中，刷新即清空——导出按钮应禁用（防空文件）。
  // 这是正确行为；随后补跑一次会话，导出仍应是专业版。
  await page.evaluate(() => window.__fatigue.app.router.gotoView('viewReport'));
  await sleep(400);
  const btnState = await page.evaluate(() => document.getElementById('btnPrint').disabled);
  if (btnState === true) ok('刷新后无数据，导出按钮正确禁用');
  else bad('刷新后无数据但导出按钮未禁用（会导出空报告）');
  await runSession();
  const { body } = await exportHtml('T7-after-reload');
  if (/class="[^"]*pro-mode/.test(body)) ok('刷新+新会话后导出仍是专业版');
  else bad(`刷新+新会话后导出退化为普通版: ${body}`);
}

// ---------- T8 渲染开关（网格/镜像/HUD）乱切后状态一致 ----------
{
  const ids = ['btnMesh', 'btnMirror', 'btnHud'];
  for (const id of ids) {
    // 切 3 次（奇数=翻转），aria 必须与 CONFIG 一致
    await page.evaluate((i) => { for (let k = 0; k < 3; k++) document.getElementById(i).click(); }, id);
    await sleep(200);
  }
  const coherence = await page.evaluate(() => {
    const m = { mesh: 'showMesh', mirror: 'mirror', hud: 'showMetricsHud' };
    const res = {};
    for (const [id, key] of Object.entries(m)) {
      const btn = document.getElementById({ mesh: 'btnMesh', mirror: 'btnMirror', hud: 'btnHud' }[key === 'showMesh' ? 'mesh' : key === 'mirror' ? 'mirror' : 'hud']);
      res[id] = { aria: btn?.getAttribute('aria-pressed'), cls: btn?.classList.contains('is-on') };
    }
    res.cfg = { mesh: window.__fatigue ? undefined : undefined };
    return res;
  });
  // 直接对 CONFIG 断言（通过 import）
  const cfgRender = await page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.render));
  const expect = { mesh: cfgRender.showMesh, mirror: cfgRender.mirror, hud: cfgRender.showMetricsHud };
  let allOk = true;
  for (const k of Object.keys(expect)) {
    const c = coherence[k];
    if (String(expect[k]) !== c.aria || expect[k] !== c.cls) { allOk = false; bad(`渲染开关 ${k} 状态不一致: cfg=${expect[k]} aria=${c.aria} class=${c.cls}`); }
  }
  if (allOk) ok('网格/镜像/HUD 乱切 3 次后 aria/class/CONFIG 三方一致');
}

// ---------- T9 设置抽屉：改了不保存 = 没改；保存 = 真的改了 ----------
{
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await sleep(500);
  const before = await page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.calibration.durationSec));
  // 找到时长滑块改到极值，但不点保存
  const changed = await page.evaluate(() => {
    const el = document.querySelector('#sheet input[type="range"]');
    if (!el) return null;
    el.value = el.max;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  });
  await page.evaluate(() => document.getElementById('btnCloseSheet').click());
  await sleep(400);
  const afterNoSave = await page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.calibration.durationSec));
  if (changed !== null && afterNoSave === before) ok(`不保存关闭后参数未变（${before}s）`);
  else if (changed === null) ok('未找到时长滑块（跳过：UI 无该项）');
  else bad(`不保存关闭后参数被改: ${before}→${afterNoSave}`);
}

if (errors.length === 0) ok('全程无未捕获异常');
else bad(`未捕获异常 ${errors.length} 条: ${errors[0]}`);

await browser.close();
console.log(`\n==== 开关混沌: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
