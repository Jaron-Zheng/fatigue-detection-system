#!/usr/bin/env node
/**
 * paper-screenshots-online.mjs — 从在线演示地址截取论文用截图
 *
 * 产出 7 张高清整页 PNG 到桌面"截图"文件夹：
 *   1. 首页初始态
 *   2a. 设置面板-简洁模式
 *   2b. 设置面板-专业模式（含阈值参数）
 *   3.  5s基线标定进行中（CALIBRATING）
 *   4.  实时检测主界面（Dashboard含报警）
 *   5.  事件时间线
 *   6.  检测报告页（REPORT含导出按钮）
 *
 * 用法：
 *   node tools/paper-screenshots-online.mjs
 */
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_BASE = 'https://jaron-zheng.github.io/fatigue-detection-system/';
const OUT_DIR = path.join(os.homedir(), 'Desktop', '截图');
const DEBUG_PORT = 9336;
const WIDTH = 1920;
const HEIGHT = 1080;
const SCALE = 2; // deviceScaleFactor: 2× → 截图实际分辨率 3840×2160，论文级清晰度

fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * 高清整页截图：
 * 1. 先用 setDeviceMetricsOverride 设 deviceScaleFactor=2，让页面以 2× 像素密度渲染；
 * 2. 读取完整文档高度（含滚动区域）；
 * 3. 用 setDeviceMetricsOverride 临时撑大 viewport 到全页高度，确保 captureBeyondViewport 能截到所有内容；
 * 4. Page.captureScreenshot 截取完整页面，PNG 无损。
 */
async function shotFullPage(cdp, name) {
  // 读取完整文档尺寸
  const metrics = await evalJs(cdp, `(()=>({
    w: document.documentElement.scrollWidth,
    h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    vw: window.innerWidth,
    vh: window.innerHeight
  }))()`);
  const fullW = Math.max(metrics.w, WIDTH);
  const fullH = Math.max(metrics.h, HEIGHT);
  console.log(`  页面尺寸: ${metrics.w}×${metrics.h}, viewport: ${metrics.vw}×${metrics.vh}, 截图: ${fullW * SCALE}×${fullH * SCALE}px`);

  // 临时撑大 viewport 到完整页面高度，确保整页可见
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: fullW,
    height: fullH,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await sleep(500);

  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  const stat = fs.statSync(file);
  console.log(`  ✓ ${name}  (${(stat.size / 1024).toFixed(0)} KB)`);

  // 恢复原始 viewport
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await sleep(300);
}

async function waitForPage(cdp) {
  let readyState = '';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    readyState = await evalJs(cdp, `(()=>document.readyState)()`);
    if (readyState === 'complete') break;
    await sleep(500);
  }
  const title = String(await evalJs(cdp, `(()=>document.title)()`));
  console.log('  页面标题:', title, 'readyState:', readyState);
  if (!title.includes('疲劳检测')) {
    throw new Error(`页面未正确加载，标题=${title}`);
  }
  return title;
}

async function main() {
  console.log('启动浏览器（headless=new, %dx%d）...', WIDTH, HEIGHT);
  const session = await launchHeadless({
    debugPort: DEBUG_PORT,
    width: WIDTH,
    height: HEIGHT,
  });
  // 覆盖默认 deviceScaleFactor=1 为 2×，所有后续截图都以 2× 像素密度渲染
  const { cdp, close } = session;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await sleep(500);

  try {
    /* ---------- 导航到首页 ---------- */
    console.log('导航到', URL_BASE);
    await cdp.send('Page.navigate', { url: URL_BASE });
    await waitForPage(cdp);
    await sleep(6000); // 等字体/动效首屏稳定

    /* ==========================================================
     * 1. 首页/启动界面（未开始检测的初始态）
     * ========================================================== */
    console.log('\n[1/7] 首页初始态...');
    await evalJs(cdp, `(()=>{
      document.documentElement.dataset.theme='light';
      document.querySelector('a[data-goto="viewHome"]')?.click();
      window.scrollTo({top:0, behavior:'instant'});
    })()`);
    await sleep(2000);
    // 首页卡片用 IntersectionObserver 做滚动进场动画，
    // 直接跳到底部不会触发回调，必须分段平滑滚动让每段卡片进入视口。
    const totalH = await evalJs(cdp, `(()=>Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))()`);
    console.log('  首页总高度:', totalH, 'px, 逐段滚动触发进场动画...');
    // 分 ~8 段平滑滚到底，每段等 IntersectionObserver 回调+CSS 动画
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const target = Math.round((totalH / steps) * i);
      await evalJs(cdp, `window.scrollTo({top:${target}, behavior:'smooth'})`);
      await sleep(700);
    }
    // 滚回顶部，等最后一段动画也播完
    await evalJs(cdp, `window.scrollTo({top:0, behavior:'smooth'})`);
    await sleep(1500);
    await shotFullPage(cdp, '01-home-initial.png');

    /* ==========================================================
     * 2a. 设置面板——简洁模式
     * ========================================================== */
    console.log('[2a/7] 设置面板-简洁模式...');
    // 先到工作台
    await evalJs(cdp, `(()=>{
      document.querySelector('a[data-goto="viewWork"]')?.click();
    })()`);
    await sleep(1500);
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
    await shotFullPage(cdp, '02a-settings-simple.png');
    // 关闭设置面板
    await evalJs(cdp, `(()=>{
      document.getElementById('btnCloseSheet')?.click();
    })()`);
    await sleep(600);

    /* ==========================================================
     * 2b. 设置面板——专业模式（含阈值参数项）
     * ========================================================== */
    console.log('[2b/7] 设置面板-专业模式...');
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
      if (sheet) sheet.scrollTo({ top: sheet.scrollHeight * 0.35, behavior: 'smooth' });
    })()`);
    await sleep(800);
    await shotFullPage(cdp, '02b-settings-pro.png');
    // 关闭设置面板
    await evalJs(cdp, `(()=>{
      document.getElementById('btnCloseSheet')?.click();
    })()`);
    await sleep(600);

    /* ==========================================================
     * 3. 5s 基线标定进行中（CALIBRATING 状态）
     *
     * 在线版是 GitHub Pages，不暴露 __fatigue 测试钩子（isLocalEnv=false）。
     * 用 ?demo=moderate 进入演示模式（自动跳过校准进 RUNNING），
     * 然后直接操作 DOM 显示校准遮罩。
     * ========================================================== */
    console.log('[3/7] 基线标定进行中...');
    // 关闭专业模式
    await evalJs(cdp, `(()=>{
      const btn = document.getElementById('btnProMode');
      if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    })()`);
    await sleep(400);
    // 通过 DOM 操作显示校准遮罩
    await evalJs(cdp, `(()=>{
      // 获取 overlay 元素
      const overlay = document.getElementById('stageOverlay');
      const ring = document.getElementById('calibRing');
      const title = document.getElementById('overlayTitle');
      const text = document.getElementById('overlayText');
      const actions = document.getElementById('overlayActions');
      const num = document.getElementById('calibNum');
      if (overlay) {
        overlay.hidden = false;
        overlay.classList.add('is-translucent');
      }
      if (ring) ring.hidden = false;
      if (title) title.textContent = '正在认识你的眼睛';
      if (text) text.textContent = '请正视摄像头，保持自然睁眼（约 5 秒）。系统正在记录你平时睁眼的样子，作为判断闭眼的个人标准。';
      if (num) num.textContent = '3';
      if (actions) actions.innerHTML = '';
    })()`);
    await sleep(1000);
    await shotFullPage(cdp, '03-calibrating.png');
    // 收起遮罩
    await evalJs(cdp, `(()=>{
      const overlay = document.getElementById('stageOverlay');
      const ring = document.getElementById('calibRing');
      if (overlay) { overlay.hidden = true; overlay.classList.remove('is-translucent'); }
      if (ring) ring.hidden = true;
    })()`);
    await sleep(500);

    /* ==========================================================
     * 4. 实时检测主界面（Dashboard，含报警）
     *
     * 导航到 ?demo=moderate 演示模式，快进到重度阶段截图
     * ========================================================== */
    console.log('[4/7] 实时检测主界面（含报警）...');
    await cdp.send('Page.navigate', { url: URL_BASE + '?demo=moderate' });
    await waitForPage(cdp);
    await sleep(8000); // 等演示模式启动并跑一会儿

    // 检查状态，如果没跑起来就等待
    const state4 = await evalJs(cdp, `(()=>{
      const app = window.__fatigue?.app;
      return app ? app.state : 'no-app';
    })()`);
    console.log('  当前状态:', state4);

    // 在线版不暴露 __fatigue，所以无法快进。
    // 但 ?demo=moderate 从中度开始，约 40 秒后会进入重度阶段。
    // 我们多等一会儿让报警自然触发。
    // 中度阶段 62-102秒，再等约 35 秒应该能看到重度报警
    console.log('  等待演示模式自然演进到重度报警阶段...');
    await sleep(35000);

    await shotFullPage(cdp, '04-dashboard-alarm.png');

    /* ==========================================================
     * 5. 事件时间线
     * ========================================================== */
    console.log('[5/7] 事件时间线...');
    // 滚动到时间线区域
    await evalJs(cdp, `(()=>{
      const tl = document.getElementById('cardTimeline');
      if (tl) tl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })()`);
    await sleep(1500);
    await shotFullPage(cdp, '05-timeline.png');

    /* ==========================================================
     * 6. 检测报告页（REPORT，含导出按钮）
     * ==========================================================
     * 在线版无法通过 __fatigue.stop() 停止会话生成报告，
     * 但可以通过 DOM 操作触发停止按钮。
     * ========================================================== */
    console.log('[6/7] 检测报告页...');
    // 点击"结束"按钮停止会话
    await evalJs(cdp, `(()=>{
      // 滚回顶部找到停止按钮
      window.scrollTo({top:0, behavior:'instant'});
      // 找结束按钮
      const btn = document.getElementById('btnStop') || document.getElementById('btnFinish');
      if (btn) btn.click();
    })()`);
    await sleep(5000); // 等报告渲染

    // 确认已经到了报告页
    const currentView = await evalJs(cdp, `(()=>{
      const active = document.querySelector('.view.active');
      return active ? active.id : 'unknown';
    })()`);
    console.log('  当前视图:', currentView);

    // 如果没到报告页，手动切过去
    if (currentView !== 'viewReport') {
      await evalJs(cdp, `(()=>{
        document.querySelector('a[data-goto="viewReport"]')?.click();
      })()`);
      await sleep(2000);
    }

    await evalJs(cdp, `(()=>{
      window.scrollTo({top:0, behavior:'instant'});
    })()`);
    await sleep(1000);
    await shotFullPage(cdp, '06-report.png');

    /* ---------- 控制台错误报告 ---------- */
    console.log('\n控制台错误:', cdp.consoleErrors.length ? `${cdp.consoleErrors.length} 条` : '无');

    /* ---------- 输出文件清单 ---------- */
    console.log('\n========== 截图完成 ==========');
    console.log('输出目录:', OUT_DIR);
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png') && f.match(/^0[1-6]/)).sort();
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
