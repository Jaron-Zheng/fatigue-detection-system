#!/usr/bin/env node
/**
 * paper-screenshots.mjs — 论文截图工具（零依赖，Node ≥ 22 内置 WebSocket）
 *
 * 按论文行文顺序截取 6 张关键界面截图：
 *   1. 首页/启动界面（未开始检测的初始态）
 *   2a. 设置面板——简洁模式
 *   2b. 设置面板——专业模式（含阈值参数项）
 *   3.  5s 基线标定进行中（CALIBRATING 状态）
 *   4.  实时检测主界面（Dashboard，含报警）
 *   5.  事件时间线
 *   6.  检测报告页（REPORT，含导出按钮）
 *
 * 用法：
 *   node tools/paper-screenshots.mjs
 *   node tools/paper-screenshots.mjs --port 5180 --out "<用户桌面>/截图"
 */
import { launchHeadless, evalJs, shot, sleep } from './cdp-util.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const OUT_DIR = path.resolve(get('--out', path.join(os.homedir(), 'Desktop', '截图')));
const DEBUG_PORT = Number(get('--cdp-port', '9334'));

const WIDTH = 1920;
const HEIGHT = 1080;

fs.mkdirSync(OUT_DIR, { recursive: true });

async function waitForPage(cdp) {
  let readyState = '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    readyState = await evalJs(cdp, `(()=>document.readyState)()`);
    if (readyState === 'complete') break;
    await sleep(300);
  }
  const title = String(await evalJs(cdp, `(()=>document.title)()`));
  console.log('  页面标题:', title);
  if (!title.includes('疲劳检测')) {
    throw new Error(`页面未正确加载，标题=${title}——服务器是否启动？`);
  }
}

async function main() {
  console.log('启动浏览器（headless=new, %dx%d）...', WIDTH, HEIGHT);
  const session = await launchHeadless({
    debugPort: DEBUG_PORT,
    width: WIDTH,
    height: HEIGHT,
  });
  const { cdp, close } = session;

  try {
    /* ---------- 导航到首页 ---------- */
    console.log('导航到', URL_TARGET);
    await cdp.send('Page.navigate', { url: URL_TARGET });
    await waitForPage(cdp);
    await sleep(5000); // 等字体/动效首屏稳定

    /* ==========================================================
     * 1. 首页/启动界面（未开始检测的初始态）
     * ========================================================== */
    console.log('\n[1/6] 首页初始态...');
    await evalJs(cdp, `(()=>{
      document.documentElement.dataset.theme='light';
      document.querySelector('a[data-goto="viewHome"]')?.click();
      window.scrollTo({top:0, behavior:'instant'});
    })()`);
    await sleep(2000);
    await shot(cdp, '01-home-initial.png', OUT_DIR);
    console.log('  ✓ 01-home-initial.png');

    /* ==========================================================
     * 2a. 设置面板——简洁模式
     * ========================================================== */
    console.log('[2a/6] 设置面板-简洁模式...');
    // 确保在简洁模式（专业模式关闭）
    await evalJs(cdp, `(()=>{
      document.documentElement.dataset.theme='light';
      // 确保在首页或工作台，先到工作台
      document.querySelector('a[data-goto="viewWork"]')?.click();
    })()`);
    await sleep(1000);
    // 确保专业模式关闭
    await evalJs(cdp, `(()=>{
      const btn = document.getElementById('btnProMode');
      if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    })()`);
    await sleep(500);
    // 打开设置面板
    await evalJs(cdp, `(()=>{
      document.getElementById('btnSettings')?.click();
    })()`);
    await sleep(1500);
    await shot(cdp, '02a-settings-simple.png', OUT_DIR);
    console.log('  ✓ 02a-settings-simple.png');
    // 关闭设置面板
    await evalJs(cdp, `(()=>{
      document.getElementById('btnCloseSheet')?.click();
    })()`);
    await sleep(600);

    /* ==========================================================
     * 2b. 设置面板——专业模式（含阈值参数项）
     * ========================================================== */
    console.log('[2b/6] 设置面板-专业模式...');
    // 打开专业模式
    await evalJs(cdp, `(()=>{
      const btn = document.getElementById('btnProMode');
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    })()`);
    await sleep(800);
    // 打开设置面板
    await evalJs(cdp, `(()=>{
      document.getElementById('btnSettings')?.click();
    })()`);
    await sleep(1500);
    // 滚动到阈值参数区域
    await evalJs(cdp, `(()=>{
      const sheet = document.querySelector('.sheet-body');
      if (sheet) sheet.scrollTo({ top: sheet.scrollHeight * 0.4, behavior: 'smooth' });
    })()`);
    await sleep(800);
    await shot(cdp, '02b-settings-pro.png', OUT_DIR);
    console.log('  ✓ 02b-settings-pro.png');
    // 关闭设置面板
    await evalJs(cdp, `(()=>{
      document.getElementById('btnCloseSheet')?.click();
    })()`);
    await sleep(600);

    /* ==========================================================
     * 3. 5s 基线标定进行中（CALIBRATING 状态）
     * ==========================================================
     * 使用 ?demo= 直通车进入演示模式（不需要摄像头），
     * 但演示模式会跳过校准直接进入 RUNNING（BEGIN_RUNNING）。
     * 要截取 CALIBRATING 状态，需要用真实启动路径，
     * 但在 headless 无摄像头环境下会失败。
     *
     * 替代方案：直接操作 UI 元素显示校准遮罩。
     * 通过 test-hooks 或直接 JS 调用 SessionStage.showCalibrating()。
     * ========================================================== */
    console.log('[3/6] 基线标定进行中...');
    // 关闭专业模式
    await evalJs(cdp, `(()=>{
      const btn = document.getElementById('btnProMode');
      if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    })()`);
    await sleep(400);
    // 通过 app 的内部 API 触发校准遮罩
    await evalJs(cdp, `(()=>{
      const app = window.__fatigue?.app;
      if (!app) return 'no app';
      // 调用 showCalibrating 显示校准遮罩
      if (app.stage && app.stage.showCalibrating) {
        app.stage.showCalibrating(() => {});
        // 模拟校准进度更新
        if (app.stage.updateCalibProgress) {
          app.stage.updateCalibProgress(0.4, true);
        }
      }
      return 'ok';
    })()`);
    await sleep(1000);
    await shot(cdp, '03-calibrating.png', OUT_DIR);
    console.log('  ✓ 03-calibrating.png');
    // 收起遮罩
    await evalJs(cdp, `(()=>{
      const app = window.__fatigue?.app;
      if (app && app.stage) app.stage.hide();
    })()`);
    await sleep(500);

    /* ==========================================================
     * 4. 实时检测主界面（Dashboard，含报警）
     * ==========================================================
     * 使用 ?demo=moderate 进入演示模式，快进到重度阶段
     * 让 Dashboard 有实际数据和报警状态。
     * ========================================================== */
    console.log('[4/6] 实时检测主界面（含报警）...');

    // 先停止当前会话（如果有的话）
    await evalJs(cdp, `(()=>{
      const app = window.__fatigue?.app;
      if (app && app.sm && !app.sm.is('idle')) app.stop();
    })()`);
    await sleep(1000);

    // 导航到 demo 模式，从中度开始
    await cdp.send('Page.navigate', { url: URL_TARGET + '?demo=moderate' });
    await waitForPage(cdp);
    await sleep(6000); // 等演示模式启动并跑一会儿

    // 快进到重度阶段（让报警出现）
    await evalJs(cdp, `(()=>{
      const f = window.__fatigue;
      if (f && f.fastForward) {
        f.fastForward(80000); // 快进 80 秒，进入重度阶段
      }
    })()`);
    await sleep(8000); // 等报警触发和数据更新

    await shot(cdp, '04-dashboard-alarm.png', OUT_DIR);
    console.log('  ✓ 04-dashboard-alarm.png');

    /* ==========================================================
     * 5. 事件时间线
     * ==========================================================
     * 在同一会话中，滚动到时间线区域截图
     * ========================================================== */
    console.log('[5/6] 事件时间线...');
    // 滚动到时间线区域（在工作台中向下滚动）
    await evalJs(cdp, `(()=>{
      // 找到时间线卡片并滚动到视图中
      const tl = document.getElementById('cardTimeline');
      if (tl) {
        tl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        // 在专业模式下尝试找其他容器
        const el = document.querySelector('[data-timeline], .timeline, #timeline');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    })()`);
    await sleep(1500);
    await shot(cdp, '05-timeline.png', OUT_DIR);
    console.log('  ✓ 05-timeline.png');

    /* ==========================================================
     * 6. 检测报告页（REPORT，含导出按钮）
     * ==========================================================
     * 停止会话生成报告
     * ========================================================== */
    console.log('[6/6] 检测报告页...');
    // 停止会话（生成报告）
    await evalJs(cdp, `(()=>{
      const f = window.__fatigue;
      if (f && f.stop) f.stop();
    })()`);
    await sleep(4000); // 等报告渲染

    // 滚动到顶部
    await evalJs(cdp, `(()=>{
      window.scrollTo({top:0, behavior:'instant'});
    })()`);
    await sleep(1000);
    await shot(cdp, '06-report.png', OUT_DIR);
    console.log('  ✓ 06-report.png');

    /* ---------- 控制台错误报告 ---------- */
    console.log('\n控制台错误:', cdp.consoleErrors.length ? JSON.stringify(cdp.consoleErrors, null, 2) : '无');

    console.log('\n截图完成 →', OUT_DIR);
    console.log('产出文件：');
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png')).sort();
    for (const f of files) {
      const stat = fs.statSync(path.join(OUT_DIR, f));
      console.log(`  ${f}  (${(stat.size / 1024).toFixed(0)} KB)`);
    }

  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
