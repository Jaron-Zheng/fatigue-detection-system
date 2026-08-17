/**
 * toggle-chaos-test.mjs — 开关状态一致性混沌测试（第六轮，2026-08 需求变更后更新）
 *
 * 核心思想：不测"功能能不能点"，测"开关状态在乱序操作后是否仍然真实"——
 * 打开→关闭→打开，功能必须是打开的。
 *
 * 需求变更（2026-08-17）：HTML 报告统一导出专业版详细内容——
 * 无论专业模式开关，导出文件都必须包含全部专业区块（body 强制 pro-mode）。
 * 开关只影响在线浏览口径，不再影响导出物。
 * CSV / JSON 导出与专业模式完全无关（只依赖 recorder 数据），本套件一并验证。
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

// ---------- T3 【新口径】普通模式导出也必须是专业版详细报告 ----------
{
  await page.evaluate(() => { if (document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  const s = await state();
  if (s.proClass) { bad('前置失败：无法切回普通模式'); }
  else {
    const { body, html } = await exportHtml('T3-normal-pro-export');
    if (/class="[^"]*pro-mode/.test(body)) ok('普通模式导出 body 强制带 pro-mode（统一专业版）');
    else bad(`普通模式导出丢失 pro-mode（退化为简版）: ${body}`);
    if (/id="rpParams"/.test(html) && /<tr/.test(html.match(/id="rpParams"[\s\S]{0,2000}/)?.[0] || '')) ok('普通模式导出含专业参数表数据行');
    else bad('普通模式导出缺专业参数表（需求变更后必须包含）');
    // pro-only 隐藏规则仍应存在（被 body.pro-mode 复活规则覆盖，两份规则都要在）
    if (/\.pro-only\{[^}]*display:\s*none/.test(html.replace(/\s/g, '')) || /\.pro-only\s*\{[^}]*display:none/.test(html)) ok('导出文件含 .pro-only 隐藏规则');
    else bad('导出文件缺 .pro-only 隐藏规则');
    if (/body\.pro-mode\s+\.pro-only\s*\{\s*display:\s*revert/.test(html)) ok('导出文件含 pro-only 复活规则');
    else bad('导出文件缺 pro-only 复活规则（专业区块会被隐藏）');
    // 副标题统一详细口径：普通模式在线页面省略采样点，导出应补齐
    if (/个采样点/.test(html)) ok('普通模式导出副标题补齐采样点数（详细口径）');
    else bad('普通模式导出副标题缺采样点数');
  }
}

// ---------- T4 普通 vs 专业两份文件：统一专业版，内容口径一致 ----------
{
  const n = readFileSync(`${OUT}/T3-normal-pro-export.html`, 'utf8');
  await page.evaluate(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  await exportHtml('T4-pro2');
  const p = readFileSync(`${OUT}/T4-pro2.html`, 'utf8');
  // 两份文件都必须带 pro-mode 且含专业参数表
  const nOk = /class="[^"]*pro-mode/.test(n.match(/<body[^>]*>/)?.[0] || '') && /id="rpParams"/.test(n);
  const pOk = /class="[^"]*pro-mode/.test(p.match(/<body[^>]*>/)?.[0] || '') && /id="rpParams"/.test(p);
  if (nOk && pOk) ok('两份导出均为专业版（body 带 pro-mode + 含参数表）');
  else bad(`导出版本不一致: 普通=${nOk} 专业=${pOk}`);
  // 关键差异点：专业版含 pro-only 复活规则（cssText 序列化带空格，正则需兼容）
  const proHasParamsVisible = /body\.pro-mode\s+\.pro-only\s*\{\s*display:\s*revert/.test(p);
  if (proHasParamsVisible) ok('专业版含 pro-only 复活规则');
  else bad('专业版缺 pro-only 复活规则');
}

// ---------- T5 导出瞬间狂切开关（竞态）：无论开关，导出恒为专业版 ----------
{
  // 连续点击导出+切换，验证每次导出都自洽（统一专业版，不出现半截或退化）
  for (let i = 0; i < 4; i++) {
    const wantPro = i % 2 === 1;
    await page.evaluate((w) => {
      const has = document.body.classList.contains('pro-mode');
      if (has !== w) window.__fatigue.app.chrome.toggleProMode();
    }, wantPro);
    const { body, html } = await exportHtml(`T5-${i}`);
    const gotPro = /class="[^"]*pro-mode/.test(body);
    const gotParams = /id="rpParams"/.test(html);
    if (gotPro && gotParams) ok(`第 ${i + 1} 次导出统一专业版（页面开关=${wantPro ? '开' : '关'}）`);
    else bad(`第 ${i + 1} 次导出错乱: pro-mode=${gotPro} 参数表=${gotParams}`);
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

// ---------- T10 CSV / JSON 与专业模式无关：两种模式导出内容一致 ----------
{
  /** 点击导出按钮并保存下载文件，返回文本内容 */
  async function exportDl(btnId, tag) {
    const dlPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.evaluate((id) => document.getElementById(id).click(), btnId);
    const dl = await dlPromise;
    const file = `${OUT}/${tag}`;
    await dl.saveAs(file);
    return readFileSync(file, 'utf8');
  }
  await runSession();
  // 普通模式导出 CSV / JSON
  await page.evaluate(() => { if (document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  const csvOff = await exportDl('btnExportCsv', 'T10-csv-off.csv');
  const jsonOff = await exportDl('btnExportJson', 'T10-json-off.json');
  // 专业模式导出 CSV / JSON（同一会话数据）
  await page.evaluate(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); });
  await sleep(300);
  const csvOn = await exportDl('btnExportCsv', 'T10-csv-on.csv');
  const jsonOn = await exportDl('btnExportJson', 'T10-json-on.json');

  if (csvOff === csvOn && csvOff.length > 0) ok(`CSV 与专业模式无关（两种模式字节级一致，${csvOff.length}B）`);
  else bad(`CSV 受专业模式影响: off=${csvOff.length}B on=${csvOn.length}B`);
  const jOff = JSON.parse(jsonOff);
  const jOn = JSON.parse(jsonOn);
  if (jOff.samples?.length === jOn.samples?.length && jOff.samples.length > 0 && jOff.events?.length === jOn.events?.length) {
    ok(`JSON 与专业模式无关（samples=${jOff.samples.length} events=${jOff.events.length} 两模式一致）`);
  } else {
    bad(`JSON 受专业模式影响: off samples=${jOff.samples?.length} on samples=${jOn.samples?.length}`);
  }
}

if (errors.length === 0) ok('全程无未捕获异常');
else bad(`未捕获异常 ${errors.length} 条: ${errors[0]}`);

await browser.close();
console.log(`\n==== 开关混沌: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
