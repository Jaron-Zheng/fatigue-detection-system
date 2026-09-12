#!/usr/bin/env node
/**
 * e2e-fake-camera-test.mjs — 假摄像头端到端测试（第三轮角色四）
 *
 * 把测试报告里"无头浏览器拿不到摄像头权限"导致的未验证项真正验证掉：
 * Chromium 支持 --use-fake-device-for-media-stream 注入虚拟摄像头，
 * --use-file-for-fake-video-capture=<.y4m> 让它从本地文件读取画面。
 * 这样真实的 getUserMedia → FaceEngine(MediaPipe) → 特征/指标/融合链路
 * 能在无头环境下跑起来，而不只是 sim-driver 的合成数据链路。
 *
 * 验证目标（对齐任务书角色四）：
 *   1. FaceEngine.ready === true、delegate 有值（GPU/CPU 如实记录）
 *   2. 走完真实校准进入 RUNNING（校准器吃到的是真实推理的关键点）
 *   3. avgInferMs 有合理数值、推理帧数持续增长
 *   4. indicators 数值随时间变化（证明真实推理链路在跑）
 *   5. 控制台无 error
 *
 * 用法：node tools/e2e-fake-camera-test.mjs --url http://127.0.0.1:5180/
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const FORCE_CPU = args.includes('--cpu');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-face.y4m');
const origin = new URL(URL_TARGET).origin;

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

/* ---------- 0. 素材准备 ---------- */
if (!fs.existsSync(FIXTURE)) {
  console.log('未找到假摄像头素材，先生成…');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'gen-y4m.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('素材生成失败，无法继续。');
    process.exit(1);
  }
}
console.log(`素材：${FIXTURE}（${(fs.statSync(FIXTURE).size / 1024 / 1024).toFixed(2)} MB）`);

/* ---------- 1. 启动带假摄像头的无头浏览器 ---------- */
const session = await launchHeadless({
  debugPort: 9345,
  extraArgs: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${FIXTURE}`,
  ],
});
const { cdp } = session;

// 全局看门狗
const watchdog = setTimeout(() => {
  console.error('\n  ✗ 看门狗超时：e2e 链路挂死，强制退出');
  session.close().finally(() => process.exit(1));
}, 180000);

try {
  await cdp.send('Browser.grantPermissions', { origin, permissions: ['videoCapture'] });

  console.log(`\n[1] 页面加载 → ${URL_TARGET}`);
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(3000);
  assert(await evalJs(cdp, 'Boolean(window.__fatigue)'), '__fatigue 测试钩子存在');

  console.log('\n[2] 真实摄像头路径启动（假摄像头设备）');
  if (FORCE_CPU) {
    await evalJs(cdp, `document.querySelector('#segDelegate button[data-v="CPU"]').click()`);
    console.log('  · 已通过设置面板切换到 CPU 委托（验证回退路径）');
  }
  const startState = await evalJs(cdp, `(async () => {
    const app = window.__fatigue.app;
    app.simulate = false;
    try { await app.start(false); return app.state; }
    catch (e) { return 'error:' + ((e && e.message) || e); }
  })()`);
  assert(startState === 'calibrating' || startState === 'running',
    `start(false) 后进入 calibrating/running (got ${startState})`);

  console.log('\n[3] 等待真实校准完成并进入 RUNNING（最多 90s）');
  let reachedRunning = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await evalJs(cdp, 'window.__fatigue.state');
    if (st === 'running') { reachedRunning = true; break; }
    if (st === 'error' || st === 'idle') break;
  }
  assert(reachedRunning, '真实校准完成并进入 RUNNING');

  console.log('\n[4] 推理引擎与链路断言');
  const snap = await evalJs(cdp, `JSON.stringify({
    ready: window.__fatigue.engineReady,
    delegate: window.__fatigue.app.engine.delegate,
    avgInferMs: window.__fatigue.app.engine.avgInferMs,
    frames: window.__fatigue.app.engine.stats.infer,
    facePresent: window.__fatigue.indicators ? window.__fatigue.indicators.facePresent : null,
    score: window.__fatigue.score,
    level: window.__fatigue.level,
  })`);
  const s = JSON.parse(snap);
  assert(s.ready === true, 'FaceEngine.ready === true');
  assert(s.delegate === 'GPU' || s.delegate === 'CPU', `delegate 有值 (${s.delegate})`);
  assert(Number.isFinite(s.avgInferMs) && s.avgInferMs > 0, `avgInferMs 合理 (${s.avgInferMs.toFixed(2)} ms)`);
  assert(s.frames > 10, `推理帧数持续增长 (got ${s.frames})`);
  assert(s.facePresent === true, '画面中人脸被真实检测到 (facePresent=true)');

  console.log('\n[5] 指标随时间变化（真实链路在跑）');
  const before = await evalJs(cdp, 'window.__fatigue.app.recorder.samples.length');
  await sleep(6000);
  const after = await evalJs(cdp, 'window.__fatigue.app.recorder.samples.length');
  assert(after > before, `采样点增长 (${before} → ${after})`);

  console.log('\n[6] 结束并出报告');
  await evalJs(cdp, 'window.__fatigue.stop()');
  await sleep(800);
  assert(await evalJs(cdp, 'window.__fatigue.state') === 'report', '结束后进入 report');

  console.log('\n[7] 控制台错误');
  // MediaPipe 会把内部 INFO 日志（如 CPU 子图委托创建）打到 console.error，
  // 属于已知无害噪声，列入白名单；其余 error 一律视为失败。
  const benign = (t) => /TensorFlow Lite XNNPACK delegate|Created TensorFlow Lite/.test(t);
  const realErrors = cdp.consoleErrors.filter((t) => !benign(t));
  const filtered = cdp.consoleErrors.length - realErrors.length;
  assert(realErrors.length === 0, `无控制台错误（白名单过滤 ${filtered} 条 MediaPipe INFO）`);
  if (realErrors.length) console.error(JSON.stringify(realErrors, null, 2));

  console.log(`\nGPU/CPU 委托实测：本次无头环境使用 ${s.delegate} 委托，平均推理 ${s.avgInferMs.toFixed(2)}ms/帧`);
} catch (err) {
  failed++;
  console.error('  ✗ e2e 异常:', err.message);
} finally {
  clearTimeout(watchdog);
  await session.close();
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
process.exit(failed > 0 ? 1 : 0);
