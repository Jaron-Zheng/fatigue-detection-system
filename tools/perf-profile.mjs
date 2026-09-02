#!/usr/bin/env node
/**
 * perf-profile.mjs — 长时稳定性与性能剖析（第三轮角色五）
 *
 * 两个阶段：
 *   memory  演示模式无人值守长会话（默认 35 分钟），CDP Performance.getMetrics()
 *           每 30 秒采样 JS 堆大小，判断内存是否持续增长（泄漏）还是稳定区间。
 *   infer   假摄像头真实推理会话（默认 3 分钟），PerformanceObserver({longtask})
 *           采集主线程长任务（>50ms），与 FaceEngine.avgInferMs 对照，
 *           量化回答"同步推理是否构成用户可感知卡顿"。
 *
 * 用法：
 *   node tools/perf-profile.mjs --mode memory --minutes 35
 *   node tools/perf-profile.mjs --mode infer  --minutes 3 [--port 9349]
 *   可选 --keep-visible：页面侧垫片锁定 document.hidden=false。
 *   长会话无人值守复测必备——headless 会话在真实桌面（锁屏/窗口遮挡）下
 *   会被系统判为后台，view-router 的 visibilitychange 自动暂停把会话冻住，
 *   测的是静止页面而非连续运行；垫片等价于"前台一直开着"的测量口径。
 *
 * 结果写入 docs-evidence/perf-<mode>-<时间戳>.json 并打印统计摘要。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const MODE = get('--mode', 'memory');
const MINUTES = Number(get('--minutes', MODE === 'memory' ? 35 : 3));
const KEEP_VISIBLE = args.includes('--keep-visible');
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const SAMPLE_INTERVAL_MS = 30000;
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-face.y4m');

if (MODE === 'infer' && !fs.existsSync(FIXTURE)) {
  console.error('缺少假摄像头素材，请先运行 node tools/gen-y4m.mjs');
  process.exit(1);
}

const session = await launchHeadless({
  // 【F5·审计加固】默认调试端口 9347→9349：与 demo-url-test 旧默认 9347 撞车，
  // 两者并行时必冲突（连到对方的页面），错开默认端口。
  debugPort: Number(get('--port', 9349)),
  extraArgs:
    MODE === 'infer' ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${FIXTURE}`] : [],
});
const { cdp } = session;

const totalMs = MINUTES * 60000;
const startedAt = Date.now();
const samples = [];

try {
  await cdp.send('Performance.enable');
  if (MODE === 'infer') {
    await cdp.send('Browser.grantPermissions', { origin: new URL(URL_TARGET).origin, permissions: ['videoCapture'] });
  }

  console.log(`导航 → ${URL_TARGET}`);
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(3000);

  if (KEEP_VISIBLE) {
    // 在 document 实例上定义 own property 遮蔽原型 getter：
    // visibilitychange 仍会触发，但处理器读到 hidden=false 不再自动暂停。
    await evalJs(
      cdp,
      `(() => {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      return document.hidden === false;
    })()`
    );
    console.log('keep-visible 垫片已注入（页面始终视为前台）');
  }

  // 注入 longtask 采集器（上限 20000 条，长会话内存友好）
  await evalJs(
    cdp,
    `(() => {
    window.__longTasks = [];
    window.__ltDropped = 0;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (window.__longTasks.length >= 20000) { window.__ltDropped++; continue; }
        window.__longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
      }
    });
    po.observe({ entryTypes: ['longtask'] });
    return true;
  })()`
  );

  // 启动会话
  if (MODE === 'memory') {
    const st = await evalJs(cdp, 'window.__fatigue.startSimulation()');
    if (st !== 'running') throw new Error('演示模式启动失败: ' + st);
    console.log(`演示模式已启动，采样 ${MINUTES} 分钟（每 30s 一次）…`);
  } else {
    const st = await evalJs(
      cdp,
      `(async () => { const a = window.__fatigue.app; a.simulate = false; await a.start(false); return a.state; })()`
    );
    if (st !== 'calibrating' && st !== 'running') throw new Error('真实推理会话启动失败: ' + st);
    console.log(`真实推理会话已启动（校准中），总计 ${MINUTES} 分钟…`);
  }

  // 采样循环
  while (Date.now() - startedAt < totalMs) {
    await sleep(SAMPLE_INTERVAL_MS);
    const m = await cdp.send('Performance.getMetrics');
    const pick = (name) => (m.metrics.find((x) => x.name === name) || {}).value ?? null;
    const snap = JSON.parse(
      await evalJs(
        cdp,
        `JSON.stringify({
      state: window.__fatigue.state,
      score: window.__fatigue.score,
      phase: window.__fatigue.simPhase,
      samples: window.__fatigue.app.recorder.samples.length,
      inferMs: window.__fatigue.app.engine.avgInferMs,
      frames: window.__fatigue.app.engine.stats.infer,
      longTasks: window.__longTasks.length,
    })`
      )
    );
    const rec = {
      tMin: +((Date.now() - startedAt) / 60000).toFixed(2),
      jsHeapUsedMB: +(pick('JSHeapUsedSize') / 1048576).toFixed(2),
      jsHeapTotalMB: +(pick('JSHeapTotalSize') / 1048576).toFixed(2),
      domNodes: pick('Nodes'),
      listeners: pick('JSEventListeners'),
      ...snap,
    };
    samples.push(rec);
    console.log(
      `  [${rec.tMin}min] heap=${rec.jsHeapUsedMB}MB dom=${rec.domNodes} state=${rec.state}` +
        (MODE === 'infer'
          ? ` infer=${rec.inferMs != null ? rec.inferMs.toFixed(1) : 'null'}ms frames=${rec.frames}`
          : ` score=${rec.score} phase=${rec.phase}`) +
        ` longTasks=${rec.longTasks}`
    );
  }

  // 收尾统计
  const lt = JSON.parse(await evalJs(cdp, 'JSON.stringify(window.__longTasks)'));
  const dropped = await evalJs(cdp, 'window.__ltDropped');
  const durs = lt.map((x) => x.d).sort((a, b) => a - b);
  const pct = (p) => (durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * p))] : 0);
  const finalSnap = JSON.parse(
    await evalJs(
      cdp,
      `JSON.stringify({
    state: window.__fatigue.state,
    inferMs: window.__fatigue.app.engine.avgInferMs,
    delegate: window.__fatigue.app.engine.delegate,
    samples: window.__fatigue.app.recorder.samples.length,
  })`
    )
  );

  const result = {
    mode: MODE,
    minutes: MINUTES,
    date: new Date().toISOString(),
    samples,
    longTaskStats: {
      count: durs.length,
      dropped,
      maxMs: durs.length ? durs[durs.length - 1] : 0,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
      over200Ms: durs.filter((d) => d >= 200).length,
      totalBlockedMs: durs.reduce((a, b) => a + b, 0),
    },
    final: finalSnap,
    heapFirstMB: samples.length ? samples[0].jsHeapUsedMB : null,
    heapLastMB: samples.length ? samples[samples.length - 1].jsHeapUsedMB : null,
    heapMaxMB: samples.length ? Math.max(...samples.map((s) => s.jsHeapUsedMB)) : null,
  };

  const outDir = path.join(ROOT, 'docs-evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `perf-${MODE}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log(`\n=== 摘要（${MODE}，${MINUTES} 分钟） ===`);
  console.log(`堆内存：首 ${result.heapFirstMB}MB → 末 ${result.heapLastMB}MB（峰值 ${result.heapMaxMB}MB）`);
  console.log(
    `长任务：${result.longTaskStats.count} 次，max=${result.longTaskStats.maxMs}ms，p95=${result.longTaskStats.p95Ms}ms，≥200ms ${result.longTaskStats.over200Ms} 次，累计阻塞 ${result.longTaskStats.totalBlockedMs}ms`
  );
  console.log(`终态：${JSON.stringify(finalSnap)}`);
  console.log(`数据 → ${outFile}`);
} catch (err) {
  console.error('剖析失败:', err.message);
  process.exitCode = 1;
} finally {
  await session.close();
}
