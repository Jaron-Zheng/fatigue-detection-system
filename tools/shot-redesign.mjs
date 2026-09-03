#!/usr/bin/env node
/**
 * shot-redesign.mjs — 2026-09 三项重设计的视觉取证（一次性脚本）
 *
 * 产出（shots/redesign/）：
 *   1. 概览页「数据流向」四步卡（浅/深两主题）——尺寸对称性证据
 *   2. 工作台四档等级色（浅色）——演示剧本快进到清醒/轻度/中度/重度
 *   3. 报告页等级色带与分布图（浅/深两主题）
 *
 * 用法: node tools/shot-redesign.mjs   （需本地服务 127.0.0.1:5180 已启动）
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const OUT = 'shots/redesign';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
  console.log('  ✓', name);
}
const state = () => page.evaluate(() => window.__fatigue?.sm?.state ?? window.__fatigue?.state ?? '?');
const level = () =>
  page.evaluate(() => {
    const chip = document.querySelector('#levelText');
    return chip ? chip.textContent.trim() : '?';
  });

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
} catch { console.log('goto timeout, continue'); }
await page.waitForSelector('#btnStart', { timeout: 20000 }).catch(() => {});
await sleep(1500);

/* ---------- 1. 概览页「数据流向」四步卡 ---------- */
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await sleep(500);
  await page.evaluate(() => {
    const el = document.querySelector('#tsPrivacy');
    el?.scrollIntoView({ block: 'center' });
  });
  await sleep(1500); // 等进场动效
  await shot(`flow-cards-${theme}`);
}

/* ---------- 2. 工作台四档等级色（浅色，演示剧本逐段快进） ----------
 * 剧本：0–32s 清醒 → 32–62s 轻度 → 62–102s 中度 → 102–147s 重度（147s 循环） */
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await page.evaluate(() => document.querySelector('a[data-goto="viewWork"]')?.click());
await sleep(800);
await page.evaluate(() => window.__fatigue?.startSimulation());
await sleep(6000); // BOOTING+校准+起步

const STOPS = [
  ['awake', 0],
  ['mild', 34000],
  ['moderate', 66000],
  ['severe', 110000],
];
for (const [tag, t] of STOPS) {
  await page.evaluate((ms) => window.__fatigue?.fastForward(ms), t);
  // PERCLOS 20s 窗口需要填充时间；等级标签变化即到位
  let lv = '';
  for (let i = 0; i < 40; i++) {
    lv = await level();
    if (lv && lv !== '?') {
      const hit = STOPS.find(([tag2]) => tag2 === tag);
      if (hit && lv.includes({ awake: '清醒', mild: '轻度', moderate: '中度', severe: '重度' }[tag])) break;
    }
    await sleep(500);
  }
  await sleep(2500); // 等图表滚动窗口画满
  await shot(`level-${tag}-light`);
  console.log(`    level=${lv} state=${await state()}`);
}

/* 深色主题抓一档重度做对照 */
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await sleep(600);
await shot('level-severe-dark');
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

/* ---------- 3. 报告页 ---------- */
await page.click('#btnStop').catch(() => {});
await sleep(4000); // 等报告渲染
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await sleep(600);
  await shot(`report-${theme}`);
  // 分布图在报告页下方
  await page.evaluate(() => {
    const el = document.querySelector('#rpBody') || document.querySelector('#viewReport');
    el?.scrollIntoView?.({ block: 'start' });
    window.scrollTo({ top: window.scrollY + 900, behavior: 'instant' });
  });
  await sleep(900);
  await shot(`report-dist-${theme}`);
}

console.log('控制台错误:', consoleErrors.length ? JSON.stringify(consoleErrors) : '无');
await browser.close();
console.log('完成 →', OUT);
if (consoleErrors.length) process.exit(1);
