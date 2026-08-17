/**
 * security-test.mjs — 安全面（批次四 #13）
 * 1) localStorage 篡改：垃圾 JSON / 原型污染 / 类型不匹配 / 数组形状攻击 / 极端数值
 * 2) 运行时健壮性：被污染配置下应用可启动、检测可运行、指标不 NaN
 * 3) URL 参数滥用：?demo 恶意值
 * 4) XSS 面：主题/专业模式等存储值不得以 HTML 方式落入 DOM
 */
import { chromium } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });

/** 带预设 localStorage 打开页面（用 init script 在任何应用脚本前写入） */
async function openWith(setupJs) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (setupJs) await ctx.addInitScript(setupJs);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 15000 }).then(() => true).catch(() => false);
  return { ctx, page, errors, booted };
}

// ---------- S1 垃圾 JSON / 非法类型 / 原型污染 ----------
{
  const { ctx, page, errors, booted } = await openWith(() => {
    localStorage.setItem('fatigue.config.v1', '{"__proto__":{"polluted":"YES"},"calibration":{"durationSec":"NOT_A_NUMBER"},"fusion":{"weights":{"perclos":"<img onerror=alert(1) src=x>"}},"theme_hack":1}');
    localStorage.setItem('fatigue.theme', '<script>window.PWNED=1</script>');
    localStorage.setItem('fatigue.proMode', 'yes-but-not-1');
  });
  if (booted) ok('垃圾配置下应用正常启动'); else bad('垃圾配置导致启动失败');
  const polluted = await page.evaluate(() => ({}).polluted);
  if (polluted === undefined) ok('__proto__ 注入被拦截（无原型污染）');
  else bad('原型污染成功：({}).polluted=' + polluted);
  const dur = await page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.calibration.durationSec)).catch((e) => 'ERR:' + e.message);
  if (typeof dur === 'number') ok(`类型不匹配值被丢弃（durationSec=${dur} 保持数字）`);
  else bad(`类型不匹配值渗入：durationSec=${dur}`);
  const weight = await page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.fusion.weights.perclos)).catch((e) => 'ERR:' + e.message);
  if (typeof weight === 'number') ok(`XSS 字符串载荷被丢弃（weights.perclos=${weight}）`);
  else bad(`字符串载荷渗入 weights.perclos=${weight}`);
  if (errors.length === 0) ok('无未捕获异常'); else bad(`页面异常: ${errors[0]}`);
  await ctx.close();
}

// ---------- S2 数组形状攻击（fusion.levels 整组替换） ----------
{
  const { ctx, page, booted, errors } = await openWith(() => {
    localStorage.setItem('fatigue.config.v1', JSON.stringify({
      fusion: { levels: [{ key: 1 }, '直接塞字符串', null] },
    }));
  });
  if (booted) ok('levels 攻击下应用启动正常'); else bad('levels 攻击导致启动失败');
  const levels = await page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.fusion.levels)).catch((e) => 'ERR:' + e.message);
  const sane = Array.isArray(levels) && levels.every((l) => l && typeof l.key === 'string' && typeof l.label === 'string');
  if (sane) ok('levels 数组形状校验生效（恶意数组被拒，保留默认）');
  else bad(`恶意 levels 渗入: ${JSON.stringify(levels).slice(0, 80)}`);
  if (errors.length === 0) ok('无未捕获异常'); else bad(`页面异常: ${errors[0]}`);
  await ctx.close();
}

// ---------- S3 极端数值（同类型但越界） ----------
{
  const { ctx, page, booted, errors } = await openWith(() => {
    localStorage.setItem('fatigue.config.v1', JSON.stringify({
      calibration: { durationSec: -999, minSamples: -1 },
      window: { seconds: 0 },
      record: { sampleIntervalMs: 0 },
    }));
  });
  if (booted) ok('越界数值下应用启动正常'); else bad('越界数值导致启动失败');
  // 钳制验证（第五轮遗留项 #1 修复后）：越界值应收到最近合法边界
  const clamped = await page.evaluate(() => import('/js/config.js').then((m) => ({
    durationSec: m.CONFIG.calibration.durationSec,
    minSamples: m.CONFIG.calibration.minSamples,
    sampleIntervalMs: m.CONFIG.record.sampleIntervalMs,
  })));
  if (clamped.durationSec === 2 && clamped.minSamples === 10 && clamped.sampleIntervalMs === 100) {
    ok(`数值钳制生效（durationSec=${clamped.durationSec} minSamples=${clamped.minSamples} sampleIntervalMs=${clamped.sampleIntervalMs}）`);
  } else {
    bad(`钳制未生效: ${JSON.stringify(clamped)}`);
  }
  // 跑演示验证运行时不炸
  const run = await page.evaluate(async () => {
    try {
      window.__fatigue.startSimulation();
      await new Promise((r) => setTimeout(r, 4500));
      const s = window.__fatigue.state;
      const score = window.__fatigue.score;
      return { s, score };
    } catch (e) { return { err: e.message }; }
  });
  if (!run.err && run.score !== null && !Number.isNaN(run.score)) ok(`越界配置下演示可运行（state=${run.s}, score=${run.score?.toFixed?.(1)}）`);
  else bad(`越界配置下运行异常: ${JSON.stringify(run)}`);
  if (errors.length === 0) ok('无未捕获异常'); else bad(`页面异常 ${errors.length} 条，首条: ${errors[0]}`);
  await ctx.close();
}

// ---------- S4 存储值 XSS 面：主题等只能走 dataset/textContent ----------
{
  const { ctx, page } = await openWith(() => {
    localStorage.setItem('fatigue.theme', 'dark" onload="alert(1)');
  });
  await sleep(500);
  const injected = await page.evaluate(() => document.querySelectorAll('script[src^="x"], img[onerror], [onload]').length);
  const pwned = await page.evaluate(() => window.PWNED === true);
  if (!pwned && injected === 0) ok('主题存储值未产生任何 HTML 注入');
  else bad(`主题值被当 HTML 处理（PWNED=${pwned}, injected=${injected}）`);
  await ctx.close();
}

// ---------- S5 URL 参数滥用 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL + '?demo=<script>alert(1)</script>&theme=INVALID', { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 15000 }).then(() => true).catch(() => false);
  const pwned = await page.evaluate(() => window.PWNED === true || document.querySelectorAll('script:not([src])').length > 1);
  if (booted && !pwned && errors.length === 0) ok('?demo 恶意值安全（无注入、无异常）');
  else bad(`URL 参数攻击异常: booted=${booted} pwned=${pwned} err=${errors[0] ?? '无'}`);
  await ctx.close();
}

await browser.close();
console.log(`\n==== 安全面: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
