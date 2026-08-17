/**
 * final-acceptance.mjs — 终验｜总验收官
 *
 * 现象 A（状态-产出不一致）复测：专业模式开/关各导出一份 HTML 报告，
 *   逐项比对产出物——关闭时不得含专业区块，开启时必须含（附对比证据）。
 * 现象 B（守卫缺失）复测：无检测数据时三个导出按钮必须 disabled，
 *   且即便绕过 UI 强行调用导出链路也无文件产出（assertHasData 兜底）。
 *
 * 用法：node tools/final-acceptance.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });

/* ---------- 现象 B：守卫缺失复测 ---------- */
console.log('\n==== 现象 B 复测：无数据时导出守卫 ====');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await sleep(600);
  await page.click('a[data-goto="viewReport"]');
  await sleep(500);

  // B1 三按钮全 disabled
  const dis = await page.evaluate(() => ({
    print: document.getElementById('btnPrint').disabled,
    json: document.getElementById('btnExportJson').disabled,
    csv: document.getElementById('btnExportCsv').disabled,
  }));
  if (dis.print && dis.json && dis.csv) ok('B1 无数据时 下载报告/JSON/CSV 三按钮全部 disabled');
  else bad(`B1 存在未禁用按钮：${JSON.stringify(dis)}`);

  // B2 绕过 UI 强行调用导出函数：assertHasData 必须兜底（无下载 + 提示）
  const results = [];
  for (const expr of [
    `import('/js/ui/export-report.js').then(m => m.exportSessionJson(window.__fatigue.app.recorder, { lastInd:null, lastFusion:null, meta:null }))`,
    `import('/js/ui/export-report.js').then(m => m.exportSessionCsv(window.__fatigue.app.recorder))`,
    `import('/js/ui/export-report.js').then(m => m.exportReportHtml(window.__fatigue.app.recorder))`,
  ]) {
    const fired = page.waitForEvent('download', { timeout: 2000 }).then(() => true).catch(() => false);
    await page.evaluate(expr);
    results.push(await fired);
  }
  await sleep(300);
  const toast = await page.evaluate(() => {
    const h = document.querySelector('.toast-host');
    return h ? [...h.querySelectorAll('.toast-title,.toast-msg')].map((t) => t.textContent).join(' ') : '';
  });
  if (results.every((r) => !r) && /暂无可导出的数据/.test(toast)) ok('B2 绕过 UI 直调三 个导出函数均被 assertHasData 拦截并提示');
  else bad(`B2 导出未兜底：fired=${JSON.stringify(results)} toast="${toast.slice(0, 60)}"`);

  // B3 校准未完成（中途取消）后：仍无数据，按钮依旧禁用
  await page.click('a[data-goto="viewWork"]');
  await sleep(300);
  await page.evaluate(() => { window.__fatigue.app.sm.force && window.__fatigue.app.sm.force('calibrating'); });
  await page.evaluate(() => {
    const app = window.__fatigue.app;
    // 直接构造 CALIBRATING 态后取消（cancelStart 链路）
    app.stop();
  });
  await sleep(400);
  await page.click('a[data-goto="viewReport"]');
  await sleep(400);
  const samples = await page.evaluate(() => window.__fatigue.app.recorder.samples.length);
  const dis2 = await page.evaluate(() => document.getElementById('btnPrint').disabled);
  if (samples === 0 && dis2) ok('B3 启动中途取消后无数据，导出按钮保持禁用');
  else if (samples === 0 && !dis2) bad('B3 中途取消后按钮未禁用（但 assertHasData 仍兜底）→ P2');
  else ok(`B3 中途取消后采样 ${samples} 条，按钮态 ${dis2 ? '禁用' : '可用'}（有数据则合理）`);

  await ctx.close();
}

/* ---------- 现象 A：状态-产出不一致复测 ---------- */
console.log('\n==== 现象 A 复测：专业模式 × 下载报告内容 ====');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });

  // 产出同一份会话数据
  await page.evaluate(() => window.__fatigue.startSimulation());
  await page.waitForFunction(() => window.__fatigue.state === 'running', null, { timeout: 20000 });
  await sleep(4200);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(800);

  const exportHtml = async () => {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.evaluate(() => document.getElementById('btnPrint').click()),
    ]);
    return readFileSync(await dl.path(), 'utf8');
  };
  const setPro = async (on) => {
    await page.evaluate((w) => {
      if (document.body.classList.contains('pro-mode') !== w) document.getElementById('btnProMode').click();
    }, on);
    await sleep(400);
  };

  // A1 专业模式关闭 → 导出
  await setPro(false);
  const htmlOff = await exportHtml();
  // A2 专业模式开启 → 导出（同一会话数据）
  await setPro(true);
  const htmlOn = await exportHtml();

  const PRO_MARKS = /id="(sensTable|replayResult|evalResult|rpParams)"/;
  const FOLD_NOTE = /本次会话未运行，无导出数据/;
  const a1 = !PRO_MARKS.test(htmlOff);
  const a2 = PRO_MARKS.test(htmlOn) || FOLD_NOTE.test(htmlOn);
  if (a1) ok(`A1 专业模式关闭：导出不含专业区块（${htmlOff.length} 字节）`);
  else bad('A1 专业模式关闭：导出仍泄漏专业区块 → 现象A仍存在');
  if (a2) ok(`A2 专业模式开启：导出含专业内容（${htmlOn.length} 字节）`);
  else bad('A2 专业模式开启：导出丢失专业内容 → 现象A仍存在');
  if (a1 && a2 && htmlOn.length !== htmlOff.length) {
    ok(`A3 产出物对比：off=${htmlOff.length}B / on=${htmlOn.length}B，内容随模式正确分流（Δ=${htmlOn.length - htmlOff.length}B）`);
  } else if (a1 && a2) {
    bad('A3 两份导出内容相同 → 现象A仍存在');
  }

  // A4 报告页 UI 上可见的结论字段与导出文件一致（标题+结论）
  const uiTitle = await page.evaluate(() => document.getElementById('rpTitle')?.textContent?.trim() || '');
  if (uiTitle && htmlOn.includes(uiTitle)) ok(`A4 导出文件含报告页标题「${uiTitle}」`);
  else bad('A4 导出文件与页面标题不一致');

  await ctx.close();
}

await browser.close();
console.log(`\n==== 终验 A/B 复测：${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
