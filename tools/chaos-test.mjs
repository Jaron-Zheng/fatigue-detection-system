/**
 * chaos-test.mjs — 对抗性混沌测试（不按正常流程操作的"熊用户"）
 *
 * 与 ui-audit.mjs（正常流程回归）互补：这里专捅状态机缝隙——
 * 中途导航、双击连点、会话中导出、暂停态重启、BOOTING 中取消等。
 *
 * 用法: node tools/chaos-test.mjs
 * 输出: 每场景 PASS/FAIL + 汇总 + console 错误归属
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
mkdirSync('shots/chaos', { recursive: true });

const results = [];
let consoleErrs = [];

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(7000); // 快速失败，避免单点悬挂拖垮全场
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // TFLite 用 console.error 打 INFO 级运行日志，不是真错误
  if (/^(INFO|DEBUG):/.test(t)) return;
  consoleErrs.push(t.slice(0, 200));
});
page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + String(e).slice(0, 200)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => page.evaluate(() => window.__fatigue?.state ?? 'n/a');
const activeView = () => page.evaluate(() => document.querySelector('.view.active')?.id ?? 'none');
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast-host .toast, .toast-host > *')].map((t) => t.textContent.trim().slice(0, 30)));
const responsive = async () => {
  try {
    return (await page.evaluate(() => 1 + 1)) === 2;
  } catch {
    return false;
  }
};

/** 每个场景独立开局：清存储 + 重载，杜绝场景间污染 */
async function freshStart() {
  consoleErrs = [];
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  // 必须等测试钩子挂载完成，否则后续 startSimulation 全是空操作
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(700);
}

async function scenario(name, fn) {
  await freshStart();
  let pass = true;
  let detail = '';
  try {
    await fn();
  } catch (e) {
    pass = false;
    detail = e.message.split('\n')[0];
  }
  // 死锁/崩溃兜底检查：页面必须仍可交互
  const alive = await responsive();
  if (!alive) {
    pass = false;
    detail += ' | 页面失去响应!';
  }
  if (consoleErrs.length) {
    pass = false;
    detail += ` | console错误x${consoleErrs.length}: ${consoleErrs[0]}`;
  }
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}]${detail ? ' | ' + detail : ''}`);
}

const startDemo = () => page.evaluate(() => window.__fatigue?.startSimulation());

// 初始落地应用页（freshStart 的 reload 依赖当前已在应用页）
await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});

/* ============ S1 用户上报bug：演示中→返回概览→点开始检测 ============ */
await scenario('S1 演示中→首页→点开始检测(应带回工作台或提示,不得无响应)', async () => {
  await startDemo();
  await sleep(7000);
  if ((await state()) !== 'running') throw new Error('前置失败:未进入running');
  await page.click('a[data-goto="viewHome"]');
  await sleep(400);
  await page.click('#btnStart');
  await sleep(800);
  const v = await activeView();
  const t = await toasts();
  const stuck = v === 'viewHome' && t.length === 0; // 停在首页且零反馈 = 假死
  if (stuck) throw new Error(`卡死复现: 停留${v}, 无任何toast反馈`);
});

/* ============ S2 双击/连点开始 ============ */
await scenario('S2 演示中→首页→狂点开始3次(每次都要有反馈)', async () => {
  await startDemo();
  await sleep(7000);
  await page.click('a[data-goto="viewHome"]');
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    await page.click('#btnStart').catch(() => {});
    await sleep(200);
  }
  await sleep(800);
  if ((await state()) !== 'running') throw new Error('原会话被意外打断: ' + (await state()));
});

/* ============ S3 暂停态下点开始（guard 不含 PAUSED 的暗坑） ============ */
await scenario('S3 暂停中→首页→点开始(不得无响应)', async () => {
  await startDemo();
  await sleep(7000);
  await page.click('#btnPause').catch(() => {});
  await sleep(500);
  if ((await state()) !== 'paused') throw new Error('前置失败:未暂停, 实际' + (await state()));
  await page.click('a[data-goto="viewHome"]');
  await sleep(300);
  await page.click('#btnStart');
  await sleep(800);
  const t = await toasts();
  const v = await activeView();
  if (v === 'viewHome' && t.length === 0) throw new Error('暂停态点开始无响应(卡死变体)');
});

/* ============ S4 会话进行中去报告页 ============ */
await scenario('S4 检测中→导航报告页(不得看到过期报告且能导出)', async () => {
  // 先跑完一次会话留下旧报告
  await startDemo();
  await sleep(6000);
  await page.evaluate(() => window.__fatigue?.stop());
  await sleep(2500);
  // 开始第二次会话（不结束），然后中途去报告页
  await startDemo();
  await sleep(6000);
  await page.click('a[data-goto="viewReport"]').catch(() => {});
  await sleep(800);
  const v = await activeView();
  const staleExport = await page.evaluate(() => {
    const grid = document.querySelector('#viewReport .report-grid');
    const shown = grid && getComputedStyle(grid).display !== 'none';
    const btn = document.getElementById('btnExportJson');
    const enabled = btn && !btn.disabled && getComputedStyle(btn).display !== 'none';
    return shown && enabled;
  });
  if (staleExport) throw new Error('会话中可见过期报告且导出可用(半截数据风险)');
  if (v === 'viewReport') {
    const t = await toasts();
    if (!t.length) throw new Error('停留在报告页且无提示');
  }
});

/* ============ S5 报告页"再次检测"双击 ============ */
await scenario('S5 报告页→再次检测→立即再点再次检测(不得死锁)', async () => {
  await startDemo();
  await sleep(6000);
  await page.evaluate(() => window.__fatigue?.stop());
  await sleep(2200);
  if ((await activeView()) !== 'viewReport') throw new Error('前置失败:未到报告页');
  await page.click('#btnBackWork');
  await sleep(300);
  await page.click('#btnBackWork').catch(() => {}); // 第二击时已在工作台，按钮应不存在/不可点
  await sleep(6000);
  const s = await state();
  if (!['running', 'booting'].includes(s)) throw new Error('会话未正常启动: ' + s);
});

/* ============ S6 快速 开始→结束→开始→结束 循环 x3 ============ */
await scenario('S6 快速启停循环x3(状态机不得残留)', async () => {
  for (let i = 0; i < 3; i++) {
    await startDemo();
    await sleep(4000);
    if ((await state()) !== 'running') throw new Error(`第${i + 1}轮未running: ` + (await state()));
    await page.evaluate(() => window.__fatigue?.stop());
    await sleep(1800);
    if ((await activeView()) !== 'viewReport') throw new Error(`第${i + 1}轮未到报告页`);
    await page.click('#btnBackWork');
    await sleep(1200);
  }
});

/* ============ S7 真实模式 BOOTING 中点结束 ============ */
await scenario('S7 真实模式启动中(BOOTING)立即点结束(应可取消)', async () => {
  await page.click('#btnStart'); // 真实模式（演示开关默认关）
  await sleep(1200); // 引擎加载中
  const s1 = await state();
  if (!['booting', 'calibrating'].includes(s1)) {
    // 引擎秒开（已缓存）也接受，但不能是卡死的 booting
    if (s1 !== 'running' && s1 !== 'idle') throw new Error('异常状态: ' + s1);
  }
  await page.click('#btnStop').catch(() => {});
  const t0 = Date.now();
  let s2 = await state();
  while (s2 !== 'idle' && Date.now() - t0 < 4000) {
    await sleep(300);
    s2 = await state();
  }
  if (s2 !== 'idle') throw new Error(`取消后未回idle(耗时>4s): ${s1}→${s2}`);
  // 取消后必须还能再启动（演示路径快速验证状态机没锁死）
  await startDemo();
  await sleep(6000);
  if ((await state()) !== 'running') throw new Error('取消后再启动失败: ' + (await state()));
});

/* ============ S8 真实模式校准中点结束 ============ */
await scenario('S8 真实模式校准中(CALIBRATING)点结束(应可取消)', async () => {
  await page.click('#btnStart');
  const t0 = Date.now();
  let s = await state();
  while (s !== 'calibrating' && Date.now() - t0 < 15000 && s !== 'idle') {
    await sleep(400);
    s = await state();
  }
  if (s !== 'calibrating') throw new Error('前置失败:未到校准态, 实际 ' + s);
  await page.click('#btnStop').catch(() => {});
  const t1 = Date.now();
  let s2 = await state();
  while (s2 !== 'idle' && Date.now() - t1 < 3000) {
    await sleep(250);
    s2 = await state();
  }
  if (s2 !== 'idle') throw new Error('校准取消失败: ' + s2);
});

/* ============ S9 暂停/继续连点 x6 ============ */
await scenario('S9 暂停继续连点x6(终态一致)', async () => {
  await startDemo();
  await sleep(7000);
  for (let i = 0; i < 6; i++) {
    await page.click('#btnPause').catch(() => {});
    await sleep(150);
  }
  await sleep(600);
  const s = await state();
  if (!['running', 'paused'].includes(s)) throw new Error('连点后非法状态: ' + s);
  // 从任一终态都应能正常结束
  await page.evaluate(() => window.__fatigue?.stop());
  await sleep(1500);
  if ((await state()) !== 'report' && (await activeView()) !== 'viewReport') throw new Error('连点后无法正常结束');
});

/* ============ S10 演示模式点重新校准 ============ */
await scenario('S10 演示中点重新校准(应toast提示且不打断)', async () => {
  await startDemo();
  await sleep(7000);
  await page.click('#btnRecalib');
  await sleep(600);
  if ((await state()) !== 'running') throw new Error('重新校准打断了演示: ' + (await state()));
});

/* ============ S11 演示中途关掉演示开关 ============ */
await scenario('S11 演示中→设置→关演示开关(应回待机且可再启动)', async () => {
  await startDemo();
  await sleep(7000);
  await page.click('#btnSettings');
  await sleep(700);
  await page.locator('#swSimulate').uncheck();
  await sleep(700);
  const s = await state();
  if (s !== 'idle') throw new Error('关开关后未回idle: ' + s);
  await page.click('#btnCloseSheet').catch(() => {});
  await sleep(400);
  // 再启动必须一次成功（状态机未锁死）
  await startDemo();
  await sleep(6000);
  if ((await state()) !== 'running') throw new Error('关开关后再启动失败');
});

/* ============ S12 会话中狂切主题 ============ */
await scenario('S12 检测中狂切主题x4(不崩不卡)', async () => {
  await startDemo();
  await sleep(6000);
  for (let i = 0; i < 4; i++) {
    await page.click('#btnTheme').catch(() => {});
    await sleep(250);
  }
  if ((await state()) !== 'running') throw new Error('切主题打断会话');
});

/* ============ S13 会话中狂切专家模式 ============ */
await scenario('S13 检测中狂切专家模式x4(不崩不卡)', async () => {
  await startDemo();
  await sleep(6000);
  for (let i = 0; i < 4; i++) {
    await page.click('#btnProMode').catch(() => {});
    await sleep(300);
  }
  if ((await state()) !== 'running') throw new Error('切专家模式打断会话');
});

/* ============ S14 极端快进（1小时） ============ */
await scenario('S14 模拟剧本快进1小时(数值溢出保护)', async () => {
  await startDemo();
  await sleep(6000);
  await page.evaluate(() => window.__fatigue?.fastForward(3600000));
  await sleep(2500);
  if ((await state()) !== 'running') throw new Error('快进导致会话异常: ' + (await state()));
  const score = await page.evaluate(() => window.__fatigue?.score);
  if (score === null || Number.isNaN(score)) throw new Error('快进后分数非法: ' + score);
});

/* ============ S15 报警浮层连点关闭 x5 ============ */
await scenario('S15 重度报警连点关闭x5(浮层不残留)', async () => {
  await startDemo();
  await sleep(5000);
  await page.evaluate(() => window.__fatigue?.fastForward(150000));
  await sleep(4000);
  for (let i = 0; i < 5; i++) {
    await page.click('#btnDismissAlarm').catch(() => {});
    await sleep(120);
  }
  await sleep(800);
  const veilGone = await page.evaluate(() => !document.querySelector('.alarm-veil.is-on, .alarm-veil[style*="opacity: 1"]'));
  if (!veilGone) throw new Error('连点后报警遮罩残留');
  if ((await state()) !== 'running') throw new Error('连点关闭打断了会话');
});

/* ============ S16 首页按空格（后台会话不应被隐形暂停） ============ */
await scenario('S16 检测中→首页→按空格(首页空格不应操控看不见的会话)', async () => {
  await startDemo();
  await sleep(6000);
  await page.click('a[data-goto="viewHome"]');
  await sleep(400);
  await page.keyboard.press('Space');
  await sleep(500);
  const s = await state();
  if (s === 'paused') throw new Error('在首页空格隐形暂停了后台会话(用户不知情)');
});

/* ============ S17 BOOTING 中途跑去首页再点开始 ============ */
await scenario('S17 真实启动中→首页→再点开始(不得双重启动/死锁)', async () => {
  await page.click('#btnStart');
  await sleep(900);
  await page.click('a[data-goto="viewHome"]');
  await sleep(300);
  await page.click('#btnStart').catch(() => {});
  await sleep(1200);
  const s = await state();
  if (s === 'idle' && (await toasts()).length === 0 && (await activeView()) === 'viewHome') {
    throw new Error('启动中再点开始: 无反馈卡死');
  }
  // 无论走到哪，结束后必须能回 idle
  await page.evaluate(() => window.__fatigue?.stop()).catch(() => {});
  await sleep(1500);
});

/* ============ S18 专家模式持久化 + ?demo= 直通车 ============ */
await scenario('S18 专家模式记忆+?demo=1直通(组合态正常)', async () => {
  await page.click('#btnProMode');
  await sleep(400);
  await page.evaluate(() => location.assign('/?demo=1'));
  await page.waitForSelector('#btnStart', { timeout: 20000 }).catch(() => {});
  await sleep(9000);
  if ((await state()) !== 'running') throw new Error('demo直通车未运行: ' + (await state()));
  await page.evaluate(() => window.__fatigue?.stop());
  await sleep(2500);
  const proVisible = await page.evaluate(() => getComputedStyle(document.querySelector('.pro-only')).display !== 'none');
  if (!proVisible) throw new Error('专家模式下 pro-only 不可见');
});

/* ============ S19 无会话时导出三连（已修，回归确认） ============ */
await scenario('S19 空态直奔报告导出(应全禁用)', async () => {
  await page.click('a[data-goto="viewReport"]');
  await sleep(700);
  for (const id of ['btnPrint', 'btnExportJson', 'btnExportCsv']) {
    const disabled = await page.locator(`#${id}`).evaluate((el) => el.disabled).catch(() => null);
    if (disabled !== true) throw new Error(`${id} 空态未禁用`);
  }
});

/* ============ S20 首页无会话狂点一切按钮 ============ */
await scenario('S20 无会话首页乱点全部按钮(不崩)', async () => {
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('button, a[data-goto]')]
      .filter((el) => el.offsetParent !== null && !el.disabled)
      .map((el) => (el.id ? '#' + el.id : `[data-goto="${el.dataset.goto}"]`))
  );
  for (const sel of [...new Set(btns)]) {
    await page.locator(sel).first().click({ timeout: 2000, force: true }).catch(() => {});
    await sleep(100);
  }
  await sleep(600);
});

await browser.close();

/* ---------- 汇总 ---------- */
const fails = results.filter((r) => !r.pass);
writeFileSync('shots/chaos/report.json', JSON.stringify(results, null, 2));
console.log('\n==== 混沌测试汇总 ====');
console.log(`场景 ${results.length}，失败 ${fails.length}`);
if (fails.length) {
  console.log('\n失败清单:');
  for (const f of fails) console.log(` - ${f.name}: ${f.detail}`);
}
process.exit(fails.length ? 1 : 0);
