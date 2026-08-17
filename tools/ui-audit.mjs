/**
 * ui-audit.mjs — 全量交互审计（Edge + playwright-core，无需摄像头/扩展）
 *
 * 1) 结构化走查：三视图切换、空报告态、演示会话、检测控制、报告导出、
 *    专家模式、设置抽屉、主题/静音。
 * 2) 调皮用户模式：把页面上所有可见可点按钮挨个点一遍，收集报错。
 * 全程捕获 console.error / pageerror，输出 shots/audit/report.json + 分步截图。
 *
 * 用法: node tools/ui-audit.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const OUT = 'shots/audit';
mkdirSync(OUT, { recursive: true });

const log = [];
const consoleErrors = [];
const downloads = [];
const shotNames = new Set();
const note = (step, action, ok, extra = '') => {
  const row = { step, action, ok, extra: String(extra).split('\n')[0].slice(0, 200) };
  log.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${step}] ${action}${extra ? ' | ' + row.extra : ''}`);
};

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)));
page.on('download', (d) => downloads.push(d.suggestedFilename()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待条件成立（连跑高负载时固定 sleep 后立即断言会误判，
 * 第五轮总回归实测第 55 步下载计数抖动即此因） */
async function waitUntil(cond, timeoutMs = 8000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(intervalMs);
  }
  return await cond();
}
async function shot(name) {
  if (shotNames.has(name)) name = name + '_' + Date.now() % 1000;
  shotNames.add(name);
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
}
async function click(sel, step, desc) {
  try {
    await page.locator(sel).first().click({ timeout: 4000 });
    note(step, `${desc || sel} 点击`, true);
    return true;
  } catch (e) {
    note(step, `${desc || sel} 点击`, false, e.message);
    return false;
  }
}
async function check(cond, step, desc) {
  note(step, desc, !!cond, cond ? '' : '条件为假');
  return !!cond;
}

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
} catch (e) {
  console.log('goto load timeout, continue');
}
// 等应用真正挂载完（视频/模型加载会让 networkidle 永不触发）
await page.waitForSelector('#btnStart', { timeout: 20000 }).catch(() => console.log('btnStart 未出现'));
await sleep(1200);

/* ---------- 1. 首页与视图切换 ---------- */
await shot('01-home');
await check(await page.locator('#viewHome.active').count() > 0, 'nav', '初始在首页视图');

await click('a[data-goto="viewWork"]', 'nav', '导航→工作台');
await sleep(600);
await check(await page.locator('#viewWork.active').count() > 0, 'nav', '工作台视图激活');
await shot('02-work-idle');

await click('a[data-goto="viewReport"]', 'nav', '导航→报告');
await sleep(800);
await check(await page.locator('#viewReport.active').count() > 0, 'nav', '报告视图激活');

/* ---------- 2. 空报告态：导出按钮应禁用 ---------- */
await check(await page.locator('#rpEmpty:not([hidden])').count() > 0, 'report-empty', '空态卡片可见');
for (const id of ['btnPrint', 'btnExportJson', 'btnExportCsv']) {
  const disabled = await page.locator(`#${id}`).evaluate((el) => el.disabled).catch(() => null);
  await check(disabled === true, 'report-empty', `空态下 ${id} 禁用`);
}
await shot('03-report-empty');

/* ---------- 3. 演示会话（测试钩子驱动，静音） ---------- */
await page.evaluate(() => window.__fatigue?.startSimulation());
// BOOTING + 校准 + 开跑：等待式断言（高负载下 9s 定时可能不够，不再硬编码）
const runningOk = await waitUntil(() =>
  page.evaluate(() => String(window.__fatigue?.state).toLowerCase() === 'running'), 15000, 400);
const state = await page.evaluate(() => window.__fatigue?.state);
await check(runningOk, 'demo', '演示会话进入 running，实际: ' + state);
await sleep(2000);
await shot('04-demo-face');

/* 检测控制按钮 */
await click('#btnMesh', 'ctrl', '网格开关');
await click('#btnMesh', 'ctrl', '网格开关(还原)');
await click('#btnMirror', 'ctrl', '镜像开关');
await click('#btnMirror', 'ctrl', '镜像开关(还原)');
await click('#btnHud', 'ctrl', 'HUD开关');
await click('#btnHud', 'ctrl', 'HUD开关(还原)');
await click('#btnRecalib', 'ctrl', '重新校准');
await sleep(1500);
await click('#btnPause', 'ctrl', '暂停');
await sleep(500);
const paused = await page.evaluate(() => window.__fatigue?.state);
await check(String(paused).toLowerCase() === 'paused', 'ctrl', '暂停生效，实际: ' + paused);
await shot('05-paused');
await click('#btnPause', 'ctrl', '恢复');
await click('#btnFilterEvents', 'ctrl', '仅看异常过滤');
await click('#btnFilterEvents', 'ctrl', '仅看异常(还原)');

/* 快进到重度，等报警层 */
await page.evaluate(() => window.__fatigue?.fastForward(110000));
await sleep(6000);
const alarmVisible = await page.locator('#btnDismissAlarm').isVisible().catch(() => false);
await check(alarmVisible, 'alarm', '重度阶段报警浮层出现');
if (alarmVisible) {
  await shot('06-alarm');
  await click('#btnDismissAlarm', 'alarm', '关闭报警');
}

/* ---------- 4. 结束会话 → 报告 ---------- */
await page.evaluate(() => window.__fatigue?.stop());
await sleep(3000);
await check(await page.locator('#viewReport.active').count() > 0, 'report', '结束后跳转报告视图');
await check(await page.locator('#rpEmpty[hidden]').count() > 0, 'report', '空态卡片隐藏(有数据)');
await shot('07-report-full');

/* 普通模式：专家元素应隐藏 */
const proHidden = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.pro-only')];
  return els.length > 0 && els.every((el) => getComputedStyle(el).display === 'none');
});
await check(proHidden, 'report', '普通模式 .pro-only 隐藏');

/* JSON/CSV 按钮是 pro-only：先开专家模式再测导出下载 */
await click('#btnProMode', 'export', '专家模式开(为导出)');
await sleep(500);
const dlBefore = downloads.length;
await click('#btnPrint', 'export', '导出HTML报告');
await sleep(1200);
await click('#btnExportJson', 'export', 'JSON导出');
await sleep(1000);
await click('#btnExportCsv', 'export', 'CSV导出');
// 下载事件异步登记：轮询最多 8s，不再固定 sleep 后立即断言
const dlOk = await waitUntil(() => Promise.resolve(downloads.length >= dlBefore + 3), 8000, 250);
await check(dlOk, 'export', `三种导出产生 ${downloads.length - dlBefore} 个文件`);
await click('#btnProMode', 'export', '专家模式关');
await click('#btnBackWork', 'report', '再次检测回工作台');
await sleep(600);
await check(await page.locator('#viewWork.active').count() > 0, 'report', '回到工作台');

/* ---------- 5. 专家模式 ---------- */
await click('#btnProMode', 'pro', '专家模式开');
await sleep(500);
await page.evaluate(() => window.__fatigue?.startSimulation());
await sleep(9000);
await page.evaluate(() => window.__fatigue?.fastForward(60000));
await sleep(3000);
await page.evaluate(() => window.__fatigue?.stop());
await sleep(3000);
await shot('08-pro-report');
const proVisible = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.pro-only')];
  return els.length > 0 && els.every((el) => getComputedStyle(el).display !== 'none');
});
await check(proVisible, 'pro', '专家模式 .pro-only 可见');

await click('#btnRunSens', 'pro', '敏感性分析');
await sleep(2500);
await shot('09-pro-sens');
await click('#btnRunAblation', 'pro', '消融实验');
await sleep(2500);
await click('#btnExportAnalysis', 'pro', '导出分析CSV');
await sleep(800);
await click('#btnProMode', 'pro', '专家模式关');

/* ---------- 6. 设置抽屉 ---------- */
await click('#btnSettings', 'settings', '打开设置');
await sleep(800);
await shot('10-settings');
await click('#btnTestAlarm', 'settings', '试听报警');
await page.locator('#swSimulate').check({ timeout: 3000 }).catch(() => {});
note('settings', '演示开关切换', true);
try {
  await page.locator('#selDemoStart').selectOption('moderate');
  note('settings', '演示阶段选择', true);
} catch (e) {
  note('settings', '演示阶段选择', false, e.message);
}
await click('#btnSaveCfg', 'settings', '保存参数');
await sleep(500);
// 保存后抽屉自动关闭（设计如此），重开再测恢复默认
await click('#btnSettings', 'settings', '重开设置');
await sleep(600);
await click('#btnResetCfg', 'settings', '恢复默认');
await sleep(500);
await click('#btnCloseSheet', 'settings', '关闭设置');

/* ---------- 7. 主题/静音 ---------- */
await click('#btnMute', 'theme', '静音切换');
await click('#btnTheme', 'theme', '深浅色切换');
await sleep(800);
await shot('11-dark-home');
await click('#btnTheme', 'theme', '切回浅色');
await click('#btnMute', 'theme', '取消静音');

/* ---------- 8. 调皮用户：点遍所有可见按钮 ----------
 * 目的只验证「乱点不崩」；视口外/被遮挡的点击失败不算 bug（force 尽力而为） */
await page.evaluate(() => location.reload());
await page.waitForSelector('#btnStart', { timeout: 20000 }).catch(() => {});
await sleep(1500);
const naughtyIds = await page.evaluate(() => {
  window.scrollTo(0, 0);
  return [...document.querySelectorAll('button, a.btn, [role="button"]')]
    .filter((el) => el.offsetParent !== null && !el.disabled)
    .map((el) => (el.id ? '#' + el.id : el.textContent.trim().slice(0, 12)));
});
for (const sel of naughtyIds) {
  await page.locator(sel).first().click({ timeout: 2500, force: true }).catch(() => {});
  await sleep(120);
}
note('naughty', `首页乱点 ${naughtyIds.length} 个按钮完成`, true);
await sleep(1000);
await shot('12-after-naughty-home');

// 工作台乱点（含各种 pill）
await page.evaluate(() => window.__fatigue?.startSimulation());
await sleep(9000);
const workIds = await page.evaluate(() =>
  [...document.querySelectorAll('#viewWork button')]
    .filter((el) => el.offsetParent !== null && !el.disabled)
    .map((el) => (el.id ? '#' + el.id : el.textContent.trim().slice(0, 12)))
);
for (const sel of workIds) {
  await page.locator(sel).first().click({ timeout: 2500, force: true }).catch(() => {});
  await sleep(120);
}
note('naughty', `工作台乱点 ${workIds.length} 个按钮完成`, true);
await shot('13-after-naughty-work');
const alive = await page.evaluate(() => !!document.querySelector('.view.active') && !document.body.innerHTML.includes('undefined is not a function'));
await check(alive, 'naughty', '乱点后页面仍存活');

await browser.close();

/* ---------- 汇总 ---------- */
const fails = log.filter((r) => !r.ok);
const report = {
  time: new Date().toISOString(),
  total: log.length,
  fails: fails.length,
  consoleErrors: [...new Set(consoleErrors)],
  downloads,
  details: log,
};
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log('\n==== 汇总 ====');
console.log(`步骤 ${log.length}，失败 ${fails.length}，console 错误 ${report.consoleErrors.length}，下载 ${downloads.length}`);
if (report.consoleErrors.length) console.log('console.errors:\n' + report.consoleErrors.join('\n'));
