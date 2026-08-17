/**
 * responsive-test.mjs — 兼容性/响应式矩阵（批次三 #9+#10）
 * 视口 × 缩放矩阵：1366/1280/1024/768/375 × DPR 1/1.5
 * 每格测：横向溢出、关键按钮可见可点、布局断裂，截图供视觉审查。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
mkdirSync('shots/responsive', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MATRIX = [
  { w: 1920, h: 1080, dpr: 1, tag: '1920' },
  { w: 1366, h: 768, dpr: 1, tag: '1366' },
  { w: 1280, h: 800, dpr: 1.25, tag: '1280@125' },
  { w: 1024, h: 768, dpr: 1, tag: '1024' },
  { w: 768, h: 1024, dpr: 2, tag: '768-pad' },
  { w: 375, h: 667, dpr: 2, tag: '375-phone' },
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = [];

for (const m of MATRIX) {
  const page = await browser.newPage({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: m.dpr });
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(900);

  // 每个视口：首页 + 工作台(演示中) + 报告页
  const views = {};
  // 首页
  const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: `shots/responsive/${m.tag}-home.png`, fullPage: false });
  views.homeOverflow = homeOverflow;

  // 工作台演示中
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(7000);
  const workOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: `shots/responsive/${m.tag}-work.png` });
  views.workOverflow = workOverflow;
  // 关键控制按钮可见性
  views.ctrlVisible = await page.evaluate(() => {
    // 运行态：开始按钮理应隐藏，暂停/结束/设置必须可用
    const mustShow = ['btnPause', 'btnStop', 'btnSettings'];
    const mustHide = ['btnStart'];
    const hiddenBad = mustShow.filter((id) => {
      const el = document.getElementById(id);
      if (!el) return true;
      const r = el.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    });
    const shownBad = mustHide.filter((id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (hiddenBad.length) return '不可见:' + hiddenBad.join(',');
    if (shownBad.length) return '该隐藏却可见:' + shownBad.join(',');
    return true;
  });

  // 报告页
  await page.evaluate(() => window.__fatigue.fastForward(60000));
  await sleep(2000);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2500);
  await page.screenshot({ path: `shots/responsive/${m.tag}-report.png`, fullPage: false });
  views.reportOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  const pass = homeOverflow <= 8 && workOverflow <= 8 && views.reportOverflow <= 8 && views.ctrlVisible === true;
  report.push({ tag: m.tag, ...views, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${m.tag}] home溢${homeOverflow}px work溢${workOverflow}px report溢${views.reportOverflow}px 控制${views.ctrlVisible}`);
  await page.close();
}

await browser.close();
writeFileSync('shots/responsive/report.json', JSON.stringify(report, null, 2));
const fails = report.filter((r) => !r.pass);
console.log(`\n==== 响应式矩阵: ${report.length} 视口, 失败 ${fails.length} ====`);
process.exit(fails.length ? 1 : 0);
