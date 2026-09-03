#!/usr/bin/env node
/**
 * export-theme-check.mjs — 导出报告主题对齐验证（2026-09 修复的回归守卫）
 *
 * 背景：canvas 位图主题敏感。会话在深色主题下渲染报告时，阈值参考线
 * 标签底衬（--bg-elevated 深色值）冻结进 canvas；导出文件强制浅色后
 * 这些深色底衬在白底上显示为黑块（用户实测：指数曲线右侧
 * 「轻度/中度/重度」标签黑底）。修复：导出截图前临时切浅色重绘。
 *
 * 本脚本两步验证：
 *   A. 分析用户导出的旧报告文件（复现缺陷基线，文件存在时）
 *   B. 全流程复现：深色主题跑演示会话→结束→导出→分析导出 PNG
 *      断言：1) 图内无深色标签底衬（暗像素占比 < 0.5%）
 *            2) 导出后在线页面主题恢复深色
 *            3) 导出文件 :root 含 --on-lv
 *
 * 用法: node tools/export-theme-check.mjs   （需本地服务 127.0.0.1:5180）
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const USER_REPORT = 'C:/Users/jiahe/Desktop/疲劳检测报告_20260903_132513910_r001.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在浏览器里解码 PNG dataURL，统计不透明像素中"暗像素"（亮度<80）占比。
 * 浅色导出的图表：轴色灰 118+、曲线/文字均为彩色，几乎不存在亮度<80
 * 的不透明像素；深色冻结的位图：三块标签底衬（#1e2229 @0.82）约
 * 2–3% 暗像素——判据非常分明。 */
async function analyzePng(page, dataUrl) {
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      opaque++;
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (lum < 80) dark++;
    }
    return { dark, opaque, ratio: opaque ? dark / opaque : 0 };
  }, dataUrl);
}

/** 从导出的 HTML 文本中提取全部 PNG dataURL */
function extractPngs(html) {
  return [...html.matchAll(/src="(data:image\/png;base64,[A-Za-z0-9+/=]+)"/g)].map((m) => m[1]);
}

let failures = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text().slice(0, 160)); });

try {
  /* ---------- A. 用户旧报告（缺陷基线） ---------- */
  if (fs.existsSync(USER_REPORT)) {
    const html = fs.readFileSync(USER_REPORT, 'utf8');
    const pngs = extractPngs(html);
    console.log(`A. 旧导出文件：${pngs.length} 张 PNG`);
    for (let i = 0; i < pngs.length; i++) {
      const r = await analyzePng(page, pngs[i]);
      console.log(`   图${i + 1}: 暗像素 ${r.dark}/${r.opaque} (${(r.ratio * 100).toFixed(2)}%)`);
      if (r.ratio > 0.01) {
        console.log('   ↑ 该图存在深色底衬（缺陷基线确认：深色主题冻结的标签底衬）');
        check(true, 'A1 旧文件复现黑底缺陷（暗像素>1%）');
      }
    }
  } else {
    console.log('A. 旧导出文件不存在，跳过基线分析');
  }

  /* ---------- B. 修复后全流程 ---------- */
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#btnStart', { timeout: 20000 });
  await sleep(1200);

  // 确认进入的是深色（无 data-theme 时走 prefers-color-scheme）
  const bgDark = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  console.log(`B0 系统深色下页面背景: ${bgDark}`);
  check(bgDark !== 'rgb(255, 255, 255)' && !/244|245|246/.test(bgDark), 'B1 页面确为深色主题');

  // 演示会话 → 结束 → 报告页
  await page.evaluate(() => window.__fatigue?.startSimulation());
  await page.waitForFunction(() => window.__fatigue?.state === 'running', null, { timeout: 30000 }).catch(() => {});
  await sleep(9000); // BOOTING+校准+跑一段，攒数据
  await page.click('#btnStop');
  await sleep(4500); // 等报告渲染
  const onReport = await page.locator('#viewReport.active').count() > 0;
  check(onReport, 'B2 结束后位于报告页');

  // 导出 HTML（先记主题属性原值，导出后必须原样还原——'auto' 表示跟随系统）
  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.evaluate(() => document.getElementById('btnPrint').click()),
  ]);
  const path = await download.path();
  const html = fs.readFileSync(path, 'utf8');

  // 断言 1：导出后在线页面主题已还原（与导出前同值）
  const bgAfter = await page.evaluate(() => {
    const t = document.documentElement.getAttribute('data-theme');
    return { theme: t, bg: getComputedStyle(document.documentElement).backgroundColor };
  });
  check(
    bgAfter.theme === themeBefore,
    'B3 导出后主题属性还原（与导出前同值）',
    `${themeBefore} → ${bgAfter.theme}`
  );
  check(
    bgAfter.bg === bgDark,
    'B4 导出后在线页面仍为深色（临时切换无残留）',
    `${bgDark} → ${bgAfter.bg}`
  );

  // 断言 2：导出 PNG 无深色底衬
  const pngs = extractPngs(html);
  check(pngs.length > 0, 'B5 导出文件含 canvas 位图', `${pngs.length} 张`);
  let worst = 0;
  for (let i = 0; i < pngs.length; i++) {
    const r = await analyzePng(page, pngs[i]);
    worst = Math.max(worst, r.ratio);
    console.log(`   图${i + 1}: 暗像素 ${(r.ratio * 100).toFixed(2)}%`);
  }
  check(worst < 0.005, 'B6 全部位图无深色标签底衬（暗像素<0.5%）', `最差 ${(worst * 100).toFixed(2)}%`);

  // 断言 3：:root 含 --on-lv（dist-seg 文字色不回退继承色）
  check(/--on-lv\s*:/.test(html), 'B7 导出 :root 含 --on-lv 变量');

  // 断言 4：导出文件强制浅色
  check(/data-theme="light"/.test(html.slice(0, 2000)), 'B8 导出文件强制浅色主题');

  /* ---------- C. 导出文件作为独立文档打开（客户双击场景） ----------
   * 注意：playwright 下载的临时文件无扩展名，file:// 直开会被当纯文本
   * 渲染；先拷贝成 .html 再加载（真实下载带完整文件名，无此问题） */
  const fileCopy = `${process.env.TEMP}\\export-theme-check.html`.replace(/\\/g, '/');
  fs.copyFileSync(path, fileCopy);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('file:///' + fileCopy, { waitUntil: 'load', timeout: 15000 });
  await sleep(600);
  check(errs.length === 0, 'C1 导出文件独立打开零控制台错误', errs.join(' | ').slice(0, 200));
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(/rgb\(2[0-9]{2}/.test(bodyBg), 'C2 导出文件浅色底', bodyBg);
  const segColor = await page.evaluate(() => {
    const seg = document.querySelector('.dist-seg');
    return seg ? getComputedStyle(seg).color : 'none';
  });
  check(/rgb\(255, 255, 255\)/.test(segColor), 'C3 分布条文字为白色（--on-lv 生效）', segColor);
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\n==== 导出主题对齐验证：全部通过 ====' : `\n==== 失败 ${failures} 项 ====`);
process.exit(failures === 0 ? 0 : 1);
