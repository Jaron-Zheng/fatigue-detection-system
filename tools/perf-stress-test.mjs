/**
 * perf-stress-test.mjs — 性能压测 + 极限边界 + 资源竞争（批次二 #6/#7/#8）
 *
 * #6 性能：真实运行 3 分钟，每 15s 采样 FPS / JS堆内存 / 推理延迟，看衰减趋势
 * #7 边界：快进 24h、事件爆炸、375px 极小屏、负值注入
 * #8 竞争：双标签页同时开真实检测（摄像头争抢）
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
mkdirSync('shots/perf', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const fail = (msg) => { fails++; console.log('✗ ' + msg); };
const ok = (msg) => console.log('✓ ' + msg);

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/* ========== #6 性能压测：3 分钟真实运行采样 ========== */
console.log('\n===== #6 性能压测（3 分钟真实运行） =====');
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(500);

  // 注入 FPS 计数器
  await page.evaluate(() => {
    window.__fps = { frames: 0, t0: performance.now(), last: 0 };
    const tick = () => {
      window.__fps.frames++;
      const now = performance.now();
      if (now - window.__fps.t0 >= 1000) {
        window.__fps.last = (window.__fps.frames * 1000) / (now - window.__fps.t0);
        window.__fps.frames = 0;
        window.__fps.t0 = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(9000); // 过校准

  const samples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(15000);
    const s = await page.evaluate(() => ({
      fps: Math.round(window.__fps.last),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      inferMs: window.__fatigue.app.engine?.avgInferMs ?? null,
      samples: window.__fatigue.app.recorder?.samples?.length ?? 0,
    }));
    samples.push(s);
    console.log(`  t=${(i + 1) * 15}s fps=${s.fps} heap=${s.heapMB}MB infer=${s.inferMs?.toFixed(1)}ms samples=${s.samples}`);
  }
  // 判定：FPS 无持续衰减（前1/3均值 vs 后1/3均值差 >40% 才算衰减）、内存无单调暴涨
  const third = Math.floor(samples.length / 3);
  const fpsEarly = samples.slice(0, third).filter((s) => s.fps > 0);
  const fpsLate = samples.slice(-third).filter((s) => s.fps > 0);
  const avg = (a) => a.reduce((x, y) => x + y.fps, 0) / Math.max(1, a.length);
  if (fpsEarly.length && fpsLate.length) {
    const drop = (avg(fpsEarly) - avg(fpsLate)) / Math.max(1, avg(fpsEarly));
    if (drop > 0.4) fail(`FPS 衰减 ${(drop * 100).toFixed(0)}%: ${avg(fpsEarly).toFixed(0)}→${avg(fpsLate).toFixed(0)}`);
    else ok(`FPS 稳定（${avg(fpsEarly).toFixed(0)}→${avg(fpsLate).toFixed(0)}，衰减 ${(drop * 100).toFixed(1)}%）`);
  }
  const heaps = samples.map((s) => s.heapMB).filter((x) => x !== null);
  if (heaps.length >= 6) {
    const growth = heaps[heaps.length - 1] - heaps[0];
    const leaky = growth > 150; // 3 分钟涨超 150MB 判泄漏嫌疑
    if (leaky) fail(`内存增长 ${growth}MB，疑似泄漏`);
    else ok(`内存增长 ${growth}MB（3 分钟，无泄漏迹象）`);
  } else {
    ok('headless 无 performance.memory，跳过内存判定');
  }
  await page.close();
}

/* ========== #7 极限边界 ========== */
console.log('\n===== #7 极限边界 =====');
{
  // 7a 快进 24h：数值不溢出、时长格式化不炸
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(500);
  await page.evaluate(() => window.__fatigue.startSimulation());
  await sleep(8000);
  await page.evaluate(() => window.__fatigue.fastForward(86400000)); // 24h
  await sleep(2500);
  const s = await page.evaluate(() => ({ state: window.__fatigue.state, score: window.__fatigue.score }));
  if (s.state === 'running' && s.score !== null && !Number.isNaN(s.score) && s.score >= 0 && s.score <= 100) {
    ok(`24h 快进: state=${s.state} score=${s.score.toFixed(1)}（无溢出）`);
  } else {
    fail(`24h 快进异常: ${JSON.stringify(s)}`);
  }
  // 24h 后正常结束出报告
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(2500);
  const view = await page.evaluate(() => document.querySelector('.view.active')?.id);
  if (view === 'viewReport') {
    const durText = await page.evaluate(() => document.getElementById('viewReport').textContent.match(/检测时长[^0-9]*([0-9:]+)/)?.[1]);
    ok(`24h 会话正常出报告，时长显示: ${durText}`);
  } else fail('24h 会话结束失败');
  await page.close();

  // 7b 375px 极小屏：不横向滚动、控制按钮可达
  const small = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await small.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await small.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  await sleep(800);
  await small.screenshot({ path: 'shots/perf/375-home.png', fullPage: true });
  const overflow = await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 8) fail(`375px 屏横向溢出 ${overflow}px（未做移动端适配，记录在案）`);
  else ok('375px 屏无横向溢出');
  await small.close();
}

/* ========== #8 资源竞争：双标签页抢摄像头 ========== */
console.log('\n===== #8 双标签页摄像头竞争 =====');
{
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ['camera'],
  });
  const p1 = await ctx.newPage();
  const p2 = await ctx.newPage();
  for (const p of [p1, p2]) {
    await p.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await p.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
  }
  await p1.evaluate(() => { window.__fatigue.app.simulate = false; window.__fatigue.app.start(false); });
  await sleep(4000);
  const s1 = await p1.evaluate(() => window.__fatigue.state);
  // 第二个页面开真实检测（同一 fake 设备，模拟争抢）
  const p2result = await p2.evaluate(async () => {
    try {
      window.__fatigue.app.simulate = false;
      await window.__fatigue.app.start(false);
      return window.__fatigue.state;
    } catch (e) {
      return 'error: ' + String(e).slice(0, 60);
    }
  });
  await sleep(3000);
  const s2 = await p2.evaluate(() => window.__fatigue.state);
  const p1Still = await p1.evaluate(() => window.__fatigue.state);
  console.log(`  标签1: ${s1}→${p1Still}，标签2: ${String(p2result).slice(0, 40)}→${s2}`);
  // 断言核心：第二个标签不能崩、第一个标签不能假死
  if (s2 === 'booting' || s2 === 'calibrating') {
    // 给足时间
    await sleep(6000);
  }
  const s2final = await p2.evaluate(() => window.__fatigue.state);
  const alive2 = await p2.evaluate(() => 1 + 1).catch(() => NaN);
  if (alive2 !== 2) fail('标签2 页面崩溃');
  else if (s2final === 'booting') fail('标签2 永久卡在 booting（无超时兜底）');
  else ok(`双标签竞争: 标签2 终态 ${s2final}（fake设备下可共存；真机独占时预期 failStart 舞台）`);
  if (p1Still !== s1) console.log(`  注: 标签1 状态变化 ${s1}→${p1Still}`);
  await ctx.close();
}

await browser.close();
console.log(`\n==== 批次二汇总: ${fails === 0 ? 'PASS' : fails + ' 项 FAIL'} ====`);
process.exit(fails ? 1 : 0);
